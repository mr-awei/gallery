export interface ImageItem {
  id: number;
  title: string;
  source: string;
  keyword: string;
  sourceUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  mime: string;
  favorite: boolean;
  /** 是否看过（进入大图预览即标记） */
  viewed: boolean;
  viewCount: number;
  viewedAt: string;
  /** 星级 0-5（0 = 未评分） */
  rating: number;
  /** 自己的备注 */
  note: string;
  /** 主色 #rrggbb；色系为多值：逗号分隔的 0-11（例 "2,5,7"），空串表示接近黑白灰 */
  dominant: string;
  hue: string;
  /** 调色板：MMCQ 提取的至多 8 个代表色及各自像素占比 h=色值 p=占比0..1 */
  palette?: { h: string; p: number }[];
  /** 颜色搜索命中的代表色与 OKLab 感知距离（仅搜索结果带） */
  matchHex?: string;
  dist?: number;
  tags: string[];
  createdAt: string;
  orientation: 'portrait' | 'landscape' | 'square';
  bucket: 'sd' | 'fhd' | '2k' | '4k';
  thumbUrl: string;
  url: string;
  downloadUrl: string;
  /** 本地磁盘绝对路径（桌面端可直接打开/设为壁纸） */
  path: string;
  /** AI 知识库打分 0-100 */
  score: number;
  scoreReason: string;
  /** 组内画质分 0-100（清晰度×分辨率，CLIP 相似分组返回时带） */
  quality?: number;
  /** 与查询图的 CLIP 余弦相似度（按图找相似时带） */
  cos?: number;
  /** 是否被「画质增强」放大过（依据文件名里的原始分辨率判断） */
  enhanced?: boolean;
  originalWidth?: number;
  originalHeight?: number;
  enhanceScale?: number;
}

export interface WallpaperResult {
  ok: boolean;
  generated: boolean;
  fit: 'cover' | 'contain';
  screen: { width: number; height: number };
  path: string;
}

export interface AiConfig {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
}

export interface AiStatus {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  visionModel: string;
  hasKey: boolean;
  ready: boolean;
}

export interface AiPreset {
  label: string;
  baseUrl: string;
  models: string[];
  visionModels: string[];
  docs: string;
  keyHint: string;
}

export interface TrashItem {
  id: number;
  imageId: number;
  title: string;
  originPath: string;
  trashPath: string;
  source: string;
  keyword: string;
  width: number;
  height: number;
  sizeBytes: number;
  reason: string;
  deletedAt: string;
}

