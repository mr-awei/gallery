import type { ThemePackTheme } from './lib/theme-pack-vars';
import type {
  AdjustParams,
  AnnotationItem,
  DupeGroup,
  ImageComment,
  TagNode,
  EditJobStatus,
  EditResult,
  EditSaveOptions,
  AiPreset,
  AiStatus,
  AiUpscaleStatus,
  AutoWallpaperConfig,
  EnhanceAiModel,
  EnhanceCandidates,
  EnhanceConfig,
  EnhanceJobStatus,
  EnhanceModel,
  EnhanceRemoteService,
  EnhanceStandard,
  AutoWallpaperStatus,
  CrawlStatus,
  NetworkConfig,
  Playlist,
  WallpaperLogItem,
  FeedbackItem,
  Filters,
  FolderNode,
  ImageItem,
  ImageNote,
  SavedFilter,
  KbRule,
  KbStats,
  Keyword,
  Library,
  Settings,
  SimilarGroups,
  Stats,
  SystemInfo,
  TrashItem,
  WallpaperMonitors,
  WallpaperResult,
  LiveWallpaperConfig,
  PluginInfo,
  PluginRunResult,
  LanShare,
  LanStatus,
} from './types';

export type { ThemePackTheme } from './lib/theme-pack-vars';

export interface ThemePackBrief {
  id: string;
  name: string;
  author: string;
  createdAt: string;
  base: 'dark' | 'light';
  varCount: number;
  settingKeys: string[];
  assetNames: string[];
  file: string;
}

export interface ThemePackFile {
  kind: string;
  version: number;
  id: string;
  name: string;
  author: string;
  createdAt: string;
  theme: ThemePackTheme;
  settings: Record<string, unknown>;
  assets: { name: string; dataUrl: string }[];
}

export interface AppInfo {
  /** 实际生效的全局快捷键（被占用时会自动换备用键） */
  hotkeys: Record<string, string>;
  /** 候选键全被占用、实际没注册上的（键名 → 试过的候选键串） */
  failedHotkeys?: Record<string, string>;
  shortcutEnabled: boolean;
  version: string;
  platform: string;
}

interface DesktopAPI {
  isDesktop: boolean;
  pickFolder: () => Promise<string | null>;
  openFolder: (path: string) => Promise<string | null>;
  /** 打开崩溃转储目录（桌面端） */
  openCrashDir?: () => Promise<string>;
  /** 打开运行日志目录（桌面端） */
  openLogDir?: () => Promise<string>;
  revealFile: (path: string) => Promise<boolean>;
  download: (url: string) => Promise<boolean>;
  /** 多窗口浏览：再开一个窗口看同一份图库 */
  openNewWindow?: () => Promise<{ ok: boolean; error?: string }>;
  /** 原生拖拽导出（桌面端把卡片拖到资源管理器/微信即落成文件） */
  dragOut?: (absPath: string) => void;
  appInfo?: () => Promise<AppInfo>;
  controlLiveWallpaper?: (patch: Partial<LiveWallpaperConfig>) => Promise<{ ok: boolean }>;
  /** 视频片段导出：data URL 交给主进程弹「另存为」写盘 */
  saveExport?: (p: { dataUrl: string; filename: string }) => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** 壁纸参数实时预览（拖动滑块即时生效，不重开窗口） */
  setLiveParams?: (params: Record<string, number>) => Promise<{ ok: boolean }>;
  pickFile?: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
  /** 打开内置微博登录窗，登录成功自动回传整段 Cookie 与登录 UA（浏览器模式下为 undefined） */
  weiboLogin?: () => Promise<{ ok: boolean; cookie?: string; ua?: string; msg?: string }>;
  /** 同步原生控件（下拉弹层等）主题，浏览器模式下为 undefined */
  setTheme?: (theme: 'dark' | 'light' | 'system') => Promise<string>;
  /** 本地 API 鉴权令牌（浏览器模式下为 undefined） */
  getApiToken?: () => Promise<string>;
  /** 开机自启（桌面端） */
  getAutoLaunch?: () => Promise<boolean>;
  setAutoLaunch?: (enabled: boolean) => Promise<boolean>;
  /** 检查更新（桌面端） */
  checkForUpdates?: () => Promise<UpdateCheckResult>;
  /** 吸管取色截图（桌面端），返回当前窗口内容 dataURL */
  screenCapture?: () => Promise<{ dataUrl?: string } | null>;
  /** 唤起区域框选（桌面端，全局快捷键 Ctrl+Shift+S） */
  captureScreenshot?: () => Promise<{ ok: boolean; pending?: boolean; error?: string }>;
  /** 框选底图：窗口所在屏的全分辨率截图（抓图前主进程会先藏起自己的窗口） */
  grabScreen?: () => Promise<{ dataUrl: string; width: number; height: number; scale: number } | null>;
  /** 框选结束：让主进程还原窗口尺寸/显示状态 */
  endShot?: () => Promise<boolean>;
  /** 主进程请求开始框选（快捷键/托盘触发） */
  onShotRequest?: (cb: () => void) => () => void;
  /** 订阅全局快捷键重新注册事件（设置里开关快捷键后即时更新提示），返回取消订阅函数 */
  onHotkeysChanged?: (
    cb: (p: { hotkeys: Record<string, string>; failed: Record<string, string> }) => void
  ) => () => void;
  /** 应用内更新（electron-updater）：检查 / 下载 / 重启安装 */
  updateCheck?: () => Promise<UpdateCheckResult & { supported?: boolean }>;
  updateDownload?: () => Promise<{ ok: boolean; msg?: string }>;
  updateInstall?: () => Promise<{ ok: boolean; msg?: string }>;
  updateState?: () => Promise<UpdateState>;
  onUpdateState?: (cb: (s: UpdateState) => void) => () => void;
  /** 本地服务重启中/已恢复（重启期间界面要遮住，避免用户对着失败请求操作） */
  onServiceState?: (cb: (s: { restarting: boolean; dead?: boolean; port?: number; error?: string }) => void) => () => void;
  /** 离线横幅上的一键重启（dev 模式下没有子进程可重启，会返回 ok:false） */
  restartService?: () => Promise<{ ok: boolean; error?: string }>;
  /** 忽略本次更新提示（安装失败时的出口） */
  updateDismiss?: () => Promise<{ ok: boolean }>;
  /** 清零连续安装失败计数，恢复强制更新策略 */
  updateResetFailures?: () => Promise<{ ok: boolean }>;
  /** 退出应用（强制更新失败时的兜底出口） */
  quit?: () => Promise<{ ok: boolean }>;
}

/** 采集源（/api/sources 下发，前端不再维护第二份硬编码列表） */
export interface SourceInfo {
  key: string;
  label: string;
  hint?: string;
  needsCookie?: boolean;
  /** crawl = 真正去网上搜的采集源；import = 本地导入（只用于筛选/统计） */
  kind: 'crawl' | 'import';
  enabled: boolean;
}

/** 采集参数与上限 */
export interface CrawlConfig {
  sources: SourceInfo[];
  limits: { maxPages: number; maxConcurrency: number };
  crawl: {
    pagesPerKeyword: number;
    concurrency: number;
    minResolution: number;
    minFileSize: number;
    maxFileSize: number;
  };
}

/** 后台任务（采集 / 批量编辑 / 增强 / 模型下载）的历史记录 */
export interface JobItem {
  id: number;
  kind: 'crawl' | 'edit' | 'enhance' | 'model-install' | string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled' | 'interrupted';
  progress: number;
  message: string;
  done: number;
  total: number;
  failed: number;
  error: string;
  payload: Record<string, unknown>;
  result: Record<string, number> | null;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
}

/** 操作日志（撤销栈）条目 */
export interface OpLogItem {
  id: number;
  op: string;
  summary: string;
  undone: boolean;
  undoable: boolean;
  createdAt: string;
}

/** 应用内更新状态（主进程广播） */
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  percent: number;
  version: string;
  notes: string;
  error: string;
  supported: boolean;
  current?: string;
  /** 已确认有新版本且要求强制更新：界面必须全屏遮挡，装完才允许继续用 */
  force?: boolean;
  /** 更新包已下载到本地、可以安装：界面此时才需要遮挡提示 */
  ready?: boolean;
  /** 用户选了「本次先继续用」，本次会话不再遮挡 */
  dismissed?: boolean;
  /** 连续装不上、强制更新已自动降级为非强制 */
  degraded?: boolean;
  /** 记录下来的连续安装失败次数 */
  installFailures?: number;
}

export const desktop = (window as unknown as { desktopAPI?: DesktopAPI }).desktopAPI;
export const isDesktop = !!desktop;

/** 桌面端信息（浏览器模式返回 null） */
export async function getAppInfo(): Promise<AppInfo | null> {
  try {
    return (await desktop?.appInfo?.()) || null;
  } catch {
    return null;
  }
}

/** 检查更新结果（桌面端） */
export interface UpdateCheckResult {
  ok: boolean;
  hasUpdate?: boolean;
  latest?: string;
  current?: string;
  url?: string;
  msg?: string;
}
/** 把 Electron 加速键文本转成更好读的写法：CommandOrControl+Alt+Shift+W → Ctrl+Alt+Shift+W */
export function prettyHotkey(acc?: string) {
  if (!acc) return '';
  return acc
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
    .split('+')
    .join('+');
}

/**
 * 复制纯文本到剪贴板。返回是否成功——调用方据此给「已复制 / 复制失败」，
 * 不再每个组件各写一份 try/catch 与各自的成功文案。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 下载文件。
 * 桌面端走 Electron 下载管理器（弹「另存为」），避免 window.open 拉出空白窗口；
 * 网页端退回 a[download] 点击。
 */
export function downloadFile(url: string) {
  if (desktop?.download) return desktop.download(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return Promise.resolve(true);
}

/**
 * 把图片复制到系统剪贴板（对标 Eagle 的 Ctrl+C），可直接粘到微信/PPT/聊天框。
 * 统一先转成 PNG 再写剪贴板：Chrome/Electron 只接受 image/png 的 ClipboardItem。
 */
export async function copyImageToClipboard(url: string) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('当前环境不支持写入剪贴板，请用「下载」');
  }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('图片加载失败'));
    el.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('转换 PNG 失败'))), 'image/png');
  });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** 单张格式转换导出的下载地址（实际下载交给 downloadFile，桌面端会弹「另存为」） */
