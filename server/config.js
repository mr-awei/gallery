import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(__dirname, '..');
export const WORKSPACE_ROOT = path.resolve(APP_ROOT, '..');

/**
 * 打包后的应用代码位于只读的 app.asar 内，数据库 / 缩略图 / 下载的 AI 运行库
 * 都必须写到可写目录，否则会直接启动失败。
 * - 开发运行：沿用代码同级的 app/data、app/storage（不影响现有图库）
 * - 打包运行：使用系统用户数据目录（%APPDATA%/图库）
 *
 * 目录由 Electron 主进程在加载本模块之前用环境变量注入。
 * 注意：这里不能用顶层 await import('electron') —— 主进程要等入口模块求值完成
 * 才会启动事件循环，那样会死锁（进程活着但无窗口、无端口、无子进程）。
 */
export const IS_PACKAGED = process.env.TUKU_PACKAGED === '1';
const USER_ROOT = process.env.TUKU_USER_DATA || APP_ROOT;

export const DATA_DIR = path.join(USER_ROOT, 'data');
export const STORAGE_DIR = path.join(USER_ROOT, 'storage');
export const IMAGE_DIR = path.join(STORAGE_DIR, 'images');
export const THUMB_DIR = path.join(STORAGE_DIR, 'thumbs');
export const TRASH_DIR = path.join(STORAGE_DIR, 'trash');
export const WEB_DIST = path.join(APP_ROOT, 'dist', 'web');

/** 首次运行时图片的默认保存位置（由主进程注入；用户可在设置页改成任意文件夹，不再写死） */
export const DEFAULT_STORAGE_DIR = process.env.TUKU_DEFAULT_STORAGE_DIR || IMAGE_DIR;

for (const dir of [DATA_DIR, IMAGE_DIR, THUMB_DIR, TRASH_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const DB_FILE = path.join(DATA_DIR, 'gallery.db');
// 全局库：存 settings + 库注册表（跨库共享的应用级数据），与「每个库一个 gallery.db」分离
export const GLOBAL_DB_FILE = path.join(DATA_DIR, 'global.db');

export const PORT = Number(process.env.PORT || 3001);

/**
 * AI 模型缓存目录（CLIP / Swin2SR 等 transformers.js 模型）。
 * 打包版代码在只读的 app.asar 内，缓存若指向 asar 里（老版本是 __dirname/../models）
 * 首次下载必然失败 —— 必须落到用户数据目录（打包后 %APPDATA%/图库/data/models）。
 * 可用环境变量 TUKU_MODEL_DIR 覆盖。
 */
export const MODEL_CACHE_DIR = process.env.TUKU_MODEL_DIR || path.join(DATA_DIR, 'models');

// 开发模式一次性迁移：老版本把模型缓存在项目根 models/，避免升级后重新下载 ~150MB。
// 打包版 asar 内的 models 无法被 ONNX Runtime 读取也无需迁移，跳过。
if (!IS_PACKAGED) {
  const legacy = path.join(APP_ROOT, 'models');
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(MODEL_CACHE_DIR)) {
      fs.renameSync(legacy, MODEL_CACHE_DIR);
    }
  } catch {
    /* 迁移失败不影响启动，最多重新下载模型 */
  }
}

/**
 * 允许免令牌调用 /api/extension/ingest 的浏览器扩展来源。
 * 之前是「任意 chrome-extension:// 都放行」：本机装的任何一个扩展（含被收购后塞私货的）
 * 都能读写图库。改为按扩展 ID 精确匹配——ID 由 manifest 的 key 固定（见 extension/manifest.json），
 * 所以从任何路径加载本扩展都是这个 ID。要换 ID 时同步改 manifest.key 与环境变量。
 */
export const EXTENSION_ORIGINS = (process.env.TUKU_EXTENSION_ORIGINS || 'olckdffcmfpciekkkdekckpgphacfnfl')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
  .map((id) => (id.startsWith('chrome-extension://') ? id : `chrome-extension://${id}`));

/** 工作区内已有的图片目录（初次启动时导入到图库；打包后不适用，留空） */
export const LEGACY_DIRS = IS_PACKAGED
  ? []
  : [IMAGE_DIR];

/**
 * 本地 API 鉴权令牌。
 * 之前 /api 完全无鉴权：本机任意网页都能向 127.0.0.1:3001 发请求（CSRF / 跨站探测），
 * 拿到图库内容甚至改写设置。现在默认启用 Bearer 令牌：
 * - 优先读环境变量 API_TOKEN；否则读/建用户数据目录 .api-token（首次自动随机生成）。
 * - 桌面端渲染进程经 preload 的 getApiToken 取得；纯 web 模式用控制台打印的
 *   地址（?token=xxx）访问即可。
 * - 用 wx 独占创建：node server 与 Electron 主进程同时首启时，后者会读到前者
 *   写入的文件而不是各自覆盖成不同的 token。
 */
export const API_TOKEN = (() => {
  if (process.env.API_TOKEN) return process.env.API_TOKEN;
  const tokenFile = path.join(USER_ROOT, '.api-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* 不存在，下面创建 */
  }
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    fs.writeFileSync(tokenFile, token, { flag: 'wx', mode: 0o600 });
    return token;
  } catch {
    try {
      return fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      return '';
    }
  }
})();
