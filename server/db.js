import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, GLOBAL_DB_FILE, DATA_DIR, THUMB_DIR, DEFAULT_STORAGE_DIR } from './config.js';
import { encryptSecret, decryptSecret } from './secret.js';
import { settingsBus } from './lib/settings-bus.js';
import { rgbToOklab } from './lib/oklab.js';
import { repairTakenAt } from './lib/timeline-repair.js';

/**
 * 跨库共享的设置键：永远存 global.db，所有库共用一份。
 * - theme / onboarded / updateRepo / autoLaunch / autoUpdateCheck：应用级偏好
 * - weiboCookie / weiboUserAgent：微博登录凭据（登录态与 UA 绑定），一处配置全部库可用
 * - network：网络代理，对采集、下载、AI 生效
 * 其余键（采集源 / 并发 / AI 开关 / 壁纸 / 删除策略 / 画质增强 / 存储位置…）
 * 都按资源库独立存储——切库即切配置，互不串扰。
 * 注意：ai 是拆分键——接入配置（密钥/模型/baseUrl）共享，enabled 开关按库，见 getSettings/saveSettings。
 *
 * 必须声明在模块最前面：migrate() / ensureDefaultLibrary() 在模块求值时就会调用
 * seedLibrarySettings()，草稿位置放在 migrate 之后会触发 TDZ（Cannot access before initialization），
 * 表现为每个新库的初始设置都播种失败、静默退回默认值。
 */
const GLOBAL_SETTING_KEYS = new Set([
  'theme',
  'onboarded',
  'tourDone',
  'updateRepo',
  'autoLaunch',
  'autoUpdateCheck',
  'weiboCookie',
  'weiboUserAgent',
  'network',
  'closeToTray',
  // 局域网投送 / 屏保是应用级能力，不该每个资源库各配一遍
  'lanAccess',
  'screensaver',
  // 水印预设是「排版方案」，用户不想每个库重新配一遍，跟着人走
  'watermarkPresets',
]);

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
}

/* ------------------------------- 库连接 ------------------------------- */

/** 库内建表 + 触发器 + 结构迁移。对每个打开的库连接执行一遍。 */
/**
 * abs_path 唯一索引的健康状态。
 * 老库里若已有重复路径，建唯一索引会失败 —— 以前只 console.warn，用户永远看不到，
 * 于是「一图一记录」这个前提在没有任何保障的情况下继续用（并发 watch + rescan 仍可能插两条）。
 * 现在把状态暴露给「数据与维护」，并提供清理后的补建入口。
 */
let pathIndexState = { ok: true, duplicates: 0, error: '' };

/**
 * 结构层面的「修失败了但还能跑」的状态。
 * 这类问题以前一律裸 catch 吞掉：界面照常打开，只是颜色筛选/计数悄悄不准。
 * 现在收集起来，由「数据与维护 → 库健康」展示，重启或下一个版本可据此排查。
 */
let schemaWarnings = [];
export function getSchemaWarnings() {
  return schemaWarnings.slice();
}
function noteSchemaWarning(msg) {
  if (!schemaWarnings.includes(msg)) schemaWarnings.push(msg);
  console.warn('[db]', msg);
}

export function getPathIndexState() {
  return { ...pathIndexState };
}

/** 建（或补建）abs_path 唯一索引；重复清干净后可由界面触发重试 */
export function retryPathIndex() {
  return createPathIndex(db);
}

function createPathIndex(conn) {
  try {
    conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_images_path_unique ON images(abs_path)');
    pathIndexState = { ok: true, duplicates: 0, error: '' };
  } catch (err) {
    let duplicates = 0;
    try {
      duplicates =
        Number(
          conn
            .prepare('SELECT COUNT(*) AS c FROM (SELECT abs_path FROM images GROUP BY abs_path HAVING COUNT(*) > 1)')
            .get()?.c
        ) || 0;
    } catch {
      /* 统计失败不影响主结论：索引确实没建起来 */
    }
    pathIndexState = { ok: false, duplicates, error: String(err?.message || err).slice(0, 200) };
    console.warn(`[db] abs_path 有 ${duplicates} 组重复路径，唯一索引未建立；清理重复后可在「数据与维护」重建`);
  }
  return { ...pathIndexState };
}

/**
 * 单调迁移列表：每项 { version, note, run(conn) }。
 * - 只在「真的改表结构」时追加新版本，版本号必须严格递增；
 * - run 必须幂等（迁移中途失败后重跑不会把库改坏）；
 * - 老库的「逐列探测 + 补列」仍留在下面的 reconcile 段里（它本身就是幂等的），
 *   这里只负责记版本、跑增量步骤、失败回滚。
 *
 * 以前没有任何版本号：迁移全靠 PRAGMA table_info 猜测，失败既不回滚也不留痕，
 * 降级安装或绿色版/安装版共用一个 userData 时，跨版本 schema 混用只能靠运气。
 */