export function exportImageUrl(id: number, opts: { format: string; quality?: number; maxSide?: number }) {
  const q = new URLSearchParams({ format: opts.format });
  if (opts.quality) q.set('quality', String(opts.quality));
  if (opts.maxSide) q.set('maxSide', String(opts.maxSide));
  return `/api/images/${id}/export?${q.toString()}`;
}

/** HTML 网页画廊导出地址：单文件、缩略图内嵌，可离线打开或丢到静态服务器 */
export function galleryExportUrl(opts: {
  scope?: 'all' | 'folder';
  folderId?: number | null;
  ids?: number[];
  title?: string;
  columns?: number;
  theme?: 'auto' | 'light' | 'dark';
  maxItems?: number;
}) {
  const q = new URLSearchParams();
  if (opts.scope) q.set('scope', opts.scope);
  if (opts.folderId) q.set('folderId', String(opts.folderId));
  if (opts.ids?.length) q.set('ids', opts.ids.join(','));
  if (opts.title) q.set('title', opts.title);
  if (opts.columns) q.set('columns', String(opts.columns));
  if (opts.theme) q.set('theme', opts.theme);
  if (opts.maxItems) q.set('maxItems', String(opts.maxItems));
  return `/api/export/gallery?${q.toString()}`;
}

/**
 * 批量打包导出的下载地址。
 * 传 format 时服务端逐张重编码（等价 Eagle 的「导出为 JPEG/PNG…」），不传则原样打包。
 */
export function exportZipUrl(ids: number[], opts: { format?: string; quality?: number; maxSide?: number } = {}) {
  const q = new URLSearchParams({ ids: ids.join(',') });
  if (opts.format) q.set('format', opts.format);
  if (opts.quality) q.set('quality', String(opts.quality));
  if (opts.maxSide) q.set('maxSide', String(opts.maxSide));
  return `/api/download/zip?${q.toString()}`;
}