export interface KbRule {
  id: number;
  type: string;
  value: string;
  label: string;
  weight: number;
  hits: number;
  origin: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface FeedbackItem {
  id: number;
  imageId: number;
  createdAt: string;
  reasons: string[];
  note: string;
  aiAnalysis: string;
  snapshot: {
    width?: number;
    height?: number;
    source?: string;
    keyword?: string;
    path?: string;
    aspect?: number;
    longEdge?: number;
    phash?: string;
  };
}

export interface KbStats {
  feedbackCount: number;
  ruleCount: number;
  enabledRuleCount: number;
  lowScoreCount: number;
  avgScore: number;
  byReason: { key: string; label: string; count: number }[];
}

export interface SystemInfo {
  platform: string;
  desktop: boolean;
  storageDir: string;
  hasBuild: boolean;
}

export interface Stats {
  total: number;
  favorite: number;
  totalSize: number;
  bySource: { source: string; count: number }[];
  byBucket: { bucket: string; count: number }[];
  byOrientation: { orientation: string; count: number }[];
  trend: { date: string; count: number }[];
  topTags: { tag: string; count: number }[];
  recent: ImageItem[];
  largest: ImageItem[];
  crawling: boolean;
}

export interface Filters {
  q: string;
  source: string[];
  favorite: 'all' | 'yes' | 'no';
  orientation: 'all' | 'portrait' | 'landscape' | 'square';
  bucket: string[];
  tag: string;
  sort: string;
  /** 已看 / 未看过（进入大图预览即算已看） */
  seen: 'all' | 'unseen' | 'seen';
  /** 星级下限（0 = 不限） */
  minRating: number;
  /** 色系筛选：逗号分隔的 hue（0-11）或 gray（粗筛；启用精确颜色时会被清空） */
  hue: string;
  /** 精确颜色筛选 #rrggbb（Eagle 式色盘）；空串 = 未启用 */
  colorHex: string;
  /** 颜色宽容度 0-160（后端 tol，越大越宽松；UI 显示的准确度 = 160 - 该值） */
  colorTol: number;
}

/** 资源库（多资源库） */
export interface Library {
  id: number;
  name: string;
  path: string;
  root_path: string;
  thumb_dir: string;
  created_at: string;
  last_opened: string;
  is_active: number;
  /** 是否可删除（默认库不可删） */
  deletable?: boolean;
}

/** 文件夹树节点（后端扁平返回，前端按 parent_id 组装） */
export interface FolderNode {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
  anchor_path: string;
  count: number;
}

export interface SimilarGroup {
  key: string;
  /** 系统推荐保留的那张（组内画质最佳） */
  recommendId: number;
  count: number;
  items: ImageItem[];
  /** CLIP 分组的双档标记：exact=完全重复（可放心清理） / series=系列照（默认不删） */
  tier?: 'exact' | 'series';
  /** 组内最高余弦（CLIP 分组返回） */
  maxCos?: number;
}

export interface SimilarGroups {
  threshold: number;
  count: number;
  groups: SimilarGroup[];
}

export interface CrawlStats {
  searchesTotal: number;
  searchesDone: number;
  candidates: number;
  newCandidates: number;
  downloaded: number;
  saved: number;
  failed: number;
  skipped: number;
  dropped: { lowres: number; small: number; format: number; duplicate: number; oversize: number; aiFilter: number };
}

export interface LogEntry {
  id: number;
  t: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface CrawlFailure {
  id: number;
  t: number;
  source: string;
  keyword: string;
  url: string;
  reason: string;
  message: string;
}

export interface CrawlStatus {
  id?: number;
  running: boolean;
  phase: 'idle' | 'running' | 'done';
  startedAt?: string;
  endedAt?: string;
  keywords: string[];
  sources: string[];
  pages: number;
  current: { keyword: string; source: string; page: number } | null;
  search: { total: number; done: number; failed: number };
  download: { queued: number; done: number; active: number; saved: number; failed: number };
  stats: CrawlStats | null;
  failures: CrawlFailure[];
  failureCount: number;
  logs: LogEntry[];
}

export interface Playlist {
  id: number;
  name: string;
  description: string;
  count: number;
  created_at: string;
  updated_at: string;
}

export interface AutoWallpaperConfig {
  enabled: boolean;
  mode: 'day' | 'week' | 'month' | 'custom';
  atTime: string;
  weekday: number;
  dayOfMonth: number;
  minutes: number;
  scope: 'all' | 'favorites' | 'playlist';
  playlistId: number | null;
  /** ai 智能适配（评分+壁纸适配度+时间）/ smart 按 AI 评分加权随机（优先高分）/ random 等概率 / sequential 按顺序 */
  order: 'random' | 'sequential' | 'smart' | 'ai';
  /** 评估「适不适合做壁纸」并参与排序 */
  useAiFit?: boolean;
  /** 「不喜欢」自动沉淀为知识库规则 */
  feedbackToKb?: boolean;
  /** 按时间挑图：白天偏亮、夜间偏暗 */
  useTimeAware?: boolean;
  /** 抽到低于画质标准的图时先自动增强 */
  autoEnhance?: boolean;
  /** 低于该评分的图片不参与壁纸轮换（0 = 不限） */
  minScore: number;
  /** 点过「不喜欢」的图片 id，不再被抽中 */
  excluded: number[];
  /** 多屏模式下每个屏幕放不同的图 */
  perMonitorDifferent: boolean;
  lastRunAt: string | null;
  lastImageId: number | null;
}

export interface MonitorInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WallpaperMonitors {
  monitors: MonitorInfo[];
  count: number;
  mode: 'single' | 'span' | 'per-monitor';
  modes: Record<string, string>;
}

/** 动态壁纸配置 */
export interface LiveWallpaperConfig {
  enabled: boolean;
  /** slideshow 相册轮播 / video 本地视频 / web 网页 */
  mode: 'slideshow' | 'video' | 'web';
  /** 轮播间隔（秒） */
  intervalSec: number;
  /** 视频文件路径（mode=video 时） */
  videoPath: string;
  /** 网页地址（mode=web 时） */
  webUrl: string;
  /** 静音 */
  mute: boolean;
  /** 音量 0-100 */
  volume: number;
  /** 缓慢缩放（Ken Burns） */
  kenBurns: boolean;
  /** 轮播范围：all / favorites / playlist */
  scope: 'all' | 'favorites' | 'playlist';
  playlistId: number | null;
  minScore: number;
  /** 有全屏应用（游戏）时暂停 */
  pauseOnFullscreen: boolean;
  /** 用电池时暂停 */
  pauseOnBattery: boolean;
}

export interface AutoWallpaperStatus {
  config: AutoWallpaperConfig;
  nextRunAt: string | null;
  scopeCount: number;
  running: boolean;
  lastLog: { imageId: number; title: string; scope: string; appliedAt: string } | null;
}

export interface WallpaperLogItem {
  id: number;
  imageId: number;
  title: string;
  scope: string;
  appliedAt: string;
}

export interface NetworkConfig {
  mode: string;
  host: string;
  port: number;
  username: string;
  password: string;
  bypass?: string;
  applied?: boolean;
  modes?: { key: string; label: string }[];
}

export interface Settings {
  minResolution: number;
  minFileSize: number;
  phashThreshold: number;
  pagesPerKeyword: number;
  maxFileSize: number;
  concurrency: number;
  sources: Record<string, boolean>;
  wallhavenApiKey: string;
  /** 微博登录 Cookie：微博接口已关闭游客访问，填了才能用微博图片源 */
  weiboCookie: string;
  /** 服务端已保存微博登录凭据（Cookie 本身永不回传前端，只回报是否已配置） */
  hasWeiboCookie?: boolean;
  /** 保存指令：显式清除服务端已保存的微博 Cookie（空字符串会被视为「未修改」） */
  weiboCookieClear?: boolean;
  /** 服务端已保存 AI API Key（同上不回传明文） */
  hasAiApiKey?: boolean;
  /** 保存指令：显式清除 AI API Key */
  aiApiKeyClear?: boolean;
  /** 微博登录会话的 User-Agent：微博风控把登录态与 UA 绑定，采集请求需复用同一 UA */
  weiboUserAgent: string;
  storageDir: string;
  /** 是否已完成首次引导（首次启动选择图片文件夹） */
  onboarded?: boolean;
  deletePolicy: 'trash' | 'permanent' | 'unlink';
  scoreThreshold: number;
  wallpaperFill: 'blur' | 'solid' | 'black';
  /** 单屏 / 跨屏合成一张 / 每个屏幕不同图片 */
  wallpaperMode: 'single' | 'span' | 'per-monitor';
  /** 全局快捷键（Ctrl+Alt+W 换壁纸 等） */
  globalShortcuts: boolean;
  ai: AiConfig;
  autoWallpaper: AutoWallpaperConfig;
  enhance: EnhanceConfig;
  theme: 'dark' | 'light';
  /** 开机自动启动（桌面端） */
  autoLaunch?: boolean;
  /** 检查更新用的 GitHub 仓库（owner/repo，空则用内置默认） */
  updateRepo?: string;
}

export interface EnhanceConfig {
  standard: string;
  customWidth: number;
  customHeight: number;
  model: string;
  remoteServices: EnhanceRemoteService[];
}

export interface EnhanceRemoteService {
  id: string;
  name: string;
  uploadUrl: string;
  method?: string;
  fileField?: string;
  params?: { key: string; value: string }[];
  /** 请求体方式：multipart 表单（默认）或二进制直传（如 Hugging Face） */
  bodyMode?: 'multipart' | 'binary';
  /** 自定义请求头，如 DeepAI 的 api-key、Replicate 的 Authorization: Token xxx */
  headers?: { key: string; value: string }[];
  resultType?: 'direct' | 'json';
  resultUrlPath?: string;
  apiKey?: string;
}

export interface EnhanceStandard {
  key: string;
  label: string;
}

export interface EnhanceModel {
  id: string;
  label: string;
  desc: string;
}

export interface EnhanceCandidates {
  standard: string;
  count: number;
  items: ImageItem[];
}

export interface EnhanceAiModel {
  id: string;
  name: string;
  label: string;
  desc: string;
  available?: boolean;
}

export interface AiUpscaleStatus {
  installed: boolean;
  downloading: boolean;
  progress: number;
  message: string;
  gpu: string | null;
  usable: boolean | null;
  error: string;
  models: EnhanceAiModel[];
  /** 社区模型（ESRGAN 架构，需单独安装） */
  community?: { id: string; name: string; label: string; desc: string; scale: number; installed: boolean }[];
  /** Real-CUGAN：带降噪档位，用于两级增强的前置降噪 */
  cugan?: { installed: boolean; usable: boolean | null; error: string; models: string[] };
}

export interface EnhanceJobStatus {
  running: boolean;
  cancelled: boolean;
  total: number;
  done: number;
  failed: number;
  model: string;
  standard: string;
  currentId: number | null;
  currentTitle: string;
  currentProgress: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string;
  failures: { id: number; ok: boolean; error?: string }[];
}

export interface Keyword {
  id: number;
  text: string;
  enabled: number;
  created_at: string;
}
