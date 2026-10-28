// 统一列表查询：结构化筛选 + FTS5 全文搜索 + 排序分页的唯一权威实现（从 library.js 拆出）
import { db, withTransaction } from '../db.js';
import { toDTO } from '../library.js';

export function markAllViewedByFilter(query = {}) {
  const colorIds = query.colorIds || null;
  const colorTable = colorIds && colorIds.length ? createColorScope(colorIds) : '';
  try {
    const { sql, params } = buildImageFilter(query, { colorTable });
    const now = new Date().toISOString();
    // 无论有无颜色筛选都是一条 UPDATE：颜色命中集经临时表引用，不再把几十万个
    // id 捞进内存再逐条更新（旧路径十万级 = 十万次 UPDATE + 一次全表 SELECT）
    return db
      .prepare(`UPDATE images SET view_count = view_count + 1, viewed_at = ? ${sql}`)
      .run(now, ...params).changes;
  } finally {
    dropColorScope(colorTable);
  }
}

/** 批量标记已看（把当前筛选结果整体标记） */
export function markAllViewed(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (!list.length) return 0;
  const stmt = db.prepare('UPDATE images SET view_count = view_count + 1, viewed_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  let affected = 0;
  db.exec('BEGIN');
  try {
    for (const id of list) affected += stmt.run(now, id).changes;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  return affected;
}

/* ------------------------------ 统一列表查询 ------------------------------ */

const SORTS = {
  newest: 'created_at DESC, id DESC',
  oldest: 'created_at ASC, id ASC',
  largest: 'size_bytes DESC',
  resolution: '(width * height) DESC',
  smart: 'score DESC, created_at DESC',
  worst: 'score ASC, created_at DESC',
  rating: 'rating DESC, score DESC, created_at DESC',
  recommend: 'pref DESC, score DESC, created_at DESC',
  random: 'RANDOM()',
};

/**
 * 统一列表入口：结构化筛选 + 全文搜索（FTS5 优先，短词回退 LIKE）+ 排序 + 分页。
 * 之前列表 SQL 与关键词搜索分散在 app.js buildFilter 和 search.js 各一份，字段还不一致；
 * 现在收敛到这里，所有「列图片」的查询都走同一套逻辑。
 * query 支持：page/pageSize/sort/q/source/favorite/orientation/bucket/tag/seen/minRating/hue/colorIds
 */
/**
 * 精确颜色筛选的临时作用域表：把颜色命中的 id（按颜色质量序）灌进 TEMP 表，
 * WHERE 里用 `id IN (SELECT id FROM 表)` 引用 —— 取代把十万级 id 内联成占位符
 * （超过 SQLite 变量上限直接报错，即使没超也是全表扫一遍巨型 IN）。
 * 插入顺序即 rowid 序，排序按颜色质量只需记住入表序。
 */
let colorScopeSeq = 0;

function createColorScope(colorIds) {
  const table = `color_scope_${++colorScopeSeq}`;
  db.exec(`CREATE TEMP TABLE ${table} (id INTEGER PRIMARY KEY)`);
  const ins = db.prepare(`INSERT INTO ${table}(id) VALUES (?)`);
  withTransaction(() => {
    for (const id of colorIds) ins.run(id);
  });
  return table;
}

function dropColorScope(table) {
  if (!table) return;
  try {
    db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  } catch {
    /* 切库导致连接变化等极端情况：表随连接消亡，忽略 */
  }
}

/**
 * 列表筛选的 WHERE 拼装（唯一权威）。
 * 之前 app.js 里另有一份 buildFilter，收敛列表逻辑时删了它却漏改路由，
 * 导致「全部标记已看」入口 100% 抛 ReferenceError（P0）。现在两处共用这一份。
 */
export function buildImageFilter(query = {}, { colorTable = '' } = {}) {
  const colorIds = query.colorIds || null;
  const where = [];
  const params = [];

  // 全文搜索：FTS5 trigram（>=3 字，中文子串走索引）；短词（1-2 字）trigram 命中为空，回退 LIKE
  if (query.q) {
    const kw = String(query.q).trim();
    const like = `%${kw}%`;
    const aiDescWhere = `id IN (SELECT image_id FROM ai_desc WHERE description LIKE ? OR issues LIKE ?)`;
    if ([...kw].length >= 3) {
      // 过滤 FTS5 查询语法特殊字符，整体作为 phrase 查询，避免用户输入被当作 AND/NOT/前缀
      const clean = kw.replace(/["()*^:+-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean) {
        where.push(`(id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?) OR ${aiDescWhere})`);
        params.push(`"${clean}"`, like, like);
      } else {
        where.push(aiDescWhere);
        params.push(like, like);
      }
    } else {
      where.push(`(title LIKE ? OR tags LIKE ? OR keyword LIKE ? OR note LIKE ? OR ${aiDescWhere})`);
      params.push(like, like, like, like, like, like);
    }
  }

  const source = String(query.source || '').trim();
  if (source && source !== 'all') {
    const list = source.split(',').filter(Boolean);
    where.push(`source IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  const favorite = String(query.favorite || 'all');
  if (favorite === 'yes') where.push('favorite = 1');
  if (favorite === 'no') where.push('favorite = 0');

  const orientation = String(query.orientation || 'all');
  if (orientation && orientation !== 'all') {
    if (orientation === 'portrait') where.push('height > width * 1.15');
    else if (orientation === 'landscape') where.push('width > height * 1.15');
    else if (orientation === 'square') where.push('ABS(width - height) <= width * 0.15');
  }

  const bucket = String(query.bucket || '').trim();
  if (bucket && bucket !== 'all') {
    const list = bucket.split(',').filter(Boolean);
    const clauses = [];
    for (const b of list) {
      if (b === 'sd') clauses.push('MAX(width, height) < 1080');
      else if (b === 'fhd') clauses.push('MAX(width, height) >= 1080 AND MAX(width, height) < 2048');
      else if (b === '2k') clauses.push('MAX(width, height) >= 2048 AND MAX(width, height) < 3840');
      else if (b === '4k') clauses.push('MAX(width, height) >= 3840');
    }
    if (clauses.length) where.push(`(${clauses.join(' OR ')})`);
  }

  const tag = String(query.tag || '').trim();
  if (tag) {
    where.push('id IN (SELECT image_id FROM item_tags WHERE tag = ?)');
    params.push(tag);
  }

  const seen = String(query.seen || 'all');
  if (seen === 'unseen') where.push('view_count = 0');
  else if (seen === 'seen') where.push('view_count > 0');

  const minRating = Number(query.minRating) || 0;
  if (minRating > 0) {
    where.push('rating >= ?');
    params.push(minRating);
  }

  const hue = String(query.hue || '').trim();
  if (hue && hue !== 'all') {
    const list = hue.split(',').filter(Boolean);
    const clauses = [];
    const hues = list.filter((h) => h !== 'gray').map(Number).filter((n) => !Number.isNaN(n));
    if (hues.length) {
      const sub = hues.map(() => `',' || hue || ',' LIKE '%,' || ? || ',%'`).join(' OR ');
      clauses.push(`(${sub})`);
    }
    if (list.includes('gray')) clauses.push(`(hue = '' OR hue IS NULL)`);
    if (clauses.length) {
      where.push(`(${clauses.join(' OR ')})`);
      params.push(...hues.map(String));
    }
  }

  if (colorIds) {
    if (!colorIds.length) where.push('0 = 1');
    else if (colorTable) where.push(`id IN (SELECT id FROM ${colorTable})`);
    else if (colorIds.length <= 30000) {
      // 兜底（仅在调用方没建临时表时）：小结果集直接内联。超过 SQLite 变量上限
      // 的颜色筛选必须走 colorTable —— 十万级命中内联会直接 500（too many variables）
      where.push(`id IN (${colorIds.map(() => '?').join(',')})`);
      params.push(...colorIds);
    } else {
      where.push('0 = 1');
    }
  }

  const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { sql, params, colorIds };
}

export function listImages(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(120, Math.max(12, Number(query.pageSize) || 48));
  const colorIds = query.colorIds || null;
  const colorTable = colorIds && colorIds.length ? createColorScope(colorIds) : '';
  try {
    const { sql, params } = buildImageFilter(query, { colorTable });

    // 精确颜色筛选：结果需按颜色相似度排序。旧实现把全部命中行整行拉回来在内存排序
    // （十万级命中 = 十万行全列 + 全量 DTO 前置）；现在只取轻量 id 列，排序后仅对当页回表
    if (colorIds && colorIds.length) {
      const rank = new Map(colorIds.map((id, i) => [id, i]));
      const hitIds = db
        .prepare(`SELECT id FROM images ${sql}`)
        .all(...params)
        .map((r) => r.id);
      hitIds.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
      const total = hitIds.length;
      const pageIds = hitIds.slice((page - 1) * pageSize, page * pageSize);
      const rows = pageIds.length
        ? db
            .prepare(`SELECT * FROM images WHERE id IN (${pageIds.map(() => '?').join(',')})`)
            .all(...pageIds)
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const items = pageIds.map((id) => byId.get(id)).filter(Boolean).map(toDTO);
      return { items, total, page, pageSize, hasMore: page * pageSize < total };
    }

    const order = SORTS[query.sort] || SORTS.newest;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM images ${sql}`).get(...params).c;
    const rows = db
      .prepare(`SELECT * FROM images ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
    return { items: rows.map(toDTO), total, page, pageSize, hasMore: page * pageSize < total };
  } finally {
    dropColorScope(colorTable);
  }
}