/** 打开系统文件夹（桌面端走 Electron，网页端走服务端） */
export async function openFolder(path?: string) {
  if (desktop && !path) return desktop.openFolder('');
  return request<{ ok: boolean }>('/api/system/open-folder', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export async function revealFile(path: string) {
  if (desktop) return desktop.revealFile(path);
  return request<{ ok: boolean }>('/api/system/reveal', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export async function pickFolder() {
  if (!desktop) return null;
  return desktop.pickFolder();
}

export const BASE = (import.meta.env.VITE_API_BASE as string) || '';

/** 水印 / 相框的参数形状（服务端 normalizeParams 会再兜一层） */
export interface WatermarkParams {
  style?: string;
  frame?: string;
  fields?: string[];
  logo?: boolean;
  brand?: string;
  /** 手选/手写的型号（如 A7 IV）：会拼在品牌名后面，覆盖 EXIF 里的型号 */
  model?: string;
  size?: number;
  opacity?: number;
  /** 文字颜色：auto（跟随样式）/ light / dark，或 #rrggbb 自选色 */
  color?: string;
  /** 字体样式：auto 跟随各样式自带字形；内置键或 sys:<本机字体名> 统一替换 font-family */
  font?: string;
  /** 自定义拍摄地点：写了就用它，空着读 EXIF */
  location?: string;
  /** 三级选择器的选择结果：只用来还原面板，合成只认 location 字符串 */
  place?: { province: string; city: string; district: string; detail: string };
}

/** 拍摄地点的三级选择器：省 → 市 → 区/县（只有名字，没有行政代码） */
export interface GeoProvince {
  name: string;
  cities: { name: string; districts: string[] }[];
}

export interface WatermarkOptions {
  fields: { key: string; label: string; hint: string }[];
  /**
   * uses：这款样式会排哪些信息（空数组 = 勾了什么都排）；
   * needs：至少要有其中哪一项，否则什么都画不出来（如日期戳要时间/地点）。
   */
  watermarks: { id: string; name: string; desc: string; uses?: string[]; needs?: string[] }[];
  frames: { id: string; name: string; desc: string }[];
  /** 品牌清单（只含自己做机身/手机/无人机的品牌）；models 是这个品牌的常见/热门型号 */
  brands: { key: string; name: string; group?: string; models?: string[] }[];
  fonts: { key: string; name: string }[];
  /** 本机已装字体（服务端解析字体文件家族名得到），key 形如 sys:Microsoft YaHei */
  systemFonts: { key: string; name: string; group: string }[];
  defaults: WatermarkParams;
}

/**
 * 二进制响应（预览图）：错误时服务端回 JSON，这里把 error 抛成正常异常。
 * 预览是服务端实时合成的，比普通接口慢，超时给到 60s；没有超时的话
 * 服务卡住时前端会一直转圈，用户只能以为「预览坏了」。
 */
export async function postBlob(path: string, payload: unknown, timeoutMs = 60000): Promise<Blob> {
  return (await postBlobWithNote(path, payload, timeoutMs)).blob;
}

/**
 * 同 postBlob，但把服务端附在响应头上的说明也带回来。
 * 水印预览用：没有可显示的信息时仍然给原图，用 note 解释「为什么画面里没有水印」，
 * 报错和出图不再是二选一。
 */
export async function postBlobWithNote(
  path: string,
  payload: unknown,
  timeoutMs = 60000
): Promise<{ blob: Blob; note: string }> {
  const token = await getApiToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timedOut = { v: false };
  const timer = setTimeout(() => {
    timedOut.v = true;
    ctrl.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
  } catch (err) {
    if (timedOut.v) throw new Error(`预览生成超时（${Math.round(timeoutMs / 1000)}s）：${path}`);
    throw networkError(err, path);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('登录令牌已失效：请重启应用后重试');
    let message = `请求失败 ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* 非 JSON 错误体，保留状态码文案 */
    }
    throw new Error(message);
  }
  const noteHeader = res.headers.get('X-Watermark-Note') || '';
  let note = '';
  if (noteHeader) {
    try {
      note = decodeURIComponent(noteHeader);
    } catch {
      note = noteHeader;
    }
  }
  return { blob: await res.blob(), note };
}

/**
 * 静默但可见的错误兜底：替代裸 `.catch(() => {})`。
 * 失败不能只写一行 console —— 那会让「请求挂了」在界面上表现为「没有数据」，
 * 用户以为图库空了。现在除了记日志，还会通知订阅者（App 全局错误条）。
 */
type ApiErrorListener = (err: Error) => void;
const apiErrorListeners = new Set<ApiErrorListener>();

/** 订阅后台请求失败（返回取消订阅函数） */
export function onApiError(cb: ApiErrorListener) {
  apiErrorListeners.add(cb);
  return () => {
    apiErrorListeners.delete(cb);
  };
}

export const quiet = (err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  console.warn('[quiet]', e.message);
  for (const cb of apiErrorListeners) {
    try {
      cb(e);
    } catch {
      /* 订阅者自己出错不该反噬请求链 */
    }
  }
};

/** 默认请求超时：本地服务正常毫秒级返回，20s 已远超正常波动 */
const DEFAULT_TIMEOUT_MS = 20000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 网络层错误翻译。fetch 在连不上服务时只会抛 `TypeError: Failed to fetch`，
 * 用户看到的英文关键字既不知道哪坏了、也不知道怎么办 —— 本地服务其实就两种可能：
 * 进程退出了，或者端口被别的程序抢了。
 */
function networkError(err: unknown, path: string): Error {
  if (err instanceof TypeError) {
    return new Error(`连不上本地服务（${path}）：服务可能已退出，请重启「图库」后再试`);
  }
  return err as Error;
}

/**
 * 本地 API 鉴权令牌：桌面端经 preload 注入；纯浏览器模式从 ?token= 读取后
 * 存入 localStorage（服务端启动时打印带令牌的访问地址）。
 */
let tokenCache = '';
export async function getApiToken(): Promise<string> {
  if (tokenCache) return tokenCache;
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    tokenCache = fromUrl;
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    try {
      localStorage.setItem('tuku_api_token', fromUrl);
    } catch {
      /* 隐私模式等场景忽略 */
    }
    return tokenCache;
  }
  try {
    tokenCache = localStorage.getItem('tuku_api_token') || '';
  } catch {
    tokenCache = '';
  }
  if (tokenCache) return tokenCache;
  try {
    tokenCache = (await desktop?.getApiToken?.().catch(() => '')) || '';
  } catch {
    tokenCache = '';
  }
  if (tokenCache) {
    try {
      localStorage.setItem('tuku_api_token', tokenCache);
    } catch {
      /* ignore */
    }
  }
  return tokenCache;
}

type RequestOptions = RequestInit & { timeoutMs?: number; retries?: number };

async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const token = await getApiToken();
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries, ...fetchInit } = init ?? {};
  // GET 默认重试 1 次（网络抖动 / 5xx）；写操作不自动重试，避免重复副作用
  const maxRetries = retries ?? (fetchInit.method && fetchInit.method !== 'GET' ? 0 : 1);
  const external = fetchInit.signal;

  let attempt = 0;
  for (;;) {
    const timedOut = { v: false };
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      timedOut.v = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (external?.aborted) ctrl.abort();
    else external?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(BASE + path, { ...fetchInit, headers, signal: ctrl.signal });
      if (!res.ok) {
        // 401 单独说清楚：令牌存在 localStorage / preload 里，服务端重启换了令牌时
        // 后面每个请求都会 401，笼统的「请求失败 401」根本没法据此排查
        if (res.status === 401) throw new Error('登录令牌已失效：请重启应用后重试');
        if (res.status === 403) throw new Error('没有权限执行这个操作');
        let message = `请求失败 ${res.status}`;
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch {
          /* ignore */
        }
        if (attempt < maxRetries && res.status >= 500) {
          attempt++;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new Error(message);
      }
      // 204 / 空 body 是合法的成功响应（DELETE 之类），无条件 res.json() 会抛
      // SyntaxError → 被下面翻译成「服务端返回了无效数据」，成功的操作反而报错
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text.trim()) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error('服务端返回了无效数据');
      }
    } catch (err) {
      // 调用方主动取消：原样抛出，绝不重试
      if (external?.aborted) throw err;
      // 超时 / 网络级失败（fetch 抛 TypeError）才重试；JSON 解析错误、HTTP 错误不重试
      const retryable = attempt < maxRetries && (timedOut.v || err instanceof TypeError);
      if (retryable) {
        attempt++;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (timedOut.v) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${path}`);
      if (err instanceof SyntaxError) throw new Error('服务端返回了无效数据');
      throw networkError(err, path);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }
}

export function buildQuery(filters: Filters, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.source.length) params.set('source', filters.source.join(','));
  if (filters.favorite !== 'all') params.set('favorite', filters.favorite);
  if (filters.orientation !== 'all') params.set('orientation', filters.orientation);
  if (filters.bucket.length) params.set('bucket', filters.bucket.join(','));
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.seen && filters.seen !== 'all') params.set('seen', filters.seen);
  if (filters.minRating) params.set('minRating', String(filters.minRating));
  if (filters.hue) params.set('hue', filters.hue);
  if (filters.colorHex) {
    params.set('colorHex', filters.colorHex);
    params.set('colorTol', String(filters.colorTol ?? 48));
  }
  if (filters.kind && filters.kind !== 'all') params.set('kind', filters.kind);
  if (filters.pending) params.set(filters.pending, '1');
  params.set('sort', filters.sort || 'newest');
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params.toString();
}

export const api = {
  stats: () => request<Stats>('/api/stats'),
  images: (filters: Filters, page: number, pageSize: number, opts?: { signal?: AbortSignal }) =>
    request<{ items: ImageItem[]; total: number; page: number; pageSize: number; hasMore: boolean }>(
      `/api/images?${buildQuery(filters, page, pageSize)}`, opts
    ),
  /** 当前筛选条件下的全部 id（全选）：不翻页、不返回 DTO。
   *  文件夹视图必须带上 folderId，否则 Ctrl+A 会选中全库（跨文件夹批量操作）。 */
  imageIds: (filters: Filters, opts?: { signal?: AbortSignal; folderId?: number | null }) =>
    request<{ ids: number[]; total: number; truncated?: boolean }>(
      `/api/images/ids?${buildQuery(filters, 1, 1)}${opts?.folderId ? `&folderId=${opts.folderId}` : ''}`,
      { signal: opts?.signal }
    ),
  // 资源库（多资源库）
  libraries: () => request<{ libraries: Library[]; activeId: number | null }>('/api/libraries'),
  createLibrary: (payload: { name: string; rootPath?: string; libFolder?: string }) =>
    request<{ ok: boolean; id: number }>('/api/libraries', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  activateLibrary: (id: number) =>
    request<{ ok: boolean; library: Library }>(`/api/libraries/${id}/activate`, { method: 'POST' }),
  deleteLibrary: (id: number) =>
    request<{ ok: boolean; libraries: Library[]; activeId: number | null }>(`/api/libraries/${id}`, {
      method: 'DELETE',
    }),
  // 文件夹树（多层级文件夹）
  folders: () => request<{ folders: FolderNode[] }>('/api/folders'),
  folderImages: (id: number, page: number, pageSize: number, opts?: { signal?: AbortSignal }) =>
    request<{ items: ImageItem[]; total: number; hasMore: boolean }>(
      `/api/folders/${id}/images?page=${page}&pageSize=${pageSize}`, opts
    ),
  createFolder: (name: string, parentId?: number | null) =>
    request<{ ok: boolean; id: number; folders: FolderNode[] }>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    }),
  renameFolder: (id: number, name: string) =>
    request<{ ok: boolean; folders: FolderNode[] }>(`/api/folders/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  deleteFolder: (id: number) =>
    request<{ ok: boolean; removed: number; folders: FolderNode[] }>(`/api/folders/${id}`, {
      method: 'DELETE',
    }),
  addToFolder: (id: number, imageIds: number[]) =>
    request<{ ok: boolean; added: number; folders: FolderNode[] }>(`/api/folders/${id}/images`, {
      method: 'POST',
      body: JSON.stringify({ imageIds }),
    }),
  /** 设置文件夹封面；imageId 省略 = 恢复自动封面 */
  setFolderCover: (id: number, imageId?: number | null) =>
    request<{ ok: boolean; coverImageId: number | null; folders: FolderNode[] }>(`/api/folders/${id}/cover`, {
      method: 'PUT',
      body: JSON.stringify({ imageId: imageId ?? null }),
    }),
  /** 文件夹标签（夹内素材搜索时自动继承） */
  setFolderTags: (id: number, tags: string[]) =>
    request<{ ok: boolean; tags: string[]; folders: FolderNode[] }>(`/api/folders/${id}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tags }),
    }),

  /** 文件夹内手动排序：传拖动后的完整顺序 */
  reorderFolder: (id: number, imageIds: number[]) =>
    request<{ ok: boolean; folderId: number; updated: number }>(`/api/folders/${id}/order`, {
      method: 'PUT',
      body: JSON.stringify({ imageIds }),
    }),

  /** 文件夹外观：emoji / 图标字符 + 主题色（空串 = 清除） */
  setFolderAppearance: (id: number, appearance: { icon?: string; color?: string }) =>
    request<{ ok: boolean; icon?: string; color?: string; folders: FolderNode[] }>(
      `/api/folders/${id}/appearance`,
      { method: 'PUT', body: JSON.stringify(appearance) }
    ),

  /** 文件夹拖拽排序：同一父级下的完整顺序 */
  reorderFolders: (parentId: number | null, folderIds: number[]) =>
    request<{ ok: boolean; parentId: number | null; updated: number; folders: FolderNode[] }>(
      '/api/folders/reorder',
      { method: 'POST', body: JSON.stringify({ parentId, folderIds }) }
    ),

  /** 批量创建文件夹：一行/逗号一个名字，同父级下同名跳过 */
  createFoldersBatch: (names: string[], parentId?: number | null) =>
    request<{ ok: boolean; created: string[]; skipped: string[]; folders: FolderNode[] }>('/api/folders/batch', {
      method: 'POST',
      body: JSON.stringify({ names, parentId: parentId ?? null }),
    }),

  /** 批量创建标签（可同时归入一个分组） */
  createTagsBatch: (names: string[], group?: string) =>
    request<{ ok: boolean; created: string[]; tags: TagNode[]; groups: string[] }>('/api/tags/batch', {
      method: 'POST',
      body: JSON.stringify({ names, group }),
    }),

  /* ---------------------------- 图片堆叠（Stack） ---------------------------- */

  /** 把选中的素材合成一个堆叠（组主 = 评分最高的一张） */
  createStack: (imageIds: number[]) =>
    request<{ ok: boolean; stackId: number; ids: number[]; stacks: ImageItem[] }>('/api/stacks', {
      method: 'POST',
      body: JSON.stringify({ imageIds }),
    }),
  stackMembers: (id: number) =>
    request<{ ok: boolean; stackId: number; items: ImageItem[] }>(`/api/stacks/${id}`),
  /** 现有堆叠列表（并入其他堆叠时选目标） */
  stacksList: () =>
    request<{ ok: boolean; stacks: { stackId: number; title: string; count: number; thumbUrl: string }[] }>(
      '/api/stacks'
    ),
  /** 把 :id 这一组整体并入 intoId 那一组 */
  mergeStacks: (id: number, intoId: number) =>
    request<{ ok: boolean; stackId: number; added: number; stacks: ImageItem[] }>(`/api/stacks/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ intoId }),
    }),
  addToStack: (id: number, imageIds: number[]) =>
    request<{ ok: boolean; stackId: number; added: number; stacks: ImageItem[] }>(`/api/stacks/${id}/add`, {
      method: 'POST',
      body: JSON.stringify({ imageIds }),
    }),
  /** 指定堆叠封面（不按评分，用户点谁就是谁） */
  setStackPrimary: (id: number, imageId: number) =>
    request<{ ok: boolean; stackId: number; stacks: ImageItem[] }>(`/api/stacks/${id}/primary`, {
      method: 'POST',
      body: JSON.stringify({ imageId }),
    }),
  ungroupStack: (id: number) =>
    request<{ ok: boolean; removed: number }>(`/api/stacks/${id}`, { method: 'DELETE' }),
  removeFromStack: (id: number) =>
    request<{ ok: boolean; stackId: number; removed: number; image: ImageItem }>(`/api/images/${id}/stack`, {
      method: 'DELETE',
    }),

  /* ------------------------------- 素材笔记 ------------------------------- */

  imageNotes: (id: number) => request<{ ok: boolean; notes: ImageNote[] }>(`/api/images/${id}/notes`),
  /** ts > 0 = 钉在音视频的某个时间点（秒） */
  addImageNote: (id: number, body: string, ts = 0) =>
    request<{ ok: boolean; note: ImageNote }>(`/api/images/${id}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body, ts }),
    }),
  deleteImageNote: (noteId: number) =>
    request<{ ok: boolean; removed: number }>(`/api/notes/${noteId}`, { method: 'DELETE' }),

  /* ------------------------------ 保存的筛选器 ------------------------------ */

  savedFilters: () => request<{ ok: boolean; filters: SavedFilter[] }>('/api/saved-filters'),
  createSavedFilter: (name: string, query: Record<string, unknown>, icon = '') =>
    request<{ ok: boolean; id: number; filters: SavedFilter[] }>('/api/saved-filters', {
      method: 'POST',
      body: JSON.stringify({ name, query, icon }),
    }),
  updateSavedFilter: (id: number, patch: { name?: string; query?: Record<string, unknown>; icon?: string }) =>
    request<{ ok: boolean; filters: SavedFilter[] }>(`/api/saved-filters/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteSavedFilter: (id: number) =>
    request<{ ok: boolean; removed: number; filters: SavedFilter[] }>(`/api/saved-filters/${id}`, {
      method: 'DELETE',
    }),
  reorderSavedFilters: (ids: number[]) =>
    request<{ ok: boolean; filters: SavedFilter[] }>('/api/saved-filters/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  /* -------------------------------- 使用统计 -------------------------------- */

  /** 记一次使用：kind = copy（复制）/ export（导出、下载） */
  bumpUsage: (kind: 'copy' | 'export', ids: number[]) =>
    request<{ ok: boolean; updated: number }>('/api/images/usage', {
      method: 'POST',
      body: JSON.stringify({ kind, ids }),
    }),
  usageStats: () =>
    request<{
      ok: boolean;
      items: { id: number; title: string; copyCount: number; exportCount: number; lastUsedAt: string; thumbUrl: string }[];
      totals: { copies: number | null; exports: number | null };
    }>('/api/usage/stats'),

  /* ---------------- 隐私空间：文件夹密码锁 ---------------- */

  /** 给文件夹加/改密码；已有密码时必须带 oldPassword */
  setFolderPassword: (id: number, password: string, oldPassword = '') =>
    request<{ ok: boolean; id: number; locked: boolean; unlocked: boolean; folders: FolderNode[] }>(
      `/api/folders/${id}/password`,
      { method: 'PUT', body: JSON.stringify({ password, oldPassword }) }
    ),

  /** 移除密码（需旧密码） */
  clearFolderPassword: (id: number, password: string) =>
    request<{ ok: boolean; folders: FolderNode[] }>(`/api/folders/${id}/password`, {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    }),

  /** 本次会话解锁（重启自动回到锁定态） */
  unlockFolder: (id: number, password: string) =>
    request<{ ok: boolean; id: number; locked: boolean; unlocked: boolean; folders: FolderNode[] }>(
      `/api/folders/${id}/unlock`,
      { method: 'POST', body: JSON.stringify({ password }) }
    ),

  /** 手动重新上锁（密码保留） */
  sealFolder: (id: number) =>
    request<{ ok: boolean; folders: FolderNode[] }>(`/api/folders/${id}/seal`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /** 标签别名 / 同义词 */
  tagAliases: () => request<{ aliases: { alias: string; tag: string }[] }>('/api/tags/aliases'),
  setTagAlias: (alias: string, tag: string) =>
    request<{ ok: boolean; aliases: { alias: string; tag: string }[] }>('/api/tags/alias', {
      method: 'PUT',
      body: JSON.stringify({ alias, tag }),
    }),
  deleteTagAlias: (alias: string) =>
    request<{ ok: boolean; aliases: { alias: string; tag: string }[] }>(
      `/api/tags/alias/${encodeURIComponent(alias)}`,
      { method: 'DELETE' }
    ),

  /** 批量移出文件夹（只解除归类，不删图） */
  removeFromFolder: (id: number, imageIds: number[]) =>
    request<{ ok: boolean; removed: number; folders: FolderNode[] }>(`/api/folders/${id}/images`, {
      method: 'DELETE',
      body: JSON.stringify({ imageIds }),
    }),
  /** 某张图归属的文件夹（大图详情展示与移出） */
  imageFolders: (id: number) =>
    request<{ folders: { id: number; name: string; parent_id: number | null; path: string }[] }>(
      `/api/images/${id}/folders`
    ),
  /** 自动检测图像焦点：给定比例（如 '4:3'）返回最该保留的归一化框 */
  imageFocus: (id: number, ratio: string) =>
    request<{
      ok: boolean;
      ratio: string;
      rect: { x: number; y: number; w: number; h: number };
      point: { x: number; y: number };
      aspect: number;
      skinRatio: number;
    }>(`/api/images/${id}/focus?ratio=${encodeURIComponent(ratio)}`),
  patch: (id: number, patch: Partial<Pick<ImageItem, 'favorite' | 'tags' | 'title' | 'rating' | 'note'>>) =>
    request<ImageItem>(`/api/images/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  similarTo: (id: number, minCos: number) =>
    request<{ minCos: number; count: number; items: ImageItem[] }>(
      `/api/images/${id}/similar?minCos=${minCos}`
    ),
  // 整理：相似图审查 / 主色补算 / AI 打标
  tidyStats: () =>
    request<{ total: number; noDominant: number; noAiDesc: number; noRating: number; rated: number; noObjHash: number }>(
      '/api/tidy/stats'
    ),
  /** ids 为扫描范围（当前筛选结果 / 选区），省略即全库 */
  similar: (threshold?: number, ids?: number[]) => {
    const q = new URLSearchParams();
    if (threshold) q.set('threshold', String(threshold));
    if (ids?.length) q.set('ids', ids.join(','));
    const qs = q.toString();
    return request<SimilarGroups>(`/api/similar${qs ? `?${qs}` : ''}`);
  },
  similarClip: (minCos?: number, ids?: number[]) => {
    const q = new URLSearchParams();
    if (minCos) q.set('minCos', String(minCos));
    if (ids?.length) q.set('ids', ids.join(','));
    const qs = q.toString();
    return request<SimilarGroups>(`/api/similar/clip${qs ? `?${qs}` : ''}`);
  },
  clipStatus: () =>
    request<{ running: boolean; done: number; total: number; error: string; indexed: number; model: string; loadError: string }>(
      '/api/clip/status'
    ),
  clipBackfill: () => request<{ ok: boolean; total?: number; message?: string }>('/api/clip/backfill', { method: 'POST' }),
  formatDupes: (ids?: number[]) =>
    request<SimilarGroups>(`/api/dupes/format${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  resolveSimilar: (keepId: number, removeIds: number[]) =>
    request<{ ok: boolean; removed: number; failures: { id: number; error: string }[] }>(
      '/api/similar/resolve',
      { method: 'POST', body: JSON.stringify({ keepId, removeIds }) }
    ),
  tidySkipList: () => request<{ ids: number[] }>('/api/tidy/skip'),
  tidySkipAdd: (id: number) =>
    request<{ ok: boolean; ids: number[] }>('/api/tidy/skip', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  tidySkipReset: () =>
    request<{ ok: boolean; ids: number[] }>('/api/tidy/skip/reset', { method: 'POST' }),
  backfillDominant: (limit = 300) =>
    request<{ ok: boolean; done: number; remain: number }>('/api/maintenance/dominant', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  backfillSubject: (limit = 300) =>
    request<{ ok: boolean; done: number; remain: number; skipped: number }>('/api/maintenance/subject', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  // 维护工具：库体检 / 重建缩略图 / 清理孤儿缩略图 / 压缩数据库 / 重新扫描
  maintenanceStatus: () =>
    request<{
      total: number;
      withThumb: number;
      missing: number;
      thumbFiles: number;
      thumbBytes: number;
      dbPath: string;
      dbBytes: number;
      undoCount: number;
      sampleMissing: { id: number; path: string }[];
    }>('/api/maintenance/status'),
  maintenanceRebuildThumbs: (limit = 300, beforeId = 0) =>
    request<{ ok: boolean; rebuilt: number; skipped: number; failed: number; nextBeforeId: number }>(
      '/api/maintenance/rebuild-thumbs',
      { method: 'POST', body: JSON.stringify({ limit, beforeId }) }
    ),
  /** 后台补齐所有缺缩略图的记录（旧库合并 / 上次导入被打断后的自愈） */
  maintenanceRebuildMissing: () =>
    request<{ ok: boolean; started: boolean; total?: number; reason?: string }>('/api/maintenance/rebuild-missing', {
      method: 'POST',
    }),
  maintenanceOrphanThumbs: (dryRun = true) =>
    request<{ ok: boolean; dryRun: boolean; found: number; removed: number; sample: string[] }>(
      '/api/maintenance/orphan-thumbs',
      { method: 'POST', body: JSON.stringify({ dryRun }) }
    ),
  maintenanceVacuum: () =>
    request<{ ok: boolean; integrity: string; before: number; after: number; saved: number }>(
      '/api/maintenance/vacuum',
      { method: 'POST' }
    ),
  maintenanceRescan: () =>
    request<{ ok: boolean; message?: string; saved?: number }>('/api/maintenance/rescan', { method: 'POST' }),
  maintenanceProbeMedia: (limit = 200) =>
    request<{ ok: boolean; probed: number; skipped: number; remain: number }>(
      '/api/maintenance/probe-media',
      { method: 'POST', body: JSON.stringify({ limit }) }
    ),
  // 撤销覆盖写回（裁切/旋转/调色/增强）
  lastUndo: () =>
    request<{ last: { id: number; imageId: number; kind: string; createdAt: string } | null }>('/api/undo/last'),
  undo: (imageId?: number) =>
    request<{ item: ImageItem | null; kind: string }>('/api/undo', {
      method: 'POST',
      body: JSON.stringify({ imageId }),
    }),
  canUndo: (id: number) => request<{ canUndo: boolean }>(`/api/images/${id}/undo`),
  aiTagBatch: (limit = 6) =>
    request<{ ok: boolean; done: number; remain: number; results: { id: number; ok: boolean; error?: string }[] }>(
      '/api/ai/tag-batch',
      { method: 'POST', body: JSON.stringify({ limit }) }
    ),
  aiDesc: (id: number) =>
    request<{ imageId?: number; description?: string; issues?: string[]; quality?: number }>(`/api/images/${id}/ai`),
  analyzeImage: (id: number) =>
    request<{ ok: boolean; description: string; issues: string[]; quality: number }>(`/api/images/${id}/ai`, {
      method: 'POST',
    }),
  remove: (id: number) => request<{ ok: boolean }>(`/api/images/${id}`, { method: 'DELETE' }),
  markViewed: (id: number) =>
    request<{ ok: boolean; item: ImageItem }>(`/api/images/${id}/viewed`, { method: 'POST' }),
  /** 把当前筛选结果整体标记为已看 */
  markAllViewed: (filters: Filters) =>
    request<{ ok: boolean; affected: number }>('/api/images/viewed-all', {
      method: 'POST',
      body: JSON.stringify(filters),
    }),
  batch: (ids: number[], action: string, tag?: string) =>
    request<{ ok: boolean; affected: number }>('/api/images/batch', {
      method: 'POST',
      body: JSON.stringify({ ids, action, tag }),
    }),
  // 标签树：count + 分组 / 颜色 / 父标签（Eagle 的标签体系）
  tags: (opts?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.offset) qs.set('offset', String(opts.offset));
    const s = qs.toString();
    return request<{
      tags: TagNode[];
      groups: string[];
      total?: number;
      limit?: number;
      offset?: number;
    }>(`/api/tags${s ? `?${s}` : ''}`);
  },
  tagMeta: (payload: { tag: string; group?: string; color?: string; parent?: string; sortOrder?: number }) =>
    request<{ ok: boolean; meta: TagNode | null; tags: TagNode[]; groups: string[] }>('/api/tags/meta', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  reorderTags: (tags: string[]) =>
    request<{ ok: boolean; tags: TagNode[]; groups: string[] }>('/api/tags/reorder', {
      method: 'POST',
      body: JSON.stringify({ tags }),
    }),
  renameTagGroup: (from: string, to: string) =>
    request<{ ok: boolean; groups: string[]; tags: TagNode[] }>('/api/tags/group/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  deleteTagGroup: (name: string) =>
    request<{ ok: boolean; groups: string[]; tags: TagNode[] }>('/api/tags/group/delete', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  moveTag: (tag: string, parent: string) =>
    request<{ ok: boolean; tags: TagNode[]; groups: string[] }>('/api/tags/move', {
      method: 'POST',
      body: JSON.stringify({ tag, parent }),
    }),

  /* ---------------------- 标注 / 评论（Eagle Annotations） ---------------------- */
  annotations: (id: number) =>
    request<{ ok: boolean; items: AnnotationItem[]; updatedAt: string }>(`/api/images/${id}/annotations`),
  saveAnnotations: (id: number, items: AnnotationItem[]) =>
    request<{ ok: boolean; items: AnnotationItem[]; updatedAt: string }>(`/api/images/${id}/annotations`, {
      method: 'PUT',
      body: JSON.stringify({ items }),
    }),
  annotationCounts: () => request<{ ok: boolean; counts: Record<string, number> }>('/api/annotations/counts'),
  comments: (id: number) => request<{ ok: boolean; comments: ImageComment[] }>(`/api/images/${id}/comments`),
  addComment: (id: number, body: string, author = '') =>
    request<{ ok: boolean; comment: ImageComment }>(`/api/images/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, author }),
    }),
  deleteComment: (id: number) => request<{ ok: boolean }>(`/api/comments/${id}`, { method: 'DELETE' }),

  /* ------------------------------- 待整理视图 ------------------------------- */
  pending: () => request<{ total: number; noFolder: number; noTags: number; noRating: number }>('/api/organize/pending'),

  /* ------------------------- 完全重复（MD5，与 pHash 互补） ------------------------- */
  md5Dupes: () => request<{ ok: boolean; groups: DupeGroup[]; reclaim: number; missing: number }>('/api/dupes/md5'),
  md5Backfill: (limit = 400) =>
    request<{ ok: boolean; done: number; remaining: number }>('/api/dupes/md5/backfill', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  resolveDupes: (keepId: number, ids: number[]) =>
    request<{ ok: boolean; removed: number; failed?: { id: number; error: string }[]; keepId: number }>(
      '/api/dupes/md5/resolve',
      { method: 'POST', body: JSON.stringify({ keepId, ids }) }
    ),

  /* ------------------------------ 批量重命名 ------------------------------ */
  renameBatch: (
    ids: number[],
    template: string,
    start = 1,
    opts: { pad?: number; find?: string; replace?: string; caseMode?: string } = {}
  ) =>
    request<{
      ok: boolean;
      renamed: number;
      failed: number;
      results: Array<{ id: number; ok: boolean; title?: string; error?: string }>;
    }>('/api/images/rename-batch', {
      method: 'POST',
      body: JSON.stringify({ ids, template, start, ...opts }),
    }),

  /* --------------------------- 音视频元数据 / 封面 --------------------------- */
  patchMedia: (
    id: number,
    patch: { duration?: number; width?: number; height?: number; coverTs?: number; trimStart?: number; trimEnd?: number }
  ) =>
    request<{ ok: boolean; image: ImageItem }>(`/api/images/${id}/media`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  setCover: (id: number, dataUrl: string, ts?: number) =>
    request<{ ok: boolean; image: ImageItem }>(`/api/images/${id}/cover`, {
      method: 'POST',
      body: JSON.stringify({ dataUrl, ts }),
    }),
  resetCover: (id: number) =>
    request<{ ok: boolean; image: ImageItem }>(`/api/images/${id}/cover`, { method: 'DELETE' }),

  /* --------------------------- 拖拽 / 粘贴入库 --------------------------- */
  uploadFile: async (file: File, opts: { tags?: string; keyword?: string } = {}) => {
    const q = new URLSearchParams({ filename: file.name });
    if (opts.tags) q.set('tags', opts.tags);
    if (opts.keyword) q.set('keyword', opts.keyword);
    // 大文件（视频）用长超时；写操作不自动重试
    return request<{ ok: boolean; image: ImageItem }>(`/api/import/upload?${q.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
      timeoutMs: 300000,
      retries: 0,
    });
  },
  // 插件 / 脚本宿主
  plugins: () => request<{ ok: boolean; plugins: PluginInfo[]; permissions: string[] }>('/api/plugins'),
  runPlugin: (
    id: string,
    payload: { action?: string; imageId?: number | null; args?: Record<string, unknown> }
  ) =>
    request<PluginRunResult>(`/api/plugins/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  openPluginDir: () => request<{ ok: boolean; dir: string }>('/api/plugins/open-folder', { method: 'POST' }),

  // 局域网 / 手机扫码投送
  lanStatus: () => request<LanStatus>('/api/lan/status'),
  setLanAccess: (enabled: boolean) =>
    request<LanStatus>('/api/lan/toggle', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  rotateLanToken: () => request<LanStatus>('/api/lan/rotate-token', { method: 'POST' }),
  createLanShare: (minutes: number) =>
    request<LanShare>('/api/lan/share', { method: 'POST', body: JSON.stringify({ minutes }) }),
  lanShares: () => request<{ ok: boolean; shares: LanShare[] }>('/api/lan/shares'),
  revokeLanShares: () => request<{ ok: boolean; revoked: number }>('/api/lan/share', { method: 'DELETE' }),

  settings: () => request<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  keywords: () => request<Keyword[]>('/api/keywords'),
  addKeyword: (text: string) =>
    request<{ ok: boolean; keywords: Keyword[] }>('/api/keywords', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  updateKeyword: (id: number, patch: Partial<Keyword>) =>
    request<{ ok: boolean; keywords: Keyword[] }>(`/api/keywords/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteKeyword: (id: number) =>
    request<{ ok: boolean; keywords: Keyword[] }>(`/api/keywords/${id}`, { method: 'DELETE' }),
  crawlStatus: () => request<CrawlStatus>('/api/crawl/status'),
  /** 采集源与采集参数（唯一事实来源在后端，前端不再硬编码源列表/并发上限） */
  crawlConfig: () => request<CrawlConfig>('/api/sources'),
  crawlStart: (payload: { keywords?: string[]; sources?: string[]; pages?: number }) =>
    request<{ ok: boolean; message?: string }>('/api/crawl/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  crawlStop: () => request<{ ok: boolean }>('/api/crawl/stop', { method: 'POST' }),
  network: () => request<NetworkConfig>('/api/network'),
  saveNetwork: (patch: Partial<NetworkConfig>) =>
    request<NetworkConfig>('/api/network', { method: 'PUT', body: JSON.stringify(patch) }),
  testNetwork: () =>
    request<{
      ok: boolean;
      mode: string;
      proxy: string;
      elapsed: number;
      results: { url: string; ok: boolean; status?: number; ms: number; error?: string }[];
    }>('/api/network/test', { method: 'POST' }),
  importLocal: () => request<{ ok: boolean }>('/api/import/local', { method: 'POST' }),
  importStatus: () =>
    request<{
      running: boolean;
      progress: number;
      message: string;
      /** 扫描整体失败时的原因（和「完成 0 张」是两回事） */
      error?: string;
      result?: {
        total?: number;
        saved?: number;
        duplicate?: number;
        dropped?: number;
        errors?: number;
        unchanged?: number;
        cancelled?: number;
        /** 超过深度上限没被扫描的目录（非空时界面要提示，不能假装导入完整） */
        depthSkippedDirs?: string[];
      };
    }>('/api/import/status'),
  systemInfo: () => request<SystemInfo>('/api/system/info'),
  /** 浏览器扩展：目录 / 版本 / 固定 ID（装不上时用来核对） */
  extensionInfo: () =>
    request<{ ok: boolean; dir: string; version: string; name: string; id: string; exists: boolean }>(
      '/api/extension/info'
    ),
  /** 资源管理器里打开扩展目录（Electron 里才有意义，网页端返回路径） */
  openExtensionDir: () => request<{ ok: boolean; dir: string }>('/api/extension/open', { method: 'POST' }),
  wallpaper: (id: number, style?: string) =>
    request<WallpaperResult>(`/api/images/${id}/wallpaper`, {
      method: 'POST',
      body: JSON.stringify({ style }),
    }),
  wallpaperPreviewUrl: (id: number, style?: string) =>
    `/api/images/${id}/wallpaper-preview${style ? `?style=${style}` : ''}`,

  // AI
  aiPresets: () => request<Record<string, AiPreset>>('/api/ai/presets'),
  aiStatus: () => request<AiStatus>('/api/ai/status'),
  aiTest: () =>
    request<{ ok: boolean; model?: string; models?: string[]; reply?: string }>('/api/ai/test', { method: 'POST' }),
  aiModels: () => request<{ ok: boolean; models: string[] }>('/api/ai/models', { method: 'POST' }),
  aiAnalyze: (id: number) =>
    request<{ ok: boolean; description: string; issues: string[]; quality: number }>('/api/ai/analyze', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  aiSummarize: () =>
    request<{ ok: boolean; added?: number; before?: number; after?: number; summary: string }>('/api/ai/summarize', {
      method: 'POST',
    }),
  aiSuggest: () => request<{ ok: boolean; text: string }>('/api/ai/suggest', { method: 'POST' }),

  // 知识库
  kbRules: () => request<KbRule[]>('/api/kb/rules'),
  kbRulesPaged: (opts: { limit?: number; offset?: number } = {}) =>
    request<{ items: KbRule[]; total: number; limit: number; offset: number }>(
      `/api/kb/rules?limit=${Number(opts.limit) || 100}&offset=${Number(opts.offset) || 0}`
    ),
  kbUpdateRule: (id: number, patch: Partial<KbRule>) =>
    request<{ ok: boolean; rules: KbRule[] }>(`/api/kb/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  kbDeleteRule: (id: number) =>
    request<{ ok: boolean; rules: KbRule[] }>(`/api/kb/rules/${id}`, { method: 'DELETE' }),
  kbFeedback: () => request<FeedbackItem[]>('/api/kb/feedback'),
  kbDeleteFeedback: (id: number) => request<{ ok: boolean }>(`/api/kb/feedback/${id}`, { method: 'DELETE' }),
  kbRescore: () => request<{ ok: boolean; updated: number; low: number }>('/api/kb/rescore', { method: 'POST' }),
  kbStats: () => request<KbStats>('/api/kb/stats'),

  // 壁纸库文件夹管理
  deleteWithReason: (id: number, payload: { reasons: string[]; note: string; aiAnalysis: string }) =>
    request<{ ok: boolean; feedbackId: number }>(`/api/images/${id}/delete-reason`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  renameImage: (id: number, title: string) =>
    request<ImageItem>(`/api/images/${id}/rename`, { method: 'POST', body: JSON.stringify({ title }) }),

  // 画质增强
  enhanceStandards: () =>
    request<{ standards: EnhanceStandard[]; config: EnhanceConfig }>('/api/enhance/standards'),
  enhanceCandidates: (standard?: string) =>
    request<EnhanceCandidates>(
      `/api/enhance/candidates${standard ? `?standard=${encodeURIComponent(standard)}` : ''}`,
      { cache: 'no-store' } // 增强后尺寸会变，必须绕开浏览器缓存拿最新列表
    ),
  enhanceModels: () =>
    request<{
      builtin: EnhanceModel[];
      remote: EnhanceRemoteService[];
      ai: EnhanceAiModel[];
      aiInstalled: boolean;
    }>('/api/enhance/models'),
  enhanceRemoteTest: (service: EnhanceRemoteService) =>
    request<{ ok: boolean; elapsed: number; bytes?: number; width?: number; height?: number; message: string }>(
      '/api/enhance/remote/test',
      { method: 'POST', body: JSON.stringify({ service }) }
    ),
  enhanceJob: () => request<EnhanceJobStatus>('/api/enhance/job'),
  enhanceJobStart: (ids: number[], model: string, standard?: string) =>
    request<{ ok: boolean } & EnhanceJobStatus>('/api/enhance/job/start', {
      method: 'POST',
      body: JSON.stringify({ ids, model, standard }),
    }),
  enhanceJobCancel: () => request<{ ok: boolean } & EnhanceJobStatus>('/api/enhance/job/cancel', { method: 'POST' }),
  aiUpscaleStatus: () => request<AiUpscaleStatus>('/api/ai/upscale/status'),
  aiUpscaleInstall: () => request<{ ok: boolean } & AiUpscaleStatus>('/api/ai/upscale/install', { method: 'POST' }),
  aiUpscaleInstallModel: (id: string) =>
    request<{ ok: boolean; model?: { id: string; label: string; installed: boolean } }>('/api/ai/upscale/install-model', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  aiUpscaleInstallCugan: () =>
    request<{ ok: boolean; installed?: boolean; models?: string[] }>('/api/ai/upscale/install-cugan', {
      method: 'POST',
    }),
  aiSrStatus: () =>
    request<{
      loading: string;
      progress: number;
      message: string;
      error: string;
      models: { id: string; repo: string; label: string; desc: string; scale: number; downloaded: boolean; loaded: boolean }[];
    }>('/api/ai/sr/status'),
  aiSrLoad: (id: string) =>
    request<{ ok: boolean } & {
      loading: string;
      progress: number;
      message: string;
      models: { id: string; label: string; downloaded: boolean }[];
    }>('/api/ai/sr/load', { method: 'POST', body: JSON.stringify({ id }) }),
  aiUpscaleSelfTest: () =>
    request<{ ok: boolean; gpu: string | null; error: string }>('/api/ai/upscale/selftest', { method: 'POST' }),
  enhanceImage: (id: number, model: string, standard?: string) =>
    // noop=true 表示已达标、文件没被改动，前端不能再报「已增强至 W×H」
    request<{ ok: boolean; noop?: boolean; message?: string; item: ImageItem }>('/api/enhance/' + id, {
      method: 'POST',
      body: JSON.stringify({ model, standard }),
    }),
  enhanceBatch: (ids: number[], model: string, standard?: string) =>
    request<{
      ok: boolean;
      success: number;
      skipped: number;
      total: number;
      results: { id: number; ok: boolean; noop?: boolean; error?: string }[];
    }>(
      '/api/enhance/batch',
      { method: 'POST', body: JSON.stringify({ ids, model, standard }) }
    ),
  rotateImage: (id: number, dir: 'cw' | 'ccw') =>
    request<{ ok: boolean; item: ImageItem }>(`/api/images/${id}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ dir }),
    }),
  // 裁切：ratio 预设（'1:1'/'16:9'…）会先做焦点检测再裁；'free'/'orig' 需带归一化框 rect
  // 追加 saveMode:'copy' + targetDir 则另存副本到该目录，原图不动（addToLibrary 可把副本登记入库）
  // outWidth/outHeight：裁完重采样到指定像素（批量裁切台的「宽/高」，与单张裁切共用）
  // 返回 focus: 'detected' = 按检测到的焦点裁；'center' = 没检测到主体，退回居中裁
  cropImage: (
    id: number,
    opts: {
      ratio: string;
      rect?: { x: number; y: number; w: number; h: number };
      outWidth?: number;
      outHeight?: number;
    } & EditSaveOptions
  ) =>
    request<EditResult & { focus?: 'detected' | 'center' }>(`/api/images/${id}/crop`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  // Camera Raw 调色：色温/色调/曝光/对比度/饱和度/锐化，全 0 时原样返回（另存模式除外）
  adjustImage: (id: number, params: Partial<AdjustParams> & EditSaveOptions) =>
    request<EditResult>(`/api/images/${id}/adjust`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  /** 擦除修复：mask 为画笔导出的 PNG data URL（白色 = 擦掉），走与调色相同的撤销链路 */
  inpaintImage: (id: number, opts: { mask: string; strength?: number } & EditSaveOptions) =>
    request<EditResult & { coverage: number }>(`/api/images/${id}/inpaint`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /* ------------------------ 水印 / 相框 ------------------------ */
  /** 23 款水印 + 20 款相框 + 可选信息项 + 品牌清单 + 本机字体（服务端是唯一来源） */
  watermarkOptions: () => request<WatermarkOptions>('/api/watermark/options'),
  /** 重新扫描本机字体（用户刚装完字体时点「刷新字体」） */
  watermarkFonts: () =>
    request<{ fonts: { key: string; name: string; group: string }[] }>('/api/watermark/fonts?refresh=1'),
  /** 拍摄地点三级选择器数据（省/市/区），55KB，前端取一次就够 */
  geoRegions: () => request<{ provinces: GeoProvince[] }>('/api/geo/regions'),
  /** 预览：返回 JPEG 二进制，长边压到 1400，调参时高频刷新也不重。
      同时带回服务端说明：没有可显示信息时仍出原图，用 note 解释原因 */
  watermarkPreview: (id: number, params: WatermarkParams) =>
    postBlobWithNote(`/api/images/${id}/watermark/preview`, params),
  /** 单张应用：默认覆盖原图（有撤销备份），saveMode='copy' 时另存 */
  watermarkImage: (id: number, params: WatermarkParams & EditSaveOptions) =>
    request<EditResult & { width: number; height: number }>(`/api/images/${id}/watermark`, {
      method: 'POST',
      body: JSON.stringify(params),
      timeoutMs: 120000,
    }),
  // 批量编辑（异步任务）：op='crop' 用 {ratio, rect?}，op='adjust' 用调色参数
  batchEdit: (ids: number[], op: 'crop' | 'adjust' | 'watermark', params: Record<string, unknown>) =>
    request<{ ok: boolean; job: EditJobStatus }>('/api/images/batch/edit', {
      method: 'POST',
      body: JSON.stringify({ ids, op, params }),
    }),
  /** 可见区预览预热：把屏幕上真正看得见的几张挪到服务端预取队首（只排队不生成） */
  warmPreviews: (ids: number[]) =>
    request<{ ok: boolean; moved: number; added: number }>('/api/images/previews/warm', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  editJob: () => request<EditJobStatus>('/api/edit/job'),
  cancelEditJob: () => request<EditJobStatus>('/api/edit/job/cancel', { method: 'POST' }),
  scanFolder: () =>
    request<{
      ok: boolean;
      total?: number;
      saved?: number;
      duplicate?: number;
      dropped?: number;
      errors?: number;
      message?: string;
    }>('/api/library/scan', {
      method: 'POST',
    }),
  missingFiles: () => request<{ count: number; ids: number[] }>('/api/library/missing'),
  purgeMissing: () => request<{ ok: boolean; removed: number }>('/api/library/purge-missing', { method: 'POST' }),
  relocateMissing: () =>
    request<{ ok: boolean; relocated: number; remaining: number }>('/api/library/relocate-missing', {
      method: 'POST',
    }),

  // 清单
  playlists: () => request<Playlist[]>('/api/playlists'),
  createPlaylist: (name: string, description = '') =>
    request<{ ok: boolean; playlists: Playlist[] }>('/api/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  updatePlaylist: (id: number, patch: Partial<Playlist>) =>
    request<{ ok: boolean; playlists: Playlist[] }>(`/api/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deletePlaylist: (id: number) =>
    request<{ ok: boolean; playlists: Playlist[] }>(`/api/playlists/${id}`, { method: 'DELETE' }),
  playlistImages: (id: number) => request<ImageItem[]>(`/api/playlists/${id}/images`),
  addToPlaylist: (id: number, ids: number[]) =>
    request<{ ok: boolean; added: number; playlists: Playlist[] }>(`/api/playlists/${id}/images`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  removeFromPlaylist: (id: number, imageId: number) =>
    request<{ ok: boolean; playlists: Playlist[] }>(`/api/playlists/${id}/images/${imageId}`, {
      method: 'DELETE',
    }),

  // 定时切换壁纸
  autoWallpaper: () => request<AutoWallpaperStatus>('/api/wallpaper/auto'),
  wallpaperMonitors: () => request<WallpaperMonitors>('/api/wallpaper/monitors'),
  currentWallpaper: () =>
    request<{ imageId?: number; title?: string; favorite?: boolean }>('/api/wallpaper/current'),
  favoriteCurrentWallpaper: () =>
    request<{ ok: boolean; imageId: number; title: string }>('/api/wallpaper/current/favorite', {
      method: 'POST',
    }),
  dislikeCurrentWallpaper: () =>
    request<{ ok: boolean; skipped: number | null; learned?: string[] }>('/api/wallpaper/current/dislike', {
      method: 'POST',
    }),
  // 动态壁纸
  platform: () =>
    request<{
      ok: boolean;
      platform: string;
      family: string;
      liveWallpaper: boolean;
      desktopLayer: boolean;
      staticWallpaper: boolean;
      screensaver: boolean;
      gpuMeter: boolean;
      foregroundApp: boolean;
      summary: string;
      notes: string[];
    }>('/api/platform'),

  /* ------------------------------ 多端同步 ------------------------------ */
  syncStatus: () =>
    request<{
      ok: boolean;
      enabled: boolean;
      syncDir: string;
      deviceId: string;
      localRevision: number;
      remoteRevision: number;
      remoteDevice: string;
      publishedAt: string;
      libraryName: string;
      dirty: boolean;
      manifestError: string;
      note: string;
    }>('/api/sync/status'),
  syncConfigure: (syncDir: string) =>
    request<{ ok: boolean; enabled: boolean; syncDir?: string; note?: string }>('/api/sync/configure', {
      method: 'POST',
      body: JSON.stringify({ syncDir }),
    }),
  syncPublish: (force?: boolean) =>
    request<{ ok: boolean; unchanged: boolean; revision: number; bytes?: number; note: string }>('/api/sync/publish', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  syncPull: (force?: boolean) =>
    request<{
      ok: boolean;
      skipped: boolean;
      revision: number;
      reason?: string;
      libraryId?: number;
      libraryName?: string;
      remapped?: number;
      missing?: number;
      note?: string;
    }>('/api/sync/pull', { method: 'POST', body: JSON.stringify({ force }) }),

  /* --------------------------- 创意工坊 / 主题包 --------------------------- */
  workshopPacks: () =>
    request<{ ok: boolean; items: ThemePackBrief[]; dir: string }>('/api/workshop/packs'),
  workshopExport: (body: {
    name: string;
    author?: string;
    theme: ThemePackTheme;
    includeSettings?: boolean;
    assets?: { name: string; dataUrl: string }[];
  }) =>
    request<{ ok: boolean; pack: ThemePackFile; file: string; skipped: string[] }>('/api/workshop/export', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  workshopImport: (data: string) =>
    request<{
      ok: boolean;
      pack: ThemePackBrief;
      theme: ThemePackTheme;
      file: string;
      assetPaths: string[];
      appliedSettings: string[];
      skipped: string[];
    }>('/api/workshop/import', { method: 'POST', body: JSON.stringify({ data }) }),
  workshopApply: (id: string) =>
    request<{ ok: boolean; theme: ThemePackTheme; appliedSettings: string[]; skipped: string[] }>(
      '/api/workshop/apply',
      { method: 'POST', body: JSON.stringify({ id }) }
    ),
  workshopDelete: (id: string) => request<{ ok: boolean }>(`/api/workshop/packs/${id}`, { method: 'DELETE' }),
  workshopDownload: (id: string) => `/api/workshop/packs/${id}/file`,
  liveWallpaper: () => request<LiveWallpaperConfig>('/api/wallpaper/live'),
  saveLiveWallpaper: (patch: Partial<LiveWallpaperConfig>) =>
    request<LiveWallpaperConfig>('/api/wallpaper/live', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  saveAutoWallpaper: (patch: Partial<AutoWallpaperConfig>) =>
    request<AutoWallpaperStatus>('/api/wallpaper/auto', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  switchWallpaperNow: (scope?: string, playlistId?: number | null) =>
    request<{ ok: boolean; imageId: number; title: string; generated: boolean }>(
      '/api/wallpaper/now',
      { method: 'POST', body: JSON.stringify({ scope, playlistId }) }
    ),
  wallpaperHistory: () => request<WallpaperLogItem[]>('/api/wallpaper/history'),
  // AI 壁纸闭环：适配度查询 / 补算 / 反馈
  wallpaperFit: (id: number, ai = false) =>
    request<{ ok: boolean; fit: { score: number; safe_area: string; reason: string; source: string } | null }>(
      `/api/wallpaper/fit/${id}?ai=${ai ? 1 : 0}`
    ),
  scanWallpaperFit: (limit = 120, ai = false) =>
    request<{ ok: boolean; done: number; remain: number }>('/api/wallpaper/scan-fit', {
      method: 'POST',
      body: JSON.stringify({ limit, ai }),
    }),
  wallpaperFeedback: (imageId: number, like: boolean) =>
    request<{ ok: boolean }>('/api/wallpaper/feedback', { method: 'POST', body: JSON.stringify({ imageId, like }) }),
  // 本地偏好模型（个性化推荐）
  prefStatus: () =>
    request<{
      trained: boolean;
      trainedAt: string | null;
      samples: number;
      pos: number;
      neg: number;
      featureCount: number;
      top: { feature: string; w: number }[];
    }>('/api/pref/status'),
  // AI 去背景
  mattingStatus: () =>
    request<{
      downloaded: boolean;
      downloading: boolean;
      progress: number;
      message: string;
      error: string;
      cancelled?: boolean;
      size: number;
    }>('/api/ai/matting/status'),
  /** 后台下载：立刻返回，进度看 mattingStatus / 任务中心 */
  mattingInstall: () =>
    request<{ ok: boolean; started?: boolean; downloaded?: boolean }>('/api/ai/matting/install', { method: 'POST' }),
  mattingCancel: () => request<{ ok: boolean }>('/api/ai/matting/cancel', { method: 'POST' }),

  /* ---------------- 任务中心 / 操作撤销 ---------------- */
  jobs: (kind = '', limit = 20) =>
    request<JobItem[]>(`/api/jobs?kind=${encodeURIComponent(kind)}&limit=${limit}`),
  cancelJob: (id: number) => request<{ ok: boolean; message?: string }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  retryJob: (id: number) => request<{ ok: boolean }>(`/api/jobs/${id}/retry`, { method: 'POST' }),
  ops: (limit = 30) => request<OpLogItem[]>(`/api/ops?limit=${limit}`),
  undoOp: (id: number) =>
    request<{ ok: boolean; op: string; info: Record<string, number> | null }>(`/api/ops/${id}/undo`, { method: 'POST' }),
  undoLastOp: () =>
    request<{ ok: boolean; op: string; info: Record<string, number> | null }>('/api/ops/undo-last', { method: 'POST' }),
  // mode: 'ai'（人像/宠物分割，需要模型）| 'flat'（纯底图：白底/灰底等任意纯色，零模型）
  // warning: 人像模型对风景/物体常抠出废图、纯底图抠不干净时，后端会带一句人话提示
  removeBackground: (id: number, mode: 'ai' | 'flat' = 'ai') =>
    request<{ ok: boolean; mode?: string; reason?: string; id?: number; coverage?: number; warning?: string }>(
      `/api/images/${id}/remove-bg`,
      { method: 'POST', body: JSON.stringify({ mode }) }
    ),
  prefTrain: () =>
    request<{ ok: boolean; samples?: number; pos?: number; neg?: number; updated?: number; message?: string; top?: { feature: string; w: number }[] }>(
      '/api/pref/train',
      { method: 'POST' }
    ),

  // 回收站：带 limit 走服务端分页（返回 items + total），不带则维持一次性取全部
  trash: (params?: { limit?: number; offset?: number; q?: string }) => {
    if (!params?.limit) return request<TrashItem[]>('/api/trash');
    const qs = new URLSearchParams({ limit: String(params.limit) });
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.q) qs.set('q', params.q);
    return request<{ items: TrashItem[]; total: number }>(`/api/trash?${qs}`);
  },
  restoreTrash: (id: number) => request<ImageItem>(`/api/trash/${id}/restore`, { method: 'POST' }),
  deleteTrash: (id: number) => request<{ ok: boolean }>(`/api/trash/${id}`, { method: 'DELETE' }),
  emptyTrash: () => request<{ ok: boolean; removed: number }>('/api/trash/empty', { method: 'POST' }),
  clearLibrary: () =>
    request<{
      ok: boolean;
      removed: number;
      /** 移动失败、仍保留在图库里的条目（文件被占用等） */
      failed?: Array<{ id: number; path: string; error: string }>;
    }>('/api/library', { method: 'DELETE' }),

  // 检索：颜色 / AI / 以图
  searchColor: (hex: string, tol = 48, limit = 120) =>
    request<{ hex: string; tolerance: number; total: number; items: ImageItem[] }>(
      `/api/search/color?hex=${encodeURIComponent(hex)}&tol=${tol}&limit=${limit}`
    ),
  /** 保存网页书签：抓标题/描述/封面，并存一份离线 HTML 快照 */
  saveBookmark: (payload: { url: string; tags?: string[]; note?: string }) =>
    request<{ ok: boolean; item: ImageItem }>('/api/bookmarks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // 自然语言搜图：engine=clip 才是真语义召回；降级时会带回 reason 和 keywords
  semanticSearch: (query: string, limit = 60) =>
    request<{
      total: number;
      items: (ImageItem & { cos?: number })[];
      engine?: 'clip' | 'llm' | 'keyword' | 'loading';
      degraded?: boolean;
      reason?: string;
      keywords?: string[];
      covered?: { indexed: number; total: number };
    }>('/api/search/semantic', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
  // engine 是后端真实用的通道（llm 抽词 / 纯关键词），degraded=配了 AI 但解析失败
  aiSearch: (query: string, limit = 60) =>
    request<{
      query: string;
      total: number;
      items: ImageItem[];
      engine?: 'llm' | 'keyword';
      degraded?: boolean;
      reason?: string;
      keywords?: string[];
    }>('/api/search/ai', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
  // engine: clip = 深度特征；phash = 感知哈希（结果里带 hamming）
  searchByImage: (dataUrl: string, maxHamming = 10, limit = 24) =>
    request<{
      total: number;
      items: (ImageItem & { hamming?: number; cos?: number })[];
      engine?: 'clip' | 'phash';
    }>('/api/search/by-image', {
      method: 'POST',
      body: JSON.stringify({ image: dataUrl, maxHamming, limit }),
    }),

  // 标签管理
  renameTag: (oldName: string, newName: string) =>
    request<{ ok: boolean; affected: number; tags: { tag: string; count: number }[] }>('/api/tags/rename', {
      method: 'POST',
      body: JSON.stringify({ oldName, newName }),
    }),
  deleteTag: (name: string) =>
    request<{ ok: boolean; affected: number; tags: { tag: string; count: number }[] }>('/api/tags/delete', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  mergeTags: (from: string, to: string) =>
    request<{ ok: boolean; affected: number; tags: { tag: string; count: number }[] }>('/api/tags/merge', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),

  // 智能文件夹
  smartFolders: () => request<SmartFolder[]>('/api/smart-folders'),
  createSmartFolder: (payload: { name: string; rules?: Record<string, unknown>; autoTags?: string[] }) =>
    request<{ ok: boolean; folders: SmartFolder[] }>('/api/smart-folders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateSmartFolder: (
    id: number,
    patch: { name?: string; rules?: Record<string, unknown>; autoTags?: string[] }
  ) =>
    request<{ ok: boolean; folders: SmartFolder[] }>(`/api/smart-folders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteSmartFolder: (id: number) =>
    request<{ ok: boolean; folders: SmartFolder[] }>(`/api/smart-folders/${id}`, { method: 'DELETE' }),
  previewSmartFolder: (id: number, opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.offset) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return request<{ folder: SmartFolder; total: number; items: ImageItem[]; limit: number; offset: number }>(
      `/api/smart-folders/${id}/images${qs ? `?${qs}` : ''}`
    );
  },
  applySmartFolderTags: (id: number) =>
    request<{ ok: boolean; changed: number; tags: { tag: string; count: number }[] }>(
      `/api/smart-folders/${id}/apply-tags`,
      { method: 'POST' }
    ),

  /* ------------------------- 图内文字（OCR） ------------------------- */
  ocrStatus: () =>
    request<{ platform: string; available: boolean; engine: string; note: string }>('/api/ocr/status'),
  ocrGet: (id: number) =>
    request<{ ok: boolean; id: number; text: string; lang: string; engine: string; createdAt: string }>(
      `/api/images/${id}/ocr`
    ),
  ocrRun: (id: number, force = false) =>
    request<{ ok: boolean; id: number; text: string; lang: string; engine: string; cached: boolean; chars?: number }>(
      `/api/images/${id}/ocr`,
      { method: 'POST', body: JSON.stringify({ force }) }
    ),
  ocrClear: (id: number) => request<{ ok: boolean; id: number }>(`/api/images/${id}/ocr`, { method: 'DELETE' }),
  ocrBatch: (ids: number[], force = false) =>
    request<{
      ok: boolean;
      total: number;
      okCount: number;
      truncated: boolean;
      results: { id: number; ok: boolean; error?: string; text?: string; chars?: number; cached?: boolean }[];
    }>('/api/images/ocr-batch', { method: 'POST', body: JSON.stringify({ ids, force }) }),

  /* --------------------- 来源：以图搜图 / 换大图 --------------------- */
  searchProviders: (id: number) =>
    request<{
      ok: boolean;
      sourceUrl: string;
      pageUrl: string;
      providers: {
        id: string;
        name: string;
        kind: 'upload' | 'url' | 'keyword';
        desc: string;
        ready: boolean;
        reason: string;
        url?: string;
      }[];
    }>(`/api/images/${id}/search-providers`),
  reverseSearch: (id: number, engine: string) =>
    request<{
      ok: boolean;
      engine: string;
      mode: 'upload' | 'url' | 'keyword';
      url?: string;
      note: string;
      results?: { similarity: number; title: string; detail: string; thumb: string; link: string }[];
    }>(`/api/images/${id}/reverse-search`, { method: 'POST', body: JSON.stringify({ engine }) }),
  upgradePreview: (id: number, minGain = 1.1) =>
    request<{
      ok: boolean;
      found: boolean;
      before: { width: number; height: number };
      after: { width: number; height: number; url: string } | null;
      tried: { url: string; error?: string; width?: number; height?: number }[];
    }>(`/api/images/${id}/upgrade-source/preview?minGain=${minGain}`),
  upgradeSource: (id: number, minGain = 1.1) =>
    request<{
      ok: boolean;
      before: { width: number; height: number };
      after: { width: number; height: number; url: string };
      bytes: number;
      item: ImageItem;
    }>(`/api/images/${id}/upgrade-source`, { method: 'POST', body: JSON.stringify({ minGain }) }),

  /* ------------------------ 检查器：EXIF / PDF / 版本 ------------------------ */
  exif: (id: number) =>
    request<{
      ok: boolean;
      width: number;
      height: number;
      format: string;
      space?: string;
      density?: number;
      hasAlpha?: boolean;
      pages?: number;
      exif: Record<string, string | number>;
      error?: string;
    }>(`/api/images/${id}/exif`),
  pdfInfo: (id: number) =>
    request<{ ok: boolean; pages: number; exact: boolean; size: number }>(`/api/images/${id}/pdf-info`),
  versions: (id: number) =>
    request<{
      ok: boolean;
      id: number;
      title: string;
      current: VersionInfo;
      versions: (VersionInfo & { id: number; label: string })[];
    }>(`/api/images/${id}/versions`),
  restoreVersion: (id: number, versionId: number) =>
    request<{ ok: boolean; id: number; restored: number; item: ImageItem }>(
      `/api/images/${id}/versions/${versionId}/restore`,
      { method: 'POST' }
    ),
  /* 一图多区域裁切：每个框另存一份副本（saveMode 固定 copy，原图不动） */
  cropRegions: (
    id: number,
    regions: { x: number; y: number; w: number; h: number }[],
    opts: { targetDir: string; addToLibrary?: boolean }
  ) =>
    request<{
      ok: boolean;
      count: number;
      results: { ok: boolean; rect: { x: number; y: number; w: number; h: number }; error?: string }[];
    }>(`/api/images/${id}/crop-regions`, {
      method: 'POST',
      body: JSON.stringify({ regions, targetDir: opts.targetDir, addToLibrary: opts.addToLibrary !== false }),
    }),

  /* ------------------------------ 动作 Actions ------------------------------ */
  actions: () =>
    request<{
      ok: boolean;
      types: Record<string, { label: string; desc: string }>;
      actions: ActionDef[];
    }>('/api/actions'),
  saveAction: (action: { id?: number; name: string; icon?: string; steps: ActionStep[] }) =>
    request<{ ok: boolean; id: number }>(action.id ? `/api/actions/${action.id}` : '/api/actions', {
      method: action.id ? 'PUT' : 'POST',
      body: JSON.stringify(action),
    }),
  deleteAction: (id: number) => request<{ ok: boolean }>(`/api/actions/${id}`, { method: 'DELETE' }),
  runAction: (id: number, ids: number[]) =>
    request<{
      ok: boolean;
      action: { id: number; name: string };
      total: number;
      okCount: number;
      failed: number;
      items: { id: number; ok: boolean; error?: string; logs: string[] }[];
    }>(`/api/actions/${id}/run`, { method: 'POST', body: JSON.stringify({ ids }) }),
  actionCount: (ids: number[]) =>
    request<{ ok: boolean; count: number }>('/api/actions/count', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  /* --------------------------- 数据出口（备份/迁移） --------------------------- */
  transferPreview: () =>
    request<{
      ok: boolean;
      library: { id?: number; name?: string; rootPath: string; dbPath: string };
      counts: { images: number; folders: number; tags: number; playlists: number; actions: number; ocr: number };
      thumbsBytes: number;
      storageDir: string;
    }>('/api/transfer/preview'),
  transferBackup: (targetDir: string, includeThumbs = true) =>
    request<{
      ok: boolean;
      dir: string;
      bytes: number;
      thumbsBytes: number;
      counts: Record<string, number>;
      note: string;
    }>('/api/transfer/backup', { method: 'POST', body: JSON.stringify({ targetDir, includeThumbs }) }),
  transferRestore: (sourceDir: string, name?: string, rootPath?: string) =>
    request<{
      ok: boolean;
      id: number;
      name: string;
      rootPath: string;
      dbPath: string;
      thumbsBytes: number;
      counts: Record<string, number> | null;
      remapped: number;
      missing: number;
      note: string;
    }>('/api/transfer/restore', { method: 'POST', body: JSON.stringify({ sourceDir, name, rootPath }) }),
  /* 迁库是长任务：单轮上限 limit 个素材，返回 remaining 供前端提示「再点一次继续」 */
  transferImportEagle: (srcDir: string, name?: string, rootPath?: string, limit?: number) =>
    request<{
      ok: boolean;
      total: number;
      processed: number;
      imported: number;
      skipped: number;
      existing: number;
      failed: number;
      folders: number;
      remaining: number;
      items: { id: number; title: string; folder?: boolean }[];
      errors: string[];
      error?: string;
    }>('/api/transfer/import-eagle', {
      method: 'POST',
      body: JSON.stringify({ srcDir, name, rootPath, limit }),
      timeoutMs: 15 * 60 * 1000,
    }),

  /* 反向互通：当前库 → Eagle 4 的 .library（父目录选好后由服务端建 <库名>.library） */
  exportEagle: (destDir: string, name?: string) =>
    request<{
      ok: boolean;
      dir: string;
      exported: number;
      missing: number;
      folders: number;
      errors: string[];
      note: string;
    }>('/api/export/eagle', {
      method: 'POST',
      body: JSON.stringify({ destDir, name }),
      timeoutMs: 30 * 60 * 1000,
    }),

  /* ------------------------------ 图片拼接 ------------------------------ */
  stitchUrl: (ids: number[], opts: { columns?: number; gap?: number; bg?: string; cell?: number; format?: string; quality?: number; title?: string } = {}) => {
    const q = new URLSearchParams({ ids: ids.join(',') });
    if (opts.columns) q.set('columns', String(opts.columns));
    if (opts.gap != null) q.set('gap', String(opts.gap));
    if (opts.bg) q.set('bg', opts.bg);
    if (opts.cell) q.set('cell', String(opts.cell));
    if (opts.format) q.set('format', opts.format);
    if (opts.quality) q.set('quality', String(opts.quality));
    if (opts.title) q.set('title', opts.title);
    return `/api/export/stitch?${q.toString()}`;
  },
};

export interface SmartFolder {
  id: number;
  name: string;
  rules: Record<string, unknown>;
  autoTags: string[];
  created_at: string;
  updated_at: string;
}

/** 版本历史里的一版（当前版本没有 id；历史版本 id = edit_history 主键） */
export interface VersionInfo {
  id?: number;
  label: string;
  width: number;
  height: number;
  size: number;
  sizeLabel: string;
  createdAt?: string;
  missing: boolean;
  current: boolean;
}

export interface ActionStep {
  type: string;
  tags?: string;
  mode?: string;
  folderId?: number;
  rating?: number;
  text?: string;
  template?: string;
  value?: boolean;
  instruction?: string;
  target?: string;
}

export interface ActionDef {
  id: number;
  name: string;
  icon: string;
  steps: ActionStep[];
  createdAt: string;
  lastRunAt: string;
}

/** 给 <img>/<iframe>/下载链接补上本地 API 令牌（仅 GET 生效） */
export async function withToken(url: string) {
  const token = await getApiToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/**
 * 体积格式化：全站唯一实现（以前有 5 份各自四舍五入，同一个文件在不同页面显示不同数字）。
 * 0 → '0 B'；10 以下保留一位小数（1.5 MB），10 以上取整（128 MB）。
 */
export function formatSize(bytes: number) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export const SOURCE_LABELS: Record<string, string> = {
  bing: '必应',
  baidu: '百度',
  sogou: '搜狗',
  image360: '360 图片',
  duitang: '堆糖',
  weibo: '微博',
  wallhaven: 'Wallhaven',
  commons: 'Wikimedia',
  douban: '豆瓣',
  tieba: '贴吧',
  local: '本地素材',
};

export const BUCKET_LABELS: Record<string, string> = {
  sd: '< 1080p',
  fhd: '1080p - 2K',
  '2k': '2K - 4K',
  '4k': '4K+',
};

export const ORIENTATION_LABELS: Record<string, string> = {
  portrait: '竖版',
  landscape: '横版',
  square: '方图',
};
