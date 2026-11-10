// @ts-check
/**
 * 任务中心 + 操作撤销的接口。
 *
 * 任务：GET /api/jobs、POST /api/jobs/:id/cancel、POST /api/jobs/:id/retry
 * 撤销：GET /api/ops、POST /api/ops/:id/undo、POST /api/ops/undo-last
 *
 * 撤销执行器注册在这里（而不是 oplog.js 里），是为了避免
 * oplog ← library ← oplog 的循环依赖。
 */
import { db } from '../db.js';
import { getJob, hasRunning, listJobs } from '../jobs.js';
import { getOp, listOps, registerUndoer, undoLast, undoOp } from '../oplog.js';
import * as lib from '../library.js';
import * as nd from '../lib/nondestructive.js';
import { addImagesToFolder, removeImagesFromFolder } from '../folders.js';
import { removeImage, restoreFromTrash } from '../lib/trash.js';
import { startCrawl, stopCrawl } from '../crawler.js';
import { cancelEditJob, startEditJob } from '../edit-job.js';
import { cancelJob as cancelEnhanceJob, startJob as startEnhanceJob } from '../enhance-job.js';
import { cancelMattingInstall, installMatting } from '../matting.js';
import { cancelFaceInstall, cancelFaceScan, startFaceInstall, startFaceScan } from '../face.js';
import { cancelEagleExport, startEagleExportJob } from '../eagle-export-job.js';
import { cancelTimelineBackfill, startTimelineBackfill } from '../timeline-backfill.js';

/* ------------------------------ 撤销执行器 ------------------------------ */

