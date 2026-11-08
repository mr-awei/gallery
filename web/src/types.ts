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
  /** 素材类型：image / gif / video / audio / font / pdf / office / model / design / raw / bookmark（Eagle 式多格式） */
  mediaKind: 'image' | 'gif' | 'video' | 'audio' | 'font' | 'pdf' | 'office' | 'model' | 'design' | 'raw' | 'bookmark' | 'other';
  /** 音视频时长（秒），0 = 尚未探明 */
  duration: number;
  /** 自定义封面帧（秒） */
  coverTs: number;
  /** 视频首尾裁剪区间（秒）；0 / 未提供表示未设置 */
  trimStart?: number;
  trimEnd?: number;
  /** 内容指纹（MD5），完全重复检测用 */
  md5: string;
  /** 图片堆叠：0 = 未堆叠；否则是组主 id（组主自己的 stackId = 自己的 id） */
  stackId?: number;
  /** 组内张数（含组主；仅列表 DTO 带） */
  stackCount?: number;
  /** 是否本组的组主 */
  stackPrimary?: boolean;
  /** 使用统计：复制 / 导出次数 + 最近一次使用时间 */
  copyCount?: number;
  exportCount?: number;
  lastUsedAt?: string;
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
  /**
   * 继承来的标签（来自所属文件夹的 tags，只读，不写库）。
   * 与 tags 分开存，用户才分得清「这是我打的」还是「文件夹带过来的」。
   */
  inheritedTags?: string[];
  createdAt: string;
  orientation: 'portrait' | 'landscape' | 'square';
  bucket: 'sd' | 'fhd' | '2k' | '4k';
  thumbUrl: string;
  /** 灯箱预览图（长边 1920）：带版本号，可长缓存 */
  previewUrl?: string;
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
  /** true = 这条规则当前打不中任何图（ai_term 规则遇库里没有 AI 描述数据） */
  dormant?: boolean;
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
  /** 当前资源库身份：多库各存各的 DB，图片记录本身不带库字段，只能由服务端告知 */
  library?: { id: string; name: string; path: string } | null;
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
  /** 素材类型：all / image / video / gif / audio / font / pdf / office / model */
  kind?: string;
  /** 待整理入口：noFolder 未分类 / noTags 无标签 / noRating 未评分 */
  pending?: '' | 'noFolder' | 'noTags' | 'noRating';
}

/** 素材类型（多格式） */
export type MediaKind =
  | 'image'
  | 'gif'
  | 'video'
  | 'audio'
  | 'font'
  | 'pdf'
  | 'office'
  | 'model'
  | 'design'
  | 'raw'
  | 'bookmark'
  | 'other';

/** 标签树节点：Eagle 式「分组 + 颜色 + 父子层级」 */
export interface TagNode {
  tag: string;
  count: number;
  group: string;
  color: string;
  parent: string;
  sortOrder: number;
}

/** 标注元素（坐标一律是相对原图的比例 0~1） */
export interface AnnotationItem {
  id: string;
  kind: 'rect' | 'arrow' | 'text' | 'mosaic' | 'brush' | 'highlight' | 'pen';
  color: string;
  size: number;
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  to?: { x: number; y: number };
  points?: [number, number][];
}

export interface ImageComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

/** 完全重复（MD5 一致）分组 */
export interface DupeGroup {
  md5: string;
  size: number;
  count: number;
  items: Array<{
    id: number;
    title: string;
    url: string;
    thumbUrl: string;
    width: number;
    height: number;
    sizeBytes: number;
    source: string;
    createdAt: string;
    absPath: string;
    mediaKind: string;
  }>;
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
  /** 直接挂在该夹的图片数 */
  count: number;
  /** 含全部子孙夹的聚合图片数（Eagle 式树上的数字） */
  total: number;
  /** 封面：手动指定优先，未指定时后端自动取夹内最新一张 */
  cover?: { imageId: number; manual: boolean; thumbUrl: string; kind: string } | null;
  /** 文件夹标签（逗号分隔）：夹内素材在搜索时自动继承这些标签 */
  tags?: string;
  /** 文件夹图标 / emoji（空 = 自动用封面或默认图标） */
  icon?: string;
  /** 文件夹主题色 #rrggbb（空 = 跟随主题） */
  color?: string;
  /** 同一父级内的手动排序值（拖动排序写入） */
  sort_order?: number;
  /** 隐私空间：是否设置了密码锁 */
  locked?: boolean;
  /** 本次会话是否已解锁（重启后回到锁定态） */
  unlocked?: boolean;
}