const MIGRATIONS = [
  { version: 1, note: '引入 schema 版本表（基线；结构由幂等 reconcile 对齐）', run() {} },
  {
    version: 2,
    note: '清理历史孤儿关联（image_folders / image_comments / clip_vec）',
    run(conn) {
      // 旧版本删素材只删 images 行，关联表没人清：文件夹张数虚高、封面指向已删图、评论永久残留。
      // 新库上这些表还没建（本迁移在建表语句之前跑），所以要逐个探测存在性。
      const has = (t) =>
        !!conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      if (!has('images')) return;
      for (const table of ['image_folders', 'image_comments', 'clip_vec']) {
        if (!has(table)) continue;
        conn.prepare(`DELETE FROM ${table} WHERE image_id NOT IN (SELECT id FROM images)`).run();
      }
    },
  },
  {
    version: 3,
    note: '清理历史孤儿关联（image_quality / image_annotations / image_ocr）',
    run(conn) {
      // 上一轮只补了 image_folders / image_comments / clip_vec 三张表的触发器，
      // 这三张（画质分、标注、OCR）同样以 image_id 为主键，删素材后一直没人清。
      const has = (t) =>
        !!conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      if (!has('images')) return;
      for (const table of ['image_quality', 'image_annotations', 'image_ocr']) {
        if (!has(table)) continue;
        conn.prepare(`DELETE FROM ${table} WHERE image_id NOT IN (SELECT id FROM images)`).run();
      }
    },
  },
  {
    version: 4,
    note: '时间线口径：taken_at 不再用入库时间兜底，改用文件修改 / 创建时间',
    run(conn) {
      // 老版本补 taken_at 列时拿 created_at（入库时间）回填，导致 2019 年的照片全排到导入那天；
      // 这里按 fs_mtime 重算，连文件指纹都没有的行先清空（时间线页会提示重建）。
      repairTakenAt(conn);
    },
  },
];

const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * 升级前留一份一致性快照：VACUUM INTO 会带上 WAL 里已提交但还没合并的数据。
 * @returns {{ ok: boolean, path?: string, error?: string }}
 *   ok=false 表示「该备份但没备份成」；调用方对会改结构的迁移必须中止，不能带着假备份继续。
 */
function backupBeforeUpgrade(conn, fromVersion) {
  let file;
  try {
    file = String(conn.prepare('PRAGMA database_list').get()?.file || '');
  } catch (err) {
    return { ok: false, error: `读不到数据库路径：${err?.message || err}` };
  }
  if (!file) return { ok: true }; // 内存库没有可备份的磁盘文件
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = `${file}.bak-v${fromVersion || 'legacy'}-${stamp}`;
  if (fs.existsSync(dest)) return { ok: true, path: dest }; // 今天已经备份过，别每次切库都复制一份
  try {
    // VACUUM INTO 不接受参数绑定，路径里的单引号必须自己转义
    conn.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    console.info('[db] 升级前已备份到', dest);
    return { ok: true, path: dest };
  } catch (err) {
    const message = String(err?.message || err);
    console.warn('[db] 升级前备份失败：', message);
    return { ok: false, error: message };
  }
}

