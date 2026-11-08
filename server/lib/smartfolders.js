// 智能文件夹：基于规则匹配的虚拟视图，可把 autoTags 一次性继承到命中图片（从 library.js 拆出）
import { db, withTransaction } from '../db.js';
import { toDTO } from '../library.js';
import { splitTags, joinTags, safeParse, aiDescText } from './utils.js';


export function listSmartFolders() {
  return db
    .prepare('SELECT * FROM smart_folders ORDER BY updated_at DESC')
    .all()
    .map((f) => ({ ...f, rules: safeParse(f.rules, {}), autoTags: splitTags(f.auto_tags) }));
}

export function getSmartFolder(id) {
  const f = db.prepare('SELECT * FROM smart_folders WHERE id = ?').get(id);
  if (!f) return null;
  return { ...f, rules: safeParse(f.rules, {}), autoTags: splitTags(f.auto_tags) };
}

export function createSmartFolder({ name, rules = {}, autoTags = [] }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('智能文件夹名称不能为空');
  const now = new Date().toISOString();
  try {
    db.prepare(
      'INSERT INTO smart_folders(name, rules, auto_tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(n, JSON.stringify(rules || {}), joinTags(autoTags), now, now);
  } catch {
    throw new Error('已存在同名智能文件夹');
  }
  return listSmartFolders();
}

export function updateSmartFolder(id, patch = {}) {
  const f = getSmartFolder(id);
  if (!f) throw new Error('智能文件夹不存在');
  const now = new Date().toISOString();
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new Error('名称不能为空');
    db.prepare('UPDATE smart_folders SET name = ?, updated_at = ? WHERE id = ?').run(n, now, id);
  }
  if (patch.rules !== undefined) {
    db.prepare('UPDATE smart_folders SET rules = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(patch.rules || {}),
      now,
      id
    );
  }
  if (patch.autoTags !== undefined) {
    db.prepare('UPDATE smart_folders SET auto_tags = ?, updated_at = ? WHERE id = ?').run(
      joinTags(patch.autoTags),
      now,
      id
    );
  }
  return listSmartFolders();
}

export function deleteSmartFolder(id) {
  db.prepare('DELETE FROM smart_folders WHERE id = ?').run(id);
  return listSmartFolders();
}

