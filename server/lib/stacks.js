// 图片堆叠（Eagle 的 Stack）：同一素材的多版本、多裁切、多个格式合成一组。
// 约定：stack_id = 0 表示没堆叠；否则指向「组主」那张图（组主自己的 stack_id = 自己的 id）。
// 列表默认只显示组主（见 lib/query.js 的 stack 过滤），成员在灯箱里展开。
import { db, withTransaction } from '../db.js';

const MAX_STACK = 200;

function normalizeIds(ids, exclude = 0) {
  return (Array.isArray(ids) ? ids : [ids])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && n !== exclude)
    .filter((n, i, a) => a.indexOf(n) === i)
    .slice(0, MAX_STACK);
}

/** 组主优先用「已置顶/评分最高」的那张，都没有就用第一张 */
function pickPrimary(ids) {
  const rows = db
    .prepare(
      `SELECT id, rating FROM images WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids);
  if (!rows.length) return 0;
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (b.rating || 0) - (a.rating || 0) || order.get(a.id) - order.get(b.id));
  return rows[0].id;
}

/**
 * 把一批图从它们原来的堆叠里摘出来（一张图只能属于一个堆叠）。
 *
 * 不能无脑 `UPDATE ... WHERE stack_id = 旧组主`：拖走的是组主时，剩下的成员会指向
 * 一个已经不在组里的 id（组就"散架"了）。这里按组算剩余成员：
 * - 剩余 >= 2：若走的是组主，把剩下最早的一张提升为组主；否则原组主不变
 * - 剩余 < 2：堆叠没有意义，整组解散
 */
function detachForMove(ids) {
  const rows = db
    .prepare(
      `SELECT id, stack_id FROM images WHERE id IN (${ids.map(() => '?').join(',')}) AND stack_id <> 0`
    )
    .all(...ids);
  const movingByStack = new Map();
  for (const r of rows) {
    const sid = Number(r.stack_id);
    const arr = movingByStack.get(sid) || [];
    arr.push(Number(r.id));
    movingByStack.set(sid, arr);
  }
  const membersOf = db.prepare('SELECT id FROM images WHERE stack_id = ? ORDER BY id');
  const clearStack = db.prepare('UPDATE images SET stack_id = 0 WHERE stack_id = ?');
  const moveGroup = db.prepare('UPDATE images SET stack_id = ? WHERE stack_id = ?');
  const setSelf = db.prepare('UPDATE images SET stack_id = ? WHERE id = ?');
  for (const [sid, moving] of movingByStack) {
    const members = membersOf.all(sid).map((r) => r.id);
    const rest = members.filter((m) => !moving.includes(m));
    if (rest.length < 2) {
      clearStack.run(sid);
      continue;
    }
    if (moving.includes(sid)) {
      const next = rest[0];
      moveGroup.run(next, sid);
      setSelf.run(next, next);
    }
  }
}

/** 把这几张图合成一个堆叠；已在别的堆叠里的成员会先被摘出来（一张图只属于一个堆叠） */
export function createStack(imageIds = []) {
  const ids = normalizeIds(imageIds);
  if (ids.length < 2) throw new Error('至少选择两张素材才能堆叠');
  const exists = db.prepare('SELECT id FROM images WHERE id = ?');
  const valid = ids.filter((id) => exists.get(id));
  if (valid.length < 2) throw new Error('素材不存在或已被删除');
  const primary = pickPrimary(valid);
  const setStack = db.prepare('UPDATE images SET stack_id = ? WHERE id = ?');
  withTransaction(() => {
    detachForMove(valid);
    for (const id of valid) setStack.run(primary, id);
    setStack.run(primary, primary);
  });
  return { ok: true, stackId: primary, ids: valid };
}

/** 把更多图加进某个堆叠（id = 组主 id；不存在则把 id 当组主自建一组） */
export function addToStack(stackId, imageIds = []) {
  const sid = Number(stackId);
  if (!sid) throw new Error('堆叠不存在');
  const primary = db.prepare('SELECT id, stack_id FROM images WHERE id = ?').get(sid);
  if (!primary) throw new Error('素材不存在或已被删除');
  const rootId = Number(primary.stack_id) === sid || Number(primary.stack_id) === 0 ? sid : Number(primary.stack_id);
  const ids = normalizeIds(imageIds, rootId);
  if (!ids.length) return { ok: true, stackId: rootId, added: 0 };
  const setStack = db.prepare('UPDATE images SET stack_id = ? WHERE id = ?');
  let added = 0;
  withTransaction(() => {
    detachForMove(ids);
    for (const id of ids) added += setStack.run(rootId, id).changes;
    setStack.run(rootId, rootId);
  });
  return { ok: true, stackId: rootId, added };
}

/** 把 source 这一组整体并入 target 组（target 可以是组主或任意成员） */
export function mergeStacks(sourceId, targetId) {
  const src = Number(sourceId);
  const dst = Number(targetId);
  if (!src || !dst || src === dst) throw new Error('请选择另一个堆叠合并');
  const membersOf = (sid) => db.prepare('SELECT id FROM images WHERE stack_id = ?').all(sid).map((r) => r.id);
  const srcMembers = membersOf(src);
  if (!srcMembers.length) throw new Error('要合并的堆叠不存在');
  const target = db.prepare('SELECT id, stack_id FROM images WHERE id = ?').get(dst);
  if (!target) throw new Error('目标堆叠不存在');
  const targetRoot = Number(target.stack_id) || dst;
  const r = addToStack(targetRoot, srcMembers);
  return { ok: true, stackId: r.stackId, added: r.added };
}

/** 堆叠列表（给「并入其他堆叠」选择器用），按组内张数降序 */
export function listStacks(limit = 50) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  return db
    .prepare(
      `SELECT i.id, i.title, i.fs_mtime, i.cover_ver, i.media_kind, c.c AS count
         FROM images i
         JOIN (SELECT stack_id, COUNT(*) AS c FROM images WHERE stack_id <> 0 GROUP BY stack_id) c
           ON c.stack_id = i.id
        ORDER BY c.c DESC, i.id DESC
        LIMIT ?`
    )
    .all(lim)
    .map((r) => ({
      stackId: Number(r.id),
      title: r.title,
      count: Number(r.count),
      thumbUrl: `/api/images/${r.id}/thumb?v=${Number(r.fs_mtime) || 0}-${Number(r.cover_ver) || 0}`,
    }));
}

/**
 * 指定新的组主（堆叠封面）。
 * 不能复用 createStack：那条路按评分挑组主，用户明确点「设封面」时不该被评分覆盖 ——
 * 4 星的花絮版也可能更适合当封面。
 */
export function setStackPrimary(id, primaryId) {
  const row = db.prepare('SELECT id, stack_id FROM images WHERE id = ?').get(Number(id));
  if (!row) throw new Error('素材不存在或已被删除');
  const sid = Number(row.stack_id) || Number(row.id);
  const target = db.prepare('SELECT id, stack_id FROM images WHERE id = ?').get(Number(primaryId));
  if (!target || (Number(target.stack_id) !== sid && Number(target.id) !== sid)) {
    throw new Error('这张素材不在该堆叠里');
  }
  withTransaction(() => {
    db.prepare('UPDATE images SET stack_id = ? WHERE stack_id = ?').run(Number(primaryId), sid);
    db.prepare('UPDATE images SET stack_id = ? WHERE id = ?').run(Number(primaryId), Number(primaryId));
  });
  return { ok: true, stackId: Number(primaryId) };
}

/** 解散整个堆叠（传组主 id 或任意成员 id 都行） */
export function ungroupStack(id) {
  const row = db.prepare('SELECT id, stack_id FROM images WHERE id = ?').get(Number(id));
  if (!row) throw new Error('素材不存在或已被删除');
  const rootId = Number(row.stack_id) || Number(row.id);
  const n = db.prepare('UPDATE images SET stack_id = 0 WHERE stack_id = ?').run(rootId).changes;
  return { ok: true, removed: n };
}

/** 把一张图从堆叠里移出；移出的是组主时，自动把剩下最早的一张提升为组主 */
export function removeFromStack(id) {
  const row = db.prepare('SELECT id, stack_id FROM images WHERE id = ?').get(Number(id));
  if (!row) throw new Error('素材不存在或已被删除');
  const sid = Number(row.stack_id) || 0;
  if (!sid) return { ok: true, stackId: 0, removed: 0 };
  const members = db.prepare('SELECT id FROM images WHERE stack_id = ? ORDER BY id').all(sid).map((r) => r.id);
  db.prepare('UPDATE images SET stack_id = 0 WHERE id = ?').run(row.id);
  const rest = members.filter((m) => m !== row.id);
  if (!rest.length) return { ok: true, stackId: 0, removed: 1 };
  const next = row.id === sid ? rest[0] : sid;
  if (next !== sid) {
    withTransaction(() => {
      db.prepare('UPDATE images SET stack_id = ? WHERE stack_id = ?').run(next, sid);
      db.prepare('UPDATE images SET stack_id = ? WHERE id = ?').run(next, next);
    });
  }
  return { ok: true, stackId: next, removed: 1 };
}

/** 堆叠成员（含组主），按 id 升序；由路由层转 DTO */
export function stackRows(id) {
  const row = db.prepare('SELECT id, stack_id FROM images WHERE id = ?').get(Number(id));
  if (!row) return [];
  const sid = Number(row.stack_id) || Number(row.id);
  return db.prepare('SELECT * FROM images WHERE stack_id = ? ORDER BY id ASC').all(sid);
}

/**
 * 给一页图片补堆叠信息（stackCount / stackPrimary）。
 * 一次 GROUP BY 拿全页的组内张数，不做逐行子查询 —— 网格是热路径。
 */
export function attachStackInfo(items) {
  if (!items || !items.length) return items;
  const stackIds = [...new Set(items.map((i) => Number(i.stackId) || 0).filter(Boolean))];
  if (!stackIds.length) {
    for (const it of items) {
      it.stackCount = 0;
      it.stackPrimary = false;
    }
    return items;
  }
  const counts = new Map(
    db
      .prepare(
        `SELECT stack_id, COUNT(*) AS c FROM images WHERE stack_id IN (${stackIds.map(() => '?').join(',')}) GROUP BY stack_id`
      )
      .all(...stackIds)
      .map((r) => [r.stack_id, r.c])
  );
  for (const it of items) {
    const sid = Number(it.stackId) || 0;
    it.stackCount = sid ? counts.get(sid) || 0 : 0;
    it.stackPrimary = sid > 0 && sid === it.id;
  }
  return items;
}
