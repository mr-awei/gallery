// @ts-check
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { DATA_DIR } from '../config.js';
import { removeThumbFiles } from '../thumbs.js';

/**
 * 编辑撤销（覆盖写回前的原文件备份）
 *
 * 为什么需要：裁切 / 调色 / 增强 / 旋转默认「覆盖原图」，一次误点就是不可逆的
 * 文件重写，既没有回收站兜底也没有版本历史。这里在写回前把原文件复制一份，
 * 并把关键字段一并记下来，撤销时按备份回滚 + 重建缩略图。
 */

const BACKUP_DIR = path.join(DATA_DIR, 'edit-backups');
/** 最多保留的条数 */
const KEEP_COUNT = 200;
/**
 * 备份总体积上限（默认 2GB，可用 TUKU_UNDO_MAX_BYTES 覆盖）。
 * 只按条数淘汰是不够的：200 张 50MB 的 RAW/大图就是 10GB 悄悄躺在数据目录里，
 * 用户只会发现 C 盘莫名其妙满了。
 */
const KEEP_BYTES = Number(process.env.TUKU_UNDO_MAX_BYTES) || 2 * 1024 ** 3;

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/** 淘汰过老的备份（含磁盘文件）：条数与总体积双上限 */
function prune() {
  // 撤销栈与重做栈分开算：重做栈只是「刚才被撤下来的状态」，不该挤掉还能用的撤销步数
  const rows = db
    .prepare('SELECT id, backup_path, prev_size FROM edit_history WHERE undone = 0 ORDER BY id DESC')
    .all();
  const doomed = [];
  let bytes = 0;
  rows.forEach((r, i) => {
    bytes += Number(r.prev_size) || 0;
    // 最新一条永远保留，否则刚编辑完的图立刻就撤不回去了
    if (i >= KEEP_COUNT || (i > 0 && bytes > KEEP_BYTES)) doomed.push(r);
  });
  // 重做栈只留最近一小段：用户连续撤销后重做的窗口通常就是几步
  const redoRows = db
    .prepare('SELECT id, backup_path FROM edit_history WHERE undone = 1 ORDER BY id DESC')
    .all();
  redoRows.forEach((r, i) => {
    if (i >= KEEP_COUNT / 2) doomed.push({ id: r.id, backup_path: r.backup_path });
  });
  if (!doomed.length) return;
  const del = db.prepare('DELETE FROM edit_history WHERE id = ?');
  for (const r of doomed) {
    del.run(r.id);
    // 异步删：同步 rmSync 删几十 MB 的副本时会把整个服务卡住（编辑是热路径）
    fs.promises.rm(r.backup_path, { force: true }).catch(() => {});
  }
}

/** 新的编辑发生后退掉该图的重做栈：再重做回去已经没有意义（会盖掉刚做的编辑） */
function dropRedo(imageId) {
  const rows = db.prepare('SELECT id, backup_path FROM edit_history WHERE image_id = ? AND undone = 1').all(imageId);
  if (!rows.length) return;
  const del = db.prepare('DELETE FROM edit_history WHERE id = ?');
  for (const r of rows) {
    del.run(r.id);
    fs.promises.rm(r.backup_path, { force: true }).catch(() => {});
  }
}

/**
 * 写回前调用：备份当前文件 + 记录可回滚的元数据。
 * 备份失败不阻断编辑本身（宁可允许编辑，也不要因为占盘/权限失败把功能锁死）。
 */