/** LIKE 里的通配符转义（标签/关键词里出现 % _ 时不能当通配符用） */
function likeArg(s) {
  return `%${String(s).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * 把规则编译成 SQL 条件。
 *
 * 为什么不用「SELECT * FROM images 全取回来再 JS 过滤」：
 * 百万级库这么做等于把整库读进内存、逐行跑 JS（原来还会对每行再查一次 ai_desc），
 * 点一下智能夹就是几秒到几十秒的主进程卡死。规则本身都是可直接下推的条件。
 * matchSmartFolder（单行判断）保留给「导入后即时判断」这类小批量场景。
 */
export function buildSmartFolderWhere(rules = {}) {
  const where = [];
  const params = [];
  if (rules.favorite === 'yes') where.push('favorite = 1');
  if (rules.favorite === 'no') where.push('favorite = 0');
  if (Number(rules.minRating) > 0) {
    where.push('COALESCE(rating, 0) >= ?');
    params.push(Number(rules.minRating));
  }
  if (Number(rules.minScore) > 0) {
    where.push('COALESCE(score, 100) >= ?');
    params.push(Number(rules.minScore));
  }
  if (Number(rules.minWidth) > 0) {
    where.push('MAX(COALESCE(width, 0), COALESCE(height, 0)) >= ?');
    params.push(Number(rules.minWidth));
  }
  if (rules.orientation === 'landscape') where.push('width > height * 1.15');
  if (rules.orientation === 'portrait') where.push('width > 0 AND height > width * 1.15');
  if (rules.orientation === 'square') where.push('width > 0 AND ABS(width - height) <= width * 0.15');
  for (const t of Array.isArray(rules.tagsInclude) ? rules.tagsInclude : []) {
    const tag = String(t).trim();
    if (!tag) continue;
    where.push("(',' || COALESCE(tags, '') || ',') LIKE ? ESCAPE '\\'");
    params.push(likeArg(`,${tag},`));
  }
  for (const t of Array.isArray(rules.tagsExclude) ? rules.tagsExclude : []) {
    const tag = String(t).trim();
    if (!tag) continue;
    where.push("(',' || COALESCE(tags, '') || ',') NOT LIKE ? ESCAPE '\\'");
    params.push(likeArg(`,${tag},`));
  }
  for (const k of Array.isArray(rules.keywords) ? rules.keywords : []) {
    const kw = String(k).trim().toLowerCase();
    if (!kw) continue;
    where.push(
      "(lower(COALESCE(title,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(tags,'')) LIKE ? ESCAPE '\\' " +
        "OR lower(COALESCE(keyword,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(note,'')) LIKE ? ESCAPE '\\')"
    );
    params.push(likeArg(kw), likeArg(kw), likeArg(kw), likeArg(kw));
  }
  // AI 描述：一次子查询搞定，不再逐行 aiDescText（原来是 N+1 查询）
  for (const k of Array.isArray(rules.aiKeywords) ? rules.aiKeywords : []) {
    const kw = String(k).trim().toLowerCase();
    if (!kw) continue;
    where.push(
      "id IN (SELECT image_id FROM ai_desc WHERE lower(COALESCE(description,'')) LIKE ? ESCAPE '\\')"
    );
    params.push(likeArg(kw));
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** 判断一张图是否命中智能文件夹的规则（单行判断，语义与 buildSmartFolderWhere 保持一致） */
export function matchSmartFolder(row, rules = {}) {
  if (rules.favorite === 'yes' && row.favorite !== 1) return false;
  if (rules.favorite === 'no' && row.favorite === 1) return false;
  if (rules.minRating && (row.rating || 0) < rules.minRating) return false;
  if (rules.minScore && (row.score ?? 100) < rules.minScore) return false;
  if (rules.minWidth && Math.max(row.width || 0, row.height || 0) < rules.minWidth) return false;
  if (rules.orientation === 'landscape' && !(row.width > (row.height || 0) * 1.15)) return false;
  if (rules.orientation === 'portrait' && !((row.width || 0) > 0 && row.height > row.width * 1.15)) return false;
  if (rules.orientation === 'square' && Math.abs((row.width || 0) - (row.height || 0)) > (row.width || 1) * 0.15)
    return false;
  if (Array.isArray(rules.tagsInclude) && rules.tagsInclude.length) {
    const tags = splitTags(row.tags);
    if (!rules.tagsInclude.every((t) => tags.includes(String(t).trim()))) return false;
  }
  if (Array.isArray(rules.tagsExclude) && rules.tagsExclude.length) {
    const tags = splitTags(row.tags);
    if (rules.tagsExclude.some((t) => tags.includes(String(t).trim()))) return false;
  }
  if (Array.isArray(rules.keywords) && rules.keywords.length) {
    const hay = `${row.title} ${row.tags} ${row.keyword} ${row.note}`.toLowerCase();
    if (!rules.keywords.every((k) => hay.includes(String(k).toLowerCase()))) return false;
  }
  if (Array.isArray(rules.aiKeywords) && rules.aiKeywords.length) {
    const desc = (aiDescText(row.id) || '').toLowerCase();
    if (!rules.aiKeywords.every((k) => desc.includes(String(k).toLowerCase()))) return false;
  }
  return true;
}

/** 预览智能文件夹命中的图片（按评分倒序，分页） */
export function previewSmartFolder(id, limit = 200, offset = 0) {
  const f = getSmartFolder(id);
  if (!f) throw new Error('智能文件夹不存在');
  const { sql, params } = buildSmartFolderWhere(f.rules);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM images ${sql}`).get(...params).c;
  const lim = Math.min(2000, Math.max(1, Math.floor(Number(limit) || 200)));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = db
    .prepare(
      `SELECT * FROM images ${sql} ORDER BY COALESCE(score, 100) DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, lim, off);
  return { folder: f, total, items: rows.map(toDTO), limit: lim, offset: off };
}

/** 文件夹标签继承：把该智能文件夹的 autoTags 应用到所有命中图片（一次性同步） */
export function applySmartFolderTags(id) {
  const f = getSmartFolder(id);
  if (!f) throw new Error('智能文件夹不存在');
  const autoTags = f.autoTags;
  if (!autoTags.length) return 0;
  // 只取命中行的 id+tags：不再把整库读进内存
  const { sql, params } = buildSmartFolderWhere(f.rules);
  const rows = db.prepare(`SELECT id, tags FROM images ${sql}`).all(...params);
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  // withTransaction（SAVEPOINT）可与外层事务嵌套；裸 BEGIN 在嵌套时会直接抛错，
  // 内层 ROLLBACK 还会把外层已写入的内容一起回滚。
  return withTransaction(() => {
    let changed = 0;
    for (const r of rows) {
      const set = new Set(splitTags(r.tags));
      autoTags.forEach((t) => set.add(String(t).trim()));
      stmt.run([...set].join(','), r.id);
      changed++;
    }
    return changed;
  });
}
