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
      const rows = db
        .prepare("SELECT id, abs_path FROM images WHERE media_kind IN ('image', 'gif') ORDER BY id DESC LIMIT ?")
        .all(limit * 4);
      let rebuilt = 0;
      let skipped = 0;
      let failed = 0;
      for (const r of rows) {
        if (rebuilt + failed >= limit) break;
        try {
          if (!fs.existsSync(r.abs_path)) {
            failed++;
            continue;
          }
          const srcMtime = fs.statSync(r.abs_path).mtimeMs;
          if (!force && existingThumbPath(r.id, srcMtime)) {
            skipped++;
            continue;
          }
          const p = await lib.ensureThumb(r.id, r.abs_path, { force });
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
      res.json({ ok: true, rebuilt, skipped, failed });
    })
  );

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
