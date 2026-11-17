// @ts-check
import crypto from 'node:crypto';
import { globalDb, getActiveLibrary } from '../db.js';

/**
 * 资源库密码锁（每个库各自一把锁）。
 *
 * 边界必须先说清楚：这是**访问口令**，不是磁盘加密。
 * - 校验在服务端：锁着的库，除解锁 / 切库 / 读设置这几条，其余 /api 请求一律 423，
 *   前端拿不到任何图片、文件夹、统计 —— 别人打开软件看不到内容。
 * - gallery.db 与缩略图**没有加密**：把库目录整个拷走，用别的工具仍能读出来。
 *   node:sqlite 不支持 SQLCipher，做真加密得整库解密到临时文件，崩溃丢数据的风险更大，
 *   所以这里不假装是磁盘加密（文案、README 都按「密码锁」写）。
 * - 只存 scrypt 哈希 + 随机盐，明文不落库；忘记密码只能在磁盘上删库解锁（不可逆是对的）。
 * - 解锁状态在进程内存里：重启应用回到锁定态；切到别的库会清空（库之间 id 会撞）。
 */

/** 本次会话已解锁的库 id（重启即失效） */
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

function libRow(id) {
  return globalDb
    .prepare('SELECT id, name, path, lock_hash, lock_salt FROM libraries WHERE id = ?')
    .get(Number(id));
}

/** 前端可见的锁状态：有密码吗、现在锁着吗（哈希永不出库） */
export function libraryLockState(id) {
  const l = libRow(id);
  if (!l) return { exists: false, hasPassword: false, locked: false, name: '' };
  return {
    exists: true,
    hasPassword: !!l.lock_hash,
    locked: !!l.lock_hash && !unlocked.has(l.id),
    name: l.name || '',
  };
}

/** 校验密码：正确返回 true（不改解锁状态） */
export function verifyLibraryPassword(id, password) {
  const l = libRow(id);
  if (!l || !l.lock_hash) return false;
  try {
    return safeEqual(l.lock_hash, hash(password, l.lock_salt));
  } catch {
    return false;
  }
}

/** 给库设密码（已有密码时必须提供原密码，避免别人顺手改掉）；设完当前会话直接解锁 */
export function setLibraryPassword(id, password, oldPassword = '') {
  const l = libRow(id);
  if (!l) throw new Error('资源库不存在');
  const pwd = String(password || '');
  if (pwd.length < 4) throw new Error('密码至少 4 位');
  if (l.lock_hash && !verifyLibraryPassword(id, oldPassword)) throw new Error('原密码不正确');
  const salt = crypto.randomBytes(16).toString('hex');
  globalDb.prepare('UPDATE libraries SET lock_hash = ?, lock_salt = ? WHERE id = ?').run(hash(pwd, salt), salt, l.id);
  unlocked.add(l.id);
  return { id: l.id, hasPassword: true, locked: false };
}

/** 解锁（本次会话内可用）；密码错误抛错 */
export function unlockLibrary(id, password) {
  const l = libRow(id);
  if (!l) throw new Error('资源库不存在');
  if (!l.lock_hash) {
    unlocked.add(l.id);
    return { id: l.id, hasPassword: false, locked: false };
  }
  if (!verifyLibraryPassword(id, password)) throw new Error('密码不正确');
  unlocked.add(l.id);
  return { id: l.id, hasPassword: true, locked: false };
}

/** 立刻重新锁上（不删密码） */
export function sealLibrary(id) {
  const l = libRow(id);
  if (!l) throw new Error('资源库不存在');
  unlocked.delete(l.id);
  return { id: l.id, hasPassword: !!l.lock_hash, locked: !!l.lock_hash };
}

/** 移除密码（必须验证原密码） */
export function clearLibraryPassword(id, password) {
  const l = libRow(id);
  if (!l) throw new Error('资源库不存在');
  if (l.lock_hash && !verifyLibraryPassword(id, password)) throw new Error('密码不正确');
  globalDb.prepare("UPDATE libraries SET lock_hash = '', lock_salt = '' WHERE id = ?").run(l.id);
  unlocked.delete(l.id);
  return { id: l.id, hasPassword: false, locked: false };
}

/** 切库时清空（解锁态是按库 id 记的） */
export function resetLibraryLock() {
  unlocked.clear();
}

/** 切库通过了密码校验：把目标库记成本次会话已解锁 */
export function markLibraryUnlocked(id) {
  unlocked.add(Number(id));
}

/**
 * 锁定态下的「白名单」：解锁 / 切库 / 设密码 / 读设置 必须还能用，
 * 否则用户连输密码的界面都拿不到数据。其余 /api 一律 423。
 */
const LOCK_ALLOW = [
  /^\/libraries$/,
  /^\/libraries\/\d+\/(unlock|activate|lock)$/,
  /^\/libraries\/\d+\/password$/,
  /^\/health$/,
  /^\/events$/,
];

/**
 * Express 中间件：当前激活库已加密且本次会话没解锁 → 拦掉所有业务接口。
 * 挂在 `app.use('/api', ...)` 上，req.path 是不含 /api 的相对路径。
 */
export function libraryLockGate(req, res, next) {
  const lib = getActiveLibrary();
  if (!lib) return next();
  const state = libraryLockState(lib.id);
  if (!state.locked) return next();
  if (req.method === 'GET' && req.path === '/settings') return next(); // 锁屏要读主题/语言
  if (LOCK_ALLOW.some((re) => re.test(req.path))) return next();
  res.status(423).json({
    error: '这个资源库已加锁：先输入密码解锁',
    code: 'library_locked',
    activeLibraryLocked: true, // 前端据此把整页切到解锁界面（切库缺密码的 423 不带这个标记）
    libraryId: lib.id,
    libraryName: state.name,
  });
}

/** 当前激活库是否处于锁定态（SSE 等非 HTTP 通道据此静音） */
export function isActiveLibraryLocked() {
  const lib = getActiveLibrary();
  if (!lib) return false;
  return libraryLockState(lib.id).locked;
}
