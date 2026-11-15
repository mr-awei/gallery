import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, GLOBAL_DB_FILE, DATA_DIR, THUMB_DIR, DEFAULT_STORAGE_DIR } from './config.js';
import { createPathIndex } from './db/schema.js';
import { initLibrarySchema } from './db/migrate.js';
import { resetSettingsCache, seedLibrarySettings } from './db/settings.js';

/* ------------------------------------------------------------------ *
 *  多资源库数据分层
 *  - global.db：settings（跨库共享的应用偏好）+ libraries 注册表
 *  - 每个库一个 gallery.db：images + 库内所有业务表
 *  `db` 是 live binding（export let），切换库后所有 `import { db }` 的
 *  模块下次访问都会读到新连接；切库统一走 setActiveLibrary()。
 *
 *  本文件只负责「打开连接 + 迁移编排 + 再导出」，具体职责已按下述边界拆分：
 *  - server/db/schema-sql.js 建表 / 索引 / 触发器 DDL 原文
 *  - server/db/schema.js     建表执行 + 逐列补列 + 索引补建 + 存量回填
 *  - server/db/migrate.js    版本化迁移、升级前备份、迁移事务编排
 *  - server/db/settings.js   默认值、设置读写（含跨库共享键）、库设置播种
 *  - server/db/state.js      结构告警 / abs_path 唯一索引健康度（可读状态）
 * ------------------------------------------------------------------ */

/* ------------------------------- 连接准备 ------------------------------- */

/** 连接级 pragma（busy_timeout / WAL / synchronous），每个连接都要设一遍 */
function applyPragmas(conn) {
  // 应用是双进程（Electron 主进程 + node server）共用库，启动时可能同时初始化，
  // 遇到锁应自动等待而不是直接抛 database is locked
  conn.exec('PRAGMA busy_timeout = 8000;');
  // journal_mode 切换需要瞬时独占锁；双进程同时启动时仍可能撞上，重试几次
  for (let attempt = 0; ; attempt++) {
    try {
      conn.exec('PRAGMA journal_mode = WAL;');
      break;
    } catch (err) {
      if (attempt >= 10 || !String(err?.message || '').includes('locked')) throw err;
      const wait = 300 * (attempt + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait); // 同步等待
    }
  }
  // WAL 下 NORMAL 是标准配置：提交不再逐次强制 fsync，断电最多丢最后几笔写入，不会损坏数据库
  conn.exec('PRAGMA synchronous = NORMAL;');
}

/* ------------------------------- 全局库 ------------------------------- */

