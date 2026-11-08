/**
 * 统一操作日志 / 撤销栈。
 *
 * 为什么需要：原来只有「编辑类」操作能撤销（edit_history 存原图备份）。
 * 打标、移动文件夹、批量删除、回收站恢复、批量导入都不可回滚 ——
 * 手滑一次只能人肉复原，百万级图库里等于灾难。
 *
 * 设计：只存「逆操作所需的最小信息」（image id、原标签、文件夹 id…），
 * 不存图片本体（原图路径不变，回收站里的文件本来就在）。撤销执行器由
 * routes/jobs.js 注册，避免 oplog ← library ← oplog 的循环依赖。
 */
import { db } from './db.js';

/** op → 撤销执行器 (payload) => Promise<any> */
const undoers = new Map();

export function registerUndoer(op, fn) {
  undoers.set(String(op), fn);
}

export function canUndo(op) {
  return undoers.has(String(op));
}

/**
 * 记录一次批量操作。
 * @param {{op:string, summary?:string, payload?:object}} info
 * @returns {number} 日志 id
 */
export function logOp({ op, summary = '', payload = {} }) {
  const at = new Date().toISOString();
  const r = db
    .prepare('INSERT INTO op_log (op, summary, payload, undone, created_at) VALUES (?,?,?,0,?)')
    .run(String(op), String(summary).slice(0, 200), JSON.stringify(payload || {}), at);
  // 只留最近 200 条：撤销栈再长也没人用，反而白占库
  try {
    db.prepare('DELETE FROM op_log WHERE id NOT IN (SELECT id FROM op_log ORDER BY id DESC LIMIT 200)').run();
  } catch {
    /* ignore */
  }
  return Number(r.lastInsertRowid);
}

/** payload 是 JSON 文本，坏数据只该影响这一条，不能让整张操作列表报错 */
function parsePayload(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function toDto(row) {
  const payload = parsePayload(row.payload);
  return {
    id: row.id,
    op: row.op,
    summary: row.summary,
    undone: !!row.undone,
    undoable: undoers.has(row.op) && !row.undone,
    createdAt: row.created_at,
    payload,
  };
}

export function listOps(limit = 30) {
  const n = Math.max(1, Math.min(200, Number(limit) || 30));
  return db.prepare('SELECT * FROM op_log ORDER BY id DESC LIMIT ?').all(n).map(toDto);
}

export function getOp(id) {
  const row = db.prepare('SELECT * FROM op_log WHERE id = ?').get(Number(id));
  return row ? toDto(row) : null;
}

/**
 * 撤销一条操作。
 * @param {number} id
 */
export async function undoOp(id) {
  const row = db.prepare('SELECT * FROM op_log WHERE id = ?').get(Number(id));
  if (!row) throw new Error('操作记录不存在（可能已被清理）');
  if (row.undone) throw new Error('这次操作已经撤销过了');
  const fn = undoers.get(row.op);
  if (!fn) throw new Error(`「${row.summary || row.op}」不支持撤销`);
  const info = await fn(JSON.parse(row.payload || '{}'));
  db.prepare('UPDATE op_log SET undone = 1 WHERE id = ?').run(Number(id));
  return { ok: true, op: row.op, info: info ?? null };
}

/** 撤销最近一条「可撤销且未撤销」的操作 */
export async function undoLast() {
  const row = db
    .prepare(
      `SELECT * FROM op_log WHERE undone = 0 AND op IN (${[...undoers.keys()].map(() => '?').join(',') || "''"})
       ORDER BY id DESC LIMIT 1`
    )
    .get(...[...undoers.keys()]);
  if (!row) throw new Error('没有可撤销的操作');
  return undoOp(row.id);
}
