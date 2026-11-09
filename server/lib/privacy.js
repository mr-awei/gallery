// @ts-check
import crypto from 'node:crypto';
import { db } from '../db.js';

/**
 * 隐私空间 / 文件夹密码锁。
 *
 * 设计要点：
 * - 只存 scrypt 哈希 + 随机盐，明文密码永不落库；忘记密码只能从磁盘上删库解锁（不可逆是对的）。
 * - 「锁定」是服务端事实，不是前端遮罩：加锁文件夹（含子夹）里的素材从所有列表、搜索、
 *   统计查询里被排除，直到本次会话内验证过密码。
 * - 解锁状态存在进程内存里：重启应用即回到锁定态；切库自动清空（库之间 id 会撞）。
 */

/** 本次会话已解锁的文件夹 id（重启即失效） */
const unlocked = new Set();

const SCRYPT_KEYLEN = 64;

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function folderRow(folderId) {
  return db
    .prepare('SELECT id, name, path, lock_hash, lock_salt FROM folders WHERE id = ?')
    .get(Number(folderId));
}

/** 已加锁且本次会话未解锁的文件夹（含名称/路径，供前端展示隐私空间入口） */
export function lockedFolders() {
  return db
    .prepare("SELECT id, name, path FROM folders WHERE lock_hash <> '' ORDER BY name ASC")
    .all()
    .map((f) => ({ ...f, unlocked: unlocked.has(f.id) }));
}

/** 给文件夹加密码（已有密码时要求提供旧密码，避免别人顺手改掉） */
export function setFolderPassword(folderId, password, oldPassword = '') {
  const f = folderRow(folderId);
  if (!f) throw new Error('文件夹不存在');
  const pwd = String(password || '');
  if (pwd.length < 4) throw new Error('密码至少 4 位');
  if (f.lock_hash && !verifyFolderPassword(folderId, oldPassword)) throw new Error('原密码不正确');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE folders SET lock_hash = ?, lock_salt = ?, updated_at = ? WHERE id = ?').run(
    hash(pwd, salt),
    salt,
    new Date().toISOString(),
    f.id
  );
  unlocked.add(f.id); // 刚设的密码，当前会话直接可见，免得自己都被挡在外面
  return { id: f.id, locked: true, unlocked: true };
}

/** 校验密码：正确返回 true（不改解锁状态） */
export function verifyFolderPassword(folderId, password) {
  const f = folderRow(folderId);
  if (!f || !f.lock_hash) return false;
  try {
    return safeEqual(f.lock_hash, hash(password, f.lock_salt));
  } catch {
    return false;
  }
}

/** 解锁（本次会话内可见）；密码错误抛错 */
export function unlockFolder(folderId, password) {
  const f = folderRow(folderId);
  if (!f) throw new Error('文件夹不存在');
  if (!f.lock_hash) return { id: f.id, unlocked: true, locked: false };
  if (!verifyFolderPassword(f.id, password)) throw new Error('密码不正确');
  unlocked.add(f.id);
  return { id: f.id, unlocked: true, locked: true };
}

/** 立刻重新锁上（不删密码），用于离开隐私文件夹时手动上锁 */
export function sealFolder(folderId) {
  const f = folderRow(folderId);
  if (!f) throw new Error('文件夹不存在');
  unlocked.delete(f.id);
  return { id: f.id, unlocked: false, locked: !!f.lock_hash };
}

/** 移除密码（必须验证旧密码）；同时把夹从解锁集合里摘掉 */
export function clearFolderPassword(folderId, password) {
  const f = folderRow(folderId);
  if (!f) throw new Error('文件夹不存在');
  if (f.lock_hash && !verifyFolderPassword(f.id, password)) throw new Error('密码不正确');
  db.prepare("UPDATE folders SET lock_hash = '', lock_salt = '', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    f.id
  );
  unlocked.delete(f.id);
  return { id: f.id, locked: false, unlocked: false };
}

/**
 * 生成「排除隐私素材」的 WHERE 片段。
 * 用 path 前缀子查询一次盖住整个子树（比把子孙 id 全列进 IN 更稳，也不受变量上限约束）。
 * 没有锁定文件夹时返回 null —— 普通用户零成本，不影响百万级查询。
 */
export function hiddenImagesClause() {
  const rows = db
    .prepare("SELECT id, path FROM folders WHERE lock_hash <> ''")
    .all()
    .filter((f) => !unlocked.has(f.id));
  if (!rows.length) return null;
  const parts = rows.map(
    () =>
      'images.id NOT IN (SELECT xif.image_id FROM image_folders xif JOIN folders xf ON xf.id = xif.folder_id WHERE xf.path LIKE ?)'
  );
  return { sql: `(${parts.join(' AND ')})`, params: rows.map((r) => `${r.path}%`) };
}

/** 被锁且本次会话未解锁的文件夹路径（含其后代）——给导出、图片列表之外的场景复用 */
export function hiddenFolderPaths() {
  return db
    .prepare("SELECT id, path FROM folders WHERE lock_hash <> ''")
    .all()
    .filter((f) => !unlocked.has(f.id))
    .map((f) => f.path);
}

/** 该文件夹（含后代）当前是否对查询可见 */
export function isFolderVisible(folderId) {
  const f = db.prepare('SELECT id, path, lock_hash FROM folders WHERE id = ?').get(Number(folderId));
  if (!f) return false;
  if (!f.lock_hash) {
    // 自己没有锁，但祖先可能被锁了
    const lockedAncestor = db
      .prepare("SELECT id FROM folders WHERE lock_hash <> '' AND ? LIKE path || '%'")
      .get(`${f.path}%`);
    return !lockedAncestor || unlocked.has(lockedAncestor.id);
  }
  return unlocked.has(f.id);
}

/** 切库 / 退出登录时清空（文件夹 id 在不同库里会撞） */
export function resetPrivacy() {
  unlocked.clear();
}
