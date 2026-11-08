// 版本历史：edit_history 里每行是一份「编辑前」的原图备份。
// 撤销（undo）只会消费最新一条；这里把同一张图的历史全部摊开，允许回到任意一版，
// 并且「回到旧版」本身也先压一份当前的备份，所以回退同样可以再撤销。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as lib from '../library.js';
import { db } from '../db.js';
import { pushEditBackup } from './undo.js';
import { removeThumbFiles } from '../thumbs.js';

const KIND_LABEL = {
  edit: '编辑',
  crop: '裁切',
  adjust: '调色',
  annotate: '标注',
  换大图: '换大图',
  restore: '恢复版本',
  rotate: '旋转',
  enhance: '增强',
};

function humanSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function listVersions(imageId) {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(Number(imageId));
  if (!img) throw new Error('图片不存在');
  const rows = db
    .prepare(
      `SELECT id, backup_path, kind, prev_width, prev_height, prev_size, created_at
         FROM edit_history WHERE image_id = ? ORDER BY id DESC`
    )
    .all(Number(imageId));
  const versions = rows.map((r) => ({
    // 版本号用历史 id：稳定、可寻址
    id: r.id,
    label: KIND_LABEL[r.kind] || r.kind,
    width: r.prev_width,
    height: r.prev_height,
    size: r.prev_size,
    sizeLabel: humanSize(r.prev_size),
    createdAt: r.created_at,
    missing: !fs.existsSync(r.backup_path),
    current: false,
  }));
  return {
    id: img.id,
    title: img.title,
    current: {
      label: '当前版本',
      width: img.width,
      height: img.height,
      size: img.size_bytes,
      sizeLabel: humanSize(img.size_bytes),
      current: true,
      missing: !img.abs_path || !fs.existsSync(img.abs_path),
    },
    versions,
  };
}

export function versionFile(imageId, versionId) {
  const row = db
    .prepare('SELECT * FROM edit_history WHERE id = ? AND image_id = ?')
    .get(Number(versionId), Number(imageId));
  if (!row) return null;
  if (!fs.existsSync(row.backup_path)) return null;
  return { file: row.backup_path, kind: row.kind };
}

export async function restoreVersion(imageId, versionId) {
  const id = Number(imageId);
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!img) throw new Error('图片不存在');
  const row = db
    .prepare('SELECT * FROM edit_history WHERE id = ? AND image_id = ?')
    .get(Number(versionId), id);
  if (!row) throw new Error('这个版本不存在（可能已被撤销清理）');
  if (!fs.existsSync(row.backup_path)) throw new Error('备份文件已丢失，无法恢复这个版本');
  if (!img.abs_path) throw new Error('原文件记录缺失');

  // 先把「现在」存一份，保证恢复旧版也能撤销
  await pushEditBackup(img, 'restore');
  await fsp.copyFile(row.backup_path, img.abs_path);

  let fsMtime = Number(img.fs_mtime || 0) + 1;
  try {
    const st = await fsp.stat(img.abs_path);
    fsMtime = Math.max(Math.round(st.mtimeMs / 1000), fsMtime);
  } catch {
    /* 用递增兜底 */
  }
  db.prepare(
    `UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ?, obj_phash = ?,
       fs_mtime = ?, cover_ver = cover_ver + 1, thumb = '' WHERE id = ?`
  ).run(row.prev_width, row.prev_height, row.prev_size, row.prev_phash, row.prev_obj_phash, fsMtime, id);
  await removeThumbFiles(id, img.thumb).catch(() => {});
  return { ok: true, id, restored: row.id, item: lib.toDTO(lib.getImage(id)) };
}

export function versionExt(file) {
  const e = path.extname(file || '').toLowerCase();
  return e || '.jpg';
}
