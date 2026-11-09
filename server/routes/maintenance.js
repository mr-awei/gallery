// @ts-check
// 维护工具：库体检 / 重建缩略图 / 清理孤立缩略图 / 压缩数据库 / 重新扫描
//
// 这些能力原先散在内部实现里，界面上没有任何入口：缩略图坏了、库里堆了孤儿文件、
// DB 涨到几个 G，用户只能删库重来。这里收敛成一组可手动触发的维护动作。
import fs from 'node:fs';
import path from 'node:path';
import { db, getThumbDir } from '../db.js';
import * as lib from '../library.js';
import { getMissingCached, importLocalImages } from '../importer.js';
import { existingThumbPath } from '../thumbs.js';
import { computePHash } from '../phash.js';
import { probeMedia } from '../lib/media-probe.js';
import { thumbRebuildStatus } from '../lib/thumb-rebuild.js';

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
    asyncRoute(async (_req, res) => {
      if (ctx.importState && ctx.importState().running) {
        return res.json({ ok: false, message: '导入任务正在运行' });
      }
      const r = await importLocalImages();
      res.json({ ok: true, ...r });
    })
  );
}
