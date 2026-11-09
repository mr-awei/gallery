// @ts-check
// 统一列表查询：结构化筛选 + FTS5 全文搜索 + 排序分页的唯一权威实现（从 library.js 拆出）
import { db, withTransaction } from '../db.js';
import { toDTO } from '../library.js';
import { expandTagName, tagsMatchingKeyword } from './tags.js';
import { hiddenImagesClause } from './privacy.js';
import { attachStackInfo } from './stacks.js';

export function markAllViewedByFilter(query = {}) {
  const colorIds = query.colorIds || null;
  const colorTable = colorIds && colorIds.length ? createColorScope(colorIds) : '';
  try {
    const { sql, params } = buildImageFilter(query, { colorTable });
    const now = new Date().toISOString();
    // 无论有无颜色筛选都是一条 UPDATE：颜色命中集经临时表引用，不再把几十万个
    // id 捞进内存再逐条更新（旧路径十万级 = 十万次 UPDATE + 一次全表 SELECT）
    return db
      .prepare(
        `UPDATE images SET view_count = view_count + 1,
           viewed_at = CASE WHEN viewed_at < ? THEN ? ELSE viewed_at END ${sql}`
      )
      .run(now, now, ...params).changes;
  } finally {
    dropColorScope(colorTable);
  }
}

/** 批量标记已看（把当前筛选结果整体标记） */
export function markAllViewed(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (!list.length) return 0;
  const stmt = db.prepare(
    `UPDATE images SET view_count = view_count + 1,
       viewed_at = CASE WHEN viewed_at < ? THEN ? ELSE viewed_at END
     WHERE id = ?`
  );
  const now = new Date().toISOString();
  // 用 withTransaction（SAVEPOINT）：裸 BEGIN 一旦被外层事务包住就会抛
  // "cannot start a transaction within a transaction"，而内层 ROLLBACK 还会把外层一起回滚。
  return withTransaction(() => {
    let affected = 0;
    for (const id of list) affected += stmt.run(now, now, id).changes;
    return affected;
  });
}

/* ------------------------------ 统一列表查询 ------------------------------ */

/** 全选（Ctrl+A）返回的 id 上限：防止一次把整库 id 灌进前端 */
const MAX_IDS = 20000;

const SORTS = {
  newest: 'created_at DESC, id DESC',
  oldest: 'created_at ASC, id ASC',
  name: 'title ASC, id ASC',
  nameDesc: 'title DESC, id DESC',
  largest: 'size_bytes DESC',
  resolution: '(width * height) DESC',
  smart: 'score DESC, created_at DESC',
  worst: 'score ASC, created_at DESC',
  rating: 'rating DESC, score DESC, created_at DESC',
  recommend: 'pref DESC, score DESC, created_at DESC',
  random: 'RANDOM()',
};

/* ------------------------------ 搜索框前缀语法 ------------------------------ */
/* Eagle / Lightroom 老用户的手速：tag:logo color:blue rating:>=4 folder:客户 kind:video is:favorite。
 * 只认白名单前缀，其它带冒号的串（尤其 http:// 网址）原样当关键词，绝不拆坏。 */
const COLOR_HUE_MAP = new Map([
  ['red', '0'], ['红', '0'], ['红色', '0'],
  ['orange', '1'], ['橙', '1'], ['橙色', '1'],
  ['yellow', '2'], ['黄', '2'], ['黄色', '2'],
  ['lime', '3'], ['黄绿', '3'],
  ['green', '4'], ['绿', '4'], ['绿色', '4'],
  ['teal', '5'], ['青绿', '5'],
  ['cyan', '6'], ['青', '6'], ['青色', '6'],
  ['blue', '7'], ['蓝', '7'], ['蓝色', '7'],
  ['indigo', '8'], ['靛', '8'], ['靛蓝', '8'],
  ['purple', '9'], ['紫', '9'], ['紫色', '9'],
  ['magenta', '10'], ['品红', '10'],
  ['pink', '11'], ['玫粉', '11'], ['粉', '11'], ['粉色', '11'],
  ['gray', 'gray'], ['grey', 'gray'], ['灰', 'gray'], ['灰色', 'gray'], ['黑白', 'gray'],
]);

