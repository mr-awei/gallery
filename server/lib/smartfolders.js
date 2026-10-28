// 智能文件夹：基于规则匹配的虚拟视图，可把 autoTags 一次性继承到命中图片（从 library.js 拆出）
import { db } from '../db.js';
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

/** 判断一张图是否命中智能文件夹的规则 */
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

/** 预览智能文件夹命中的图片（按评分/时间排序） */
export function previewSmartFolder(id, limit = 200) {
  const f = getSmartFolder(id);
  if (!f) throw new Error('智能文件夹不存在');
  const rows = db.prepare('SELECT * FROM images').all();
  const matched = rows.filter((r) => matchSmartFolder(r, f.rules));
  const sorted = matched
    .sort((a, b) => (b.score ?? 100) - (a.score ?? 100) || b.id - a.id)
    .slice(0, limit);
  return { folder: f, total: matched.length, items: sorted.map(toDTO) };
}

/** 文件夹标签继承：把该智能文件夹的 autoTags 应用到所有命中图片（一次性同步） */
export function applySmartFolderTags(id) {
  const f = getSmartFolder(id);
  if (!f) throw new Error('智能文件夹不存在');
  const autoTags = f.autoTags;
  if (!autoTags.length) return 0;
  const rows = db.prepare('SELECT * FROM images').all();
  let changed = 0;
  const stmt = db.prepare('UPDATE images SET tags = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!matchSmartFolder(r, f.rules)) continue;
      const set = new Set(splitTags(r.tags));
      autoTags.forEach((t) => set.add(String(t).trim()));
      stmt.run([...set].join(','), r.id);
      changed++;
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('COMMIT');
  return changed;
}
