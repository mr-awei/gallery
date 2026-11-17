// @ts-check
/**
 * 主进程跨模块共享状态（唯一属主）。
 *
 * 拆分 electron/main.js 时，原本散在文件顶层的 let 变量全部集中到这里：
 * 主窗口引用、服务端口、托盘对象、动态壁纸窗口等。各模块只读写本对象的字段，
 * 不互相 import 可变绑定（ESM 的 import 绑定只读，不能跨模块赋值），因此也不会
 * 出现循环依赖：context.js 不 import 任何业务模块。
 *
 * @typedef {Object} LivePowerHandlers
 * @property {() => void} lock
 * @property {() => void} unlock
 * @property {() => void} suspend
 * @property {() => void} resume
 *
 * @typedef {Object} ShotWindowRestore
 * @property {boolean} wasVisible
 * @property {boolean} wasMaximized
 * @property {boolean} wasMinimized
 * @property {boolean} wasFullScreen
 *
 * @typedef {Object} AppCtx
 * @property {import('electron').BrowserWindow | null} mainWindow 主窗口（关闭后可能为 null，托盘可重建）
 * @property {Set<import('electron').BrowserWindow>} appWindows 本应用的全部窗口（主窗口 + 多开的浏览窗口）：IPC 只认这几个 webContents
 * @property {import('electron').BrowserWindow | null} weiboWin 微博登录小窗（用完即关）
 * @property {import('../server-host.js').ServerHost | null} serverHost 服务子进程托管器
 * @property {number} serverPort 本地服务端口（0 = 未就绪）
 * @property {string} apiToken 本地 API 鉴权令牌
 * @property {string} ipcStorageRoot 缩略图/回收站所在的应用数据 storage 根（config.js STORAGE_DIR）
 * @property {boolean} serverStopped 停服务只做一次
 * @property {boolean} restartingServer 正在重启服务（防重入）
 * @property {any} desktopApi 桌面层挂载等能力（attachLiveWindow 等）
 * @property {() => Promise<void>} applyProxy
 * @property {() => void} registerProxyAuth
 * @property {boolean} forceQuit 真正退出（跳过托盘常驻与忙碌确认）
 * @property {boolean} quitting will-quit 已开始收尾
 * @property {import('electron').BrowserWindow | null} splashWindow 启动页
 * @property {import('electron').BrowserWindow | null} toastWindow 操作结果提示窗
 * @property {NodeJS.Timeout | null} toastTimer
 * @property {import('electron').Tray | null} tray
 * @property {(() => Promise<void>) | null} trayMenuRefresher 托盘菜单刷新器
 * @property {NodeJS.Timeout | null} trayTimer
 * @property {boolean} trayHintShown 是否已经提示过「仍在后台运行」
 * @property {string} lastTrayNotice 最近一次托盘操作的结果
 * @property {ShotWindowRestore | null} shotWindowRestore 框选会话里窗口的原样
 * @property {import('electron').BrowserWindow | null} liveWindow 动态壁纸窗口
 * @property {NodeJS.Timeout | null} livePerfTimer
 * @property {{ x: number, y: number, width: number, height: number }} liveBounds
 * @property {boolean} liveMounted
 * @property {string} liveSignature
 * @property {LivePowerHandlers | null} livePowerHandlers
 * @property {boolean} livePowerLocked
 * @property {number} liveRemountMisses
 * @property {number} liveLastRemount
 * @property {string} liveLastPauseReasons
 * @property {string} cachedSysAudioId
 * @property {number} cachedSysAudioAt
 * @property {import('electron').BrowserWindow | null} saverWindow 屏保窗口
 * @property {NodeJS.Timeout | null} saverTimer
 * @property {Record<string, string>} registeredHotkeys 已成功注册的全局快捷键（键名 → 加速键）
 * @property {Record<string, string>} failedHotkeys 候选键全被占用的（键名 → 试过的候选键串）
 * @property {boolean} shellImporting 「用图库打开」正在导入
 */

/** @type {AppCtx} */
export const ctx = {
  mainWindow: null,
  appWindows: new Set(),
  weiboWin: null,

  serverHost: null,
  serverPort: 0,
  apiToken: '',
  ipcStorageRoot: '',
  serverStopped: false,
  restartingServer: false,
  desktopApi: null,
  applyProxy: async () => {},
  registerProxyAuth: () => {},

  forceQuit: false,
  quitting: false,

  splashWindow: null,

  toastWindow: null,
  toastTimer: null,

  tray: null,
  trayMenuRefresher: null,
  trayTimer: null,
  trayHintShown: false,
  lastTrayNotice: '',

  shotWindowRestore: null,

  liveWindow: null,
  livePerfTimer: null,
  liveBounds: { x: 0, y: 0, width: 0, height: 0 },
  liveMounted: false,
  liveSignature: '',
  livePowerHandlers: null,
  livePowerLocked: false,
  liveRemountMisses: 0,
  liveLastRemount: 0,
  liveLastPauseReasons: '',
  cachedSysAudioId: '',
  cachedSysAudioAt: 0,

  saverWindow: null,
  saverTimer: null,

  registeredHotkeys: {},
  failedHotkeys: {},

  shellImporting: false,
};