/** 解析搜索框里的 key:value 前缀；没有可识别前缀时返回 null（保持原有纯关键词行为） */
export function parseSearchSyntax(raw) {
  const src = String(raw || '').trim();
  if (!src || !src.includes(':')) return null;
  const out = {
    matched: false, text: '', tags: [], hues: [], minRating: 0, maxRating: 0,
    folderPath: '', kind: [], favorite: '', seen: '', noTags: false,
  };
  const re = /(?:^|\s)(tag|color|rating|folder|kind|is):("([^"]*)"|[^\s]+)/gi;
  let rest = src;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[1].toLowerCase();
    const val = String(m[3] !== undefined ? m[3] : m[2]).trim();
    rest = rest.replace(m[0], ' ');
    if (!val) continue;
    out.matched = true;
    if (key === 'tag') out.tags.push(val);
    else if (key === 'color') {
      for (const part of val.split(/[,，]/)) {
        const h = COLOR_HUE_MAP.get(part.trim().toLowerCase());
        if (h) out.hues.push(h);
      }
    } else if (key === 'rating') {
      const mm = val.match(/^(>=|<=|>|<|=)?\s*([0-5])$/);
      if (mm) {
        const n = Number(mm[2]);
        if (mm[1] === '<=' || mm[1] === '<') out.maxRating = mm[1] === '<' ? Math.max(0, n - 1) : n;
        else out.minRating = n;
      }
    } else if (key === 'folder') {
      const f = db.prepare('SELECT path FROM folders WHERE name = ? ORDER BY id LIMIT 1').get(val);
      if (f) out.folderPath = String(f.path);
    } else if (key === 'kind') {
      out.kind.push(...val.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
    } else if (key === 'is') {
      const v = val.toLowerCase();
      if (v === 'favorite' || v === 'star' || v === '收藏') out.favorite = 'yes';
      else if (v === 'unseen' || v === '未看') out.seen = 'unseen';
      else if (v === 'seen' || v === '已看') out.seen = 'seen';
      else if (v === 'notag' || v === '无标签') out.noTags = true;
    }
  }
  if (!out.matched) return null;
  out.text = rest.replace(/\s+/g, ' ').trim();
  return out;
}