/** 打标：把每张图还原成操作前的标签串 */
registerUndoer('tags', async (p) => {
  let n = 0;
  for (const it of p.items || []) {
    const before = String(it.before || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    lib.setTags(it.id, before);
    n++;
  }
  return { restored: n };
});

/**
 * 批量改元数据 → 按每张的快照整批恢复。
 * 标签必须走 lib.setTags（有倒排表），裸 UPDATE 会让标签筛选/标签云与图片对不上。
 */
registerUndoer('meta', async (p) => {
  let n = 0;
  for (const it of p.items || []) {
    const b = it.before || {};
    if (b.tags !== undefined) lib.setTags(it.id, b.tags);
    if (b.rating !== undefined) lib.setRating(it.id, b.rating);
    if (b.favorite !== undefined) lib.setFavorite(it.id, !!b.favorite);
    if (b.note !== undefined) lib.setNote(it.id, b.note);
    n++;
  }
  return { restored: n };
});

/** 非破坏编辑：撤销一步 = 从操作链里摘掉那一步（原文件从来没动过） */
registerUndoer('nd-edit', async (p) => {
  return { restored: nd.dropOp(Number(p.id), Number(p.opId)) ? 1 : 0 };
});

/** 还原整条操作链 → 撤销时按原顺序补回去 */
registerUndoer('nd-clear', async (p) => {
  let n = 0;
  for (const op of p.ops || []) {
    try {
      nd.addOp(Number(p.id), String(op.kind), op.params || {}, { log: false });
      n++;
    } catch {
      // 超过上限或操作已失效：能补几步补几步，别让整条撤销失败
    }
  }
  return { restored: n };
});

/** 收藏状态回滚 */
registerUndoer('favorite', async (p) => {
  let n = 0;
  for (const it of p.items || []) {
    lib.setFavorite(it.id, !!it.before);
    n++;
  }
  return { restored: n };
});

/** 批量重命名 → 名字改回去（磁盘文件名一起还原，失败逐条回报） */
registerUndoer('rename', async (p) => {
  let n = 0;
  const failed = [];
  for (const it of p.items || []) {
    try {
      await lib.renameImage(Number(it.id), String(it.before || ''));
      n++;
    } catch {
      failed.push(it.id);
    }
  }
  return { restored: n, failed: failed.length };
});

/** 加入文件夹 → 移除回来；被移出文件夹 → 加回去 */
registerUndoer('folder-add', async (p) => {
  const removed = removeImagesFromFolder(Number(p.folderId), p.imageIds || []);
  return { removed };
});

registerUndoer('folder-remove', async (p) => {
  const added = addImagesToFolder(Number(p.folderId), p.imageIds || []);
  return { added };
});

/** 删除（进回收站）→ 从回收站恢复。按 image_id 找对应回收站记录 */
registerUndoer('trash', async (p) => {
  let n = 0;
  const failed = [];
  for (const imageId of p.imageIds || []) {
    const row = db.prepare('SELECT id FROM trash WHERE image_id = ? ORDER BY id DESC LIMIT 1').get(Number(imageId));
    if (!row) {
      failed.push(imageId);
      continue;
    }
    try {
      await restoreFromTrash(row.id);
      n++;
    } catch {
      failed.push(imageId);
    }
  }
  return { restored: n, failed: failed.length };
});

/**
 * 动作（AI Action）→ 按快照把标题 / 标签 / 备注 / 评分 / 收藏恢复，
 * 并只摘掉本次执行新加的文件夹归属（执行前已有的归属不动）。
 * 走 lib.* 而不是裸 SQL：标签有倒排表，直接 UPDATE 会让标签筛选与标签云不一致。
 */
registerUndoer('action', async (p) => {
  let restored = 0;
  const failed = [];
  for (const it of p.rows || []) {
    const id = Number(it.id);
    try {
      const cur = db
        .prepare('SELECT title, tags, note, rating, favorite FROM images WHERE id = ?')
        .get(id);
      if (!cur) {
        failed.push(id);
        continue;
      }
      if (String(cur.title || '') !== String(it.title || '')) lib.renameTitle(id, String(it.title || ''));
      if (String(cur.tags || '') !== String(it.tags || '')) {
        lib.setTags(
          id,
          String(it.tags || '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        );
      }
      if (String(cur.note || '') !== String(it.note || '')) lib.setNote(id, String(it.note || ''));
      if (Number(cur.rating || 0) !== Number(it.rating || 0)) lib.setRating(id, Number(it.rating) || 0);
      if (!!Number(cur.favorite) !== !!Number(it.favorite)) lib.setFavorite(id, !!Number(it.favorite));
      for (const fid of Array.isArray(it.addedFolders) ? it.addedFolders : []) {
        removeImagesFromFolder(Number(fid), [id]);
      }
      restored++;
    } catch {
      failed.push(id);
    }
  }
  return { restored, failed: failed.length };
});

/** 回收站恢复 → 再删回去（仍走回收站，不会真删文件） */
registerUndoer('restore', async (p) => {
  let n = 0;
  for (const imageId of p.imageIds || []) {
    const r = await removeImage(Number(imageId), { reason: '撤销恢复' });
    if (r.ok) n++;
  }
  return { restored: n };
});

/** 批量导入 → 把这次导入的图移进回收站（不真删，可再恢复） */
registerUndoer('import', async (p) => {
  const maxId = Number(p.maxId) || 0;
  if (!maxId) throw new Error('这次导入没有记录可撤销的边界');
  const cap = 2000;
  // 以前只取最新 2000 张就收工：导入 8000 张点「撤销」会静默留下 6000 张，
  // 而这次 op 已标 consumed，用户再也没有第二次机会。这里分批循环撤到边界。
  let trashed = 0;
  let rounds = 0;
  for (;;) {
    const rows = db
      .prepare('SELECT id FROM images WHERE id > ? ORDER BY id DESC LIMIT ?')
      .all(maxId, cap);
    if (!rows.length) break;
    let progressed = 0;
    for (const row of rows) {
      const r = await removeImage(row.id, { reason: '撤销导入' });
      if (r.ok) {
        trashed++;
        progressed++;
      }
    }
    // 整批都删不掉（文件被占用/权限不足）时再查还是同一批，及时收手避免死循环，
    // 剩余条数由返回值的 failed 体现
    if (!progressed || rows.length < cap) break;
    if (++rounds >= 500) break; // 防御：上限 100 万张
  }
  return { trashed };
});

/* -------------------------------- 路由 -------------------------------- */

const KIND_TITLE = {
  crawl: '采集',
  edit: '批量编辑',
  enhance: '画质增强',
  'model-install': '模型下载',
  'face-scan': '人脸扫描',
  'eagle-export': '导出 Eagle 库',
  'timeline-backfill': '重建拍摄时间',
};

export function register(app) {
  // 任务历史（新的在前）。kind 可选，limit 默认 20
  app.get('/api/jobs', (req, res) => {
    const kind = String(req.query.kind || '');
    const limit = Number(req.query.limit) || 20;
    res.json(listJobs({ kind, limit }));
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    res.json(job);
  });

  // 取消：转给各子系统的现有取消入口，任务表只负责记录
  app.post('/api/jobs/:id/cancel', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (job.status !== 'running' && job.status !== 'queued') {
      return res.json({ ok: false, message: '任务已结束，无需停止' });
    }
    let ok = false;
    if (job.kind === 'crawl') ok = stopCrawl();
    // cancelEditJob / cancelJob 返回的是任务状态对象，不是布尔：以前直接把对象当 ok 回给前端，
    // 前端 if (ok) 恒为真，取消失败也显示「已请求停止」。
    else if (job.kind === 'edit') ok = !!cancelEditJob()?.cancelled;
    else if (job.kind === 'enhance') ok = !!cancelEnhanceJob()?.cancelled;
    else if (job.kind === 'model-install') {
      // 人脸模型与去背景模型都走 model-install，取消要落到真正在下的那个
      ok = cancelMattingInstall() || cancelFaceInstall();
    } else if (job.kind === 'face-scan') ok = cancelFaceScan();
    else if (job.kind === 'eagle-export') ok = cancelEagleExport();
    else if (job.kind === 'timeline-backfill') {
      cancelTimelineBackfill();
      ok = true;
    }
    res.json({ ok, message: ok ? '已请求停止' : '该任务不支持从任务中心停止' });
  });

  // 重试：用任务表里存的 payload 重新跑一遍（已入库的内容会走查重，不会重复占空间）
  app.post('/api/jobs/:id/retry', async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (job.status === 'running') return res.status(409).json({ error: '该任务还在运行' });
    if (hasRunning(job.kind)) {
      return res.status(409).json({ error: `还有${KIND_TITLE[job.kind] || ''}任务在跑，等它结束再重试` });
    }
    const p = job.payload || {};
    try {
      /** @type {any} 各子系统返回值形状不同（{ok,message} / 状态对象），这里只关心 ok 与 message */
      let out;
      if (job.kind === 'crawl') out = startCrawl({ keywords: p.keywords, sources: p.sources, pages: p.pages });
      else if (job.kind === 'edit') out = startEditJob(p.ids || [], p.op, p.params || {});
      else if (job.kind === 'enhance') out = startEnhanceJob(p.ids || [], p.model, p.standard);
      else if (job.kind === 'model-install') {
        if (p.model === 'sr') out = { ok: false, message: '超分模型按需加载，无需预下载' };
        else if (p.model === 'face') out = startFaceInstall();
        else out = installMatting();
      } else if (job.kind === 'face-scan') {
        out = startFaceScan({ limit: p.limit || 0, force: p.force === true, minCos: p.minCos || 0 });
      } else if (job.kind === 'eagle-export') {
        out = startEagleExportJob({ destDir: p.destDir, name: p.name });
      } else if (job.kind === 'timeline-backfill') {
        out = startTimelineBackfill();
      } else out = { ok: false, message: '未知任务类型' };
      if (out?.ok === false) return res.status(400).json({ error: out.message || '重试失败' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 操作日志（撤销栈）
  app.get('/api/ops', (req, res) => {
    res.json(listOps(Number(req.query.limit) || 30));
  });

  app.post('/api/ops/:id/undo', async (req, res) => {
    const op = getOp(req.params.id);
    if (!op) return res.status(404).json({ error: '操作记录不存在' });
    try {
      res.json(await undoOp(op.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/ops/undo-last', async (_req, res) => {
    try {
      res.json(await undoLast());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}