export const globalDb = new DatabaseSync(GLOBAL_DB_FILE);
applyPragmas(globalDb);
globalDb.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 资源库注册表：每个库是一个自包含目录（内含 gallery.db / thumbs / library.json）
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,        -- 库目录绝对路径
  root_path TEXT NOT NULL DEFAULT '', -- 库挂载的素材根目录（桌面端壁纸库文件夹）
  thumb_dir TEXT NOT NULL DEFAULT '', -- 该库缩略图目录（默认库沿用历史 storage/thumbs）
  created_at TEXT NOT NULL,
  last_opened TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 0,
  import_pending INTEGER NOT NULL DEFAULT 0,  -- 1 = 上次扫描未完成，重启后要继续
  lock_hash TEXT NOT NULL DEFAULT '',        -- 库密码（scrypt 哈希，空 = 未加锁）
  lock_salt TEXT NOT NULL DEFAULT ''         -- 哈希用的随机盐
);
`);
// 存量库迁移：libraries 表的多库字段是分批加的，老全局库缺列时
// 启动查询直接报 no such column 导致服务起不来（listen 回调抛错）。
{
  const ensureLibColumn = (column, ddl) => {
    const cols = globalDb.prepare('PRAGMA table_info(libraries)').all();
    if (!cols.some((c) => c.name === column)) {
      globalDb.exec(`ALTER TABLE libraries ADD COLUMN ${ddl}`);
    }
  };
  ensureLibColumn('root_path', "root_path TEXT NOT NULL DEFAULT ''");
  ensureLibColumn('thumb_dir', "thumb_dir TEXT NOT NULL DEFAULT ''");
  ensureLibColumn('last_opened', "last_opened TEXT NOT NULL DEFAULT ''");
  ensureLibColumn('is_active', 'is_active INTEGER NOT NULL DEFAULT 0');
  ensureLibColumn('import_pending', 'import_pending INTEGER NOT NULL DEFAULT 0');
  ensureLibColumn('lock_hash', "lock_hash TEXT NOT NULL DEFAULT ''");
  ensureLibColumn('lock_salt', "lock_salt TEXT NOT NULL DEFAULT ''");
}

/* ------------------------------- 库连接 ------------------------------- */

/** 建（或补建）abs_path 唯一索引；重复清干净后可由界面触发重试 */
export function retryPathIndex() {
  return createPathIndex(db);
}

/** 打开（或新建）一个库连接并完成其 schema 初始化 */
export function openLibrary(dbFile) {
  const conn = new DatabaseSync(dbFile);
  applyPragmas(conn);
  initLibrarySchema(conn);
  seedLibrarySettings(conn);
  return conn;
}

/**
 * 当前库连接（live binding：切库后所有 import 方读到新连接）。
 * node:sqlite 的行是运行时动态结构，见 lib/db-handle.d.ts：只放宽这一处边界，
 * server/lib 里其余 JSDoc 全部由 tsconfig.server.json 真检查。
 * @type {import('./lib/db-handle.js').DbHandle}
 */
export let db = openLibrary(DB_FILE);

// 当前激活库元信息（内存缓存，切库时更新）
let activeLibrary = null;

/**
 * 库切换代数。`db` 是 live binding，导入这类跨 await 的长任务会在中途读到新库的连接 ——
 * 于是「A 库在导入时切到 B 库」会把 A 的图片写进 B 的 gallery.db（前端表现为
 * B 库的仪表盘/图库不断冒出 A 的图片）。长任务在开始时记下代数，写库前比对，
 * 代数变了就说明自己已经不是在给当初那个库干活，应当中止。
 */
let libraryGeneration = 0;

export function getLibraryGeneration() {
  return libraryGeneration;
}

export function getActiveLibrary() {
  return activeLibrary;
}

/** 切换当前库连接（仅切换 DB 与元信息；storageDir 同步 / 监听重挂由 libraries.js 负责） */
export function setActiveLibrary(lib) {
  const next = openLibrary(path.join(lib.path, 'gallery.db'));
  // 关闭旧连接，避免文件句柄泄漏（Windows 上占用句柄会导致库目录删不掉）
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
  db = next;
  activeLibrary = lib;
  libraryGeneration++;
  resetSettingsCache(); // storageDir 随库变化，失效缓存
}

/** 当前库缩略图目录（默认库沿用历史 storage/thumbs；新建库在库内 thumbs/） */
export function getThumbDir() {
  return activeLibrary?.thumb_dir || THUMB_DIR;
}

/* ------------------------------- 事务 ------------------------------- */

let savepointSeq = 0;

/**
 * 可嵌套事务（SAVEPOINT 实现）。
 *
 * 旧实现靠「BEGIN 抛异常」推断是否已在事务内 —— SQLITE_BUSY 同样会抛错，
 * 繁忙时被误判成嵌套 → 既不 COMMIT 也不 ROLLBACK，最需要保护的场景反而没有事务。
 * 而 node:sqlite 不暴露 autocommit 状态，无法可靠探测。
 *
 * SAVEPOINT 在事务内外都合法：最外层 RELEASE 即提交，内层 ROLLBACK TO 只回滚自己，
 * 所以既能正确嵌套，也不会因为「判断嵌套」失败而静默丢事务。
 */
export function withTransaction(fn) {
  const name = `tuku_sp_${(savepointSeq = (savepointSeq + 1) % 1e9)}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      /* 连接失效或 SQLite 已自动回滚：忽略，保留原始错误 */
    }
    throw err;
  }
}

/* ------------------------------- 默认库初始化 ------------------------------- */

/**
 * 把旧单库（gallery.db）里的 settings 迁到 global.db，并登记默认库。
 * 幂等：只在 libraries 为空时执行一次。
 */
