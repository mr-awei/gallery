import path from 'node:path';
import { db, getSettings, withTransaction } from './db.js';

/**
 * 文件夹树：Eagle 式「虚拟树 + 一图多夹」，但导入时按磁盘真实目录自动建树。
 * - folders.path 是物化路径（含自身 id，如 '/1/5/9/'），点父夹聚合后代用前缀 LIKE
 * - anchor_path 记该节点对应的磁盘相对目录（未来供 fs.watch 同步）；纯虚拟夹为空
 * - 一张图可挂到多个文件夹（image_folders 多对多）
 */

/** 相对目录（'白底图/2508季'）→ find-or-create 层级节点，返回叶子 folder id */
export function ensureFolderByRelDir(relDir) {
  if (!relDir) return null;
  const parts = String(relDir).split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  let parentId = null;
  let parentPath = '/';
  let leaf = null;
  const now = new Date().toISOString();
  const find = db.prepare('SELECT id, path FROM folders WHERE name = ? AND parent_id IS ?');
  const insert = db.prepare(
    'INSERT INTO folders(name, parent_id, path, sort_order, anchor_path, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)'
  );
  const setPath = db.prepare('UPDATE folders SET path = ? WHERE id = ?');
  for (const name of parts) {
    const row = find.get(name, parentId);
    if (row) {
      leaf = row.id;
      parentPath = row.path;
      parentId = row.id;
      continue;
    }
    const ins = insert.run(name, parentId, '', '', now, now);
    const id = Number(ins.lastInsertRowid);
    const selfPath = parentPath + id + '/';
    setPath.run(selfPath, id);
    leaf = id;
    parentId = id;
    parentPath = selfPath;
  }
  return leaf;
}

export function linkImageToFolder(imageId, folderId) {
  if (!imageId || !folderId) return;
  db.prepare('INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES (?, ?)').run(imageId, folderId);
}

/** 按图片绝对路径归入文件夹树（相对当前库 root 的目录层级） */
export function linkImageByPath(imageId, absPath, rootPath = getSettings().storageDir) {
  if (!imageId || !absPath || !rootPath) return null;
  const rel = path.relative(rootPath, path.dirname(absPath));
  // 不在 root 下（跨盘 / 采集到别处）→ 归入根，不建子夹
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const folderId = ensureFolderByRelDir(rel);
  if (folderId) linkImageToFolder(imageId, folderId);
  return folderId;
}

/** 返回全部文件夹（含每个夹直接图片数），前端按 parent_id 组装树 */
export function listFolderTree() {
  const folders = db.prepare('SELECT id, name, parent_id, path, anchor_path FROM folders ORDER BY name ASC').all();
  const counts = db.prepare('SELECT folder_id, COUNT(*) AS c FROM image_folders GROUP BY folder_id').all();
  const countMap = new Map(counts.map((r) => [r.folder_id, r.c]));
  return folders.map((f) => ({ ...f, count: countMap.get(f.id) || 0 }));
}

/** 查某文件夹（含全部后代）的图片行（原始行，由调用方转 DTO）。
 *  子夹 id 全部内联进 IN 会在大树上超 SQLite 变量上限（32766）；
 *  改为让子查询直接用 path 前缀 LIKE（idx_folders_path 走索引）。 */