/** 打了某个标签的文件夹 + 它的全部子孙夹（文件夹标签继承用） */
function folderIdsByTag(names) {
  if (!names.length) return [];
  const rows = db.prepare('SELECT id, path, tags FROM folders').all();
  const prefixes = [];
  for (const r of rows) {
    const own = String(r.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (own.some((t) => names.includes(t))) prefixes.push(String(r.path || '/'));
  }
  if (!prefixes.length) return [];
  return rows
    .filter((r) => {
      const p = String(r.path || '/');
      return prefixes.some((pre) => p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/'));
    })
    .map((r) => r.id);
}

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
 * @param {Record<string, any>} [query] HTTP query / 调用方给的动态筛选条件
 * @param {{colorTable?:string}} [opts]
 */
export function buildImageFilter(query = {}, { colorTable = '' } = {}) {
  // 先拆搜索框前缀，剩余文本继续走全文检索 —— 不改数据库、不改调用方
  const syntax = parseSearchSyntax(query.q);
  if (syntax) {
    /** @type {Record<string, any>} 搜索语法会补写 tag / hue / rating 等键 */
    const merged = { ...query, q: syntax.text };
    if (syntax.tags.length && !merged.tag) merged.tag = syntax.tags.join(',');
    if (syntax.hues.length && (!merged.hue || merged.hue === 'all')) merged.hue = syntax.hues.join(',');
    if (syntax.minRating) merged.minRating = Math.max(Number(merged.minRating) || 0, syntax.minRating);
    if (syntax.maxRating) merged.maxRating = Math.min(Number(merged.maxRating) || 5, syntax.maxRating);
    if (syntax.folderPath && !merged.folderId) merged.folderPath = syntax.folderPath;
    if (syntax.kind.length && (!merged.kind || merged.kind === 'all')) merged.kind = syntax.kind.join(',');
    if (syntax.favorite) merged.favorite = 'yes';
    if (syntax.seen) merged.seen = syntax.seen;
    if (syntax.noTags) merged.noTags = '1';
    query = merged;
  }
  const colorIds = query.colorIds || null;
  const where = [];
  const params = [];

  // 全文搜索：FTS5 trigram（>=3 字，中文子串走索引）；短词（1-2 字）trigram 命中为空，回退 LIKE
  if (query.q) {
    const kw = String(query.q).trim();
    const like = `%${kw}%`;
    const aiDescWhere = `id IN (SELECT image_id FROM ai_desc WHERE description LIKE ? OR issues LIKE ?)`;
    // 图内文字（OCR）也要能被关键词搜到：设计稿/截图里真正有用的信息常常只存在于画面文字里
    const ocrWhere = 'id IN (SELECT image_id FROM image_ocr WHERE text LIKE ?)';
    // 别名 / 同义词命中：搜「界面」也要搜到只打了 ui 的图（正式标签不在关键词里出现）
    const aliasTags = tagsMatchingKeyword(kw);
    const aliasSql = aliasTags.map(() => 'tags LIKE ?');
    const aliasParams = aliasTags.map((t) => `%${t}%`);
    let clause;
    if ([...kw].length >= 3) {
      // 过滤 FTS5 查询语法特殊字符，整体作为 phrase 查询，避免用户输入被当作 AND/NOT/前缀
      const clean = kw.replace(/["()*^:+-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean) {
        clause = `(id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?) OR ${aiDescWhere} OR ${ocrWhere}`;
        params.push(`"${clean}"`, like, like, like);
      } else {
        clause = `(${aiDescWhere} OR ${ocrWhere}`;
        params.push(like, like, like);
      }
    } else {
      clause = `(title LIKE ? OR tags LIKE ? OR keyword LIKE ? OR note LIKE ? OR ${aiDescWhere} OR ${ocrWhere}`;
      params.push(like, like, like, like, like, like, like);
    }
    if (aliasSql.length) {
      clause += ` OR ${aliasSql.join(' OR ')}`;
      params.push(...aliasParams);
    }
    where.push(clause + ')');
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
    // 逗号分隔 = 多标签 AND（与标签面板多选语义一致）
    for (const one of tag.split(',').map((s) => s.trim()).filter(Boolean)) {
      const names = expandTagName(one);
      const parts = [
        `id IN (SELECT image_id FROM item_tags WHERE tag IN (${names.map(() => '?').join(',')}))`,
      ];
      params.push(...names);
      // 文件夹标签继承：夹上打了这个标签，夹内（含子孙夹）的素材也算带着它
      const inherited = folderIdsByTag(names);
      if (inherited.length) {
        parts.push(
          `id IN (SELECT image_id FROM image_folders WHERE folder_id IN (${inherited.map(() => '?').join(',')}))`
        );
        params.push(...inherited);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
  }

  // 「待整理」三个固定入口（Eagle 的未分类 / 无标签 / 未评分）
  if (String(query.noFolder || '') === '1') where.push('id NOT IN (SELECT image_id FROM image_folders)');
  if (String(query.noTags || '') === '1') where.push("tags = ''");
  if (String(query.noRating || '') === '1') where.push('rating = 0');

  // 文件夹范围（含全部子夹）：Ctrl+A 全选必须与列表视图同范围，
  // 否则在子文件夹里全选会选中全库，批量删/移动直接波及范围外的图。
  // 也支持直接按路径范围（搜索语法 folder:名称 解析出来的结果是路径，不是 id）
  const folderPath = String(query.folderPath || '').trim();
  if (query.folderId || folderPath) {
    const folder = folderPath
      ? { path: folderPath.endsWith('/') ? folderPath : folderPath + '/' }
      : db.prepare('SELECT path FROM folders WHERE id = ?').get(Number(query.folderId));
    if (folder) {
      where.push(
        'id IN (SELECT f.image_id FROM image_folders f JOIN folders d ON d.id = f.folder_id WHERE d.path LIKE ?)'
      );
      params.push(folder.path + '%');
    } else {
      where.push('0 = 1');
    }
  }

  // 素材类型筛选：image / gif / video / audio / font / pdf / office / model
  const kind = String(query.kind || '').trim();
  if (kind && kind !== 'all') {
    const list = kind.split(',').filter(Boolean);
    where.push(`media_kind IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }

  const seen = String(query.seen || 'all');
  if (seen === 'unseen') where.push('view_count = 0');
  else if (seen === 'seen') where.push('view_count > 0');

  const minRating = Number(query.minRating) || 0;
  if (minRating > 0) {
    where.push('rating >= ?');
    params.push(minRating);
  }

  // 上界：rating:<=2 这类「找差图来重做」的用法
  const maxRating = Number(query.maxRating) || 0;
  if (maxRating > 0) {
    where.push('rating <= ?');
    params.push(maxRating);
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

  // 图片堆叠：默认只列组主（成员在灯箱里展开）。stackId 指定某个堆叠时，
  // 改成「组主 + 该组成员」都能看到，供灯箱的堆叠翻页使用。
  const stackId = Number(query.stackId) || 0;
  if (stackId > 0) {
    where.push('(id = ? OR stack_id = ?)');
    params.push(stackId, stackId);
  } else if (!query.includeStacked) {
    where.push('(stack_id = 0 OR stack_id = id)');
  }

  // 隐私空间：密码锁住且本次会话未解锁的文件夹，其素材从所有列表/搜索里消失（服务端事实，不是前端遮罩）
  const hidden = hiddenImagesClause();
  if (hidden) {
    where.push(hidden.sql);
    params.push(...hidden.params);
  }

  const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { sql, params, colorIds };
}

/**
 * 给一页素材补上「来自文件夹的继承标签」（只读，不写库）。
 * 信息面板要区分直接标签与继承标签，否则用户会以为自己打过却删不掉。
 */
export function attachInheritedTags(items) {
  if (!items || !items.length) return items;
  try {
    const ids = items.map((i) => i.id);
    // 祖先文件夹的标签也算继承（Eagle 的语义是整条路径生效），所以按 path 前缀把
    // 每一级祖先都 join 进来；只取直接父夹会漏掉「父夹打标签、子夹里看图」的常见情况
    const rows = db
      .prepare(
        `SELECT f.image_id AS id, d2.tags AS tags
           FROM image_folders f
           JOIN folders d ON d.id = f.folder_id
           JOIN folders d2 ON d2.path <> '' AND d.path LIKE d2.path || '%'
          WHERE f.image_id IN (${ids.map(() => '?').join(',')}) AND d2.tags <> ''`
      )
      .all(...ids);
    if (!rows.length) {
      for (const it of items) it.inheritedTags = [];
      return items;
    }
    const map = new Map();
    for (const r of rows) {
      const set = map.get(r.id) || new Set();
      for (const t of String(r.tags).split(',')) if (t.trim()) set.add(t.trim());
      map.set(r.id, set);
    }
    for (const it of items) {
      const own = new Set(Array.isArray(it.tags) ? it.tags : []);
      it.inheritedTags = [...(map.get(it.id) || [])].filter((t) => !own.has(t));
    }
  } catch {
    for (const it of items) it.inheritedTags = [];
  }
  return items;
}

/**
 * 只返回命中的 id 列表（配合「全选」）。
 * 前端原本 Ctrl+A 只能选中已加载的那一页，就是因为只能从分页结果里拿 id；
 * 这里直接按同一套筛选条件出 id，避免为了全选去翻几百页。
 */
export function listImageIds(query = {}) {
  const colorIds = query.colorIds || null;
  const colorTable = colorIds && colorIds.length ? createColorScope(colorIds) : '';
  const { sql, params } = buildImageFilter(query, { colorTable });
  // 全选也要有上限：十万级库一次返回 10 万个 id = 1MB+ JSON + 前端 10 万项 Set，
  // 而且用户根本没法真对 10 万张做批量操作。多取一行用来判断「是否被截断」。
  const rows = db
    .prepare(`SELECT id FROM images ${sql} ORDER BY id DESC LIMIT ?`)
    .all(...params, MAX_IDS + 1);
  const truncated = rows.length > MAX_IDS;
  const ids = (truncated ? rows.slice(0, MAX_IDS) : rows).map((r) => r.id);
  const total = truncated
    ? db.prepare(`SELECT COUNT(*) AS c FROM images ${sql}`).get(...params).c
    : ids.length;
  return { ids, total, truncated };
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
      const items = attachStackInfo(attachInheritedTags(pageIds.map((id) => byId.get(id)).filter(Boolean).map(toDTO)));
      return { items, total, page, pageSize, hasMore: page * pageSize < total };
    }

    // 手动排序：只在文件夹视图里有意义（同一张图在不同夹可以有不同顺序）。
    // 没进过手动序的新图 sort_order = 0，排在后面，不会打乱用户已经拖好的顺序。
    let order = SORTS[query.sort] || SORTS.newest;
    const orderParams = [];
    if (query.sort === 'manual') {
      const fid = Number(query.folderId) || 0;
      if (fid) {
        order =
          '(SELECT f.sort_order FROM image_folders f WHERE f.image_id = images.id AND f.folder_id = ?) IS NULL, ' +
          '(SELECT f.sort_order FROM image_folders f WHERE f.image_id = images.id AND f.folder_id = ?) ASC, id DESC';
        orderParams.push(fid, fid);
      } else {
        order = SORTS.newest;
      }
    }
    const total = db.prepare(`SELECT COUNT(*) AS c FROM images ${sql}`).get(...params).c;
    const rows = db
      .prepare(`SELECT * FROM images ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, ...orderParams, pageSize, (page - 1) * pageSize);
    return {
      items: attachStackInfo(attachInheritedTags(rows.map(toDTO))),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  } finally {
    dropColorScope(colorTable);
  }
}
