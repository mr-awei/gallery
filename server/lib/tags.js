// @ts-check
// 标签管理：单一事实来源是 images.tags 逗号串，item_tags 是派生索引（从 library.js 拆出）
// tag_meta 只存展示属性（分组 / 颜色 / 父标签 / 排序），是 Eagle 式标签体系的「皮肤」。
import { db, withTransaction } from '../db.js';
import { hiddenImagesClause } from './privacy.js';

/**
 * 只把「老库还没建这张表」当成可忽略的兼容错误。
 * 以前这里是裸 catch{}：BUSY、约束冲突、磁盘写满全被当成「没这张表」吞掉，
 * 调用方拿到 ok:true，别名表却停在旧值上。
 */
function isMissingTable(err) {
  return /no such table/i.test(String(err?.message || err));
}


/** 标签计数的聚合缓存：key 是「库文件 + 本连接累计写入行数」，任何写都会自然失效 */
let aggCache = { key: '', rows: null };

function changesKey() {
  const file = String(
    db
      .prepare('PRAGMA database_list')
      .all()
      ?.find((r) => r.name === 'main')?.file || ''
  );
  const n = Number(db.prepare('SELECT total_changes() AS n').get()?.n || 0);
  return `${file}|${n}`;
}

/** 聚合 SQL 的公共部分：始终 join images（隐私锁 + 堆叠口径都要用），item_tags 按 tag 走索引 */
function aggBase() {
  const hidden = hiddenImagesClause();
  const conds = `(images.stack_id = 0 OR images.stack_id = images.id)${hidden ? ` AND ${hidden.sql}` : ''}`;
  return { conds, params: hidden ? [...hidden.params] : [] };
}

/** 标签 → 张数（带缓存）。force=true 跳过缓存重算，给 ?fresh=1 用 */
function tagCounts({ force = false } = {}) {
  const { conds, params } = aggBase();
  // 缓存 key 必须带上隐私条件：解锁 / 加锁某个文件夹不一定写库，
  // 只按「写入行数」判断会把锁定文件夹的标签名从缓存里漏出去
  const key = `${changesKey()}|${conds}`;
  if (!force && aggCache.key === key && aggCache.rows) return aggCache.rows;
  const rows = db
    .prepare(
      `SELECT t.tag AS tag, COUNT(*) AS count FROM item_tags t JOIN images ON images.id = t.image_id
        WHERE ${conds} GROUP BY t.tag`
    )
    .all(...params);
  aggCache = { key, rows };
  return rows;
}