export function folderImageRows(folderId, { page = 1, pageSize = 48 } = {}) {
  const folder = db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId);
  if (!folder) return { rows: [], total: 0, hasMore: false };
  const sub = `SELECT f.image_id FROM image_folders f JOIN folders d ON d.id = f.folder_id WHERE d.path LIKE ?`;
  const like = folder.path + '%';
  const where = `id IN (${sub})`;
  const total = db.prepare(`SELECT COUNT(*) AS c FROM images WHERE ${where}`).get(like).c;
  const rows = db
    .prepare(`SELECT * FROM images WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(like, pageSize, (page - 1) * pageSize);
  return { rows, total, hasMore: page * pageSize < total };
}

/** 一次性回填：为库中已有图片按磁盘目录建树（folders 为空但有图时执行）。
 *  按 id 游标分批（5000/批）扫图，百万库不全表一把梭进内存。 */
export function backfillFolders(rootPath = getSettings().storageDir) {
  const folderCount = db.prepare('SELECT COUNT(*) AS c FROM folders').get().c;
  const imageCount = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
  if (folderCount > 0 || imageCount === 0) return { folders: folderCount, linked: 0 };
  const batch = db.prepare('SELECT id, abs_path FROM images WHERE id > ? ORDER BY id LIMIT 5000');
  let linked = 0;
  let lastId = 0;
  withTransaction(() => {
    for (;;) {
      const rows = batch.all(lastId);
      if (!rows.length) break;
      for (const r of rows) {
        if (linkImageByPath(r.id, r.abs_path, rootPath)) linked++;
      }
      lastId = rows[rows.length - 1].id;
    }
  });
  return { folders: db.prepare('SELECT COUNT(*) AS c FROM folders').get().c, linked };
}

/* ------------------------- 虚拟文件夹管理（Eagle 式，不碰磁盘） ------------------------- */
/* 磁盘目录同步产生的夹有 anchor_path；纯虚拟夹 anchor_path 为空。二者在树里共存，
 * 一张图可同时归属多个文件夹（image_folders 多对多），删除文件夹不删除图片。 */

/** 新建虚拟文件夹，parentId 为 null 表示根级。返回新夹 id */
export function createVirtualFolder(name, parentId = null) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('文件夹名称不能为空');
  const now = new Date().toISOString();
  let parentPath = '/';
  if (parentId != null) {
    const p = db.prepare('SELECT path FROM folders WHERE id = ?').get(parentId);
    if (!p) throw new Error('父文件夹不存在');
    parentPath = p.path;
  }
  const ins = db
    .prepare(
      'INSERT INTO folders(name, parent_id, path, sort_order, anchor_path, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)'
    )
    .run(nm, parentId ?? null, '', '', now, now);
  const id = Number(ins.lastInsertRowid);
  db.prepare('UPDATE folders SET path = ? WHERE id = ?').run(parentPath + id + '/', id);
  return id;
}

/** 重命名文件夹（虚拟夹与磁盘夹均可） */
export function renameFolder(id, name) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('文件夹名称不能为空');
  const r = db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(nm, new Date().toISOString(), id);
  if (!r.changes) throw new Error('文件夹不存在');
}

/** 删除文件夹及其全部子夹（级联），不删除任何图片，只解除关联 */
export function deleteFolder(id) {
  const f = db.prepare('SELECT path FROM folders WHERE id = ?').get(id);
  if (!f) throw new Error('文件夹不存在');
  // 大树（几千个子夹）时把 id 全捞出来内联进 IN 会超变量上限；直接用 path 前缀删
  const like = f.path + '%';
  const count = db.prepare('SELECT COUNT(*) AS c FROM folders WHERE path LIKE ?').get(like).c;
  db.prepare('DELETE FROM image_folders WHERE folder_id IN (SELECT id FROM folders WHERE path LIKE ?)').run(like);
  db.prepare('DELETE FROM folders WHERE path LIKE ?').run(like);
  return count;
}

/** 把一批图片加入某个文件夹（一图可多夹；返回实际新增的关联数） */
export function addImagesToFolder(folderId, imageIds = []) {
  const f = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
  if (!f) throw new Error('文件夹不存在');
  const ins = db.prepare('INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES (?, ?)');
  let added = 0;
  withTransaction(() => {
    for (const iid of imageIds) {
      if (ins.run(Number(iid), folderId).changes) added++;
    }
  });
  return added;
}

/** 把一批图片从某个文件夹移除（不影响图片本身，也不影响其他文件夹归属） */
export function removeImagesFromFolder(folderId, imageIds = []) {
  const del = db.prepare('DELETE FROM image_folders WHERE folder_id = ? AND image_id = ?');
  let removed = 0;
  withTransaction(() => {
    for (const iid of imageIds) {
      removed += del.run(folderId, Number(iid)).changes;
    }
  });
  return removed;
}
