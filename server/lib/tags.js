// 标签管理：单一事实来源是 images.tags 逗号串，item_tags 是派生索引（从 library.js 拆出）
import { db } from '../db.js';


/** 列出所有标签及出现次数（用于标签云 / 筛选） */
export function listTags() {
  const counter = new Map();
  for (const row of db.prepare("SELECT tags FROM images WHERE tags <> ''").all()) {
    for (const tag of String(row.tags).split(',')) {
      const t = tag.trim();
      if (t) counter.set(t, (counter.get(t) || 0) + 1);
    }
  }
  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
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
  return rows.length;
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
  return rows.length;
}