/** 列出所有标签及出现次数（用于标签云 / 筛选） */
export function listTags() {
  // 百万行的 tags 串不再拉进 Node 逐条 split：聚合下推到 item_tags 倒排表
  return tagCounts()
    .slice()
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
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
export function listTagsRich({ fresh = false } = {}) {
  const meta = metaMap();
  // 以前把整库 tags 串拉进 Node 逐条 split：百万行时单次调用 800ms 且吃掉几十 MB。
  // 现在聚合下推到 item_tags（tag 是主键前缀，GROUP BY 可走索引），结果按写入指纹缓存。
  const counter = new Map();
  for (const row of tagCounts({ force: fresh })) counter.set(row.tag, row.count);
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

/**
 * 分页版标签列表：聚合下推到 item_tags 倒排表（走索引），LIMIT/OFFSET 在 SQL 里做。
 * listTags / listTagsRich 会把整库 tags 拉进内存再切，标签涨到几千条时接口会线性变慢；
 * 老接口保留给「写操作后返回完整树」等场景，新调用方用这个。
 * @param {{limit?:number, offset?:number, rich?:boolean}} [opts]
 * @returns {{items:object[], total:number, limit:number, offset:number}}
 */
export function listTagsPaged({ limit = 200, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  const off = Math.max(0, Number(offset) || 0);
  const hidden = hiddenImagesClause();
  const stack = '(images.stack_id = 0 OR images.stack_id = images.id)';
  const conds = `${stack}${hidden ? ` AND ${hidden.sql}` : ''}`;
  const where = `WHERE ${conds}`;
  const params = hidden ? [...hidden.params] : [];
  const base = `FROM item_tags t JOIN images ON images.id = t.image_id ${where}`;
  const imageTags = Number(db.prepare(`SELECT COUNT(DISTINCT t.tag) AS c ${base}`).get(...params)?.c || 0);
  // 只在 tag_meta 里存在的空标签（批量建标签建出来的、或夹标签写进来的）没有挂任何可见素材，
  // 但必须出现在侧栏，否则「批量创建」完什么都看不到。
  const metaOnly = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM tag_meta m WHERE NOT EXISTS (
           SELECT 1 FROM item_tags t JOIN images ON images.id = t.image_id WHERE ${conds} AND t.tag = m.tag
         )`
      )
      .get(...params)?.c || 0
  );
  const rows = db
    .prepare(
      `SELECT t.tag AS tag, COUNT(*) AS count ${base}
       GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT ? OFFSET ?`
    )
    .all(...params, lim, off);
  const meta = metaMap();
  const shape = (tag, count) => {
    const m = meta.get(tag);
    return {
      tag,
      count,
      group: m?.tag_group || '',
      color: m?.color || '',
      parent: m?.parent || '',
      sortOrder: m?.sort_order || 0,
    };
  };
  const items = rows.map((r) => shape(r.tag, r.count));
  if (off === 0) {
    // 补在第一页末尾：空标签数量本来就少（几十个），不会把一页撑爆
    const seen = new Set(items.map((x) => x.tag));
    const empties = [...meta.values()]
      .filter((m) => !seen.has(m.tag))
      .sort(
        (a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.tag).localeCompare(String(b.tag), 'zh-Hans-CN')
      );
    for (const m of empties) items.push(shape(m.tag, 0));
  }
  return { items, total: imageTags + metaOnly, limit: lim, offset: off };
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

/**
 * 设置标签元数据（未提供的字段保持不变）
 * @param {{tag?:string, group?:string, color?:string, parent?:string, sortOrder?:number}} [opts]
 */
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
  return listTagsPaged({ limit: 500, rich: true }).items;
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
  return withTransaction(() => {
    for (const r of rows) {
      const tags = String(r.tags)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t === o ? n : t));
      stmt.run(tags.join(','), r.id);
    }
    // 元数据与别名和主表在同一个事务里：以前 COMMIT 之后才写，
    // 中途失败会留下「图已改名、别名还指着旧名」的半完成状态。
    try {
      // 元数据跟着标签走：目标标签已有元数据时保留目标的（避免覆盖用户设置）
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
    } catch (err) {
      if (!isMissingTable(err)) throw err; // 老库无 tag_meta/tag_alias 表才忽略
    }
    return rows.length;
  });
}

/** 删除标签（从所有图片上摘除） */
export function deleteTag(name) {
  const t = String(name || '').trim();
  if (!t) throw new Error('标签名不能为空');
  const rows = db
    .prepare('SELECT id, tags FROM images WHERE id IN (SELECT image_id FROM item_tags WHERE tag = ?)')
    .all(t);
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  return withTransaction(() => {
    for (const r of rows) {
      const tags = String(r.tags)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x) => x !== t);
      stmt.run(tags.join(','), r.id);
    }
    // 清掉被删标签的元数据，挂在它下面的子标签回到顶层，不留悬空 parent
    try {
      db.prepare('DELETE FROM tag_meta WHERE tag = ?').run(t);
      db.prepare("UPDATE tag_meta SET parent = '' WHERE parent = ?").run(t);
      // 标签没了，指向它的别名也必须清掉，否则搜索会把用户导向一个空标签
      db.prepare('DELETE FROM tag_alias WHERE tag = ? OR alias = ?').run(t, t);
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
    return rows.length;
  });
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
  return withTransaction(() => {
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
        db.prepare(
          `INSERT INTO tag_alias (alias, tag, created_at) VALUES (?, ?, ?)
           ON CONFLICT(alias) DO UPDATE SET tag = excluded.tag`
        ).run(f, t, new Date().toISOString());
      }
      db.prepare('DELETE FROM tag_alias WHERE alias = ?').run(t);
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
    return rows.length;
  });
}
