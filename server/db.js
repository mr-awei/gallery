import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, GLOBAL_DB_FILE, DATA_DIR, THUMB_DIR, DEFAULT_STORAGE_DIR } from './config.js';
import { encryptSecret, decryptSecret } from './secret.js';

/* ------------------------------------------------------------------ *
 *  多资源库数据分层
 *  - global.db：settings（跨库共享的应用偏好）+ libraries 注册表
 *  - 每个库一个 gallery.db：images + 库内所有业务表
 *  `db` 是 live binding（export let），切换库后所有 `import { db }` 的
 *  模块下次访问都会读到新连接；切库统一走 setActiveLibrary()。
 * ------------------------------------------------------------------ */

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
  import_pending INTEGER NOT NULL DEFAULT 0   -- 1 = 上次扫描未完成，重启后要继续
);
`);

/* ------------------------------- 库连接 ------------------------------- */

/** 库内建表 + 触发器 + 结构迁移。对每个打开的库连接执行一遍。 */
function initLibrarySchema(conn) {
  conn.exec(`
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  abs_path TEXT NOT NULL,
  thumb TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  keyword TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  phash TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  viewed_at TEXT NOT NULL DEFAULT '',
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_source ON images(source);
CREATE INDEX IF NOT EXISTS idx_images_path ON images(abs_path);
CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  created_at TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  ai_analysis TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kb_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 12,
  hits INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'user',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  origin_path TEXT NOT NULL,
  trash_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  phash TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE(playlist_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_playlist_items ON playlist_items(playlist_id);

CREATE TABLE IF NOT EXISTS tidy_skip (
  recommend_id INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS wallpaper_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  scope TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_desc (
  image_id INTEGER PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  issues TEXT NOT NULL DEFAULT '',
  quality INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clip_vec (
  image_id INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS image_quality (
  image_id INTEGER PRIMARY KEY,
  sharpness REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallpaper_fit (
  image_id INTEGER PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 60,
  safe_area TEXT NOT NULL DEFAULT 'center',
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'local',
  brightness INTEGER,
  likes INTEGER NOT NULL DEFAULT 0,
  dislikes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS smart_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  rules TEXT NOT NULL DEFAULT '{}',
  auto_tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 标签倒排表：tags 列是逗号串，LIKE '%x%' 无法走索引（每次筛选全表扫）。
-- 这里拆成一行一 tag，触发器自动同步（含绕过应用层的直接 SQL 写入），查询走主键索引。
CREATE TABLE IF NOT EXISTS item_tags (
  tag TEXT NOT NULL,
  image_id INTEGER NOT NULL,
  PRIMARY KEY (tag, image_id)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_image ON item_tags(image_id);

-- 文件夹树：物化路径（path 含自身 id），点父夹聚合后代用前缀 LIKE 走索引
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  path TEXT NOT NULL DEFAULT '',       -- 祖先路径 + 自身 id，如 '/1/5/9/'
  sort_order INTEGER NOT NULL DEFAULT 0,
  anchor_path TEXT NOT NULL DEFAULT '', -- 对应磁盘目录相对路径；纯虚拟夹为空
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(path);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- 图 ↔ 文件夹 多对多（一张图可属多个文件夹，Eagle 式一图多夹）
CREATE TABLE IF NOT EXISTS image_folders (
  image_id INTEGER NOT NULL,
  folder_id INTEGER NOT NULL,
  PRIMARY KEY (image_id, folder_id)
);
CREATE INDEX IF NOT EXISTS idx_image_folders_folder ON image_folders(folder_id);
`);

  // 触发器依赖的拆分/清理函数（必须在任何写入前注册）。
  // 注意：闭包必须捕获「注册它的连接 conn」而非 live `db` —— 切库后旧连接的
  // 触发器仍应操作旧连接，否则会把数据写进新库。
  conn.function('sync_item_tags', (id, tagsStr) => {
    const tags = String(tagsStr || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    conn.prepare('DELETE FROM item_tags WHERE image_id = ?').run(id);
    const ins = conn.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
    for (const t of tags) ins.run(t, id);
  });
  conn.function('delete_item_tags', (id) => {
    conn.prepare('DELETE FROM item_tags WHERE image_id = ?').run(id);
  });
  conn.exec(`
CREATE TRIGGER IF NOT EXISTS trg_item_tags_insert AFTER INSERT ON images BEGIN
  SELECT sync_item_tags(NEW.id, NEW.tags);
END;
CREATE TRIGGER IF NOT EXISTS trg_item_tags_update AFTER UPDATE OF tags ON images BEGIN
  SELECT sync_item_tags(NEW.id, NEW.tags);
END;
CREATE TRIGGER IF NOT EXISTS trg_item_tags_delete AFTER DELETE ON images BEGIN
  SELECT delete_item_tags(OLD.id);
END;
`);

  // ---- 结构迁移（对当前连接执行，等价旧版顶层 ensureColumn）----
  const ensureColumn = (table, column, ddl) => {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  ensureColumn('images', 'score', 'score INTEGER NOT NULL DEFAULT 100');
  ensureColumn('images', 'score_reason', "score_reason TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_score ON images(score)');
  ensureColumn('images', 'viewed_at', "viewed_at TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'view_count', 'view_count INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_viewed ON images(view_count)');
  ensureColumn('images', 'rating', 'rating INTEGER NOT NULL DEFAULT 0');
  ensureColumn('images', 'note', "note TEXT NOT NULL DEFAULT ''");
  // 文件指纹（mtime 秒）：导入时据此跳过内容未变的文件，让二次扫描接近零成本
  ensureColumn('images', 'fs_mtime', 'fs_mtime INTEGER NOT NULL DEFAULT 0');
  ensureColumn('images', 'dominant', "dominant TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'hue', "hue TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'palette', "palette TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_rating ON images(rating)');
  ensureColumn('images', 'pref', 'pref INTEGER NOT NULL DEFAULT 50');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_pref ON images(pref)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_hue ON images(hue)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_palette ON images(palette)');

  // hue 由单列整数改为多值文本（逗号分隔，最多 3 个色系；空串 = 黑白灰）。
  {
    const hueCol = conn.prepare("SELECT name, type FROM pragma_table_info('images') WHERE name='hue'").get();
    if (hueCol && /INT/i.test(hueCol.type || '')) {
      conn.exec("ALTER TABLE images ADD COLUMN hue_txt TEXT NOT NULL DEFAULT ''");
      conn.exec("UPDATE images SET hue_txt = CASE WHEN hue IS NULL OR hue < 0 THEN '' ELSE CAST(hue AS TEXT) END");
      conn.exec('DROP INDEX IF EXISTS idx_images_hue');
      try {
        conn.exec('ALTER TABLE images DROP COLUMN hue');
        conn.exec('ALTER TABLE images RENAME COLUMN hue_txt TO hue');
      } catch {
        try { conn.exec('ALTER TABLE images RENAME COLUMN hue TO hue_old'); } catch {}
        try { conn.exec('ALTER TABLE images RENAME COLUMN hue_txt TO hue'); } catch {}
      }
      conn.exec('CREATE INDEX IF NOT EXISTS idx_images_hue ON images(hue)');
    }
  }

  // 倒排表空但 images 有标签时（老库首次升级）一次性重建
  const need = conn.prepare("SELECT count(*) c FROM images WHERE tags <> ''").get().c;
  const have = conn.prepare('SELECT count(DISTINCT image_id) c FROM item_tags').get().c;
  if (need > 0 && have === 0) {
    conn.prepare('DELETE FROM item_tags').run();
    const rows = conn.prepare("SELECT id, tags FROM images WHERE tags <> ''").all();
    const ins = conn.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
    for (const r of rows) {
      for (const t of String(r.tags).split(',')) {
        const tag = t.trim();
        if (tag) ins.run(tag, r.id);
      }
    }
  }

  // FTS5 全文索引（trigram 中文子串匹配）：>=3 字查询走索引；短词（1-2 字）由查询层回退 LIKE
  try {
    conn.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(title, tags, keyword, note, tokenize='trigram')"
    );
    conn.exec(`
CREATE TRIGGER IF NOT EXISTS trg_fts_insert AFTER INSERT ON images BEGIN
  INSERT INTO images_fts(rowid, title, tags, keyword, note) VALUES (NEW.id, NEW.title, NEW.tags, NEW.keyword, NEW.note);
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_delete AFTER DELETE ON images BEGIN
  DELETE FROM images_fts WHERE rowid = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_update AFTER UPDATE OF title, tags, keyword, note ON images BEGIN
  DELETE FROM images_fts WHERE rowid = OLD.id;
  INSERT INTO images_fts(rowid, title, tags, keyword, note) VALUES (NEW.id, NEW.title, NEW.tags, NEW.keyword, NEW.note);
END;
`);
    // 存量库迁移：旧触发器用 FTS5 'delete' 命令语法（INSERT INTO images_fts(images_fts,...)
    // VALUES ('delete', ...)），本 node:sqlite 版本对常规 FTS5 表稳定报 SQL logic error ——
    // 表现为删除图片 / 修改标题标签时整个语句失败。检测到旧写法就 DROP 并按新版重建
    // （CREATE TRIGGER IF NOT EXISTS 对已存在的旧触发器不会生效，必须显式升级）。
    const isLegacyFtsTrigger = (name) => {
      const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
      return Boolean(row && /'delete'/i.test(row.sql));
    };
    if (isLegacyFtsTrigger('trg_fts_insert') || isLegacyFtsTrigger('trg_fts_delete') || isLegacyFtsTrigger('trg_fts_update')) {
      conn.exec('DROP TRIGGER IF EXISTS trg_fts_insert; DROP TRIGGER IF EXISTS trg_fts_delete; DROP TRIGGER IF EXISTS trg_fts_update;');
      conn.exec(`
CREATE TRIGGER trg_fts_insert AFTER INSERT ON images BEGIN
  INSERT INTO images_fts(rowid, title, tags, keyword, note) VALUES (NEW.id, NEW.title, NEW.tags, NEW.keyword, NEW.note);
END;
CREATE TRIGGER trg_fts_delete AFTER DELETE ON images BEGIN
  DELETE FROM images_fts WHERE rowid = OLD.id;
END;
CREATE TRIGGER trg_fts_update AFTER UPDATE OF title, tags, keyword, note ON images BEGIN
  DELETE FROM images_fts WHERE rowid = OLD.id;
  INSERT INTO images_fts(rowid, title, tags, keyword, note) VALUES (NEW.id, NEW.title, NEW.tags, NEW.keyword, NEW.note);
END;`);
    }
    // 回填：FTS 空但 images 有数据时（老库首次升级）一次性构建
    const ftsCount = conn.prepare('SELECT COUNT(*) AS c FROM images_fts').get().c;
    const imgCount = conn.prepare('SELECT COUNT(*) AS c FROM images').get().c;
    if (ftsCount === 0 && imgCount > 0) {
      conn.exec(
        'INSERT INTO images_fts(rowid, title, tags, keyword, note) SELECT id, title, tags, keyword, note FROM images'
      );
    }
  } catch (err) {
    console.error('[fts] FTS5 初始化失败（搜索退回 LIKE）:', err?.message || err);
  }
}

/** 打开（或新建）一个库连接并完成其 schema 初始化 */
export function openLibrary(dbFile) {
  const conn = new DatabaseSync(dbFile);
  applyPragmas(conn);
  initLibrarySchema(conn);
  return conn;
}

/** 当前库连接（live binding：切库后所有 import 方读到新连接） */
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
  settingsCache = null; // storageDir 随库变化，失效缓存
}

/** 当前库缩略图目录（默认库沿用历史 storage/thumbs；新建库在库内 thumbs/） */
export function getThumbDir() {
  return activeLibrary?.thumb_dir || THUMB_DIR;
}

/* ------------------------------- 迁移 ------------------------------- */

/** 可嵌套事务：已在事务内则直接执行（由外层提交），否则自行 BEGIN/COMMIT */
export function withTransaction(fn) {
  let own = false;
  try {
    db.exec('BEGIN');
    own = true;
  } catch {
    /* 已在事务内 */
  }
  try {
    const result = fn();
    if (own) db.exec('COMMIT');
    return result;
  } catch (err) {
    if (own) {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
    throw err;
  }
}

/** 全量重建标签倒排表（结构升级 / 怀疑不同步时可用） */
export function rebuildItemTags() {
  return withTransaction(() => {
    db.prepare('DELETE FROM item_tags').run();
    const rows = db.prepare("SELECT id, tags FROM images WHERE tags <> ''").all();
    const ins = db.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
    let n = 0;
    for (const r of rows) {
      for (const t of String(r.tags).split(',')) {
        const tag = t.trim();
        if (!tag) continue;
        ins.run(tag, r.id);
        n++;
      }
    }
    return { images: rows.length, pairs: n };
  });
}

/* ------------------------------- settings ------------------------------- */

export const DEFAULT_SETTINGS = {
  minResolution: 800, // 长边最小像素
  minFileSize: 30, // 最小 KB
  phashThreshold: 8, // 汉明距离阈值
  pagesPerKeyword: 3, // 每个关键词采集页数
  maxFileSize: 25, // 单张最大 MB
  concurrency: 5,
  sources: {
    bing: true,
    baidu: true,
    sogou: true,
    image360: true,
    duitang: true,
    weibo: false, // 需要登录 Cookie，默认不开，填好后可在采集页勾选
    wallhaven: true,
  },
  wallhavenApiKey: '',
  // 更新源（GitHub owner/repo）：设置页「检查更新」用，留空则提示未配置
  updateRepo: '',
  // 开机自启（桌面端）：应用启动时写入系统登录项
  autoLaunch: false,
  // 微博登录 Cookie（微博接口已关闭游客访问，填了才能用微博源）
  weiboCookie: '',
  // 微博登录会话的 User-Agent：微博风控把登录态与 UA 绑定，采集请求必须复用同一 UA
  weiboUserAgent: '',
  // 桌面端壁纸库文件夹（软件可直接管理其中的图片）；当前激活库的素材根目录
  storageDir: DEFAULT_STORAGE_DIR,
  // 是否已完成首次引导（首次启动让用户选择图片文件夹）；完成后置 true 不再弹出
  onboarded: false,
  // 删除策略：trash 回收站 / permanent 彻底删除 / unlink 仅移出图库
  deletePolicy: 'trash',
  // 智能评分：低于该分数的图片在采集时自动丢弃
  scoreThreshold: 40,
  // AI 打标后自动按智能文件夹规则归类（打标 → 自动分类 的联动）
  autoSmartFolder: true,
  // 竖版图设为横屏壁纸时的留白填充方式：blur 模糊同图 / solid 主色 / black 纯黑
  wallpaperFill: 'blur',
  // 壁纸模式：single 单屏 / span 跨屏合成一张 / per-monitor 每屏不同图
  wallpaperMode: 'single',
  // 动态壁纸（把窗口挂到桌面 WorkerW 层，做成真正的动态桌面）
  liveWallpaper: {
    enabled: false,
    mode: 'slideshow', // slideshow 相册轮播 / video 本地视频 / web 网页
    intervalSec: 15,
    videoPath: '',
    webUrl: '',
    mute: true,
    volume: 0,
    kenBurns: true, // 缓慢缩放（Ken Burns 效果）
    scope: 'favorites', // all / favorites / playlist
    playlistId: null,
    minScore: 0,
    pauseOnFullscreen: true, // 有全屏应用/游戏时暂停
    pauseOnBattery: false, // 用电池时暂停
  },
  // 定时自动切换壁纸
  autoWallpaper: {
    enabled: false,
    mode: 'day', // day 每天 / week 每周 / month 每月 / custom 自定义间隔
    atTime: '09:00', // day|week|month 的执行时刻
    weekday: 1, // 每周：1=周一 … 7=周日
    dayOfMonth: 1, // 每月几号
    minutes: 60, // custom 模式的间隔分钟数
    scope: 'favorites', // all 全库 / favorites 收藏 / playlist 指定清单
    playlistId: null,
    order: 'smart', // smart 评分加权随机（优先高分）/ random 等概率 / sequential 顺序
    minScore: 0, // 低于该评分的图片不参与壁纸（0 = 不限）
    excluded: [], // 点过「不喜欢」的图片 id，不再抽中
    perMonitorDifferent: true, // 多屏模式：每个屏幕放不同的图
    lastRunAt: null,
    lastImageId: null,
    cursor: 0,
    // —— AI 壁纸闭环 ——
    useAiFit: true, // 用 AI / 本地启发式评估「适不适合做壁纸」并参与排序
    useTimeAware: true, // 按时间挑：白天偏明亮、夜间偏暗色
    feedbackToKb: true, // 「不喜欢」自动沉淀为知识库规则，越用越准
    autoEnhance: false, // 抽到的图低于画质标准时，先自动增强再设为壁纸
  },
  // 网络代理（走 Chromium 网络栈，采集 / AI / 下载统一生效）
  network: {
    mode: 'off', // off | system | http | https | socks5 | socks4
    host: '127.0.0.1',
    port: 7890,
    username: '',
    password: '',
    bypass: '<local>',
  },
  // 界面主题：light 明亮（默认）/ dark 暗色
  theme: 'light',
  // 画质增强：低于标准的图片自动收录，可一键增强至标准以上
  enhance: {
    standard: '1080p', // 目标标准（低于该分辨率的图片视为待增强）：480p|720p|1080p|2k|4k|custom
    customWidth: 1920, // standard='custom' 时生效
    customHeight: 1080,
    model: 'sharp-standard', // 默认增强模型（见 server/enhance.js 内置模型）
    remoteServices: [], // 用户配置的线上免费增强服务（可选，软件负责上传/下载/覆盖原文件）
  },
  // AI 接入（OpenAI 兼容）
  ai: {
    enabled: false,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    visionModel: '',
  },
};

// 默认不预置任何采集关键词——软件是通用图库，搜什么由用户在「采集」页自己填。
const DEFAULT_KEYWORDS = [];

let settingsCache = null;

export function getSettings() {
  // 热路径缓存：getSettings 在服务端被高频调用（请求、调度、AI 流程内部都有），
  // 每次全表 SELECT + JSON.parse + 解密纯属浪费。写路径统一走 saveSettings，会同步失效缓存。
  if (settingsCache) return structuredClone(settingsCache);
  const rows = globalDb.prepare('SELECT key, value FROM settings').all();
  const stored = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      stored[row.key] = row.value;
    }
  }
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // 采集源是「键值开关」，老版本存下的对象里没有新加的源，这里补齐默认值
  merged.sources = { ...DEFAULT_SETTINGS.sources, ...(stored.sources || {}) };
  // 微博 Cookie 入库为密文（见 saveSettings），这里解密成明文供服务端内部使用；
  // HTTP 出口由 /api/settings 脱敏，明文永不下发前端
  if (merged.weiboCookie) merged.weiboCookie = decryptSecret(merged.weiboCookie);
  settingsCache = merged;
  return structuredClone(settingsCache);
}

export function saveSettings(patch) {
  const current = getSettings();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // 脱敏辅助字段（服务端生成，不入库）
    if (k === 'hasWeiboCookie' || k === 'hasAiApiKey') continue;
    if (typeof DEFAULT_SETTINGS[k] === 'object' && v && typeof v === 'object') {
      next[k] = { ...DEFAULT_SETTINGS[k], ...current[k], ...v };
    } else {
      next[k] = v;
    }
  }
  // 微博 Cookie 保护规则：空串 = 未修改，不能清掉真实凭据；显式清除带 weiboCookieClear
  if (patch.weiboCookieClear) {
    next.weiboCookie = '';
  } else if ('weiboCookie' in patch && !String(patch.weiboCookie || '').trim()) {
    next.weiboCookie = current.weiboCookie;
  }
  // AI API Key 同规则
  if (patch.aiApiKeyClear) {
    next.ai = { ...(next.ai || {}), apiKey: '' };
  } else if (next.ai && !String(next.ai.apiKey || '').trim()) {
    next.ai = { ...next.ai, apiKey: current.ai?.apiKey || '' };
  }
  const upsert = globalDb.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(next)) {
    // 指令键只用于本次保存，不落库
    if (k === 'weiboCookieClear' || k === 'aiApiKeyClear') continue;
    const value = k === 'weiboCookie' ? encryptSecret(String(v || '')) : v;
    upsert.run(k, JSON.stringify(value));
  }
  settingsCache = null; // 下次读取重建缓存
  return next;
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
    // 迁移完成，库内 settings 表不再使用，删除避免双份来源
    try {
      db.exec('DROP TABLE settings');
    } catch {
      /* 忽略 */
    }
  }

  // 2) 登记默认库（沿用历史 DATA_DIR/gallery.db + storage/thumbs）
  const rootPath = (() => {
    try {
      const row = globalDb.prepare("SELECT value FROM settings WHERE key='storageDir'").get();
      if (row) return String(JSON.parse(row.value));
    } catch {
      /* fallthrough */
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

export function listEnabledKeywords() {
  return db.prepare('SELECT * FROM keywords WHERE enabled = 1 ORDER BY id ASC').all();
}

export function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM keywords').get().c;
  if (count === 0) {
    for (const kw of DEFAULT_KEYWORDS) addKeyword(kw);
  }
}

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
seedDefaults();
