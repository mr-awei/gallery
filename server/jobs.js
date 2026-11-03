/**
 * 后台任务表（持久化 + 历史 + 中断标记）。
 *
 * 为什么需要：采集 / 批量编辑 / 画质增强 / 模型下载原先都是模块内的内存单例，
 * 进程一退就什么都不剩 —— 没有历史、不能重试、崩溃后连「上次跑到第几张」都查不到，
 * 界面上只能看到一个当前任务。这里把它们统一落表：
 *   - 运行中定期写 progress/message（节流，别把 SQLite 写爆）
 *   - 启动时把上次残留的 running/queued 标成 interrupted，界面据此提示「可重试」
 *   - payload 存够重试所需的最小参数（不存图片内容，只存 id 列表 / 关键词等）
 */
import { db } from './db.js';

/** 进度写库节流：任务里每张图都会调一次，没必要每次都落盘 */
const WRITE_GAP_MS = 400;
const lastWrite = new Map();

const nowIso = () => new Date().toISOString();

/** 这些状态代表「已经结束」，不再参与中断标记 */
const FINAL = new Set(['done', 'failed', 'canceled', 'interrupted']);

/**
 * 新建任务记录。
 * @param {{kind:string, title?:string, payload?:object, total?:number}} info
 */
export function createJob({ kind, title = '', payload = {}, total = 0 }) {
  const at = nowIso();
  const r = db
    .prepare(
      `INSERT INTO jobs (kind, title, status, payload, progress, message, done, total, failed, created_at, started_at)
       VALUES (?, ?, 'running', ?, 0, '', 0, ?, 0, ?, ?)`
    )
    .run(
      String(kind),
      String(title).slice(0, 200),
      JSON.stringify(payload || {}),
      Number(total) || 0,
      at,
      at
    );
  return Number(r.lastInsertRowid);
}

/**
 * 更新进度。节流写库，避免几百张图把磁盘刷满。
 * @param {number} id
 * @param {{progress?:number, message?:string, done?:number, total?:number, failed?:number, force?:boolean}} patch
 */
export function jobProgress(id, patch = {}) {
  if (!id) return;
  const key = Number(id);
  const now = Date.now();
  const last = lastWrite.get(key) || 0;
  if (!patch.force && now - last < WRITE_GAP_MS) return;
  lastWrite.set(key, now);
  const sets = [];
  const vals = [];
  for (const k of ['progress', 'message', 'done', 'total', 'failed']) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(
      k === 'message' ? String(patch[k]).slice(0, 300) : k === 'progress' ? Number(patch[k]) || 0 : Number(patch[k]) || 0
    );
  }
  if (!sets.length) return;
  vals.push(key);
  try {
    db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } catch {
    /* 任务表写入失败不该影响主流程 */
  }
}

/**
 * 结束任务。
 * @param {number} id
 * @param {{status?:'done'|'failed'|'canceled'|'interrupted', error?:string, result?:object}} info
 */
export function finishJob(id, { status = 'done', error = '', result = null } = {}) {
  if (!id) return;
  lastWrite.delete(Number(id));
  try {
    db.prepare(
      `UPDATE jobs SET status = ?, error = ?, result = ?, finished_at = ?, progress = CASE WHEN ? = 'done' THEN 100 ELSE progress END
       WHERE id = ?`
    ).run(
      String(status),
      String(error || '').slice(0, 500),
      result ? JSON.stringify(result).slice(0, 4000) : '',
      nowIso(),
      String(status),
      Number(id)
    );
  } catch {
    /* ignore */
  }
}

/** 库里存的是 JSON 文本，历史脏数据不该让整个列表 500，坏行一律降级为默认值 */
function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function toDto(row) {
  if (!row) return null;
  const payload = parseJson(row.payload, {});
  const result = parseJson(row.result, null);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    progress: row.progress,
    message: row.message,
    done: row.done,
    total: row.total,
    failed: row.failed,
    error: row.error,
    payload,
    result,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function getJob(id) {
  return toDto(db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id)));
}

/** 任务历史（新的在前）。kind 为空 = 全部 */
export function listJobs({ kind = '', limit = 20 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  const rows = kind
    ? db.prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY id DESC LIMIT ?').all(String(kind), n)
    : db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(n);
  return rows.map(toDto);
}

/** 某类任务最近一次（界面用它显示「上次采集」/「可继续」） */
export function lastJob(kind) {
  return toDto(db.prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(String(kind)));
}

/** 还有没有在跑的同类型任务（并发上限 = 每类 1 个，避免两个采集互相打架） */
export function hasRunning(kind) {
  const row = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE kind = ? AND status IN ('queued','running')`).get(
    String(kind)
  );
  return Number(row?.n || 0) > 0;
}

/**
 * 启动时调用：上次没跑完的任务一律标 interrupted。
 * 不标的话它们会永远停在 running，界面显示「正在进行」但实际什么也没发生。
 */
export function markInterruptedJobs() {
  try {
    const r = db
      .prepare(
        `UPDATE jobs SET status = 'interrupted', finished_at = ?, error = CASE WHEN error = '' THEN '进程退出时任务未完成' ELSE error END
         WHERE status IN ('queued','running')`
      )
      .run(nowIso());
    return Number(r.changes || 0);
  } catch {
    return 0;
  }
}

/** 裁剪历史，别让任务表无限增长（每类留最近 200 条） */
export function pruneJobs(keepPerKind = 200) {
  try {
    const kinds = db.prepare('SELECT DISTINCT kind FROM jobs').all();
    for (const { kind } of kinds) {
      db.prepare(
        `DELETE FROM jobs WHERE kind = ? AND id NOT IN (SELECT id FROM jobs WHERE kind = ? ORDER BY id DESC LIMIT ?)`
      ).run(kind, kind, Number(keepPerKind) || 200);
    }
  } catch {
    /* ignore */
  }
}

export { FINAL };
