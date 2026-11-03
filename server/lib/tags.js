// 标签管理：单一事实来源是 images.tags 逗号串，item_tags 是派生索引（从 library.js 拆出）
// tag_meta 只存展示属性（分组 / 颜色 / 父标签 / 排序），是 Eagle 式标签体系的「皮肤」。
import { db, withTransaction } from '../db.js';
import { hiddenImagesClause } from './privacy.js';


/** 只看「当前可见」的素材的标签：隐私夹里的图不能通过标签云/筛选把名字漏出来 */
function visibleTagRows() {
  const hidden = hiddenImagesClause();
  const sql = `SELECT tags FROM images WHERE tags <> ''${hidden ? ` AND ${hidden.sql}` : ''}`;
  return db.prepare(sql).all(...(hidden ? hidden.params : []));
}

/** 列出所有标签及出现次数（用于标签云 / 筛选） */
export function listTags() {
  const counter = new Map();
  for (const row of visibleTagRows()) {
    for (const tag of String(row.tags).split(',')) {
      const t = tag.trim();
      if (t) counter.set(t, (counter.get(t) || 0) + 1);
    }
  }
  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/* ------------------------------ 标签元数据 ------------------------------ */

function metaMap() {
  const map = new Map();
  let rows;
  try {
    rows = db.prepare('SELECT * FROM tag_meta').all();
  } catch {
    return map;
  }
  for (const r of rows) map.set(r.tag, r);
  return map;
}

/**
 * 标签树：每个标签带上 count / 分组 / 颜色 / 父标签 / 排序。
 * 层级用 parent（父标签名）表达 —— 标签本体仍是逗号串，层级只影响展示与筛选，
 * 所以「父标签」不必真实存在于某张图上，也可以只是一个分类节点。
 */
export function listTagsRich() {
  const meta = metaMap();
  const counter = new Map();
  for (const row of visibleTagRows()) {
    for (const tag of String(row.tags).split(',')) {
      const t = tag.trim();
      if (t) counter.set(t, (counter.get(t) || 0) + 1);
    }
  }
  // 只作为父节点存在、自身没有挂图的分类节点也要出现在树里（Eagle 允许空分组）
  for (const m of meta.values()) if (!counter.has(m.tag)) counter.set(m.tag, 0);
  const list = [...counter.entries()].map(([tag, count]) => {
    const m = meta.get(tag);
    return {
      tag,
      count,
      group: m?.tag_group || '',
      color: m?.color || '',
      parent: m?.parent || '',
      sortOrder: m?.sort_order || 0,
    };
  });
  // 排序：手动 sort_order 优先，其次出现次数
  list.sort((a, b) => a.sortOrder - b.sortOrder || b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
  return list;
}

/** 列出所有分组名（含空分组） */
export function listTagGroups() {
  const set = new Set();
  try {
    for (const r of db.prepare("SELECT DISTINCT tag_group FROM tag_meta WHERE tag_group <> ''").all()) {
      set.add(r.tag_group);
    }
  } catch {
    /* 老库没有表时忽略 */
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function upsertMeta({ tag, group, color, parent, sortOrder, onlyIfExists = false }) {
  const t = String(tag || '').trim();
  if (!t) throw new Error('标签名不能为空');
  const now = new Date().toISOString();
  const cur = db.prepare('SELECT * FROM tag_meta WHERE tag = ?').get(t);
  if (!cur) {
    if (onlyIfExists) return null;
    db.prepare(
      `INSERT INTO tag_meta (tag, tag_group, color, parent, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(t, String(group || ''), String(color || ''), String(parent || ''), Number(sortOrder) || 0, now);
    return db.prepare('SELECT * FROM tag_meta WHERE tag = ?').get(t);
  }
  const next = {
    group: group === undefined ? cur.tag_group : String(group || ''),
    color: color === undefined ? cur.color : String(color || ''),
    parent: parent === undefined ? cur.parent : String(parent || ''),
    sortOrder: sortOrder === undefined ? cur.sort_order : Number(sortOrder) || 0,
  };
  db.prepare(
    'UPDATE tag_meta SET tag_group = ?, color = ?, parent = ?, sort_order = ?, updated_at = ? WHERE tag = ?'
  ).run(next.group, next.color, next.parent, next.sortOrder, now, t);
  return db.prepare('SELECT * FROM tag_meta WHERE tag = ?').get(t);
}

/** 设置标签元数据（未提供的字段保持不变） */
export function setTagMeta({ tag, group, color, parent, sortOrder } = {}) {
  const row = upsertMeta({ tag, group, color, parent, sortOrder });
  if (!row) return null;
  return {
    tag: row.tag,
    group: row.tag_group,
    color: row.color,
    parent: row.parent,
    sortOrder: row.sort_order,
  };
}

/** 给标签挂到父标签下（拖动排序 / 建层级用），parent 为空串表示回到顶层 */
export function setTagParent(tag, parent) {
  const self = String(tag || '').trim();
  const up = String(parent || '').trim();
  if (!self) throw new Error('标签名不能为空');
  if (up === self) throw new Error('标签不能作为自己的父标签');
  // 沿 parent 链向上走，一旦绕回自己就是成环，直接拒绝（前端也拦了一道，这里是最后防线）
  let cur = up;
  const seen = new Set();
  const parentOf = db.prepare('SELECT parent FROM tag_meta WHERE tag = ?');
  while (cur && !seen.has(cur)) {
    if (cur === self) throw new Error('不能把标签挂到自己的子标签下');
    seen.add(cur);
    cur = String(parentOf.get(cur)?.parent || '');
  }
  return setTagMeta({ tag: self, parent: up });
}

/**
 * 批量重排标签顺序（侧栏拖动排序）：按传入数组的顺序重写 sort_order。
 * 同级/跨组都用这一个入口，前端算好最终顺序即可，避免一堆零碎的 meta 请求。
 */
export function reorderTags(list) {
  const arr = (Array.isArray(list) ? list : []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!arr.length) return listTagsRich();
  const now = new Date().toISOString();
  // node:sqlite 没有 better-sqlite3 的 db.transaction()，统一用 db.js 的 withTransaction
  const has = db.prepare('SELECT tag FROM tag_meta WHERE tag = ?');
  const upd = db.prepare('UPDATE tag_meta SET sort_order = ?, updated_at = ? WHERE tag = ?');
  const ins = db.prepare(
    "INSERT INTO tag_meta (tag, tag_group, color, parent, sort_order, updated_at) VALUES (?, '', '', '', ?, ?)"
  );
  withTransaction(() => {
    arr.forEach((t, i) => {
      if (has.get(t)) upd.run(i, now, t);
      else ins.run(t, i, now);
    });
  });
  return listTagsRich();
}

/** 分组改名：分组只是 tag_meta.tag_group 字符串，整体搬过去即可 */
export function renameTagGroup(from, to) {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  if (!f) throw new Error('原分组名不能为空');
  if (!t) throw new Error('新分组名不能为空');
  if (f === t) return listTagGroups();
  db.prepare('UPDATE tag_meta SET tag_group = ?, updated_at = ? WHERE tag_group = ?').run(
    t,
    new Date().toISOString(),
    f
  );
  return listTagGroups();
}

/** 删除分组：把组内标签退回「未分组」，标签本身不删 */
export function clearTagGroup(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('分组名不能为空');
  db.prepare('UPDATE tag_meta SET tag_group = ?, updated_at = ? WHERE tag_group = ?').run(
    '',
    new Date().toISOString(),
    n
  );
  return listTagGroups();
}

/** 删除标签的元数据（标签本体还在时通常不需要；标签被彻底删掉时清理） */
export function removeTagMeta(tag) {
  db.prepare('DELETE FROM tag_meta WHERE tag = ?').run(String(tag || '').trim());
}

/** 重命名标签（在所有图片上替换，保持单一事实来源：images.tags 逗号串） */
export function renameTag(oldName, newName) {
  const o = String(oldName || '').trim();
  const n = String(newName || '').trim();
  if (!o || !n) throw new Error('标签名不能为空');
  const rows = db
    .prepare('SELECT id, tags FROM images WHERE id IN (SELECT image_id FROM item_tags WHERE tag = ?)')
    .all(o);
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const tags = String(r.tags)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t === o ? n : t));
      stmt.run(tags.join(','), r.id);
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  // 元数据跟着标签走：目标标签已有元数据时保留目标的（避免覆盖用户设置）
  try {
    const src = db.prepare('SELECT * FROM tag_meta WHERE tag = ?').get(o);
    if (src) {
      const dst = db.prepare('SELECT tag FROM tag_meta WHERE tag = ?').get(n);
      if (!dst) {
        db.prepare('UPDATE tag_meta SET tag = ?, updated_at = ? WHERE tag = ?').run(n, new Date().toISOString(), o);
      } else {
        db.prepare('DELETE FROM tag_meta WHERE tag = ?').run(o);
      }
    }
    // 子标签的父子关系跟着改名
    db.prepare('UPDATE tag_meta SET parent = ? WHERE parent = ?').run(n, o);
    // 别名跟着走；别名正好等于新名（会和标签撞名）的那条丢掉
    db.prepare('UPDATE tag_alias SET tag = ? WHERE tag = ?').run(n, o);
    db.prepare('DELETE FROM tag_alias WHERE alias = ?').run(n);
  } catch {
    /* 老库无 tag_meta 表时忽略 */
  }
  return rows.length;
}

/** 删除标签（从所有图片上摘除） */
export function deleteTag(name) {
  const t = String(name || '').trim();
  if (!t) throw new Error('标签名不能为空');
  const rows = db
    .prepare('SELECT id, tags FROM images WHERE id IN (SELECT image_id FROM item_tags WHERE tag = ?)')
    .all(t);
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const tags = String(r.tags)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x) => x !== t);
      stmt.run(tags.join(','), r.id);
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  // 清掉被删标签的元数据，挂在它下面的子标签回到顶层，不留悬空 parent
  try {
    db.prepare('DELETE FROM tag_meta WHERE tag = ?').run(t);
    db.prepare("UPDATE tag_meta SET parent = '' WHERE parent = ?").run(t);
    // 标签没了，指向它的别名也必须清掉，否则搜索会把用户导向一个空标签
    db.prepare('DELETE FROM tag_alias WHERE tag = ? OR alias = ?').run(t, t);
  } catch {
    /* 老库无 tag_meta 表时忽略 */
  }
  return rows.length;
}

/* ------------------------------ 标签别名 / 同义词 ------------------------------ */
/* 别名不写进 images.tags：图片上的标签仍是唯一事实来源，别名只在「查」的时候展开。
 * 反过来，改名/合并/删除标签时必须把别名一起搬走，否则会留下指向空标签的死别名。 */

/** 全部别名（前端标签设置面板用） */
export function listAliases() {
  try {
    return db.prepare('SELECT alias, tag FROM tag_alias ORDER BY alias ASC').all();
  } catch {
    return [];
  }
}

/** 某个标签的所有别名 */
export function aliasesOfTag(tag) {
  try {
    return db.prepare('SELECT alias FROM tag_alias WHERE tag = ? ORDER BY alias ASC').all(String(tag || '').trim()).map((r) => r.alias);
  } catch {
    return [];
  }
}

/** 新增 / 覆盖一个别名（一个别名只能指向一个正式标签） */
export function setAlias(alias, tag) {
  const a = String(alias || '').trim();
  const t = String(tag || '').trim();
  if (!a) throw new Error('别名不能为空');
  if (!t) throw new Error('目标标签不能为空');
  if (a === t) throw new Error('别名不能和标签本身同名');
  if (a.includes(',')) throw new Error('别名不能包含英文逗号');
  db.prepare(
    `INSERT INTO tag_alias (alias, tag, created_at) VALUES (?, ?, ?)
     ON CONFLICT(alias) DO UPDATE SET tag = excluded.tag`
  ).run(a, t, new Date().toISOString());
  return listAliases();
}

/** 删除别名 */
export function deleteAlias(alias) {
  const a = String(alias || '').trim();
  if (!a) throw new Error('别名不能为空');
  db.prepare('DELETE FROM tag_alias WHERE alias = ?').run(a);
  return listAliases();
}

/**
 * 查询期展开：把「用户输入的一个标签名」展开成同义词集合（含自身）。
 * 双向展开 —— 用别名搜正式标签要命中，用正式标签搜「只打了别名的图」也要命中。
 */
export function expandTagName(tag) {
  const t = String(tag || '').trim();
  if (!t) return [];
  const out = new Set([t]);
  try {
    for (const r of db.prepare('SELECT tag FROM tag_alias WHERE alias = ?').all(t)) out.add(String(r.tag));
    for (const r of db.prepare('SELECT alias FROM tag_alias WHERE tag = ?').all(t)) out.add(String(r.alias));
  } catch {
    /* 老库还没建 tag_alias 表 */
  }
  return [...out];
}

/** 关键词模糊命中别名时，返回对应的正式标签（让「界面」也能搜到 ui 的图） */
export function tagsMatchingKeyword(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  try {
    return db
      .prepare('SELECT DISTINCT tag FROM tag_alias WHERE alias LIKE ? OR tag LIKE ? LIMIT 20')
      .all(`%${kw}%`, `%${kw}%`)
      .map((r) => String(r.tag));
  } catch {
    return [];
  }
}

/** 合并标签：把 from 全部改名为 to（去重） */
export function mergeTags(from, to) {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  if (!f || !t) throw new Error('标签名不能为空');
  const rows = db
    .prepare('SELECT id, tags FROM images WHERE id IN (SELECT image_id FROM item_tags WHERE tag = ?)')
    .all(f);
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const set = new Set(
        String(r.tags)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      );
      set.delete(f);
      set.add(t);
      stmt.run([...set].join(','), r.id);
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  // 被合并掉的标签把元数据让给目标标签（目标没设置过时），子标签一并改挂
  try {
    const src = db.prepare('SELECT * FROM tag_meta WHERE tag = ?').get(f);
    const dst = db.prepare('SELECT tag FROM tag_meta WHERE tag = ?').get(t);
    if (src && !dst) {
      db.prepare('UPDATE tag_meta SET tag = ?, updated_at = ? WHERE tag = ?').run(t, new Date().toISOString(), f);
    } else if (src) {
      db.prepare('DELETE FROM tag_meta WHERE tag = ?').run(f);
    }
    db.prepare('UPDATE tag_meta SET parent = ? WHERE parent = ?').run(t, f);
    // 别名一起并过去：被合并标签的名字本身就变成目标标签的别名，老搜法仍然能命中
    db.prepare('UPDATE tag_alias SET tag = ? WHERE tag = ?').run(t, f);
    if (f !== t) {
      try {
        db.prepare(
          `INSERT INTO tag_alias (alias, tag, created_at) VALUES (?, ?, ?)
           ON CONFLICT(alias) DO UPDATE SET tag = excluded.tag`
        ).run(f, t, new Date().toISOString());
      } catch {
        /* 老库无别名表时忽略 */
      }
    }
    db.prepare('DELETE FROM tag_alias WHERE alias = ?').run(t);
  } catch {
    /* 老库无 tag_meta 表时忽略 */
  }
  return rows.length;
}