function ensureDefaultLibrary() {
  const hasLib = globalDb.prepare('SELECT COUNT(*) AS c FROM libraries').get().c;
  if (hasLib > 0) return;

  // 1) 迁移旧 settings：旧版 settings 表在库 DB 里，读出来写进 globalDb（globalDb 空才写）
  const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if (legacyTable) {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    for (const r of rows) {
      globalDb
        .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
        .run(r.key, r.value);
    }
    // 迁移完成，清空库内 settings 行避免双份来源。
    // 注意保留空表：连接还开着，且设置已改为按库存储（getSettings 会查这张表）
    try {
      db.exec('DELETE FROM settings');
    } catch (err) {
      // 一次性迁移：清不掉旧 settings 不致命，但静默会让人误以为双份来源已被清
      console.warn('[db] 迁移后清空旧 settings 失败（可忽略，不影响启动）：', err?.message || err);
    }
    // 再把迁移到 global.db 的非全局键播种回默认库——设置分库后，
    // 默认库的第一份配置就来自这次迁移的结果（其他库在各自首次打开时播种）
    seedLibrarySettings(db);
  }

  // 2) 登记默认库（沿用历史 DATA_DIR/gallery.db + storage/thumbs）
  const rootPath = (() => {
    try {
      const row = globalDb.prepare("SELECT value FROM settings WHERE key='storageDir'").get();
      if (row) return String(JSON.parse(row.value));
    } catch (err) {
      // 读不到 storageDir 就退回默认路径，但别静默 —— 用户改了存储位置却没生效会很困惑
      console.warn('[db] 读取 storageDir 失败，回退默认路径：', err?.message || err);
    }
    return DEFAULT_STORAGE_DIR;
  })();
  const now = new Date().toISOString();
  // 老库升级时可能已经有别的库在册：默认库不得把别人的激活状态顶掉
  const others = globalDb.prepare('SELECT COUNT(*) AS c FROM libraries').get().c;
  globalDb
    .prepare(
      `INSERT INTO libraries(name, path, root_path, thumb_dir, created_at, last_opened, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run('默认图库', DATA_DIR, rootPath, THUMB_DIR, now, now, others > 0 ? 0 : 1);
}

/* ------------------------------- keywords ------------------------------- */

export function listKeywords() {
  return db.prepare('SELECT * FROM keywords ORDER BY id ASC').all();
}

export function addKeyword(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('关键词不能为空');
  const exists = db.prepare('SELECT id FROM keywords WHERE text = ?').get(value);
  if (exists) return exists.id;
  const info = db
    .prepare('INSERT INTO keywords(text, enabled, created_at) VALUES (?, 1, ?)')
    .run(value, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function updateKeyword(id, patch) {
  const fields = [];
  const values = [];
  if (patch.text !== undefined) {
    fields.push('text = ?');
    values.push(String(patch.text).trim());
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE keywords SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteKeyword(id) {
  db.prepare('DELETE FROM keywords WHERE id = ?').run(id);
}

// seedDefaults() 已删除：DEFAULT_KEYWORDS 是空数组，这个函数永远是空操作。

/* ------------------------------- 启动初始化 ------------------------------- */

ensureDefaultLibrary();
/**
 * 恢复上次激活的资源库。
 * 这里必须真的把 `db` 切到那个库的 gallery.db —— 只改 activeLibrary 元信息的话，
 * 重启后 db 仍指向默认库，而缩略图目录 / storageDir 却来自上次激活的库：
 * 启动扫描会把图片整批写进默认库（用户看到「上次导入的图莫名出现在默认图库、
 * 原库里的图永远缺缩略图」），后续所有读写也都落到错的库上。
 */
{
  const active =
    globalDb.prepare('SELECT * FROM libraries WHERE is_active = 1').get() ||
    globalDb.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get();
  if (active && path.resolve(active.path) !== path.resolve(DATA_DIR)) {
    const next = openLibrary(path.join(active.path, 'gallery.db'));
    // 关掉默认库连接，避免白白占着一个句柄（Windows 上会导致库目录删不掉）
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    db = next;
  }
  if (active) activeLibrary = active;
}

/* ------------------------------- 再导出 ------------------------------- */

// 以下导出仍是旧 db.js 的公开面，签名与行为不变，只是实现在 server/db/ 下。
export { getSchemaWarnings, getPathIndexState } from './db/state.js';
export { DEFAULT_SETTINGS, getSettings, saveSettings } from './db/settings.js';
