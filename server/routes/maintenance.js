// @ts-check
// 维护工具：库体检 / 重建缩略图 / 清理孤立缩略图 / 压缩数据库 / 重新扫描
//
// 这些能力原先散在内部实现里，界面上没有任何入口：缩略图坏了、库里堆了孤儿文件、
// DB 涨到几个 G，用户只能删库重来。这里收敛成一组可手动触发的维护动作。
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { db, getPathIndexState, getSchemaWarnings, getThumbDir, retryPathIndex } from '../db.js';
import * as lib from '../library.js';
import { getMissingCached, importLocalImages, readImportJob } from '../importer.js';
import { existingThumbPath } from '../thumbs.js';
import { thumbQueueStats, retryFailedThumbs, clearThumbFailures } from '../lib/thumb-queue.js';
import { thumbMissingCount } from '../lib/thumb-rebuild.js';
import { computePHash } from '../phash.js';
import { probeMedia } from '../lib/media-probe.js';
import { thumbRebuildStatus } from '../lib/thumb-rebuild.js';
import { pruneGhostFolders } from '../folders.js';

function dbFilePath() {
  try {
    return db.prepare('PRAGMA database_list').all().find((r) => r.name === 'main')?.file || '';
  } catch {
    return '';
  }
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* 文件可能刚被删 */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** 缩略图目录里「库里已经没有对应记录」的文件 */
function orphanThumbFiles() {
  const ids = new Set(db.prepare('SELECT id FROM images').all().map((r) => r.id));
  const out = [];
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jpg')) {
        // 灯箱预览图叫 4856-pv.jpg，它同样属于 4856：以前直接 Number('4856-pv')
        // 得到 NaN 就被当成孤儿，一清理会把整库的预览图删光
        const id = Number(e.name.replace(/-pv\.jpg$/, '').replace(/\.jpg$/, ''));
        if (!id || !ids.has(id)) out.push(p);
      }
    }
  };
  walk(getThumbDir());
  return out;
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get(
    '/api/maintenance/status',
    asyncRoute(async (_req, res) => {
      const total = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
      const missing = await getMissingCached().catch(() => ({ count: 0, ids: [] }));
      // getMissingCached 只回 id 列表，样例路径按 id 再查一次（最多 5 条，主键查询）
      const missIds = (missing.ids || []).slice(0, 5);
      const sampleMissing = missIds.length
        ? db
            .prepare(
              `SELECT id, abs_path AS path FROM images WHERE id IN (${missIds.map(() => '?').join(',')})`
            )
            .all(...missIds)
        : [];
      const withThumb = db
        .prepare("SELECT COUNT(*) AS c FROM images WHERE COALESCE(thumb, '') <> ''")
        .get().c;
      const thumbs = dirSize(getThumbDir());
      const dbPath = dbFilePath();
      let dbBytes = 0;
      try {
        dbBytes = dbPath ? fs.statSync(dbPath).size : 0;
      } catch {
        /* 忽略 */
      }
      const undo = db.prepare('SELECT COUNT(*) AS c FROM edit_history').get().c;
      res.json({
        total,
        withThumb,
        missing: Number(missing.count) || 0,
        thumbFiles: thumbs.files,
        thumbBytes: thumbs.bytes,
        dbPath,
        dbBytes,
        undoCount: undo,
        sampleMissing,
      });
    })
  );

  /**
   * 重建缩略图：补「缺了的」+ 「早于原图的旧缓存」。
   *
   * 后一种是真 bug 的修法：缩略图按 id 命名，id 会随重建库/清空库从头再来，
   * 磁盘上上一辈子同 id 的缩略图会被直接认领，列表显示的就不是这张图。
   * 所以这里不能只看「文件在不在」，要比 mtime；force=true 则整批重画（含灯箱预览图）。
   */
  app.post(
    '/api/maintenance/rebuild-thumbs',
    asyncRoute(async (req, res) => {
      const limit = Math.min(2000, Math.max(1, Number(req.body?.limit) || 300));
      const force = req.body?.force === true;
      // 续跑游标：整库补图要走好几轮，每轮都从「最新的 limit*4 张」里挑，
      // 排在后面的老图永远轮不到（8 千张的库会卡在最后几百张上）
      const beforeId = Math.max(0, Number(req.body?.beforeId) || 0);
      // RAW / PSD 也要能在里修：它们的缩略图来自文件内嵌预览，以前被这条 SQL 排除在外，
      // 一旦导入时没提取成功就永远修不好（卡片一直是「文件缺失」）
      // 非 force 时直接筛「还没有缩略图」的，天然分页，不会被已修好的行占满窗口
      const sql = force
        ? `SELECT id, abs_path FROM images WHERE media_kind IN ('image', 'gif', 'raw', 'design')
           ${beforeId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`
        : `SELECT id, abs_path FROM images WHERE media_kind IN ('image', 'gif', 'raw', 'design')
           AND COALESCE(thumb, '') = '' ${beforeId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`;
      const rows = beforeId ? db.prepare(sql).all(beforeId, limit) : db.prepare(sql).all(limit);
      let rebuilt = 0;
      let skipped = 0;
      let failed = 0;
      for (const r of rows) {
        // rows 本身已经 LIMIT 过，最多就是 limit 行，不需要在循环里再 break；
        // 旧的 break 还会让游标停在「没处理的那一行」上
        try {
          if (!fs.existsSync(r.abs_path)) {
            failed++;
            continue;
          }
          const srcMtime = fs.statSync(r.abs_path).mtimeMs;
          if (!force) {
            const cached = existingThumbPath(r.id, srcMtime);
            if (cached) {
              // 磁盘上有可用缩略图但 thumb 字段为空：必须回写。
              // 否则 thumbMissingCount() 一直把它算作缺失，每轮续跑都白扫一遍。
              db.prepare("UPDATE images SET thumb = ? WHERE id = ? AND COALESCE(thumb, '') = ''").run(cached, r.id);
              skipped++;
              continue;
            }
          }
          const p = await lib.ensureThumb(r.id, r.abs_path, { force });
          // 生成失败不要把 thumb 写成 NULL 还算「已重建」
          if (!p) {
            failed++;
            continue;
          }
          // 缩略图换了，pHash 必须跟着重算：查重用的指纹是从缩略图派生的，
          // 留着按旧缩略图算出的 hash，等于拿别人的指纹去比对，还会把好图误判成「重复」。
          const phash = await computePHash(p || r.abs_path).catch(() => '');
          // cover_ver 必须 +1：前端缩略图 URL 带版本号，不换号浏览器会继续用旧图
          if (phash) {
            db.prepare('UPDATE images SET thumb = ?, cover_ver = cover_ver + 1, phash = ? WHERE id = ?').run(
              p,
              phash,
              r.id
            );
            lib.indexPhash(r.id, phash);
          } else {
            db.prepare('UPDATE images SET thumb = ?, cover_ver = cover_ver + 1 WHERE id = ?').run(p, r.id);
          }
          rebuilt++;
        } catch {
          failed++;
        }
      }
      // nextBeforeId：这一批处理到的最小 id，下一轮带上它继续往前翻（0 = 已到头）。
      // 不能按「有没有 rebuilt/failed」判断：整页都被 skipped 时会被判成 0，
      // 前端续跑就永远从第一页重来，排在后面的图一辈子轮不到。
      const nextBeforeId = rows.length ? Number(rows[rows.length - 1].id) : 0;
      res.json({ ok: true, rebuilt, skipped, failed, nextBeforeId });
    })
  );

  /**
   * 修正 EXIF 方向造成的两类错：
   * 1) images.width/height 存的是「像素没转」的尺寸（5D4 竖拍 5472×3648），
   *    瀑布流按横图排版，图片被 object-fit: cover 裁掉大半；
   * 2) RAW/设计稿的缩略图来自文件内嵌预览，那段 JPEG 里没有方向标签，
   *    以前只调 .rotate() → 竖拍照片在库里整个躺倒 90°。
   *
   * 第 2 类只能重出图。以前这里只「删文件 + thumb 置空」，指望后台补图任务重画，
   * 但 ensureThumb 的缓存判断是「缩略图文件比源图新就能复用」—— Windows 上文件被
   * 占用时 fsp.rm 会静默失败，后台任务看到旧文件还在就直接复用，缩略图永远是躺倒的。
   * 所以这里直接 force 重画（RAW 抽取内嵌预览只要几十毫秒，一批 300 张在请求内能跑完）。
   */
  app.post(
    '/api/maintenance/fix-orientation',
    asyncRoute(async (req, res) => {
      const limit = Math.min(2000, Math.max(1, Number(req.body?.limit) || 300));
      const beforeId = Math.max(0, Number(req.body?.beforeId) || 0);
      const sql = `SELECT id, abs_path, width, height, media_kind, thumb FROM images
        WHERE COALESCE(abs_path, '') <> '' AND media_kind IN ('image', 'gif', 'raw', 'design')
        ${beforeId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`;
      const rows = beforeId ? db.prepare(sql).all(beforeId, limit) : db.prepare(sql).all(limit);
      let rotated = 0;
      let dims = 0;
      let cleared = 0;
      let failed = 0;
      const px = sharp;
      for (const r of rows) {
        try {
          if (!fs.existsSync(r.abs_path)) continue;
          const meta = await px(r.abs_path, { failOn: 'none' }).metadata();
          const ori = Number(meta.orientation) || 1;
          if (ori < 5 || ori > 8) continue;
          rotated++;
          if (r.media_kind === 'raw' || r.media_kind === 'design') {
            // 宽高由 ensureThumb 按「屏幕方向」写回（designThumbJpeg 已经过 orientedSize），
            // 这里不能再自己换一次，否则会换回去
            const p = await lib.ensureThumb(r.id, r.abs_path, { force: true });
            if (p) cleared++;
            else failed++;
            continue;
          }
          // orientation 5~8 = 画面被转 90°：屏幕上的宽高要互换
          const w = Number(meta.height) || 0;
          const h = Number(meta.width) || 0;
          if (w && h && (Number(r.width) !== w || Number(r.height) !== h)) {
            db.prepare('UPDATE images SET width = ?, height = ?, cover_ver = cover_ver + 1 WHERE id = ?').run(
              w,
              h,
              r.id
            );
            dims++;
          }
        } catch {
          failed++;
        }
      }
      const nextBeforeId = rows.length ? Number(rows[rows.length - 1].id) : 0;
      res.json({ ok: true, rotated, dims, cleared, failed, nextBeforeId });
    })
  );

  /**
   * 一键补齐所有缺缩略图的记录（后台任务，不阻塞请求）。
   * 与上面的 rebuild-thumbs 的区别：那个是「前端一轮轮点」，这个是服务端自己按记录补完，
   * 进度写进任务表，适合「旧库合并进来 / 上次导入被强杀」这种成片缺图。
   */
  app.post('/api/maintenance/rebuild-missing', (_req, res) => {
    const r = ctx.startThumbRebuild?.({
      onProgress: (s) => {
        if (s.finished) ctx.sseBroadcast?.('library', { thumbRebuild: s });
      },
    }) || { started: false, reason: 'unavailable' };
    res.json({ ok: true, ...r });
  });

  app.get('/api/maintenance/rebuild-missing', (_req, res) => {
    res.json({ ok: true, ...thumbRebuildStatus() });
  });

  /** 清理孤立缩略图；默认 dryRun，只报告不动手 */
  app.post(
    '/api/maintenance/orphan-thumbs',
    asyncRoute(async (req, res) => {
      const dryRun = req.body?.dryRun !== false;
      const total = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
      // 空库一律拒绝：切库/建库未完成的瞬间 ids 是空的，
      // 按「全都不认识」清理会把刚生成的缩略图全部删掉
      if (!total) {
        return res.status(409).json({
          ok: false,
          dryRun,
          found: 0,
          removed: 0,
          sample: [],
          message: '当前库没有任何图片记录，已拒绝清理',
        });
      }
      const files = orphanThumbFiles();
      let removed = 0;
      // 失败原因必须带回去：以前这里静默吞掉，清理「成功但一个没删」时完全查不出为什么
      const errors = [];
      if (!dryRun) {
        // 分批并发删：单个 rmSync 在 Windows 上要几十毫秒（杀软逐个扫），
        // 上千个文件同步删会把整个 HTTP 线程钉死几分钟，其他请求全排队
        const BATCH = 32;
        for (let i = 0; i < files.length; i += BATCH) {
          const batch = files.slice(i, i + BATCH);
          const settled = await Promise.allSettled(batch.map((f) => fs.promises.rm(f, { force: true })));
          settled.forEach((s, k) => {
            if (s.status === 'fulfilled') removed++;
            else if (errors.length < 5) errors.push(`${batch[k]}: ${s.reason?.code || s.reason?.message || s.reason}`);
          });
        }
      }
      res.json({ ok: true, dryRun, found: files.length, removed, errors, sample: files.slice(0, 5) });
    })
  );

  /**
   * 清理幽灵文件夹：磁盘上已不存在、子树一张图都没有的夹。
   * 侧栏冒出「另一个库的文件夹」通常就是这类残留，默认 dryRun 先给清单。
   */
  app.post(
    '/api/maintenance/ghost-folders',
    asyncRoute(async (req, res) => {
      const dryRun = req.body?.dryRun !== false;
      const r = pruneGhostFolders({ dryRun });
      res.json({ ok: true, ...r });
    })
  );

  /** 压缩数据库 + 完整性检查（VACUUM 会短暂占锁，所以做成手动动作） */
  app.post(
    '/api/maintenance/vacuum',
    asyncRoute(async (_req, res) => {
      const dbPath = dbFilePath();
      const size = () => {
        try {
          return dbPath ? fs.statSync(dbPath).size : 0;
        } catch {
          return 0;
        }
      };
      const before = size();
      const integrity = db.prepare('PRAGMA integrity_check').get();
      db.exec('VACUUM');
      db.exec('ANALYZE');
      const after = size();
      res.json({
        ok: true,
        integrity: integrity?.integrity_check || 'unknown',
        before,
        after,
        saved: Math.max(0, before - after),
      });
    })
  );

  /**
   * 补算视频元数据：入库时才带上时长/分辨率，但存量视频（以及 ffmpeg 未介入前入库的）
   * 宽高/时长都是 0，卡片只能显示「未知」。这里按容器头原地探测，不需要 ffmpeg。
   */
  app.post(
    '/api/maintenance/probe-media',
    asyncRoute(async (req, res) => {
      const limit = Math.min(2000, Math.max(1, Number(req.body?.limit) || 200));
      const rows = db
        .prepare(
          `SELECT id, abs_path FROM images
           WHERE media_kind IN ('video', 'audio') AND (COALESCE(duration, 0) = 0 OR COALESCE(width, 0) = 0)
           ORDER BY id DESC LIMIT ?`
        )
        .all(limit);
      let probed = 0;
      let skipped = 0;
      const stmt = db.prepare('UPDATE images SET duration = ?, width = ?, height = ? WHERE id = ?');
      for (const r of rows) {
        try {
          if (!fs.existsSync(r.abs_path)) {
            skipped++;
            continue;
          }
          const m = probeMedia(r.abs_path);
          if (!m.duration && !m.width && !m.height) {
            skipped++;
            continue;
          }
          stmt.run(m.duration, m.width, m.height, r.id);
          probed++;
        } catch {
          skipped++;
        }
      }
      const remain = db
        .prepare(
          `SELECT COUNT(*) AS c FROM images
           WHERE media_kind IN ('video', 'audio') AND (COALESCE(duration, 0) = 0 OR COALESCE(width, 0) = 0)`
        )
        .get().c;
      res.json({ ok: true, probed, skipped, remain });
    })
  );

  /** 重新扫描存储目录（补进应用外新增的文件） */
  app.post(
    '/api/maintenance/rescan',
    asyncRoute(async (req, res) => {
      if (ctx.importState && ctx.importState().running) {
        return res.json({ ok: false, message: '导入任务正在运行' });
      }
      // dedupe 默认开：同尺寸候选会算 MD5，命中已有素材就跳过（用户可显式传 false）
      const r = await importLocalImages({ dedupe: req.body?.dedupe !== false });
      res.json({ ok: true, ...r });
    })
  );

  /* ------------------------------ 导入任务状态 ------------------------------ */
  /* 上次导入干到哪了：中断 / 失败 / 完成都有记录，重启后不再只是「库是半截的」 */
  app.get('/api/import/job', (_req, res) => {
    res.json({ ok: true, running: ctx.importState?.().running ?? false, job: readImportJob() });
  });

  app.post(
    '/api/import/resume',
    asyncRoute(async (req, res) => {
      if (ctx.importState && ctx.importState().running) {
        return res.json({ ok: false, message: '导入任务正在运行' });
      }
      // 续传 = 重跑增量扫描：已登记且指纹未变的文件会被直接跳过，只补没进来的
      const r = await importLocalImages({ dedupe: req.body?.dedupe !== false });
      res.json({ ok: true, ...r });
    })
  );

  /* ------------------------------ 缩略图队列 ------------------------------ */
  /* 「失败被伪装成空白卡片」是这个项目里反复出现的坑：这里把队列、失败原因、
     缺图数量一起暴露出来，面板上能看见、能重试，而不是只会在日志里叹气。 */
  app.get('/api/thumbs/status', (_req, res) => {
    const q = thumbQueueStats();
    res.json({ ok: true, ...q, missing: thumbMissingCount() });
  });

  app.post('/api/thumbs/retry', (_req, res) => {
    res.json({ ok: true, ...retryFailedThumbs() });
  });

  app.post('/api/thumbs/failures/clear', (_req, res) => {
    clearThumbFailures();
    res.json({ ok: true });
  });

  /* ------------------------------ 库健康 ------------------------------ */
  /* 「唯一索引悄悄没建起来」与「删除留下孤儿关联」都属于用户看不见的坏状态：
     前者让并发导入能插入重复路径，后者让文件夹张数与封面撒谎。这里一次性暴露出来。 */
  const countOrphans = () => {
    const one = (sql) => {
      try {
        return Number(db.prepare(sql).get()?.c) || 0;
      } catch {
        return -1; // 表还不存在（极老的库）：不算问题，也不假装是 0
      }
    };
    return {
      folders: one('SELECT COUNT(*) AS c FROM image_folders WHERE image_id NOT IN (SELECT id FROM images)'),
      comments: one('SELECT COUNT(*) AS c FROM image_comments WHERE image_id NOT IN (SELECT id FROM images)'),
      clipVec: one('SELECT COUNT(*) AS c FROM clip_vec WHERE image_id NOT IN (SELECT id FROM images)'),
    };
  };

  app.get('/api/maintenance/health', (_req, res) => {
    res.json({
      ok: true,
      pathIndex: getPathIndexState(),
      orphans: countOrphans(),
      // 结构层「修失败了但还能跑」的问题（如 hue 列迁移不完整），以前完全不可见
      warnings: getSchemaWarnings(),
    });
  });

  /** 重复路径清干净后补建唯一索引（启动时建不上只会告警，不会阻断） */
  app.post('/api/maintenance/path-index', (_req, res) => {
    res.json({ ok: true, ...retryPathIndex() });
  });

  app.post('/api/maintenance/orphans/clean', (_req, res) => {
    const before = countOrphans();
    let removed = 0;
    try {
      for (const n of Object.values(before)) {
        if (n > 0) removed += n;
      }
      db.exec(`
        DELETE FROM image_folders  WHERE image_id NOT IN (SELECT id FROM images);
        DELETE FROM image_comments WHERE image_id NOT IN (SELECT id FROM images);
        DELETE FROM clip_vec       WHERE image_id NOT IN (SELECT id FROM images);
      `);
    } catch (err) {
      return res.status(500).json({ error: `清理失败：${err.message}` });
    }
    res.json({ ok: true, removed, after: countOrphans() });
  });
}
