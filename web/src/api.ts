import type {
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
} from './types';

export interface AppInfo {
  /** 实际生效的全局快捷键（被占用时会自动换备用键） */
  hotkeys: Record<string, string>;
  shortcutEnabled: boolean;
  version: string;
  platform: string;
}

interface DesktopAPI {
  isDesktop: boolean;
  pickFolder: () => Promise<string | null>;
  openFolder: (path: string) => Promise<string | null>;
  revealFile: (path: string) => Promise<boolean>;
  download: (url: string) => Promise<boolean>;
  appInfo?: () => Promise<AppInfo>;
  controlLiveWallpaper?: (patch: Partial<LiveWallpaperConfig>) => Promise<{ ok: boolean }>;
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

/**
 * 静默但可见的错误兜底：替代裸 `.catch(() => {})`。
 * 预取/后台刷新这类「失败无所谓」的请求不再完全吞错——失败原因至少留在
 * DevTools console 里，排查「为什么某功能一直不更新」时不再两眼一抹黑。
 */
export const quiet = (err: unknown) => {
  console.warn('[quiet]', (err as Error)?.message || err);
};

/** 默认请求超时：本地服务正常毫秒级返回，20s 已远超正常波动 */
const DEFAULT_TIMEOUT_MS = 20000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      localStorage.setItem('gem_api_token', fromUrl);
    } catch {
      /* 隐私模式等场景忽略 */
    }
    return tokenCache;
  }
  try {
    tokenCache = localStorage.getItem('gem_api_token') || '';
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
      localStorage.setItem('gem_api_token', tokenCache);
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
      return (await res.json()) as T;
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
      throw err;
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
  // 资源库（多资源库）
  libraries: () => request<{ libraries: Library[]; activeId: number | null }>('/api/libraries'),
  createLibrary: (payload: { name: string; rootPath?: string; libFolder: string }) =>
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
  patch: (id: number, patch: Partial<Pick<ImageItem, 'favorite' | 'tags' | 'title' | 'rating' | 'note'>>) =>
    request<ImageItem>(`/api/images/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  similarTo: (id: number, minCos: number) =>
    request<{ minCos: number; count: number; items: ImageItem[] }>(
      `/api/images/${id}/similar?minCos=${minCos}`
    ),
  // 整理：相似图审查 / 主色补算 / AI 打标
  tidyStats: () =>
    request<{ total: number; noDominant: number; noAiDesc: number; noRating: number; rated: number }>(
      '/api/tidy/stats'
    ),
  similar: (threshold?: number) =>
    request<SimilarGroups>(`/api/similar${threshold ? `?threshold=${threshold}` : ''}`),
  similarClip: (minCos?: number) =>
    request<SimilarGroups>(`/api/similar/clip${minCos ? `?minCos=${minCos}` : ''}`),
  clipStatus: () =>
    request<{ running: boolean; done: number; total: number; error: string; indexed: number; model: string; loadError: string }>(
      '/api/clip/status'
    ),
  clipBackfill: () => request<{ ok: boolean; total?: number; message?: string }>('/api/clip/backfill', { method: 'POST' }),
  formatDupes: () => request<SimilarGroups>('/api/dupes/format'),
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
  tags: () => request<{ tag: string; count: number }[]>('/api/tags'),
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
      result?: {
        total?: number;
        saved?: number;
        duplicate?: number;
        dropped?: number;
        errors?: number;
        unchanged?: number;
        cancelled?: number;
      };
    }>('/api/import/status'),
  systemInfo: () => request<SystemInfo>('/api/system/info'),
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
    request<{ ok: boolean; item: ImageItem }>('/api/enhance/' + id, {
      method: 'POST',
      body: JSON.stringify({ model, standard }),
    }),
  enhanceBatch: (ids: number[], model: string, standard?: string) =>
    request<{ ok: boolean; success: number; total: number; results: { id: number; ok: boolean; error?: string }[] }>(
      '/api/enhance/batch',
      { method: 'POST', body: JSON.stringify({ ids, model, standard }) }
    ),
  rotateImage: (id: number, dir: 'cw' | 'ccw') =>
    request<{ ok: boolean; item: ImageItem }>(`/api/images/${id}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ dir }),
    }),
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
    request<{ downloaded: boolean; downloading: boolean; progress: number; message: string; error: string; size: number }>(
      '/api/ai/matting/status'
    ),
  mattingInstall: () =>
    request<{ ok: boolean; downloaded?: boolean }>('/api/ai/matting/install', { method: 'POST' }),
  removeBackground: (id: number) =>
    request<{ ok: boolean; reason?: string; id?: number }>(`/api/images/${id}/remove-bg`, { method: 'POST' }),
  prefTrain: () =>
    request<{ ok: boolean; samples?: number; pos?: number; neg?: number; updated?: number; message?: string; top?: { feature: string; w: number }[] }>(
      '/api/pref/train',
      { method: 'POST' }
    ),

  // 回收站
  trash: () => request<TrashItem[]>('/api/trash'),
  restoreTrash: (id: number) => request<ImageItem>(`/api/trash/${id}/restore`, { method: 'POST' }),
  deleteTrash: (id: number) => request<{ ok: boolean }>(`/api/trash/${id}`, { method: 'DELETE' }),
  emptyTrash: () => request<{ ok: boolean; removed: number }>('/api/trash/empty', { method: 'POST' }),
  clearLibrary: () => request<{ ok: boolean; removed: number }>('/api/library', { method: 'DELETE' }),
  seed: () => request<{ ok: boolean }>('/api/seed', { method: 'POST' }),

  // 检索：颜色 / AI / 以图
  searchColor: (hex: string, tol = 48, limit = 120) =>
    request<{ hex: string; tolerance: number; total: number; items: ImageItem[] }>(
      `/api/search/color?hex=${encodeURIComponent(hex)}&tol=${tol}&limit=${limit}`
    ),
  aiSearch: (query: string, limit = 60) =>
    request<{ query: string; total: number; items: ImageItem[] }>('/api/search/ai', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
  searchByImage: (dataUrl: string, maxHamming = 10, limit = 24) =>
    request<{ total: number; items: (ImageItem & { hamming: number })[] }>('/api/search/by-image', {
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
  previewSmartFolder: (id: number) =>
    request<{ folder: SmartFolder; total: number; items: ImageItem[] }>(`/api/smart-folders/${id}/images`),
  applySmartFolderTags: (id: number) =>
    request<{ ok: boolean; changed: number; tags: { tag: string; count: number }[] }>(
      `/api/smart-folders/${id}/apply-tags`,
      { method: 'POST' }
    ),
};

export interface SmartFolder {
  id: number;
  name: string;
  rules: Record<string, unknown>;
  autoTags: string[];
  created_at: string;
  updated_at: string;
}

export function formatSize(bytes: number) {
  if (!bytes) return '0 B';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
  local: '本地素材',
  seed: '初始素材',
};

/** 采集源选项：设置页与采集页共用一份，避免两处维护不一致 */
export const SOURCE_OPTIONS: { key: string; label: string; hint?: string }[] = [
  { key: 'bing', label: '必应图片' },
  { key: 'baidu', label: '百度图片' },
  { key: 'sogou', label: '搜狗图片' },
  { key: 'image360', label: '360 图片' },
  { key: 'duitang', label: '堆糖' },
  { key: 'weibo', label: '微博图片', hint: '需先在下方填写微博 Cookie（微博已关闭游客访问）' },
  { key: 'wallhaven', label: 'Wallhaven' },
];

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
