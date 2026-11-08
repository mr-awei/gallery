/**
 * 旧版单库（<素材目录>/gallery.db）的识别与合并。
 *
 * 背景：v1.1.2 之前，「一个素材目录 = 一个 gallery.db」，多资源库改造后库文件搬到了
 * `<素材目录>/.tuku/lib_xxx/gallery.db`。用户升级后新建/切换资源库时，老库文件没人读，
 * 界面就是「一张图都没有」—— 但文件、标签、文件夹全在盘上。
 *
 * 这里在激活库时做一次自动识别 + 合并（只读老库、先备份、按 abs_path 唯一索引去重），
 * 避免真实用户升级后以为丢图。合并后的缩略图重建由 lib/thumb-rebuild.js 接管。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../db.js';
import { copyLegacyTables } from './legacy-copy.js';

export { copyLegacyTables };

/** 当前连接实际使用的库文件（切库后由 live binding 指向新连接） */
export function currentDbFile() {
  try {
    const rows = db.prepare('PRAGMA database_list').all();
    return rows.find((r) => r.name === 'main')?.file || '';
  } catch {
    return '';
  }
}

/** 素材目录下是否存在「不是当前库」的旧库文件 */
export function findLegacyDb(rootPath) {
  const root = String(rootPath || '').trim();
  if (!root) return '';
  const file = path.join(root, 'gallery.db');
  if (!fs.existsSync(file)) return '';
  const cur = currentDbFile();
  if (cur && path.resolve(cur).toLowerCase() === path.resolve(file).toLowerCase()) return '';
  return file;
}

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/**
 * 检查这个旧库值不值得合并：必须是图库结构、有记录、且绝大多数记录指向这个素材目录
 * （避免把用户随便放在目录里的同名数据库当成自家数据吞掉）。
 */
export function inspectLegacyDb(file, rootPath) {
  let conn;
  try {
    conn = new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const has = Number(
      conn.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'images'").get()?.c || 0
    );
    if (!has) return null;
    const total = Number(conn.prepare('SELECT COUNT(*) AS c FROM images').get()?.c || 0);
    if (!total) return null;
    const sample = conn.prepare('SELECT abs_path FROM images LIMIT 200').all();
    const root = norm(rootPath);
    const inside = sample.filter((r) => norm(r.abs_path).startsWith(root)).length;
    if (sample.length && inside / sample.length < 0.8) return null;
    const folders = Number(
      (() => {
        try {
          return conn.prepare('SELECT COUNT(*) AS c FROM folders').get()?.c || 0;
        } catch {
          return 0;
        }
      })()
    );
    return { total, folders };
  } finally {
    conn.close();
  }
}

function backupLegacy(file, dir) {
  const target = path.join(dir, `legacy-gallery-${Date.now()}.db`);
  fs.mkdirSync(dir, { recursive: true });
  // 老库可能还有未 checkpoint 的 WAL：一起复制，恢复时才不会少最近的记录
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${file}${suffix}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, `${target}${suffix}`);
  }
  return target;
}

/**
 * 把旧库合并进「当前激活的库」。
 * 只在目标库为空时才该调用（有数据的库交给用户手动决定，避免合并出重复记录）。
 * @returns {{ok:boolean, images:number, folders:number, backup:string, error?:string}}
 */
export function mergeLegacyDb(file, { rootPath = '', backupParent = '' } = {}) {
  const info = inspectLegacyDb(file, rootPath);
  if (!info) return { ok: false, images: 0, folders: 0, backup: '', error: '不是本素材目录的旧图库' };

  const before = Number(db.prepare('SELECT COUNT(*) AS c FROM images').get()?.c || 0);
  const backupDir = path.join(backupParent || path.dirname(file), `_recovery-backup-${Date.now()}`);
  let backup;
  try {
    backup = backupLegacy(file, backupDir);
  } catch (err) {
    // 备份失败就不动数据：宁可少一次自动恢复，也不能把唯一的数据源弄坏
    return { ok: false, images: 0, folders: 0, backup: '', error: `旧库备份失败：${err.message}` };
  }

  copyLegacyTables(db, file);

  const after = Number(db.prepare('SELECT COUNT(*) AS c FROM images').get()?.c || 0);
  const images = after - before;
  // 空库合并却一行都没进来 = 结构不兼容（OR IGNORE 把约束错误吞了），必须留痕
  if (before === 0 && info.total > 0 && images === 0) {
    console.warn('[library] 旧库合并没有写入任何记录，可能是表结构不兼容:', file);
  }
  try {
    db.prepare('DELETE FROM image_folders WHERE image_id NOT IN (SELECT id FROM images)').run();
    db.prepare('DELETE FROM clip_vec WHERE image_id NOT IN (SELECT id FROM images)').run();
    db.prepare('DELETE FROM item_tags WHERE image_id NOT IN (SELECT id FROM images)').run();
  } catch {
    /* 附属表不存在时忽略 */
  }
  try {
    db.exec("INSERT INTO images_fts(images_fts) VALUES('rebuild')");
  } catch {
    /* 没有 FTS 表时忽略（搜索会退化成 LIKE） */
  }
  const folders = Number(db.prepare('SELECT COUNT(*) AS c FROM folders').get()?.c || 0);
  return { ok: true, images, folders, backup, legacyTotal: info.total };
}

/**
 * 激活库时的自动识别入口：目标库为空 + 素材目录里有旧库 → 直接合并。
 * 有数据的库不动（合并会引入重复，交给用户决定）。
 */
export function autoMergeLegacy(rootPath, { backupParent = '' } = {}) {
  const file = findLegacyDb(rootPath);
  if (!file) return null;
  const rows = Number(db.prepare('SELECT COUNT(*) AS c FROM images').get()?.c || 0);
  if (rows > 0) return null;
  return { file, ...mergeLegacyDb(file, { rootPath, backupParent }) };
}

/**
 * 合并后的收尾（异步、失败不影响主流程）：
 * - 清掉指向已不存在文件的 thumb（旧库的 thumbs 目录多半跟着老库一起没了）
 * - 补 fs_mtime（前端缩略图/原图 URL 的版本号来源，空值会被强缓存）
 * @returns {Promise<number>} 仍缺缩略图的行数
 */
export async function refreshMergedRows() {
  const rows = db.prepare('SELECT id, abs_path, thumb, fs_mtime FROM images').all();
  const clearThumb = db.prepare("UPDATE images SET thumb = '' WHERE id = ?");
  const setMtime = db.prepare('UPDATE images SET fs_mtime = ? WHERE id = ?');
  let missingThumbs = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let stat = null;
    try {
      stat = fs.statSync(r.abs_path);
    } catch {
      /* 文件不在：留给「清理缺失」处理 */
    }
    let thumb = r.thumb || '';
    if (thumb && !fs.existsSync(thumb)) {
      clearThumb.run(r.id);
      thumb = '';
    }
    if (stat && !Number(r.fs_mtime)) setMtime.run(Math.round(stat.mtimeMs / 1000), r.id);
    if (!thumb) missingThumbs++;
    // 十万级大库别把事件循环按住：每 500 行让出一次
    if (i % 500 === 499) await new Promise((resolve) => setImmediate(resolve));
  }
  return missingThumbs;
}