export async function pushEditBackup(row, kind = 'edit') {
  try {
    if (!row?.abs_path) return;
    ensureDir();
    const ext = path.extname(row.abs_path) || '.bin';
    const file = path.join(BACKUP_DIR, `${Date.now()}-${row.id}${ext}`);
    // 异步复制：几十 MB 的相机原图用 copyFileSync 会把整个服务的事件循环按住
    await fsp.copyFile(row.abs_path, file);
    // 有新的编辑，这条分支的重做就作废了（保留会让「重做」把刚做的编辑覆盖掉）
    dropRedo(row.id);
    db.prepare(
      `INSERT INTO edit_history
         (image_id, backup_path, kind, prev_width, prev_height, prev_size, prev_phash, prev_obj_phash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id,
      file,
      kind,
      Number(row.width) || 0,
      Number(row.height) || 0,
      Number(row.size_bytes) || 0,
      row.phash || '',
      row.obj_phash || '',
      new Date().toISOString()
    );
    prune();
  } catch {
    /* 备份失败静默：不影响编辑 */
  }
}

/** 撤销 / 重做栈的深度（给前端显示「还能撤销 N 步」） */
export function undoStatus(imageId) {
  const id = Number(imageId) || 0;
  const one = (undone) =>
    id > 0
      ? Number(
          db.prepare('SELECT COUNT(*) AS n FROM edit_history WHERE image_id = ? AND undone = ?').get(id, undone)?.n || 0
        )
      : Number(db.prepare('SELECT COUNT(*) AS n FROM edit_history WHERE undone = ?').get(undone)?.n || 0);
  return { canUndo: one(0), canRedo: one(1) };
}

/** 最近一次可撤销的编辑（给前端显示「撤销」按钮用） */
export function lastEdit(imageId) {
  const id = Number(imageId) || 0;
  const r =
    id > 0
      ? db
          .prepare(
            `SELECT h.id, h.image_id, h.kind, h.created_at, i.title
               FROM edit_history h LEFT JOIN images i ON i.id = h.image_id
              WHERE h.image_id = ? AND h.undone = 0 ORDER BY h.id DESC LIMIT 1`
          )
          .get(id)
      : db
          .prepare(
            `SELECT h.id, h.image_id, h.kind, h.created_at, i.title
               FROM edit_history h LEFT JOIN images i ON i.id = h.image_id
              WHERE h.undone = 0 ORDER BY h.id DESC LIMIT 1`
          )
          .get();
  return r || null;
}

/**
 * 把一条历史记录里的文件 + 尺寸换回原位，并把「换下去的那份现状」压到对面栈上。
 * undo 时现状进 redo 栈，redo 时现状回 undo 栈 —— 同一份逻辑，方向由 nextUndone 决定。
 * @param {any} h edit_history 行
 * @param {0|1} nextUndone 现状压入哪个栈
 */
async function swapWithBackup(h, nextUndone) {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(h.image_id);
  if (!img) throw new Error('原图记录已不存在');
  if (!fs.existsSync(h.backup_path)) {
    db.prepare('DELETE FROM edit_history WHERE id = ?').run(h.id);
    throw new Error('备份文件已丢失，无法撤销');
  }

  ensureDir();
  // 现状先另存一份再覆盖：没有它，撤销就变成单向不可逆（旧实现正是这么丢的）
  const ext = path.extname(img.abs_path) || '.bin';
  const keep = path.join(BACKUP_DIR, `${Date.now()}-${img.id}-keep${ext}`);
  await fsp.copyFile(img.abs_path, keep);
  db.prepare(
    `INSERT INTO edit_history
       (image_id, backup_path, kind, prev_width, prev_height, prev_size, prev_phash, prev_obj_phash, created_at, undone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    img.id,
    keep,
    h.kind,
    Number(img.width) || 0,
    Number(img.height) || 0,
    Number(img.size_bytes) || 0,
    img.phash || '',
    img.obj_phash || '',
    new Date().toISOString(),
    nextUndone
  );

  // 先把备份复制回原位置（用 copy 而不是 rename：跨盘/权限场景下 rename 会失败）
  await fsp.copyFile(h.backup_path, img.abs_path);
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
  ).run(h.prev_width, h.prev_height, h.prev_size, h.prev_phash, h.prev_obj_phash, fsMtime, img.id);

  // 缩略图必须重建，否则新的 URL 背后还是旧文件
  await removeThumbFiles(img.id, img.thumb).catch(() => {});

  db.prepare('DELETE FROM edit_history WHERE id = ?').run(h.id);
  await fs.promises.rm(h.backup_path, { force: true }).catch(() => {});

  return { id: img.id, kind: h.kind, ...undoStatus(img.id) };
}

/**
 * 撤销一次编辑（可连续撤销，直到栈空）。
 * - 传 imageId：撤销该图最近一次编辑
 * - 不传：撤销全库最近一次编辑
 * 撤销掉的这一步进重做栈，可以再 redoLastEdit 回来。
 */
export async function undoLastEdit(imageId) {
  const id = Number(imageId) || 0;
  const h =
    id > 0
      ? db
          .prepare('SELECT * FROM edit_history WHERE image_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1')
          .get(id)
      : db.prepare('SELECT * FROM edit_history WHERE undone = 0 ORDER BY id DESC LIMIT 1').get();
  if (!h) return { ok: false, reason: '没有可撤销的编辑' };
  const r = await swapWithBackup(h, 1);
  prune();
  return { ok: true, ...r };
}

/** 重做刚撤销的一步（只对同一张图生效，避免把别的图的编辑盖回来） */
export async function redoLastEdit(imageId) {
  const id = Number(imageId) || 0;
  const h =
    id > 0
      ? db
          .prepare('SELECT * FROM edit_history WHERE image_id = ? AND undone = 1 ORDER BY id DESC LIMIT 1')
          .get(id)
      : db.prepare('SELECT * FROM edit_history WHERE undone = 1 ORDER BY id DESC LIMIT 1').get();
  if (!h) return { ok: false, reason: '没有可重做的编辑' };
  const r = await swapWithBackup(h, 0);
  prune();
  return { ok: true, ...r };
}

/** 该图是否还有可撤销的编辑 */
export function hasUndo(imageId) {
  const r = db
    .prepare('SELECT 1 AS x FROM edit_history WHERE image_id = ? AND undone = 0 LIMIT 1')
    .get(Number(imageId));
  return !!r;
}