function initLibrarySchema(conn) {
  schemaWarnings = []; // 每次 open（含切库）重置：告警只描述「当前这个库」的状态
  // ---- 版本化迁移：先建版本表，老库没有它 = 0 ----
  conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const fromVersion = Number(conn.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v) || 0;
  if (fromVersion > SCHEMA_VERSION) {
    // 降级安装：新库里有本版本不认识的列/表。幂等 reconcile 不会删东西，
    // 但写进去的数据旧代码可能读不懂 —— 至少留一份备份并明确告警。
    console.error(
      `[db] 这个库由更高版本创建（v${fromVersion} > v${SCHEMA_VERSION}），请升级应用后再使用；已自动备份。`
    );
    const downgradeBackup = backupBeforeUpgrade(conn, `newer-${fromVersion}`);
    if (!downgradeBackup.ok) noteSchemaWarning(`降级前备份失败：${downgradeBackup.error}`);
  } else if (fromVersion > 0 && fromVersion < SCHEMA_VERSION) {
    // 只在「真的要跑结构迁移」时备份：
    // 老库（fromVersion = 0）走的仍是幂等 reconcile（只补列/建索引，不删不改），
    // 对它做 VACUUM INTO 等于在启动路径上复制一整个可能几个 GB 的库，得不偿失。
    //
    // 备份失败必须中止：以前只 console.warn 就继续跑迁移，用户以为有回退点、实际没有；
    // 迁移一旦失败（断电 / 磁盘满 / 老库结构异常）就没有任何可恢复的快照。
    const backup = backupBeforeUpgrade(conn, fromVersion);
    if (!backup.ok) {
      throw new Error(
        `升级前备份失败，已中止迁移（v${fromVersion} → v${SCHEMA_VERSION}）：${backup.error}。` +
          '库结构未做任何改动；请先手动复制一份 gallery.db（或处理磁盘空间 / 权限）后重新启动。'
      );
    }
  }

  conn.exec('BEGIN');
  try {
    for (const m of MIGRATIONS) {
      if (m.version <= fromVersion) continue;
      m.run(conn);
      conn
        .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString());
    }

    conn.exec(`
-- 库内设置表：除应用级键（主题/首次引导/自启/更新源，见 GLOBAL_SETTING_KEYS）外的
-- 所有设置都存在这里——每个资源库一套独立的采集源、AI、壁纸、网络配置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  -- 拍摄时间（EXIF DateTimeOriginal 优先，取不到时退回文件 mtime / 入库时间）。
  -- 时间线视图按它排序与聚合；空串表示老数据尚未补算（reconcile 会先按 created_at 兜底）。
  taken_at TEXT NOT NULL DEFAULT '',
  viewed_at TEXT NOT NULL DEFAULT '',
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_source ON images(source);
CREATE INDEX IF NOT EXISTS idx_images_path ON images(abs_path);
CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);
-- 注意：taken_at 的索引不能写在这里。老库（v3 之前）还没有这一列，
-- 建索引会直接抛 no such column；下面 ensureColumn 加完列之后统一建。

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

-- 人脸：一张图可检出多张脸，每张脸存 512 维归一化特征（ArcFace）。
-- vec 存原始 float32 小端字节（与 clip_vec 一致，不入库量化），对齐后的 112 裁剪按 bbox 现算。
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  person_id INTEGER,
  x1 REAL NOT NULL, y1 REAL NOT NULL, x2 REAL NOT NULL, y2 REAL NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  det REAL NOT NULL DEFAULT 0,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faces_image ON faces(image_id);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);

-- 人物：聚类结果。centroid 存归一化质心，增量聚类时不必每次重算全表平均。
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  cover_face_id INTEGER,
  count INTEGER NOT NULL DEFAULT 0,
  centroid BLOB,
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
  lock_hash TEXT NOT NULL DEFAULT '',    -- 隐私空间：密码哈希（scrypt），空串 = 未加锁
  lock_salt TEXT NOT NULL DEFAULT '',    -- 哈希用盐；明文密码永不落库
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

-- 标签元数据：分组 / 颜色 / 父标签（层级）/ 手动排序。
-- 标签本体仍是 images.tags 逗号串 + item_tags 倒排，这里只存「展示属性」，
-- 标签被改名/删除/合并时由 lib/tags.js 同步维护，避免出现孤儿元数据。
CREATE TABLE IF NOT EXISTS tag_meta (
  tag TEXT PRIMARY KEY,
  tag_group TEXT NOT NULL DEFAULT '',   -- 分组名（Eagle 的「标签群组」）
  color TEXT NOT NULL DEFAULT '',       -- #rrggbb，空 = 跟随主题
  parent TEXT NOT NULL DEFAULT '',      -- 父标签名，空 = 顶层（Eagle 的「标签层级」）
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 图片标注：整层存一份 JSON 数组（Eagle 的标注是一张图上的一个可编辑图层，
-- 拆成行反而要处理 z-order / 增删改的批处理，这里按整层读写最简单可靠）。
-- 标签别名 / 同义词：搜「界面」也能命中「ui」。别名不写进 images.tags（单一事实来源不变），
-- 只在查询期展开成正式标签，所以合并/改名时要跟着迁移，否则会留下悬空别名。
CREATE TABLE IF NOT EXISTS tag_alias (
  alias TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS image_annotations (
  image_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 图片评论：Eagle 4 的图注评论，按时间正序展示
CREATE TABLE IF NOT EXISTS image_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_comments_image ON image_comments(image_id);

-- 完全重复检测用的内容指纹按 (size_bytes, md5) 分组，先按大小粗筛再比对哈希
CREATE INDEX IF NOT EXISTS idx_images_size ON images(size_bytes);

-- 编辑历史（覆盖写回前的原文件备份）：
-- 裁切/调色/增强/旋转默认直接覆盖原图且不可逆，这里留一份原始副本支持「撤销」。
-- 只保留最近若干条，避免长期占盘。
CREATE TABLE IF NOT EXISTS edit_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  backup_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'edit',
  prev_width INTEGER NOT NULL DEFAULT 0,
  prev_height INTEGER NOT NULL DEFAULT 0,
  prev_size INTEGER NOT NULL DEFAULT 0,
  prev_phash TEXT NOT NULL DEFAULT '',
  prev_obj_phash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edit_history_image ON edit_history(image_id, id);

-- 后台任务（采集 / 批量编辑 / 增强 / 模型下载）：
-- 以前这些任务全是内存里的单例，进程一退就没了 —— 既没有历史，也没法重试，
-- 崩了以后连「上次跑到哪」都查不到。这里落表，做历史 + 中断标记 + 重试依据。
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL DEFAULT '{}',
  progress REAL NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_jobs_kind ON jobs(kind, id DESC);

-- 统一操作日志：撤销原先只覆盖「编辑类」（edit_history 的原图备份）。
-- 打标、移动文件夹、删除、回收站恢复、批量导入都不可回滚，误操作只能靠人肉复原。
-- 这里记录每次批量操作的逆操作描述，支持逐条撤销。
CREATE TABLE IF NOT EXISTS op_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_log_id ON op_log(id DESC);

-- 图片文字识别结果（OCR）：单独成表而不是给 images 加列，
-- 因为一张图的识别文本可能很长，且绝大多数图没有；放主表会拖慢列表扫描。
-- 关键词搜索时用 image_id IN (SELECT ... LIKE) 挂进主查询。
CREATE TABLE IF NOT EXISTS image_ocr (
  image_id INTEGER PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_ocr_created ON image_ocr(created_at);

-- 动作（Actions）：把「打标签 + 归类 + 改名 + AI 描述」这类固定流程存成可复用宏，
-- 对齐 Eagle 4 的「动作」与 Build 22 的 AI Action。steps 是 JSON 数组。
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  -- 执行条件（JSON：{combine:'and'|'or', rules:{...}}），与智能文件夹共用同一套规则语义；
  -- 空串 = 无条件，对选区全量执行
  conditions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_run_at TEXT NOT NULL DEFAULT ''
);

-- 保存的筛选器：把当前筛选栏（关键词/类型/星级/标签/文件夹…）整套存下来，
-- 侧栏一键回到同一视图。query 存 JSON，不做字段拆分 —— 筛选参数还在演进，
-- 拆成列每次加参数都要迁移，而这里只做整体回放。
CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '{}',
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 素材笔记：Eagle 式「文字笔记 + 视频时间点笔记」。
-- ts > 0 表示钉在音视频的某个时间点（秒），0 = 纯文本笔记。
-- 单独成表而不是给 images.note 加数组：一张图可以有任意多条带时间的笔记。
CREATE TABLE IF NOT EXISTS image_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ts REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_notes_image ON image_notes(image_id, id);
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
  // 素材被彻底删除时一并清掉笔记，否则素材删掉后笔记表会一直长（还带着正文）
  conn.function('delete_image_notes', (id) => {
    conn.prepare('DELETE FROM image_notes WHERE image_id = ?').run(id);
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
CREATE TRIGGER IF NOT EXISTS trg_image_notes_delete AFTER DELETE ON images BEGIN
  SELECT delete_image_notes(OLD.id);
END;
-- 素材被彻底删除时一并清掉人脸记录：否则人物页会一直挂着已删素材的裁切图，
-- 聚类质心也被幽灵向量污染。人物行本身保留（用户可能已改名，宁可空着也不丢名字）。
CREATE TRIGGER IF NOT EXISTS trg_faces_delete AFTER DELETE ON images BEGIN
  DELETE FROM faces WHERE image_id = OLD.id;
END;
-- 同理清掉「图 ↔ 文件夹」关联：以前只有回收站/导入两条路径手工清，
-- 去重回滚与批量淘汰直接 DELETE images 就留下了孤儿 —— 侧栏张数虚高、封面指向已删图。
CREATE TRIGGER IF NOT EXISTS trg_image_folders_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_folders WHERE image_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_image_comments_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_comments WHERE image_id = OLD.id;
END;
-- 向量也要跟着走：去重回滚只删 images 行时，残留向量会让「相似图」把已删素材召回。
CREATE TRIGGER IF NOT EXISTS trg_clip_vec_delete AFTER DELETE ON images BEGIN
  DELETE FROM clip_vec WHERE image_id = OLD.id;
END;
-- 画质分 / 标注 / OCR 同样是 image_id 主键：以前只在业务路径手工清，
-- 去重回滚、批量淘汰、清空回收站这些硬删除会留下孤儿（画质分还会被「整理」页当有效数据读）。
CREATE TRIGGER IF NOT EXISTS trg_image_quality_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_quality WHERE image_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_image_annotations_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_annotations WHERE image_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_image_ocr_delete AFTER DELETE ON images BEGIN
  DELETE FROM image_ocr WHERE image_id = OLD.id;
END;
`);

  // ---- 结构迁移（对当前连接执行，等价旧版顶层 ensureColumn）----
  /** @returns {boolean} 是否本次新加的列（老库补列后需要一次性回填） */
  const ensureColumn = (table, column, ddl) => {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      return true;
    }
    return false;
  };
  // 时间线视图：拍摄时间列 + 索引。老库新加列后立刻按文件时间（fs_mtime）回填 ——
  // 绝不用入库时间：那会让整库照片堆到导入那天。连文件指纹都没有的行留空，
  // 时间线页会提示「N 张待校正」，重建任务 stat 一次文件就能补上。
  if (ensureColumn('images', 'taken_at', "taken_at TEXT NOT NULL DEFAULT ''")) {
    repairTakenAt(conn);
  }
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_taken ON images(taken_at)');
  // 非破坏性编辑：操作链条数冗余在 images 上，列表 DTO 不必为每行查一次 edit_ops
  ensureColumn('images', 'edit_ops_count', 'edit_ops_count INTEGER NOT NULL DEFAULT 0');
  // 操作链版本号：任何增删都 +1。前端 URL（?v=）与派生图缓存都靠它失效，
  // 光靠条数不够 —— 撤销一步再补一步，条数不变但画面已经不同了。
  ensureColumn('images', 'edit_ops_ver', 'edit_ops_ver INTEGER NOT NULL DEFAULT 0');
  // 非破坏性编辑的操作链（裁切/旋转/调色的可逆记录）。
  // 开着这个模式时原图不动，所有改动记在这里，由渲染层套用；「应用到底片」才真正写回。
  conn.exec(`
CREATE TABLE IF NOT EXISTS edit_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edit_ops_image ON edit_ops(image_id);
CREATE TRIGGER IF NOT EXISTS trg_edit_ops_delete AFTER DELETE ON images BEGIN
  DELETE FROM edit_ops WHERE image_id = OLD.id;
END;
`);
  ensureColumn('images', 'score', 'score INTEGER NOT NULL DEFAULT 100');
  ensureColumn('images', 'score_reason', "score_reason TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_score ON images(score)');
  ensureColumn('images', 'viewed_at', "viewed_at TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'view_count', 'view_count INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_viewed ON images(view_count)');
  ensureColumn('images', 'rating', 'rating INTEGER NOT NULL DEFAULT 0');
  ensureColumn('images', 'note', "note TEXT NOT NULL DEFAULT ''");
  // 视频首尾裁剪区间（秒）：灯箱里拖动裁剪滑块后保存，0 = 未设置。
  // 用幂等 reconcile 补列，不新增迁移版本——老库不备份整个 DB 也能平滑升级。
  ensureColumn('images', 'trim_start', 'trim_start REAL NOT NULL DEFAULT 0');
  ensureColumn('images', 'trim_end', 'trim_end REAL NOT NULL DEFAULT 0');
  // 文件指纹（mtime 秒）：导入时据此跳过内容未变的文件，让二次扫描接近零成本
  ensureColumn('images', 'fs_mtime', 'fs_mtime INTEGER NOT NULL DEFAULT 0');
  // 封面版本号：换/恢复自定义封面只重写缩略图文件、不动原文件，fs_mtime 不会变，
  // 单独用它让缩略图 URL 变化，避免浏览器 7 天强缓存里一直是旧封面
  ensureColumn('images', 'cover_ver', 'cover_ver INTEGER NOT NULL DEFAULT 0');
  // 人脸扫描进度：0 = 还没扫过（含扫过但一张脸都没有的照片，扫完置 1）。
  // 用部分索引只索引「待扫」的行，百万库清空后索引几乎为空，续扫不必全表反连接。
  ensureColumn('images', 'face_scanned', 'face_scanned INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_face_pending ON images(id) WHERE face_scanned = 0');
  // 文件夹封面：NULL = 自动用夹内最新一张；有值 = 用户手动指定的那一张
  ensureColumn('folders', 'cover_image_id', 'cover_image_id INTEGER');
  // 文件夹标签（Eagle：给文件夹打标签，里面素材自动带上）：只存逗号串，查询期沿路径继承，
  // 不物化进 images.tags —— 物化后「删文件夹标签」得逐张回滚，得不偿失
  ensureColumn('folders', 'tags', "tags TEXT NOT NULL DEFAULT ''");
  // 文件夹外观：emoji / 图标字符 + 主题色（Eagle 允许给文件夹上色，一眼区分用途）
  ensureColumn('folders', 'icon', "icon TEXT NOT NULL DEFAULT ''");
  ensureColumn('folders', 'color', "color TEXT NOT NULL DEFAULT ''");
  // 文件夹内手动排序（拖动定序）：同一张图在不同文件夹可以有不同顺序，所以落在这里而不是 images
  ensureColumn('image_folders', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
  // 隐私空间：文件夹密码锁（哈希 + 盐，明文不落库）
  ensureColumn('folders', 'lock_hash', "lock_hash TEXT NOT NULL DEFAULT ''");
  ensureColumn('folders', 'lock_salt', "lock_salt TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'dominant', "dominant TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'hue', "hue TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'palette', "palette TEXT NOT NULL DEFAULT ''");
  // 颜色搜索索引：主色 OKLab 三通道落库，SQL 粗筛 box 下推，避免每次请求全库解析 palette JSON。
  // 以幂等 reconcile 补列（老库不备份整库也能平滑升级），并用后台回填把已存在的 dominant 量化进库。
  ensureColumn('images', 'dominant_l', 'dominant_l REAL');
  ensureColumn('images', 'dominant_a', 'dominant_a REAL');
  ensureColumn('images', 'dominant_b', 'dominant_b REAL');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_domlab ON images(dominant_l, dominant_a, dominant_b)');
  {
    const nullCount = Number(conn.prepare("SELECT COUNT(*) AS c FROM images WHERE dominant_l IS NULL AND dominant <> ''").get()?.c || 0);
    if (nullCount > 0) {
      console.info(`[db] 回填主色 OKLab 索引（约 ${nullCount} 张，仅此一次）…`);
      const upd = conn.prepare('UPDATE images SET dominant_l = ?, dominant_a = ?, dominant_b = ? WHERE id = ?');
      const rows = conn.prepare("SELECT id, dominant FROM images WHERE dominant_l IS NULL AND dominant <> ''").all();
      for (const r of rows) {
        const lab = rgbToOklab(r.dominant);
        if (lab) upd.run(+lab.L.toFixed(4), +lab.a.toFixed(4), +lab.b.toFixed(4), r.id);
      }
      console.info('[db] 主色 OKLab 索引回填完成');
    }
  }
  // 主体哈希（白底抠图+主体包围盒归一化后的 pHash）：全图哈希被白底背景主导导致
  // 不同商品误判相似，主体化后彻底解决；'' = 尚未补算（相似分组退回全图 phash）
  ensureColumn('images', 'obj_phash', "obj_phash TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_rating ON images(rating)');
  ensureColumn('images', 'pref', 'pref INTEGER NOT NULL DEFAULT 50');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_pref ON images(pref)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_hue ON images(hue)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_palette ON images(palette)');

  // —— 素材类型扩展（Eagle 式多格式）——
  // media_kind: image / video / gif / audio / font / pdf / office / model / other
  // 图片以外的素材不走 sharp，缩略图由前端用对应元素渲染，故 thumb 留空。
  ensureColumn('images', 'media_kind', "media_kind TEXT NOT NULL DEFAULT 'image'");
  conn.exec("UPDATE images SET media_kind = 'image' WHERE media_kind = ''");
  ensureColumn('images', 'duration', 'duration REAL NOT NULL DEFAULT 0');   // 音视频时长（秒），前端读元数据后回写
  ensureColumn('images', 'cover_ts', 'cover_ts REAL NOT NULL DEFAULT 0');    // 自定义封面帧（秒），视频/GIF 用
  // 内容指纹：完全重复检测（pHash 只能找「看起来像」的，MD5 找「字节完全相同」的）
  ensureColumn('images', 'md5', "md5 TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_md5 ON images(md5)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_kind ON images(media_kind)');
  // Eagle 素材 id：从 .library 迁移时记下来，重复导入同一个库直接跳过（幂等），
  // 而不是每点一次「开始迁移」就多出一份副本
  ensureColumn('actions', 'conditions', "conditions TEXT NOT NULL DEFAULT ''");
  ensureColumn('images', 'eagle_id', "eagle_id TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_eagle ON images(eagle_id)');
  // 回收站整行快照（images 行的 JSON）：恢复时要还原 media_kind / rating / note /
  // duration / cover_ts / md5 / fs_mtime 等全部列。只存回收站表那 15 个字段的话，
  // 视频恢复成图片、评分备注丢失、fs_mtime=0 让 ?v=0 的缩略图缓存永不刷新。
  ensureColumn('trash', 'snapshot', "snapshot TEXT NOT NULL DEFAULT ''");

  // 图片堆叠（Eagle 的 Stack）：同一素材的多版本/多裁切合成一组。
  // stack_id = 0 表示没堆叠；否则指向「组主」那张图的 id（组主自己的 stack_id = 自己的 id）。
  // 列表默认只显示组主，成员在灯箱里展开 —— 否则同素材几个版本会把网格占满。
  ensureColumn('images', 'stack_id', 'stack_id INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_stack ON images(stack_id)');
  // 使用统计：复制 / 导出次数（Eagle 详情里能看到「用过几次」，也便于找出从没用过的素材）
  ensureColumn('images', 'copy_count', 'copy_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('images', 'export_count', 'export_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('images', 'last_used_at', "last_used_at TEXT NOT NULL DEFAULT ''");
  conn.exec('CREATE INDEX IF NOT EXISTS idx_images_last_used ON images(last_used_at)');

  // 人脸质量（0..1）/ 正面程度（0..1）/ 排除标记：
  // quality、frontal 为 -1 表示老数据未评估，扫描或「清理模糊人脸」后回填；
  // hidden: 0 正常、1 低质量自动排除（不聚类/不当封面/不显示）、2 用户手动保留。
  ensureColumn('faces', 'quality', 'quality REAL NOT NULL DEFAULT -1');
  ensureColumn('faces', 'frontal', 'frontal REAL NOT NULL DEFAULT -1');
  ensureColumn('faces', 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_faces_quality ON faces(person_id, hidden, quality)');

  // 封面脸的原图像素短边：0 表示「这个人没有够格当封面的清晰脸」。
  // 存成列而不是每次 JOIN images 现算，是因为人物列表按它做筛选（默认只列有清晰封面的），
  // 2241 个人物乘一次 JOIN 足够卡顿，而它只在聚簇重算/清理时变一次。
  ensureColumn('persons', 'cover_px', 'cover_px REAL NOT NULL DEFAULT 0');

  // 用户手动指定的封面：1 = 锁住，聚类重算 / 清理 / 扫描新增都不许再自动换人。
  // 不加这一列的话，手动选了一张「不够清晰但好看」的封面，下一次扫描就会被 coverRank 顶掉，
  // 用户会以为「设封面」这个功能根本没生效。
  ensureColumn('persons', 'cover_locked', 'cover_locked INTEGER NOT NULL DEFAULT 0');

  // abs_path 唯一索引：watch 防抖回调与手动 rescan 可能同时进入，两边都判「不存在」就各插一条。
  // 老库里若已经有重复路径，唯一索引建不起来 —— 不阻断启动，但状态要能被界面读到（见 getPathIndexState）。
  createPathIndex(conn);

  // hue 由单列整数改为多值文本（逗号分隔，最多 3 个色系；空串 = 黑白灰）。
  {
    const hueCol = conn.prepare("SELECT name, type FROM pragma_table_info('images') WHERE name='hue'").get();
    if (hueCol && /INT/i.test(hueCol.type || '')) {
      conn.exec("ALTER TABLE images ADD COLUMN hue_txt TEXT NOT NULL DEFAULT ''");
      conn.exec("UPDATE images SET hue_txt = CASE WHEN hue IS NULL OR hue < 0 THEN '' ELSE CAST(hue AS TEXT) END");
      conn.exec('DROP INDEX IF EXISTS idx_images_hue');
      let stepError = '';
      try {
        conn.exec('ALTER TABLE images DROP COLUMN hue');
        conn.exec('ALTER TABLE images RENAME COLUMN hue_txt TO hue');
      } catch (err) {
        // 老 SQLite 不支持 DROP COLUMN：退化为「改名让位」两步走
        stepError = String(err?.message || err).slice(0, 160);
        try {
          conn.exec('ALTER TABLE images RENAME COLUMN hue TO hue_old');
          conn.exec('ALTER TABLE images RENAME COLUMN hue_txt TO hue');
          stepError = '';
        } catch (err2) {
          stepError = String(err2?.message || err2).slice(0, 160);
        }
      }
      // 不假设「没抛错就等于改对了」：直接查表结构，改不动就明确记一条结构告警
      const type = conn.prepare("SELECT type FROM pragma_table_info('images') WHERE name = 'hue'").get()?.type || '';
      const leftover = conn.prepare("SELECT 1 AS x FROM pragma_table_info('images') WHERE name = 'hue_txt'").get();
      if (/INT/i.test(String(type)) || leftover) {
        noteSchemaWarning(
          `hue 列迁移未完成（当前类型 ${type || '未知'}${leftover ? '，仍残留 hue_txt' : ''}${stepError ? `；${stepError}` : ''}），颜色筛选结果可能不正确`
        );
      }
      try {
        conn.exec('CREATE INDEX IF NOT EXISTS idx_images_hue ON images(hue)');
      } catch (err) {
        noteSchemaWarning(`hue 索引建立失败（${String(err?.message || err).slice(0, 120)}），颜色筛选会变慢`);
      }
    }
  }

  // 倒排表空但 images 有标签时（老库首次升级）一次性重建。
  // 只探「有没有」，不要 count(*)：每次切库都全表扫一遍上万行，大库上是白花的几百毫秒
  const need = conn.prepare("SELECT 1 AS x FROM images WHERE tags <> '' LIMIT 1").get() ? 1 : 0;
  const have = conn.prepare('SELECT 1 AS x FROM item_tags LIMIT 1').get() ? 1 : 0;
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
    // 回填：FTS 空但 images 有数据时（老库首次升级）一次性构建。
    // 同样只探测存在性 —— COUNT(*) 在 FTS5 上要遍历整个索引，1.8 万文档就是秒级，
    // 而这段代码每次切库都会跑到
    const ftsEmpty = !conn.prepare('SELECT rowid FROM images_fts LIMIT 1').get();
    const hasImg = Boolean(conn.prepare('SELECT id FROM images LIMIT 1').get());
    if (ftsEmpty && hasImg) {
      conn.exec(
        'INSERT INTO images_fts(rowid, title, tags, keyword, note) SELECT id, title, tags, keyword, note FROM images'
      );
    }
  } catch (err) {
    console.error('[fts] FTS5 初始化失败（搜索退回 LIKE）:', err?.message || err);
  }

    conn
      .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION, new Date().toISOString());
    conn.exec('COMMIT');
  } catch (err) {
    // SQLite 的 DDL 也在事务里：中途失败就整体回滚，库还是迁移前的样子，
    // 不会留下「加了一半列」的半成品（以前失败只抛错，状态未知）。
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 事务可能已经被 SQLite 自己回滚 */
    }
    throw new Error(
      `库结构迁移失败（v${fromVersion} → v${SCHEMA_VERSION}）：${err?.message || err}`,
      { cause: err }
    );
  }
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
  settingsCache = null; // storageDir 随库变化，失效缓存
}

/** 当前库缩略图目录（默认库沿用历史 storage/thumbs；新建库在库内 thumbs/） */
export function getThumbDir() {
  return activeLibrary?.thumb_dir || THUMB_DIR;
}

/* ------------------------------- 迁移 ------------------------------- */

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

/**
 * 库的 settings 表为空时，从 global.db 复制一份非全局键作为起点。
 * 设置分库是一次结构迁移：老用户的现有配置都攒在 global.db 里，
 * 每个存量库首次打开时播种一份，之后各自独立演进；新建库同样以这份快照起步。
 * 幂等：只在空表时执行（用户主动改过的库不会被覆盖）。
 */
function seedLibrarySettings(conn) {
  try {
    const count = conn.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
    if (count > 0) return;
    const rows = globalDb
      .prepare('SELECT key, value FROM settings')
      .all()
      .filter((r) => !GLOBAL_SETTING_KEYS.has(r.key));
    if (!rows.length) return;
    const ins = conn.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
    for (const r of rows) ins.run(r.key, r.value);
  } catch (err) {
    console.warn('[settings] 库设置初始化失败（以默认值继续）:', err?.message || err);
  }
}

export const DEFAULT_SETTINGS = {
  minResolution: 800, // 长边最小像素
  minFileSize: 30, // 最小 KB
  phashThreshold: 8, // 汉明距离阈值
  pagesPerKeyword: 3, // 每个关键词采集页数
  importMaxDepth: 4, // 导入时目录遍历深度上限（层），超过的目录会跳过并在导入结束时提示
  // 导入命名模板：空 = 沿用内置「关键词_来源_尺寸_时间戳_随机」。
  // 采集 / 拖拽 / 粘贴 / 手机投送 / 浏览器扩展 / 批量入库都按它落盘，原图不会被改名
  importNameTemplate: '',
  // 本地扫描默认原地登记；开启后才复制一份到保存文件夹并按模板命名，原文件始终不动
  importNameTemplateForLocal: false,
  // 调色台历史记录保留步数：调色是「反复试」的过程，默认留 100 步够回退一整轮试色
  historySteps: 100,
  // 水印预设（跨库共享）：用户存下来的整套排版方案 —— 样式/相框/信息项/品牌型号/字号…
  // 结构：[{ id, name, params, at }]，导入导出的 JSON 见 web/src/lib/watermark-preset.ts
  watermarkPresets: [],
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
    commons: true, // Wikimedia 官方 API，稳定且图片可自由使用
    douban: false, // 风控较严，按需在设置里打开；失败会在任务日志说明原因
    tieba: false,
  },
  wallhavenApiKey: '',
  // 更新源（GitHub owner/repo）：设置页「检查更新」用，留空则提示未配置
  updateRepo: '',
  // 开机自启（桌面端）：应用启动时写入系统登录项
  autoLaunch: false,
  // 启动时自动检查更新（桌面安装版）：关掉后只在「设置 → 关于」手动检查
  autoUpdateCheck: true,
  // 关窗行为（桌面端）：true = 收到托盘继续后台跑；false = 关窗即退出
  closeToTray: true,
  // 微博登录 Cookie（微博接口已关闭游客访问，填了才能用微博源）
  weiboCookie: '',
  // 微博登录会话的 User-Agent：微博风控把登录态与 UA 绑定，采集请求必须复用同一 UA
  weiboUserAgent: '',
  // 桌面端壁纸库文件夹（软件可直接管理其中的图片）；当前激活库的素材根目录
  storageDir: DEFAULT_STORAGE_DIR,
  // 文件夹监控：往素材文件夹里丢文件即自动入库（fs.watch 递归监听，2s 防抖）
  watchEnabled: true,
  // 是否已完成首次引导（首次启动让用户选择图片文件夹）；完成后置 true 不再弹出
  onboarded: false,
  // 是否已看过教程（分步导览）；跳过也算看过，可在设置里重新播放
  tourDone: false,
  // 删除策略：trash 回收站 / permanent 彻底删除 / unlink 仅移出图库
  deletePolicy: 'trash',
  // 局域网 / 手机扫码投送：默认关闭。开启时另起独立端口 + 独立小权限令牌，主服务仍只绑 127.0.0.1
  lanAccess: false,
  // 屏幕保护程序：空闲 N 分钟后用动态壁纸窗口全屏覆盖，用户一动键鼠即退出
  screensaver: {
    enabled: false,
    idleMinutes: 10,
    mode: 'slideshow',
    showClock: true,
  },
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
    // slideshow 相册轮播 / video 本地视频 / web 网页 / shader GLSL / interactive 交互 / audio 音频可视化
    mode: 'slideshow',
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
    pauseOnGpu: false, // GPU 占用达到阈值时暂停
    gpuThreshold: 85, // 取最忙 GPU 引擎的占用率（%），计数器不可用时规则自动跳过
    pauseApps: [], // 这些进程在前台时暂停，如 ['photoshop.exe', 'msedge*']
    // 网页壁纸：默认只放公网 http(s)；显式放开后才允许本机/内网页面与可信目录内的 file://
    allowLocalUrl: false,
    trustedDir: '',
    clickThrough: true, // 网页壁纸默认点击穿透；关掉后网页可接收鼠标，Esc 恢复
    // 壁纸实时交互参数：UI 滑块 0~300，渲染页归一化到倍率；拖滑块不重开窗口
    params: { brightness: 100, speed: 50, intensity: 60, depth: 40 },
    // 着色器：预设 id 稳定，自定义源码为空时用预设；编译失败会在桌面层如实提示
    shaderPreset: 'plasma',
    shaderSource: '',
    // 交互壁纸：开启后桌面层窗口不再忽略鼠标事件，Esc 可退出交互
    interactive: false,
    // 音频可视化：素材音频文件 / 麦克风（系统音频回环需 WASAPI，暂不假装支持）
    audioPath: '',
    audioSource: 'file', // file / mic
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
  // 非破坏性编辑：开着时裁切/旋转/调色只记操作链，原图保持字节不变，
  // 浏览与下载套用渲染结果；「应用到底片」或关闭模式时才真正写回。默认关（沿用原有行为）。
  nonDestructiveEdit: false,
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

let settingsCache = null;

export function getSettings() {
  // 热路径缓存：getSettings 在服务端被高频调用（请求、调度、AI 流程内部都有），
  // 每次全表 SELECT + JSON.parse + 解密纯属浪费。写路径统一走 saveSettings，会同步失效缓存。
  if (settingsCache) return structuredClone(settingsCache);
  const stored = {};
  const readRows = (rows) => {
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value);
      } catch {
        stored[row.key] = row.value;
      }
    }
  };
  // 当前库的设置（采集 / AI 开关 / 壁纸 / 存储位置…按库独立）
  readRows(db.prepare('SELECT key, value FROM settings').all());
  // 共享键以 global.db 为准（主题 / 引导 / 自启 / 更新源 / 微博凭据 / 网络代理）
  readRows(
    globalDb
      .prepare('SELECT key, value FROM settings')
      .all()
      .filter((r) => GLOBAL_SETTING_KEYS.has(r.key))
  );
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // ai 拆分键：接入配置（provider/baseUrl/apiKey/model/visionModel）跨库共享存 global.db；
  // enabled（智能评分开关）按库独立存各库。两侧行都可能是旧的全量格式，显式合并。
  const libAi = stored.ai && typeof stored.ai === 'object' ? stored.ai : {};
  delete stored.ai;
  let sharedAi = {};
  try {
    sharedAi = JSON.parse(globalDb.prepare("SELECT value FROM settings WHERE key='ai'").get()?.value || '{}');
  } catch {
    /* 忽略坏行，走默认值 */
  }
  if (typeof sharedAi !== 'object' || !sharedAi) sharedAi = {};
  merged.ai = {
    ...DEFAULT_SETTINGS.ai,
    ...sharedAi,
    // enabled 权威在库行；库行没有（新库/旧数据）时退回共享行的快照，最后到默认值
    enabled: libAi.enabled ?? sharedAi.enabled ?? DEFAULT_SETTINGS.ai.enabled,
  };
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
    // 数组（水印预设、壁纸排除名单…）整体替换，别按对象合并——展开数组会变成 {"0":…} 的怪东西
    if (Array.isArray(v)) {
      next[k] = v;
    } else if (typeof DEFAULT_SETTINGS[k] === 'object' && v && typeof v === 'object') {
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
  const upsertLib = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const upsertGlobal = globalDb.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(next)) {
    // 指令键只用于本次保存，不落库
    if (k === 'weiboCookieClear' || k === 'aiApiKeyClear') continue;
    // ai 拆分写入：接入配置（密钥/模型/baseUrl）写 global.db 供所有库共享，
    // enabled（智能评分开关）写当前库——每库自己决定开不开 AI 评分。
    // global 行附带 enabled 快照，供新库播种时继承「最近一次的开关状态」。
    if (k === 'ai') {
      const { enabled, ...sharedAi } = v && typeof v === 'object' ? v : {};
      upsertGlobal.run('ai', JSON.stringify({ ...sharedAi, enabled: !!enabled }));
      upsertLib.run('ai', JSON.stringify({ enabled: !!enabled }));
      continue;
    }
    const value = k === 'weiboCookie' ? encryptSecret(String(v || '')) : v;
    // 共享键写回 global.db（跨库共用一份），其余写入当前库的 settings 表
    if (GLOBAL_SETTING_KEYS.has(k)) upsertGlobal.run(k, JSON.stringify(value));
    else upsertLib.run(k, JSON.stringify(value));
  }
  settingsCache = null; // 下次读取重建缓存
  // 通知订阅方（Electron 主进程：storageDir / 代理 / 开机自启这些本地能力要跟着改）
  try {
    settingsBus.emit('changed', getSettings());
  } catch (err) {
    console.error('[settings] 广播设置变更失败', err.message);
  }
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

export function listEnabledKeywords() {
  return db.prepare('SELECT * FROM keywords WHERE enabled = 1 ORDER BY id ASC').all();
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
