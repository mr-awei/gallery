/**
 * 接口返回值的类型定义（原本堆在 api.ts 头部）。
 * 这些是「请求层 + 各域接口」共用的形状，单独一个文件，改字段时一眼能看全。
 */
import type { ThemePackTheme } from '../lib/theme-pack-vars';
import type {
  AdjustParams,
  AnnotationItem,
  DupeGroup,
  ImageComment,
  TagNode,
  EditJobStatus,
  EditOpsInfo,
  EditResult,
  EditSaveOptions,
  AiPreset,
  AiProviderInfo,
  AiStatus,
  AiUpscaleStatus,
  ModelsPayload,
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
  HardwareReport,
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
  TimelineDay,
  TimelineSummary,
  TrashItem,
  WallpaperMonitors,
  WallpaperResult,
  LiveWallpaperConfig,
  PluginInfo,
  PluginInstallResult,
  PluginMarketView,
  PluginRunResult,
  LanSelfCheck,
  LanShare,
  LanShareInput,
  LanStatus,
} from '../types';

export type { ThemePackTheme } from '../lib/theme-pack-vars';

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
  /** 进程架构（x64 / arm64）：装错架构的包会白屏，关于页要让用户能核对 */
  arch?: string;
  /** 是否安装版：只有安装版能走应用内自动更新 */
  packaged?: boolean;
  /** 运行时组件版本（关于页「运行环境」列出） */
  versions?: { electron?: string; chromium?: string; node?: string; v8?: string };
  /** 程序自己的目录（不含素材）：诊断、日志、崩溃转储 */
  paths?: { userData?: string; logs?: string; crashDumps?: string };
  /** 更新通道说明：只有 tag 构建的正式 Release 会进更新源 */
  updateChannel?: string;
  /** 唯一允许的更新源（owner/repo），用于拼发布页 / 仓库链接 */
  officialRepo?: string;
}

/** 热更状态：只反映本机事实（生效序号 / 待生效序号 / 已隔离的坏包） */
export interface HotfixState {
  enabled: boolean;
  /** 当前生效的热更序号（0 = 纯安装包） */
  activeSeq: number;
  /** 已下载、尚未生效的序号（0 = 没有） */
  pendingSeq: number;
  pendingNotes: string;
  lastSeq: number;
  badSeqs: number[];
  /** 生效时机（来自设置快照，主进程读的是同一份） */
  apply: 'next' | 'now' | 'manual';
}

export interface DesktopAPI {
  isDesktop: boolean;
  pickFolder: () => Promise<string | null>;
  /** 热更：状态 / 手动检查 / 立即生效 / 离线导入 zip */
  hotfixState?: () => Promise<HotfixState>;
  hotfixCheck?: () => Promise<{ ok: boolean; updated: boolean; seq?: number; notes?: string; error?: string }>;
  hotfixApply?: () => Promise<{ applied: boolean; seq?: number; error?: string }>;
  hotfixImport?: () => Promise<{ ok: boolean; seq?: number; notes?: string; error?: string }>;
  openFolder: (path: string) => Promise<string | null>;
  /** 打开崩溃转储目录（桌面端） */
  openCrashDir?: () => Promise<string>;
  /** 打开运行日志目录（桌面端） */
  openLogDir?: () => Promise<string>;
  /** 导出诊断包（日志 + 环境 + 崩溃清单，密钥已打码） */
  exportDiagnostics?: () => Promise<{ ok: boolean; path?: string; bytes?: number; canceled?: boolean; error?: string }>;
  /** 打开程序自己的目录：userData / logs / crashDumps（路径在主进程解析，渲染层只给名字） */
  openAppDir?: (key: 'userData' | 'logs' | 'crashDumps') => Promise<string>;
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
  /** 同步界面语言给主进程（托盘 / 原生对话框），浏览器模式下为 undefined */
  setLocale?: (lang: 'zh-CN' | 'en-US') => Promise<boolean>;
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
  /** 「下次打开时安装」：记下要装的版本，下次启动必须先装完（不装就退出） */
  updateDefer?: () => Promise<{ ok: boolean; version?: string; msg?: string }>;
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
  result: Record<string, unknown> | null;
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
  /** 用户选过「下次打开时安装」：本次已放行，下次启动要装 */
  deferred?: boolean;
  /** 本次启动必须先装完更新：遮罩只有「安装 / 退出」，没有继续用 */
  mandatory?: boolean;
  /** 延后安装的目标版本 */
  deferredVersion?: string;
  /** 连续装不上、强制更新已自动降级为非强制 */
  degraded?: boolean;
  /** 记录下来的连续安装失败次数 */
  installFailures?: number;
}

export interface UpdateCheckResult {
  ok: boolean;
  hasUpdate?: boolean;
  latest?: string;
  current?: string;
  url?: string;
  msg?: string;
}

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

/** 动作的执行条件：与智能文件夹同一套规则语义（一层平坦条件） */
export interface ActionConditions {
  combine: 'and' | 'or';
  rules: {
    favorite?: 'yes' | 'no';
    minRating?: number;
    minScore?: number;
    minWidth?: number;
    orientation?: 'landscape' | 'portrait' | 'square';
    tagsInclude?: string[];
    tagsExclude?: string[];
    keywords?: string[];
    aiKeywords?: string[];
  };
}

export interface ActionDef {
  id: number;
  name: string;
  icon: string;
  steps: ActionStep[];
  conditions?: ActionConditions;
  createdAt: string;
  lastRunAt: string;
}

/** 预演结果：确定性步骤给出改前改后，AI/OCR/插件步骤如实标注无法预演 */
export interface ActionPreviewStep {
  type: string;
  label: string;
  diffs: { field: string; before: string; after: string }[];
  willSkip: string;
  unknown: string;
}

/** 给 <img>/<iframe>/下载链接补上本地 API 令牌（仅 GET 生效） */
