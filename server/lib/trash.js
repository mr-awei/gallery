// 删除图片 / 应用内回收站 / 文件重命名 / 清空图库：文件移动与库记录联动的单一出处（从 library.js 拆出）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, getSettings } from '../db.js';
import * as clip from '../clip.js';
import { invalidateQuality } from '../quality.js';
import {
  clearPhashIndex,
  ensureThumb,
  getImage,
  indexPhash,
  isManagedPath,
  removePhash,
  toDTO,
} from '../library.js';

/**
 * 回收站目录：放在被删文件「同目录下」的 trash 子文件夹，
 * 这样与源文件同盘，rename 不会因跨盘而报 EXDEV（图库常放在与软件不同的磁盘/分区上）。
 */
function trashDirFor(absPath) {
  const dir = path.dirname(absPath || '');
  const t = path.join(dir || '.', 'trash');
  try {
    fs.mkdirSync(t, { recursive: true });
  } catch {
    /* 创建失败交给上层 rename 报错 */
  }
  return t;
}

/**
 * 删除图片。默认策略 trash：把文件移动到应用内回收站（同盘移动，可一键恢复）
 * @returns {{ok:boolean, error?:string}}
 */
export async function removeImage(id, { reason = '' } = {}) {
  const row = getImage(id);
  if (!row) return { ok: false, error: '图片不存在' };
  await fsp.rm(row.thumb, { force: true }).catch(() => {});

  const settings = getSettings();
  const policy = settings.deletePolicy || 'trash';
  let fileError = null;

  if (isManagedPath(row.abs_path, settings) && fs.existsSync(row.abs_path)) {
    if (policy === 'trash') {
      try {
        await moveToAppTrash(row, reason);
      } catch (err) {
        fileError = `移到回收站失败：${err.message}`;
      }
    } else if (policy === 'permanent') {
      try {
        await fsp.rm(row.abs_path, { force: true });
      } catch (err) {
        fileError = `删除文件失败：${err.message}`;
      }
    }
    // unlink：仅移出图库，保留文件
  }

  if (fileError) return { ok: false, error: fileError };
  db.prepare('DELETE FROM images WHERE id = ?').run(id);
  removePhash(id);
  clip.deleteEmbedding(id);
  invalidateQuality(id);
  return { ok: true };
}

async function moveToAppTrash(row, reason) {
  const base = path.basename(row.abs_path);
  const trashDir = trashDirFor(row.abs_path);
  let target = path.join(trashDir, base);
  if (fs.existsSync(target)) target = path.join(trashDir, `${Date.now().toString(36)}_${base}`);
  await fsp.rename(row.abs_path, target);
  db.prepare(
    `INSERT INTO trash(image_id, title, origin_path, trash_path, source, keyword, width, height,
      size_bytes, mime, phash, tags, favorite, reason, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id,
    row.title,
    row.abs_path,
    target,
    row.source,
    row.keyword,
    row.width,
    row.height,
    row.size_bytes,
    row.mime,
    row.phash,
    row.tags,
    row.favorite,
    reason,
    new Date().toISOString()
  );
}

/* ------------------------------- 应用内回收站 ------------------------------ */

export function listTrash() {
  return db
    .prepare('SELECT * FROM trash ORDER BY id DESC')
    .all()
    .map((r) => ({
      id: r.id,
      imageId: r.image_id,
      title: r.title,
      originPath: r.origin_path,
      trashPath: r.trash_path,
      source: r.source,
      keyword: r.keyword,
      width: r.width,
      height: r.height,
      sizeBytes: r.size_bytes,
      phash: r.phash,
      reason: r.reason,
      deletedAt: r.deleted_at,
    }));
}

export async function restoreFromTrash(id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
  if (!row) throw new Error('回收站记录不存在');
  if (!fs.existsSync(row.trash_path)) throw new Error('回收站里的文件已丢失');
  let target = row.origin_path;
  if (fs.existsSync(target)) {
    target = target.replace(/(\.\w+)$/, `_恢复${Date.now().toString(36)}$1`);
  }
  await fsp.rename(row.trash_path, target);
  const info = db
    .prepare(
      `INSERT INTO images(title, abs_path, thumb, source, keyword, source_url, width, height,
        size_bytes, mime, phash, favorite, tags, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      row.title,
      target,
      null,
      row.source,
      row.keyword,
      '',
      row.width,
      row.height,
      row.size_bytes,
      row.mime,
      row.phash,
      row.favorite,
      row.tags,
      new Date().toISOString()
    );
  const newId = Number(info.lastInsertRowid);
  if (row.phash) indexPhash(newId, row.phash);
  const thumb = await ensureThumb(newId, target);
  if (thumb) db.prepare('UPDATE images SET thumb = ? WHERE id = ?').run(thumb, newId);
  db.prepare('DELETE FROM trash WHERE id = ?').run(id);
  return toDTO(getImage(newId));
}

export async function deleteTrashItem(id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
  if (!row) return false;
  await fsp.rm(row.trash_path, { force: true }).catch(() => {});
  db.prepare('DELETE FROM trash WHERE id = ?').run(id);
  return true;
}

export async function emptyTrash() {
  const rows = db.prepare('SELECT * FROM trash').all();
  for (const row of rows) await fsp.rm(row.trash_path, { force: true }).catch(() => {});
  db.prepare('DELETE FROM trash').run();
  return rows.length;
}

/** 重命名磁盘文件并同步标题（壁纸库文件夹管理） */
export async function renameImage(id, title) {
  const row = getImage(id);
  if (!row) throw new Error('图片不存在');
  const clean = String(title || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim();
  if (!clean) throw new Error('名称不能为空');
  const ext = path.extname(row.abs_path) || '.jpg';
  const base = clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : clean + ext;
  const target = path.join(path.dirname(row.abs_path), base);
  if (target !== row.abs_path) {
    if (fs.existsSync(target)) throw new Error('该文件夹下已存在同名文件');
    await fsp.rename(row.abs_path, target);
  }
  db.prepare('UPDATE images SET abs_path = ?, title = ? WHERE id = ?').run(target, base, id);
  return toDTO(getImage(id));
}

/** 清空图库：文件移入应用内回收站，仍可恢复 */
export function clearLibrary() {
  const rows = db.prepare('SELECT * FROM images').all();
  const settings = getSettings();
  const insert = db.prepare(
    `INSERT INTO trash(image_id, title, origin_path, trash_path, source, keyword, width, height,
      size_bytes, mime, phash, tags, favorite, reason, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const row of rows) {
    if (row.thumb) fs.rmSync(row.thumb, { force: true });
    if (isManagedPath(row.abs_path, settings) && fs.existsSync(row.abs_path)) {
      const base = path.basename(row.abs_path);
      const trashDir = trashDirFor(row.abs_path);
      let target = path.join(trashDir, base);
      if (fs.existsSync(target)) target = path.join(trashDir, `${Date.now().toString(36)}_${base}`);
      try {
        fs.renameSync(row.abs_path, target);
        insert.run(
          row.id,
          row.title,
          row.abs_path,
          target,
          row.source,
          row.keyword,
          row.width,
          row.height,
          row.size_bytes,
          row.mime,
          row.phash,
          row.tags,
          row.favorite,
          '清空图库',
          new Date().toISOString()
        );
      } catch (err) {
        console.error('[trash] 清空图库时移动失败', row.abs_path, err.message);
      }
    }
  }
  db.prepare('DELETE FROM images').run();
  clearPhashIndex();
  return rows.length;
}
