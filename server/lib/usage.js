// @ts-check
// 素材使用统计：复制 / 导出次数。
// Eagle 的大图详情能看到「这张图用过几次」，也用来找出「从没用过的素材」。
// 只记次数与最近一次时间，不记「谁在什么时候导出到哪」——那是操作日志（op_log）的事。
import { db, withTransaction } from '../db.js';

const COLUMNS = {
  copy: 'copy_count',
  export: 'export_count',
};

const MAX_IDS = 500;

/**
 * 给一批图累加使用次数。
 * kind: copy（复制图片/链接/路径）| export（导出、下载、纯图）
 * 返回实际更新成功的行数；未知 kind 直接抛错，避免静默丢计数。
 */
export function bumpUsage(kind, ids = []) {
  const col = COLUMNS[String(kind || '')];
  if (!col) throw new Error(`未知的使用统计类型：${kind}`);
  const list = (Array.isArray(ids) ? ids : [ids])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .filter((n, i, a) => a.indexOf(n) === i)
    .slice(0, MAX_IDS);
  if (!list.length) return 0;
  const now = new Date().toISOString();
  const upd = db.prepare(`UPDATE images SET ${col} = ${col} + 1, last_used_at = ? WHERE id = ?`);
  let n = 0;
  withTransaction(() => {
    // node:sqlite 的 changes 是 number | bigint，显式收敛成 number 再累加
    for (const id of list) n += Number(upd.run(now, id).changes);
  });
  return n;
}
