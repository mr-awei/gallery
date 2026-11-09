// @ts-check
// 删除图片 / 应用内回收站 / 文件重命名 / 清空图库：文件移动与库记录联动的单一出处（从 library.js 拆出）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, getSettings, withTransaction } from '../db.js';
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
import { kindOfPath } from './media-kind.js';

/** 删除前把整行 images 快照塞进回收站：恢复时才能还原全部列（见 restoreFromTrash） */
function snapshotOf(row) {
  try {
    return JSON.stringify(row || {});
  } catch {
    return '';
  }
}

function parseSnapshot(raw) {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {}; // 旧记录 / 损坏快照：退回按回收站表自身的字段恢复
  }
}

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
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function removeImage(id, { reason = '' } = {}) {
  const row = getImage(id);
  if (!row) return { ok: false, error: '图片不存在' };
  // 缩略图只是缓存：清不掉不影响删除结果，但不能一声不吭 —— 排查「磁盘越用越大」时要能对上账
  await fsp.rm(row.thumb, { force: true }).catch((err) => {
    console.warn('[trash] 缩略图清理失败（不影响删除）', row.thumb, err?.message || err);
  });

  const settings = getSettings();
  const policy = settings.deletePolicy || 'trash';
  let fileError = null;
  /** 本次搬到回收站后的实际路径：记录删不掉时要能搬回去 */
  let movedTo = null;

  if (isManagedPath(row.abs_path, settings) && fs.existsSync(row.abs_path)) {
    if (policy === 'trash') {
      try {
        movedTo = await moveToAppTrash(row, reason);
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
  try {
    withTransaction(() => {
      db.prepare('DELETE FROM images WHERE id = ?').run(id);
    });
  } catch (err) {
    // 记录没删掉：文件必须搬回原位，否则就是「文件走了、记录还在」的半删除态
    if (movedTo) {
      await fsp.rename(movedTo, row.abs_path).catch(() => {});
      try {
        db.prepare('DELETE FROM trash WHERE trash_path = ?').run(movedTo);
      } catch {
        /* 回收站行留在原地，至少文件已回去 */
      }
    }
    return { ok: false, error: `删除记录失败：${err.message}` };
  }
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
  try {
    withTransaction(() => {
      db.prepare(
        `INSERT INTO trash(image_id, title, origin_path, trash_path, source, keyword, width, height,
          size_bytes, mime, phash, tags, favorite, reason, deleted_at, snapshot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        new Date().toISOString(),
        snapshotOf(row)
      );
    });
  } catch (err) {
    // 回收站记录没写成功：把文件搬回原位，别让用户既看不到图也找不到文件
    await fsp.rename(target, row.abs_path).catch(() => {});
    throw err;
  }
  return target;
}

/* ------------------------------- 应用内回收站 ------------------------------ */

/**
 * 回收站列表。
 * 不传分页参数时保持旧行为（返回全部数组）；传了 limit/offset 就只取这一页并带总数，
 * 免得回收站里堆了几万条时每次打开都要把整表读出来再序列化。
 */
export function listTrash(opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 0));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const q = String(opts.q || '').trim();

  if (!limit) {
    return db
      .prepare('SELECT * FROM trash ORDER BY id DESC')
      .all()
      .map(toTrashDTO);
  }

  const where = q ? 'WHERE title LIKE ? OR reason LIKE ? OR origin_path LIKE ?' : '';
  const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM trash ${where}`).get(...args)?.n || 0);
  const items = db
    .prepare(`SELECT * FROM trash ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
    .map(toTrashDTO);
  return { items, total };
}

function toTrashDTO(r) {
  return {
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
  };
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
  let newId;
  try {
    // 入库与清回收站记录必须在同一个事务里：以前是先 rename 再 INSERT，
    // INSERT 一抛错文件已回原位、回收站行却还指着不存在的路径，第二次恢复必失败。
    newId = withTransaction(() => {
      // 快照里带着删除前的整行（media_kind / duration / cover_ts / rating / note / md5…）。
      // 只按回收站表的 15 个字段恢复，视频会变回 image、评分备注丢失、fs_mtime=0
      // 让 ?v=0 的缩略图 URL 永远命中旧缓存。这里按「当前 images 表实际存在的列」取值，
      // 旧回收站记录（没有 snapshot）仍走回收站表的字段兜底。
      const snap = parseSnapshot(row.snapshot);
      const tableCols = new Set(db.prepare('PRAGMA table_info(images)').all().map((c) => c.name));
      const stat = fs.statSync(target);
      const next = {
        title: row.title,
        source: row.source,
        keyword: row.keyword,
        width: row.width,
        height: row.height,
        size_bytes: row.size_bytes,
        mime: row.mime,
        phash: row.phash,
        favorite: row.favorite,
        tags: row.tags,
        ...snap,
        // 这三列必须按恢复现场定，不能照抄快照（id 由数据库重新分配）
        abs_path: target,
        thumb: null,
        fs_mtime: Math.round(stat.mtimeMs / 1000),
      };
      if (!next.media_kind) next.media_kind = kindOfPath(target); // 老记录：按扩展名补回类型
      if (!next.created_at) next.created_at = new Date().toISOString();
      const cols = Object.keys(next).filter((k) => k !== 'id' && tableCols.has(k));
      const info = db
        .prepare(
          `INSERT INTO images(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`
        )
        .run(...cols.map((k) => next[k]));
      db.prepare('DELETE FROM trash WHERE id = ?').run(id);
      return Number(info.lastInsertRowid);
    });
  } catch (err) {
    // 记录没写成：把文件放回回收站，保持记录与文件仍然一致
    await fsp.rename(target, row.trash_path).catch(() => {});
    throw err;
  }
  if (row.phash) indexPhash(newId, row.phash);
  // 还原拿到的是新的 id，同 id 的旧缓存（旧库/旧行残留）必须先清掉再生成
  const thumb = await ensureThumb(newId, target, { force: true });
  if (thumb) db.prepare('UPDATE images SET thumb = ? WHERE id = ?').run(thumb, newId);
  return toDTO(getImage(newId));
}

/**
 * 彻底删除回收站里的一项。
 * 文件删不掉时**不能**删记录：否则文件永远留在 trash 目录，界面上也再没有入口去清它。
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function deleteTrashItem(id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
  if (!row) return { ok: false, error: '回收站记录不存在' };
  try {
    await fsp.rm(row.trash_path, { force: true });
  } catch (err) {
    const message = String(err?.message || err);
    console.error('[trash] 彻底删除失败，保留记录以便重试：', row.trash_path, message);
    return { ok: false, error: `删除文件失败：${message}` };
  }
  db.prepare('DELETE FROM trash WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * 清空回收站。删不掉的项保留记录并单独返回，不再「吞掉错误后整表 DELETE」。
 * @returns {Promise<{ removed: number, failed: Array<{ id: number, path: string, error: string }> }>}
 */
export async function emptyTrash() {
  const rows = db.prepare('SELECT * FROM trash').all();
  const failed = [];
  let removed = 0;
  for (const row of rows) {
    try {
      await fsp.rm(row.trash_path, { force: true });
      db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
      removed++;
    } catch (err) {
      failed.push({ id: row.id, path: row.trash_path, error: String(err?.message || err) });
    }
  }
  if (failed.length) {
    console.error(`[trash] 清空回收站有 ${failed.length} 个文件没删掉，记录已保留以便重试`);
  }
  return { removed, failed };
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

/**
 * 清空图库：文件移入应用内回收站，仍可恢复。
 *
 * 关键约束：**移动失败的那一行必须留在图库里**。
 * 过去的写法是失败只打日志、循环结束后无条件 DELETE FROM images ——
 * 文件还在磁盘上、记录却被抹掉，既不在图库也不在回收站，用户无从恢复。
 * @returns {Promise<{removed:number, failed:Array<{id:number, path:string, error:string}>}>}
 */
export async function clearLibrary() {
  const rows = db.prepare('SELECT * FROM images').all();
  const settings = getSettings();
  const insert = db.prepare(
    `INSERT INTO trash(image_id, title, origin_path, trash_path, source, keyword, width, height,
      size_bytes, mime, phash, tags, favorite, reason, deleted_at, snapshot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const del = db.prepare('DELETE FROM images WHERE id = ?');
  const cleared = [];
  const failed = [];
  const now = new Date().toISOString();

  const exists = (p) =>
    fsp
      .access(p)
      .then(() => true)
      .catch(() => false);

  // 异步搬文件：以前同步 rename 遍历全库，大库清空时整个服务（含界面请求）都卡住
  for (const row of rows) {
    const managed = isManagedPath(row.abs_path, settings) && (await exists(row.abs_path));
    if (managed) {
      const base = path.basename(row.abs_path);
      const trashDir = trashDirFor(row.abs_path);
      let target = path.join(trashDir, base);
      if (await exists(target)) target = path.join(trashDir, `${Date.now().toString(36)}_${base}`);
      try {
        await fsp.rename(row.abs_path, target);
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
          now,
          snapshotOf(row)
        );
      } catch (err) {
        console.error('[trash] 清空图库时移动失败', row.abs_path, err.message);
        failed.push({ id: row.id, path: row.abs_path, error: err.message });
        continue; // 记录保留：文件还在，用户仍能在图库里看到它
      }
    }
    cleared.push(row);
  }

  // 只删除确认已搬进回收站的记录，且一次性事务提交
  withTransaction(() => {
    for (const row of cleared) del.run(row.id);
  });

  let thumbCleanupFailed = 0;
  for (const row of cleared) {
    if (row.thumb) {
      await fsp.rm(row.thumb, { force: true }).catch(() => {
        thumbCleanupFailed++;
      });
    }
    clip.deleteEmbedding(row.id);
    invalidateQuality(row.id);
    // 有失败项时索引不能整表清空，逐个摘掉已删除的 id
    if (failed.length) removePhash(row.id);
  }
  if (!failed.length) clearPhashIndex();
  if (thumbCleanupFailed) {
    console.warn(`[trash] 清空图库时有 ${thumbCleanupFailed} 张缩略图没删掉（缓存，可重建）`);
  }

  return { removed: cleared.length, failed };
}