/** 保存的筛选器：一整套筛选条件（含文件夹），侧栏一键回到同一视图 */
export interface SavedFilter {
  id: number;
  name: string;
  query: Partial<Filters> & { folderId?: number | null };
  icon: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 素材笔记：ts > 0 = 钉在音视频的某个时间点（秒） */
export interface ImageNote {
  id: number;
  body: string;
  ts: number;
  createdAt: string;
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
  /** ai = 知识库评分 + 本地启发式适配度（+ 已训练的个人偏好 + 时间偏好）/ smart 只按知识库评分加权随机 / random 等概率 / sequential 按顺序 */
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
/** 壁纸实时交互参数（滑块 0~300，100 为基准） */
export interface LiveWallpaperParams {
  brightness: number;
  speed: number;
  intensity: number;
  depth: number;
}

export interface LiveWallpaperConfig {
  enabled: boolean;
  /** slideshow 相册轮播 / video / web / shader GLSL / interactive 交互 / audio 音频可视化 */
  mode: 'slideshow' | 'video' | 'web' | 'shader' | 'interactive' | 'audio';
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
  /** GPU 占用达到阈值时暂停 */
  pauseOnGpu?: boolean;
  /** GPU 阈值百分比 1-100（取最忙引擎） */
  gpuThreshold?: number;
  /** 这些进程在前台时暂停（basename / 简单通配） */
  pauseApps?: string[];
  /** 允许本机 / 内网 http(s) 与可信目录内的 file:// 网页 */
  allowLocalUrl?: boolean;
  /** file:// 网页允许的根目录（绝对路径） */
  trustedDir?: string;
  /** 网页壁纸点击穿透（false = 网页可接收鼠标，Esc 恢复） */
  clickThrough?: boolean;
  /** 实时交互参数：亮度 / 速度 / 强度 / 景深 */
  params?: LiveWallpaperParams;
  /** GLSL 预设 id（shaderPreset），内置四款 */
  shaderPreset?: string;
  /** 自定义 GLSL 片元着色器源码；非空时优先于预设 */
  shaderSource?: string;
  /** 交互壁纸：开启后桌面层接收鼠标事件 */
  interactive?: boolean;
  /** 音频可视化：本地音频路径 */
  audioPath?: string;
  /** file = 素材音频文件 / mic = 麦克风 / system = 系统音频回环（Windows 桌面音频） */
  audioSource?: 'file' | 'mic' | 'system';
}

/** 屏幕保护程序：空闲 N 分钟后用动态壁纸窗口全屏覆盖 */
export interface ScreensaverConfig {
  enabled: boolean;
  idleMinutes: number;
  /** slideshow / shader / interactive / audio */
  mode: 'slideshow' | 'shader' | 'interactive' | 'audio';
  showClock: boolean;
}

export interface AutoWallpaperStatus {
  config: AutoWallpaperConfig;
  nextRunAt: string | null;
  scopeCount: number;
  running: boolean;
  /** 当前排序策略真实参与的评分项（后端 pickPlan 算的，不是按选项名猜的） */
  pick?: { order: string; engine: string; label: string; parts: string[]; prefTrained?: boolean };
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

/** 水印预设里的参数：与 api.ts 的 WatermarkParams 同形，但不含「这次怎么存」的字段 */
export interface WatermarkPresetParams {
  style: string;
  frame: string;
  fields: string[];
  logo: boolean;
  brand: string;
  model: string;
  size: number;
  opacity: number;
  color: string;
  font: string;
  location: string;
  /** 三级选择器的选择结果（老预设没有这个字段，套用时按「手填地点」处理） */
  place?: { province: string; city: string; district: string; detail: string };
}

/** 一条水印预设（settings.watermarkPresets 的元素） */
export interface WatermarkPreset {
  id: string;
  name: string;
  params: WatermarkPresetParams;
  /** 保存/导入的时间戳（ms） */
  at: number;
}

/** 局域网投送状态（/api/lan/status） */
export interface LanStatus {
  ok: boolean;
  enabled: boolean;
  /** 独立投送端口；0 = 未开启 */
  port: number;
  /** 手机可访问的 URL（含投送令牌） */
  urls: string[];
  qrText: string;
  token: string;
  note: string;
}

/** 已安装的插件（/api/plugins 下发；宿主不回传 entry / 绝对路径细节） */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  actions: string[];
  builtin: boolean;
}

export interface PluginRunResult {
  ok: boolean;
  plugin: string;
  action: string;
  logs: string[];
  patch: Record<string, unknown>;
  applied: string[];
  result: unknown;
  /** 插件想写库但没声明 image:write 时为 true */
  denied?: boolean;
}

export interface Settings {
  minResolution: number;
  minFileSize: number;
  phashThreshold: number;
  pagesPerKeyword: number;
  /** 导入时目录遍历深度上限（层），默认 4 */
  importMaxDepth: number;
  /** 调色台历史记录保留步数（默认 100，1~500） */
  historySteps: number;
  /** 水印预设（跨库共享）：整套排版参数，随设置一起存 */
  watermarkPresets?: WatermarkPreset[];
  /** 关窗行为（桌面端）：true = 收到托盘继续后台跑，false = 关窗即退出 */
  closeToTray?: boolean;
  /** 局域网 / 手机扫码投送（跨库共享，默认关闭） */
  lanAccess?: boolean;
  /** 屏幕保护程序（跨库共享） */
  screensaver?: ScreensaverConfig;
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
  /** 文件夹监控：递归监听素材文件夹，新文件自动入库（默认开） */
  watchEnabled?: boolean;
  /** 是否已完成首次引导（首次启动选择图片文件夹） */
  onboarded?: boolean;
  /** 是否已看过新手教程（跳过也算），设置页可重新播放 */
  tourDone?: boolean;
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
  /** resample = 插值放大（不合成细节）；ai = 模型超分 */
  engine?: 'resample' | 'ai';
  engineLabel?: string;
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
  skipped: number;
  failed: number;
  model: string;
  standard: string;
  currentId: number | null;
  currentTitle: string;
  currentProgress: number;
  /** true = 当前这张图拿不到中间进度（如 Swin2SR 推理阶段），别显示百分比 */
  currentIndeterminate?: boolean;
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

/** 曲线控制点：[x, y]，取值 0..255（x 升序，首末点固定 0,0 / 255,255） */
export type CurvePoint = [number, number];

/** 曲线通道：rgb = 主通道（合成后作用于三原色），r/g/b = 单原色通道（PS 曲线面板同构） */
export type CurveChannel = 'rgb' | 'r' | 'g' | 'b';

/** 四通道曲线；空数组 = 恒等（不调整） */
export interface CurveSet {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export const CURVES_DEFAULTS: CurveSet = { rgb: [], r: [], g: [], b: [] };

/** 通道显示顺序与名称（与 PS 曲线的「RGB / 红 / 绿 / 蓝」一致） */
export const CURVE_CHANNELS: { key: CurveChannel; label: string; color: string }[] = [
  { key: 'rgb', label: 'RGB', color: '#e6e8f2' },
  { key: 'r', label: '红', color: '#ff6b6b' },
  { key: 'g', label: '绿', color: '#4ade80' },
  { key: 'b', label: '蓝', color: '#60a5fa' },
];

/** PS「色相/饱和度」的通道：全图 + 六个色带 */
export type HueBandKey = 'master' | 'red' | 'yellow' | 'green' | 'cyan' | 'blue' | 'magenta';

/** 单个通道的三项：色相角偏移（度，-180..180）、饱和度（-100..100）、明度（-100..100） */
export interface HueBand {
  h: number;
  s: number;
  l: number;
}

/** PS「色相/饱和度」全量参数（7 通道 + 着色） */
export interface HueSatParams {
  bands: Record<HueBandKey, HueBand>;
  /** 着色：把整幅图归到单一色相（PS 里勾选后通道锁死为全图） */
  colorize: boolean;
  /** 着色目标色相 0..360 */
  colorizeHue: number;
  /** 着色饱和度 0..100 */
  colorizeSat: number;
  /** 着色明度 -100..100 */
  colorizeLight: number;
}

export const HUE_BANDS: { key: HueBandKey; label: string; color: string }[] = [
  { key: 'master', label: '全图', color: '#e6e8f2' },
  { key: 'red', label: '红色', color: '#ff5c5c' },
  { key: 'yellow', label: '黄色', color: '#ffd93d' },
  { key: 'green', label: '绿色', color: '#4ade80' },
  { key: 'cyan', label: '青色', color: '#38d6e0' },
  { key: 'blue', label: '蓝色', color: '#5b9dff' },
  { key: 'magenta', label: '洋红', color: '#e879f9' },
];

const zeroBand = (): HueBand => ({ h: 0, s: 0, l: 0 });

export const HUE_SAT_DEFAULTS: HueSatParams = {
  bands: {
    master: zeroBand(),
    red: zeroBand(),
    yellow: zeroBand(),
    green: zeroBand(),
    cyan: zeroBand(),
    blue: zeroBand(),
    magenta: zeroBand(),
  },
  colorize: false,
  colorizeHue: 210,
  colorizeSat: 25,
  colorizeLight: 0,
};

/** 新建一份可安全改写的默认值（对象层级深，避免多处共享同一引用） */
export function makeHueSat(): HueSatParams {
  return {
    bands: {
      master: zeroBand(),
      red: zeroBand(),
      yellow: zeroBand(),
      green: zeroBand(),
      cyan: zeroBand(),
      blue: zeroBand(),
      magenta: zeroBand(),
    },
    colorize: false,
    colorizeHue: 210,
    colorizeSat: 25,
    colorizeLight: 0,
  };
}

/** 色相/饱和度是否全默认（批量/保存按钮判断） */
export function isHueSatDefault(hs: HueSatParams | undefined): boolean {
  if (!hs) return true;
  if (hs.colorize) return false;
  return Object.values(hs.bands).every((b) => !b || (!b.h && !b.s && !b.l));
}

/* ============ Camera Raw「混色器」：8 个色带 × 色相/饱和度/明亮度 ============ */

/** 混色器色带（Camera Raw 的 8 个颜色范围，按色相环顺序） */
export type MixBandKey = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta';

/** 单个色带的三项，均为 -100..100 */
export interface MixBand {
  h: number;
  s: number;
  l: number;
}

export interface ColorMixerParams {
  bands: Record<MixBandKey, MixBand>;
}

/** center = 该色带在色相环上的中心角（度），权重按到中心的角距离衰减 */
export const MIX_BANDS: { key: MixBandKey; label: string; color: string; center: number }[] = [
  { key: 'red', label: '红色', color: '#ff4d4d', center: 0 },
  { key: 'orange', label: '橙色', color: '#ff9a3c', center: 30 },
  { key: 'yellow', label: '黄色', color: '#ffd93d', center: 60 },
  { key: 'green', label: '绿色', color: '#4ade80', center: 120 },
  { key: 'aqua', label: '浅绿色', color: '#38d6e0', center: 180 },
  { key: 'blue', label: '蓝色', color: '#5b9dff', center: 240 },
  { key: 'purple', label: '紫色', color: '#a78bfa', center: 280 },
  { key: 'magenta', label: '洋红', color: '#e879f9', center: 320 },
];

const zeroMix = (): MixBand => ({ h: 0, s: 0, l: 0 });

export function makeColorMixer(): ColorMixerParams {
  return {
    bands: {
      red: zeroMix(),
      orange: zeroMix(),
      yellow: zeroMix(),
      green: zeroMix(),
      aqua: zeroMix(),
      blue: zeroMix(),
      purple: zeroMix(),
      magenta: zeroMix(),
    },
  };
}

export const COLOR_MIXER_DEFAULTS: ColorMixerParams = makeColorMixer();

/** 混色器是否全默认 */
export function isColorMixerDefault(m: ColorMixerParams | undefined): boolean {
  if (!m) return true;
  return MIX_BANDS.every(({ key }) => {
    const b = m.bands?.[key];
    return !b || (!b.h && !b.s && !b.l);
  });
}

/** 混色器页签（PS 里是「色相 / 饱和度 / 明亮度」三个页签） */
export type MixTab = 'hue' | 'sat' | 'lum';

export const MIX_TABS: { key: MixTab; label: string }[] = [
  { key: 'hue', label: '色相' },
  { key: 'sat', label: '饱和度' },
  { key: 'lum', label: '明亮度' },
];

/* ============ Camera Raw「颜色分级」：阴影/中间调/高光/全局 ============ */

export type GradeZoneKey = 'shadows' | 'midtones' | 'highlights' | 'global';

/** 单个区域：色相 0..360、饱和度 0..100、明度 -100..100 */
export interface GradeZone {
  hue: number;
  sat: number;
  lum: number;
}

export interface ColorGradeParams {
  zones: Record<GradeZoneKey, GradeZone>;
  /** 混合 0..100：三个亮度区域之间的过渡柔度 */
  blending: number;
  /** 平衡 -100..100：把区域分界往暗（负）/往亮（正）推 */
  balance: number;
}

export const GRADE_ZONES: { key: GradeZoneKey; label: string; color: string }[] = [
  { key: 'shadows', label: '阴影', color: '#7aa2ff' },
  { key: 'midtones', label: '中间调', color: '#9aa4bd' },
  { key: 'highlights', label: '高光', color: '#ffd98a' },
  { key: 'global', label: '全局', color: '#e6e8f2' },
];

const zeroZone = (): GradeZone => ({ hue: 0, sat: 0, lum: 0 });

export function makeColorGrade(): ColorGradeParams {
  return {
    zones: { shadows: zeroZone(), midtones: zeroZone(), highlights: zeroZone(), global: zeroZone() },
    blending: 50,
    balance: 0,
  };
}

export const COLOR_GRADE_DEFAULTS: ColorGradeParams = makeColorGrade();

/** 颜色分级是否全默认（色相单独不为 0 不算：饱和度 0 时染色不生效） */
export function isColorGradeDefault(g: ColorGradeParams | undefined): boolean {
  if (!g) return true;
  return GRADE_ZONES.every(({ key }) => {
    const z = g.zones?.[key];
    return !z || (!z.sat && !z.lum);
  });
}

/** Camera Raw 调色参数（全部 0 = 原图；范围 -100..100，sharpen/clarity 0..100） */
export interface AdjustParams {
  /** 色温：负冷正暖（吸管取样后会自动换算到这里） */
  temperature: number;
  /** 色调：负绿正品红 */
  tint: number;
  exposure: number;
  contrast: number;
  /** 高光：正提亮高光、负压暗 */
  highlights: number;
  /** 阴影：正提亮暗部、负压暗 */
  shadows: number;
  /** 白色：正提高白点（更通透） */
  whites: number;
  /** 黑色：正抬高黑点（更灰） */
  blacks: number;
  saturation: number;
  /** 自然饱和度：只提低饱和处，避免肤色/高饱和区过艳 */
  vibrance: number;
  /** 色相旋转：-100..100 → ±45° */
  hue: number;
  /** PS 色相/饱和度：7 个通道 + 着色 */
  hueSat: HueSatParams;
  /** Camera Raw 混色器：8 色带 × 色相/饱和度/明亮度 */
  colorMixer: ColorMixerParams;
  /** Camera Raw 颜色分级：阴影/中间调/高光/全局 + 混合/平衡 */
  colorGrade: ColorGradeParams;
  /** 清晰度：中间调局部对比 */
  clarity: number;
  sharpen: number;
  /** 曲线：主通道 + 三原色通道 */
  curves: CurveSet;
}

export const ADJUST_DEFAULTS: AdjustParams = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 0,
  vibrance: 0,
  hue: 0,
  hueSat: HUE_SAT_DEFAULTS,
  colorMixer: COLOR_MIXER_DEFAULTS,
  colorGrade: COLOR_GRADE_DEFAULTS,
  clarity: 0,
  sharpen: 0,
  curves: { rgb: [], r: [], g: [], b: [] },
};

/** 恒等曲线（用于判断"是否调整过"） */
export function isCurveIdentity(curve: CurvePoint[] | undefined): boolean {
  if (!curve || curve.length < 2) return true;
  return curve.every(([x, y]) => Math.abs(x - y) <= 1);
}

/** 任意通道是否画过曲线 */
export function hasAnyCurve(curves: CurveSet | undefined): boolean {
  if (!curves) return false;
  return (Object.keys(CURVES_DEFAULTS) as CurveChannel[]).some((k) => !isCurveIdentity(curves[k]));
}

/** 参数是否全为默认值（批量/保存按钮的禁用判断） */
export function isAdjustDefault(p: AdjustParams): boolean {
  const { curves, hueSat, colorMixer, colorGrade, ...rest } = p;
  return (
    Object.values(rest).every((v) => Math.abs(v) < 0.5) &&
    !hasAnyCurve(curves) &&
    isHueSatDefault(hueSat) &&
    isColorMixerDefault(colorMixer) &&
    isColorGradeDefault(colorGrade)
  );
}

/** 编辑结果的保存方式：默认覆盖原图；copy = 另存副本到指定目录 */
export interface EditSaveOptions {
  saveMode?: 'overwrite' | 'copy';
  targetDir?: string;
  addToLibrary?: boolean;
}

/** 单张编辑返回：item 在「另存且未入库」时为 null（原图未变） */
export interface EditResult {
  ok: boolean;
  item: ImageItem | null;
  savedPath: string;
  copied: boolean;
  note?: string;
}

/** 批量编辑任务状态（服务端 /api/edit/job） */
export interface EditJobStatus {
  running: boolean;
  cancelled: boolean;
  total: number;
  done: number;
  failed: number;
  op: string;
  label: string;
  currentId: number | null;
  currentTitle: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string;
  failures: { id: number; ok: boolean; error?: string }[];
}

/** 顶层视图（侧栏入口 + 顶栏工具箱 + URL 的 v 参数共用同一套枚举） */
export type View =
  | 'dashboard'
  | 'gallery'
  | 'favorites'
  | 'tidy'
  | 'playlists'
  | 'crawl'
  | 'bookmarks'
  | 'knowledge'
  | 'search'
  | 'smart'
  | 'enhance'
  | 'tutorial'
  | 'settings';
