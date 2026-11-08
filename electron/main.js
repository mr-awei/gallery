import { app, BrowserWindow, Menu, Tray, globalShortcut, dialog, ipcMain, shell, screen, session, powerMonitor, nativeTheme, crashReporter, desktopCapturer, nativeImage } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flushLogs, getLogDir, initLogger } from './logger.js';
import {
  escapeHtml,
  isLocalApiUrl as isLocalApiUrlFor,
  isNewer,
  isPathInsideAny,
  originAllowed,
  parseExportPayload,
  isSafeLiveUrl,
  normalizePauseApps,
  shouldPauseLive,
  liveMountBroken,
} from './lib/pure.js';
import { ServerHost } from './server-host.js';
import { getSettingsSnapshot, setSettingsCache } from './settings-cache.js';
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  updateState,
  startBackgroundUpdate,
  dismissUpdate,
  onBeforeInstall,
  onInstallFailed,
  onUpdateReady,
  resetUpdateFailures,
} from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT_DIR = path.resolve(__dirname, '..');

/**
 * 开机自启写入的登录项参数里带了 --hidden，但以前没有任何代码消费它：
 * 开机自启 = 一登录就把主窗口糊到用户脸上。这里统一判定，启动时只留托盘。
 */
const START_HIDDEN = process.argv.includes('--hidden');

export const APP_NAME = '图库';
// 磁盘上的目录名一律 ASCII：安装目录、AppData 数据目录都会跟着它走。
// 中文目录还有实打实的坑——node:sqlite 在中文路径下关闭后句柄不释放，
// 删库目录会卡住（见 server/libraries.js 里库目录也用 ASCII 名）。
const APP_DIR_NAME = 'TuKu';
export const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');

app.setName(APP_DIR_NAME);

// 绿色版（electron-builder portable 目标）会把 exe 解到临时目录运行，若仍用默认
// userData，绿色版与安装版会共用同一个库目录与设置：一边升级 schema、另一边还在写，
// 混用版本直接互相破坏。portable 会注入 PORTABLE_EXECUTABLE_DIR，把数据放到 exe 旁边。
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, `${APP_DIR_NAME}Data`));
  } catch (err) {
    console.warn('[desktop] 绿色版数据目录设置失败，沿用默认 userData：', err?.message || err);
  }
}

// 必须与 electron-builder 的 appId / 安装快捷方式 AUMID 完全一致，否则 Windows 上
// Notification / 托盘气泡（Win10+ 走 toast）会被系统静默丢弃 —— 表现就是「点了没反馈」
app.setAppUserModelId('com.tuku.gallery');

/* ------------------------- 崩溃捕获与日志落盘（最先初始化） ------------------------- */
// minidump 只落本地 userData/CrashReports，不上传（隐私优先）；配合日志可定位白屏 / 闪退
try {
  // 不自动上传；转储只留在本机
  crashReporter.start({ uploadToServer: false, compress: true });
} catch {
  /* 部分平台不支持，忽略 */
}

/** 清掉 7 天前的崩溃转储：崩溃信息既不出去，也不该无限占磁盘 */
function cleanupCrashDumps(maxAgeDays = 7) {
  try {
    const dir = app.getPath('crashDumps');
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    const walk = (d, depth = 0) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(p, depth + 1);
          try {
            if (!fs.readdirSync(p).length) fs.rmdirSync(p);
          } catch {
            /* 非空/被占用 */
          }
          continue;
        }
        try {
          if (fs.statSync(p).mtimeMs < cutoff) {
            fs.unlinkSync(p);
            removed += 1;
          }
        } catch {
          /* 单个文件失败不影响其它 */
        }
      }
    };
    walk(dir);
    if (removed) console.info(`[crash] 已清理 ${removed} 个 ${maxAgeDays} 天前的崩溃转储`);
  } catch (err) {
    console.warn('[crash] 清理崩溃转储失败：', err?.message || err);
  }
}
initLogger(app.isPackaged ? app.getPath('userData') : APP_ROOT_DIR);
process.on('uncaughtException', (err) => {
  console.error('[desktop] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[desktop] unhandledRejection:', err);
});

/**
 * 打包后应用代码位于只读的 app.asar 内，数据库 / 缩略图 / AI 运行库必须写到可写目录。
 * 这里在「服务端模块被加载之前」注入目录，服务端因此改为动态 import：
 * 主进程必须等入口模块求值完成才会启动事件循环，若在模块顶层 await import('electron')
 * 会形成死锁（表现为进程活着但无窗口、无端口、无子进程）。
 */
process.env.TUKU_USER_DATA = app.isPackaged ? app.getPath('userData') : APP_ROOT_DIR;
process.env.TUKU_PACKAGED = app.isPackaged ? '1' : '';
// 默认图片保存位置：用户「图片」目录下的 TuKu 文件夹。
// 不用中文目录名——素材路径会进 DB、进日志、进备份，ASCII 少一堆编码麻烦。
// 不再写死具体路径——任何人安装后都能在设置页改成自己想要的任意文件夹。
process.env.TUKU_DEFAULT_STORAGE_DIR = path.join(app.getPath('pictures'), 'TuKu');

// 服务端相关能力（在 app ready 后动态加载）
// 服务端跑在独立 utilityProcess 里（见 server-host.js），主进程只保留
// 设置快照 + 桌面层能力；不再 import server/db.js —— SQLite 只能有一个属主进程。
let serverHost = null; // ServerHost 实例
const getSettings = getSettingsSnapshot; // 服务端推送的设置快照
let ipcStorageRoot = ''; // 缩略图/回收站所在的应用数据 storage 根（config.js STORAGE_DIR）
let applyProxy = async () => {};
let registerProxyAuth = () => {};
let desktopApi = null; // 桌面层挂载等能力（attachLiveWindow 等）

// 只允许一个实例：第二次启动直接退出，并把已有窗口带到前台
// （两个实例会同时读写同一个数据库与图片文件，容易互相锁住）
let mainWindow = null;
/** 本应用的全部窗口（主窗口 + 用户多开的浏览窗口）：IPC 只认这几个 webContents */
const appWindows = new Set();
let serverPort = 0;
let forceQuit = false;
let weiboWin = null; // 微博登录小窗（用完即关）

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // 直接从开始菜单再点一次时，主窗口可能已经被销毁（进程还在托盘）：
    // 以前这里只处理「窗口还在」的情况，于是表现成「应用打不开」。
    // showMainWindow 自带「窗口缺失就重建」。
    showMainWindow();
    // 拖到 exe 上 / 双击关联文件打开：第二个实例把文件路径带进来
    const files = pickImagePathsFromArgv(argv);
    if (files.length) void importPathsFromShell(files);
  });
}

/** 本地 API 鉴权令牌（app ready 后从 server/config.js 读入，见 fetchJson） */
let apiToken = '';

/** 给本机 API 的 URL 追加 ?token=（下载直链等无法自定义 header 的请求用） */
function withApiToken(url) {
  if (!apiToken || !/^https?:/i.test(url)) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('token')) u.searchParams.set('token', apiToken);
    return u.toString();
  } catch {
    return url;
  }
}

/** URL 是否指向本机的图库服务（实现见 lib/pure.js，便于单测） */
function isLocalApiUrl(raw) {
  return isLocalApiUrlFor(raw, serverPort);
}

/**
 * IPC 调用方校验：只接受本应用主窗口（且同为本机页面）发起的调用。
 * 以前 18 个 handle 谁调都答——一旦主窗口被导航到外部页面、或被其它窗口
 * 拿到渲染进程上下文，就能直接调 open-folder / weibo-login / download-file。
 */
function trustedSender(e) {
  if (!e) return false;
  // 多窗口：任一应用窗口都算可信（仍校验是本机页面）
  const owner = [...appWindows].find((w) => !w.isDestroyed() && w.webContents === e.sender);
  if (!owner) return false;
  const url = String(e.senderFrame?.url || '');
  if (!url) return true; // 主框架无 URL（极早期调用）时只靠 sender 身份
  // 与导航白名单同一套精确 origin 比对（含端口）：以前这里用正则放行任意端口，
  // 本机别的服务占一个端口就能冒充「可信调用方」
  return isTrustedOrigin(url);
}

/** 带调用方校验的 ipcMain.handle */
function handleIpc(channel, listener) {
  ipcMain['handle'](channel, async (e, ...args) => {
    if (!trustedSender(e)) {
      console.warn('[ipc] 拒绝非本应用页面的调用:', channel, e?.senderFrame?.url || '');
      return null;
    }
    return listener(e, ...args);
  });
}

/** 任务进行中时拦截退出（任务管理器、强制关机等系统级手段无法拦截，属正常） */
async function fetchJson(url, init = {}, timeoutMs = 2500) {
  // Node fetch 不带 Sec-Fetch 头，必须显式带 Bearer 令牌过 /api 鉴权
  const headers = { ...(init.headers || {}) };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

async function busyTasks() {
  const tasks = [];
  if (!serverPort) return tasks;
  try {
    const crawl = await fetchJson(`http://127.0.0.1:${serverPort}/api/crawl/status`);
    if (crawl?.running) tasks.push('图片采集');
  } catch {}
  try {
    const imp = await fetchJson(`http://127.0.0.1:${serverPort}/api/import/status`);
    if (imp?.running) tasks.push('本地素材导入');
  } catch {}
  try {
    const enh = await fetchJson(`http://127.0.0.1:${serverPort}/api/enhance/job`);
    if (enh?.running) tasks.push('画质增强');
  } catch {}
  return tasks;
}

async function confirmExitWhileBusy() {
  if (forceQuit) return true;
  const tasks = await busyTasks();
  if (!tasks.length) return true;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '任务进行中',
    message: `有任务正在进行：${tasks.join('、')}`,
    detail: '现在退出会中断任务，可能导致部分图片未完成下载或入库。确定要退出吗？',
    buttons: ['继续运行（不退出）', '仍然退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

/** 不显示原生菜单栏（顶部「文件 / 视图 / 帮助」由应用内界面承担）。
 *  常用的开发者快捷键改为窗口级快捷键，保持调试便利。 */
function buildMenu() {
  Menu.setApplicationMenu(null);
}

/** 窗口级快捷键（替代原菜单加速键） */
function registerShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    if (ctrl && key === 'r') {
      win.webContents.reload();
      event.preventDefault();
    } else if (ctrl && input.key === '0') {
      win.webContents.setZoomLevel(0);
      event.preventDefault();
    } else if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

/** 开发用：让桌面窗口加载 Vite 开发服务器（前端热更新），API 走 npm run dev 起的 3001。
 *  打包版一律忽略：--dev-url / TUKU_DEV_URL 可加载任意远程页面且携带完整桥接，绝不能在生产生效。 */
function devServerUrl() {
  if (app.isPackaged) return '';
  const arg = process.argv.find((a) => a.startsWith('--dev-url='));
  return arg ? arg.slice('--dev-url='.length) : process.env.TUKU_DEV_URL || '';
}

/* --------------------------- 导航 / 权限白名单 --------------------------- */
// 主窗口挂着 preload 桥（打开文件夹、下载、截图、微博登录…），一旦同窗口跳到外站，
// 外站脚本仍能直接调用 window.desktopAPI。setWindowOpenHandler 只挡 window.open，
// 挡不住 location.href / 表单提交 / JS 跳转，必须再拦 will-navigate。

/** 允许页面停留/跳转的 origin：本地服务（窗口本体、/live 壁纸页）+ 开发服务器 */
function trustedOrigins() {
  const set = new Set();
  if (serverPort) {
    set.add(`http://127.0.0.1:${serverPort}`);
    set.add(`http://localhost:${serverPort}`);
  }
  const dev = devServerUrl();
  if (dev) {
    try {
      set.add(new URL(dev).origin);
    } catch {
      /* 非法 devUrl 忽略 */
    }
  }
  return set;
}

function isTrustedOrigin(target) {
  return originAllowed(target, trustedOrigins());
}

/** 微博登录窗允许停留的站点：登录流程会跨 passport / login.sina / 静态资源几跳 */
const WEIBO_HOST_RE = /(^|\.)(weibo\.(cn|com)|sina\.(com\.cn|cn)|sinaimg\.cn)$/i;

function isWeiboOrigin(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return WEIBO_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/** 敏感权限白名单：只给自家页面，且只给真正需要的几项。
 * 补 'media'：动态壁纸音频可视化（麦克风 / 系统音频回环）需要 getUserMedia，
 * 但只放行自家 localhost 源（isTrustedOrigin 已把关），不波及远程 web 壁纸页。 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications', 'media']);

/** 已装守卫的 session：微博登录窗/壁纸窗用的是各自 partition，全局布尔只护得住第一个窗口 */
const guardedSessions = new WeakSet();
function installPermissionGuard(ses) {
  if (!ses || guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  // 原来完全没有处理器：默认全部放行，任意页面（含动态壁纸加载的远程站点）
  // 打开一次就能拿到摄像头/麦克风/地理定位/通知权限。
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const from = details?.requestingUrl || wc?.getURL?.() || '';
    const ok = isTrustedOrigin(from) && ALLOWED_PERMISSIONS.has(permission);
    if (!ok) console.warn('[desktop] 拒绝权限：', permission, from);
    callback(ok);
  });
  // 同步的光标/可用性检查，行为和上面的请求处理器保持一致
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return isTrustedOrigin(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission);
  });
}

/* ---------------- 窗口位置记忆 / 关联文件（双击图片用本应用打开） ---------------- */

/** 窗口状态落在 userData 下的一个小 JSON 里：不进图库 DB，多库切换时也不会互相覆盖 */
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf8');
    const s = JSON.parse(raw);
    if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return null;
    return s;
  } catch {
    return null;
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    const payload = { ...b, maximized: win.isMaximized() };
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(payload));
  } catch (err) {
    console.warn('[desktop] 保存窗口位置失败：', err?.message || err);
  }
}

/** 恢复的窗口必须还有足够面积落在某块屏幕上，否则（拔了副屏）会开在看不见的地方 */
function boundsVisibleOnSomeDisplay(b) {
  if (!b) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w > 200 && h > 120;
  });
}

const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|avif|svg|tiff?|heic|mp4|webm|mov|mkv|avi|mp3|wav|flac|ogg|m4a)$/i;

/** 从命令行参数里挑出「看起来是图片/视频/音频」的绝对路径（拖到 exe 上、双击关联文件） */
function pickImagePathsFromArgv(argv) {
  const out = [];
  for (const raw of argv || []) {
    if (!raw || raw.startsWith('-')) continue;
    if (!MEDIA_EXT_RE.test(raw)) continue;
    const p = path.resolve(raw);
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      /* 不是真实文件：多半是 exe 自身路径 */
    }
  }
  return out;
}

/**
 * 把「用本应用打开」的文件导进图库。
 * 服务端只提供目录扫描与上传两个入口，这里按单文件走上传（二进制 body），
 * 避免为了几十个文件去改动导入任务的状态机。
 */
let shellImporting = false;
async function importPathsFromShell(files) {
  if (!files?.length) return;
  if (!serverPort) {
    showToastBanner('暂时无法导入', '本地服务还没就绪，请稍后再试');
    return;
  }
  if (shellImporting) {
    showToastBanner('导入进行中', '上一批「用图库打开」的文件还在入库，请稍候');
    return;
  }
  shellImporting = true;
  let ok = 0;
  let failed = 0;
  try {
    for (const file of files) {
      try {
        const buf = await fsp.readFile(file);
        const url = withApiToken(
          `http://127.0.0.1:${serverPort}/api/import/upload?filename=${encodeURIComponent(path.basename(file))}`
        );
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
          },
          body: buf,
        });
        if (res.ok) ok += 1;
        else failed += 1;
      } catch (err) {
        console.warn('[desktop] 导入关联文件失败：', file, err?.message || err);
        failed += 1;
      }
    }
  } finally {
    shellImporting = false;
  }
  if (ok || failed) {
    showToastBanner(
      '已用图库打开',
      failed ? `成功 ${ok} 个，失败 ${failed} 个（格式或体积不符合入库规则）` : `成功导入 ${ok} 个文件`
    );
  }
}

/* ------------------------------ 启动页 ------------------------------ */
// 首次建库 / 大库迁移时服务可能十几秒才就绪。以前这段时间什么都没有，
// 用户看到鼠标转圈会以为没打开，于是重复双击（又被单实例锁吞掉）。
let splashWindow = null;

function splashHtml(text) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0a0a12;color:#e8ecf5;
      font:13.5px/1.7 "Microsoft YaHei",system-ui,sans-serif;display:flex;
      align-items:center;justify-content:center;-webkit-user-select:none}
    .box{text-align:center;padding:0 28px}
    .logo{width:56px;height:56px;margin:0 auto 14px;border-radius:14px;
      background:linear-gradient(135deg,#4f6bff,#9b5cff);box-shadow:0 8px 24px rgba(79,107,255,.35)}
    .t{font-size:15px;font-weight:600;letter-spacing:.5px}
    .s{margin-top:8px;color:#8b93a7;font-size:12.5px}
  </style></head><body><div class="box">
    <div class="logo"></div><div class="t">图库</div>
    <div class="s" id="s">${text}</div>
  </div></body></html>`;
}

function showSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;
  try {
    splashWindow = new BrowserWindow({
      width: 380,
      height: 220,
      frame: false,
      resizable: false,
      center: true,
      show: true,
      backgroundColor: '#0a0a12',
      title: '图库',
      icon: APP_ICON,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml('正在启动本地服务…'))}`);
    splashWindow.on('closed', () => {
      splashWindow = null;
    });
  } catch (err) {
    console.warn('[desktop] 启动页创建失败：', err?.message || err);
  }
  return splashWindow;
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

/** 启动失败：关掉启动页，给出原因与「重试 / 退出」——不能让用户干等或直接消失 */
async function failSplash(message) {
  closeSplash();
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: '图库启动失败',
    message: '本地服务没能启动',
    detail: `${message}\n\n可以点「重试」再启动一次；仍失败请查看日志目录（设置 → 数据与维护）。`,
    buttons: ['重试', '退出'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    app.relaunch();
    app.exit(0);
  } else {
    app.exit(1);
  }
}

async function createWindow() {
  if (!serverPort) {
    // 走到这里说明服务进程没起来（whenReady 已经做过一次提示与重试），不再白屏
    console.error('[desktop] 创建窗口时服务端口为空');
    return;
  }

  // 主窗口尺寸按屏幕工作区算：4K 上不再是一块小窗，1366×768 也不会大到装不下
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = Math.min(1760, Math.max(1120, Math.round(workArea.width * 0.84)));
  const winHeight = Math.min(1080, Math.max(660, Math.round(workArea.height * 0.86)));

  // 还原上次的位置/大小；拔掉副屏导致越界时回落到「居中 + 默认尺寸」
  const saved = loadWindowState();
  const restore = boundsVisibleOnSomeDisplay(saved);
  const initialBounds = restore
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : { width: winWidth, height: winHeight };

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: Math.min(1024, initialBounds.width),
    minHeight: Math.min(680, initialBounds.height),
    center: !restore,
    title: `${APP_NAME} · 本地图片管理`,
    icon: APP_ICON,
    backgroundColor: '#0a0a12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 必须在 loadURL 之前登记：页面最早的 IPC（例如启动时应用主题的 set-theme）
  // 在窗口加载过程中就会发出来，登记晚了会被 trustedSender 当成外部页面拒掉
  appWindows.add(mainWindow);

  // 位置/大小记忆：拖动/缩放停下来 400ms 后写盘，关窗时再补一次
  let boundsTimer = null;
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveWindowState(mainWindow), 400);
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('close', () => saveWindowState(mainWindow));
  if (restore && saved.maximized) mainWindow.maximize();

  registerShortcuts(mainWindow);

  // 权限白名单（主窗口与 /live 壁纸页共用默认 session）
  installPermissionGuard(mainWindow.webContents.session);

  // 同窗口跳转白名单：外链交给系统浏览器，绝不让带 preload 桥的窗口离开本地服务
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isTrustedOrigin(target)) return;
    event.preventDefault();
    console.warn('[desktop] 已阻止窗口跳转：', target);
    if (/^https?:/i.test(target)) void shell.openExternal(target);
  });
  mainWindow.webContents.on('will-redirect', (event, target) => {
    if (isTrustedOrigin(target)) return;
    event.preventDefault();
    console.warn('[desktop] 已阻止重定向：', target);
  });

  const devUrl = devServerUrl();
  const url = devUrl || `http://127.0.0.1:${serverPort}`;
  console.info('[desktop] 加载', url);
  if (devUrl) {
    // 开发态以前完全不设 CSP（生产态由服务端下发）：Vite 命中 XSS 时没有任何兜底。
    // 这里按 Vite 的最低需求给一份「宽松但存在」的策略。
    const DEV_CSP = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: http: https:",
      "media-src 'self' data: blob: http: https:",
      "font-src 'self' data:",
      "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
    ].join('; ');
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== 'mainFrame' || !isTrustedOrigin(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [DEV_CSP] },
      });
    });
    // 开发模式：Vite 可能还没起来，失败就重试，避免白屏
    let lastErr = null;
    for (let i = 0; i < 40; i++) {
      try {
        await mainWindow.loadURL(url);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastErr) {
      console.error('[desktop] 开发服务器未就绪：', lastErr.message);
      await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`).catch(() => {});
    }
  } else {
    await mainWindow.loadURL(url);
  }
  if (START_HIDDEN) {
    // 开机自启：界面已经加载好但先不显示，用户点托盘/快捷键再露出来
    console.info('[desktop] --hidden 启动：窗口保持隐藏，仅托盘可见');
  } else {
    mainWindow.show();
  }

  // 不新建窗口：下载类链接交给下载管理器，其他链接交给系统浏览器
  // （原来 window.open 会拉出一个空白窗口）
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.includes('/api/')) {
      mainWindow.webContents.downloadURL(target);
    } else if (/^https?:/i.test(target)) {
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  /* ------------- 渲染进程兜底：崩溃自动重载、卡死给出口、加载失败重试 ------------- */
  let renderCrashes = 0;
  let lastCrashAt = 0;
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[desktop] 渲染进程崩溃:', details.reason, details.exitCode);
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    if (now - lastCrashAt > 5 * 60_000) renderCrashes = 0; // 时间窗重置
    lastCrashAt = now;
    renderCrashes += 1;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (renderCrashes > 3) {
      // 以前这里弹完错误框就 return：窗口停在白屏、主进程和托盘还活着，
      // 用户既看不到界面也退不掉，只能去任务管理器杀进程（「半死状态」）。
      // 现在必须给出可执行的出口：重载一次（计数清零）或直接退出。
      void dialog
        .showMessageBox(mainWindow, {
          type: 'error',
          title: '界面反复崩溃',
          message: `界面进程 5 分钟内崩溃 ${renderCrashes} 次`,
          detail:
            '自动重载已暂停。可以先重载一次继续使用；如果立刻又崩，请退出后把日志（应用数据目录 logs/app-日期.log）反馈给开发者。',
          buttons: ['重载一次', '退出程序'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then(({ response }) => {
          if (response === 1) {
            forceQuit = true;
            app.quit();
            return;
          }
          renderCrashes = 0;
          lastCrashAt = 0;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        })
        .catch((err) => console.error('[desktop] 崩溃提示框失败：', err?.message || err));
      return;
    }
    // 崩溃后窗口是白屏，重载一次通常就能恢复（筛选状态在 URL 里，不会丢）
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    }, 400);
  });

  // 事件循环被长任务卡住时给用户两条路，而不是一直转圈
  mainWindow.on('unresponsive', async () => {
    console.warn('[desktop] 窗口无响应');
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '界面无响应',
      message: '界面长时间没有响应',
      detail: '可能正在处理大图或执行批量任务。可以再等一会儿，或强制重载界面（未保存的编辑会丢失）。',
      buttons: ['继续等待', '重载界面'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1 && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  });

  let loadRetries = 0;
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 主动中断（重载/跳转），不算失败
    console.error('[desktop] 页面加载失败:', code, desc, url);
    if (loadRetries >= 3) return;
    loadRetries += 1;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url).catch(() => {});
    }, 500 * loadRetries);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    loadRetries = 0;
  });

  // 兼容新旧两种签名（Electron 44 起改为事件对象）
  mainWindow.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const level = typeof ev?.level === 'number' ? ev.level : args[1];
    const message = ev?.message ?? args[2] ?? '';
    const line = ev?.lineNumber ?? args[3] ?? 0;
    const sourceId = ev?.sourceId ?? args[4] ?? '';
    if (level >= 3) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on('close', async (e) => {
    if (forceQuit) return;
    e.preventDefault();
    // 托盘常驻：之前关窗直接 quit，「托盘图标 + 打开主窗口」形同虚设——
    // 定时换壁纸、全局快捷键也跟着一起失效。默认关窗只藏起来，真正退出走托盘「退出」。
    if (shouldHideToTray()) {
      hideToTray();
      return;
    }
    // 事件回调里的 await 一旦抛错就是 unhandledRejection，窗口会「点了关闭没反应」；
    // 出问题时按「不退出」处理，至少窗口还在，用户能重试
    let ok;
    try {
      ok = await confirmExitWhileBusy();
    } catch (err) {
      console.error('[desktop] 退出确认失败：', err?.message || err);
      return;
    }
    if (!ok) return;
    forceQuit = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    app.quit();
  });

  mainWindow.on('closed', () => {
    appWindows.delete(mainWindow);
    mainWindow = null;
  });
}

/**
 * 多窗口浏览：再开一个窗口看同一份图库（共享同一个本地服务与数据库）。
 *
 * 刻意不复用 createWindow：主窗口那套「关窗藏托盘 / 忙碌确认退出 / 崩溃兜底」只属于
 * 那一个窗口；副窗口关掉就该真的关掉，否则用户开了一堆窗口却退不干净。
 */
async function openAppWindow() {
  if (!serverPort) return { ok: false, error: '本地服务尚未就绪，请稍后再试' };
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: `${APP_NAME} · 新窗口`,
    icon: APP_ICON,
    backgroundColor: '#0a0a12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  appWindows.add(win);
  win.on('closed', () => appWindows.delete(win));

  installPermissionGuard(win.webContents.session);
  // 副窗口同样不许离开本地服务（带着 preload 桥的窗口不能变成浏览器）
  win.webContents.on('will-navigate', (event, target) => {
    if (isTrustedOrigin(target)) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) void shell.openExternal(target);
  });
  win.webContents.on('will-redirect', (event, target) => {
    if (isTrustedOrigin(target)) return;
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.includes('/api/')) win.webContents.downloadURL(withApiToken(target));
    else if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });

  const devUrl = devServerUrl();
  try {
    await win.loadURL(devUrl || `http://127.0.0.1:${serverPort}`);
  } catch (err) {
    win.destroy();
    return { ok: false, error: err?.message || '窗口加载失败' };
  }
  win.show();
  return { ok: true };
}

/* --------------------------- 托盘与全局快捷键 --------------------------- */

let tray = null;
let trayHintShown = false;
/** 托盘菜单刷新器（createTray 里赋值）：trayNotify 操作完顺手把菜单内容也更新一遍 */
let trayMenuRefresher = null;
let trayTimer = null;
/** 最近一次托盘操作的结果：系统通知被免打扰拦掉时，用户点开菜单仍能看到 */
let lastTrayNotice = '';

/**
 * 关窗是否只藏到托盘。
 * 托盘创建失败（无 GUI/图标缺失）时必须退回「关窗=退出」，否则用户既看不到窗口
 * 也没有托盘入口，等于把应用变成后台幽灵进程。
 */
function shouldHideToTray() {
  if (!tray || tray.isDestroyed()) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return getSettings().closeToTray !== false;
}

/** 关窗 → 藏进托盘，首次提示「还在后台运行」 */
function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  // 第一次藏起来必须说一声：托盘图标常在任务栏小箭头里，不说用户会以为应用已退出
  if (!trayHintShown && tray && !tray.isDestroyed()) {
    trayHintShown = true;
    try {
      tray.displayBalloon({
        title: `${APP_NAME} 仍在后台运行`,
        content: '窗口已收到托盘：定时换壁纸与全局快捷键继续生效，右键托盘图标可退出。',
        icon: APP_ICON,
      });
    } catch (err) {
      console.warn('[tray] 气泡提示失败：', err?.message || err);
    }
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 窗口被销毁（崩溃 / 关闭后留在托盘）时，托盘与全局快捷键必须能把它重建出来，
    // 否则这些入口全部静默失效，看起来就是「点托盘没反应」。
    if (serverPort) {
      void createWindow().catch((err) => console.error('[desktop] 重建窗口失败：', err?.message || err));
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

let restartingServer = false;

/** 服务重启前/后通知所有渲染窗口：重启期间界面该显示遮罩，而不是让用户对着失败的请求发呆 */
function broadcastServiceState(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('service-state', payload);
    } catch {
      /* 窗口正在销毁 */
    }
  }
}

/**
 * 端口变了以后，所有应用窗口都要换 origin —— 以前只重载 mainWindow，
 * appWindows 里的多开窗口会一直指着旧端口，全部请求失败，navigation 白名单也跟着失效。
 */
function reloadAllAppWindows() {
  const base = `http://127.0.0.1:${serverPort}`;
  const targets = new Set([mainWindow, ...appWindows]);
  for (const win of targets) {
    if (!win || win.isDestroyed()) continue;
    let url = base;
    try {
      // 保留各窗口原来的路由（#/xx 或 /search），只换端口
      const cur = new URL(win.webContents.getURL());
      if (cur.hostname === '127.0.0.1' || cur.hostname === 'localhost') {
        cur.protocol = 'http:';
        cur.port = String(serverPort);
        url = cur.toString();
      }
    } catch {
      /* 当前不是应用页面（about:blank 等）：直接用根地址 */
    }
    win.loadURL(url).catch((err) => console.warn('[desktop] 重载窗口失败：', err?.message || err));
  }
}

/**
 * 托盘「重启本地服务」。
 * server-host 在崩溃窗口内连续失败达到上限后会进入 dead 态：此时所有接口、壁纸、
 * 快捷键、缩略图全部静默失效，而以前唯一出路是「彻底退出再打开」——
 * 用户看到的就是「应用打开着但什么都点不动」，且不知道该干什么。
 */
async function restartLocalServer() {
  if (restartingServer) return false;
  if (!serverHost) {
    // 开发模式下 API 由外部 node 进程提供，这里没有子进程可重启
    dialog.showErrorBox('无法重启本地服务', '当前是开发模式（API 不在应用内），请重启 npm run dev。');
    return false;
  }
  restartingServer = true;
  broadcastServiceState({ restarting: true });
  try {
    await serverHost.stop().catch(() => {});
    // 清空崩溃窗口内的失败计数与换端口兜底标记，否则刚起来再崩一次又立刻进 dead
    serverHost.revive();
    const info = await serverHost.start();
    serverPort = info.port;
    apiToken = info.token || apiToken;
    setSettingsCache(info.settings || {});
    broadcastServiceState({ restarting: false, dead: false, port: serverPort });
    reloadAllAppWindows();
    return true;
  } catch (err) {
    broadcastServiceState({ restarting: false, dead: true, error: String(err?.message || err) });
    dialog.showErrorBox(
      '重启本地服务失败',
      `${err?.message || err}\n\n请完全退出应用后重新打开。`
    );
    return false;
  } finally {
    restartingServer = false;
  }
}

/* --------------------------- 操作结果提示窗 --------------------------- */

const TOAST_WIDTH = 380;
const TOAST_HEIGHT = 96;

let toastWindow = null;
let toastTimer = null;

// escapeHtml 已抽到 lib/pure.js（提示窗拼 HTML，转义漏一个就是注入）

function closeToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.destroy();
  toastWindow = null;
}

/**
 * 右下角自绘提示窗：4 秒自动消失，点击穿透、不抢焦点、不占任务栏。
 *
 * 为什么不用系统通知：Windows 的 toast / 托盘气泡依赖 AUMID、安装快捷方式、
 * 系统通知开关三件事同时成立，任何一项不满足就被**静默丢弃**。用户点完托盘
 * 什么也没看到，只能认为「点了没生效」。自绘窗口不依赖这些前提。
 */
function showToastBanner(title, body) {
  if (quitting) return;
  const text = String(body || '').trim();
  const bad = /失败|没换成|不可用|不支持|出错|异常|无法/.test(`${title}${text}`);
  const accent = bad ? '#ff6b6b' : '#4f6bff';
  const head = escapeHtml(title || '图库');
  const detail = escapeHtml(text);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#1c1e2b;overflow:hidden;user-select:none;
    font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;color:#eaeaef;}
  .box{display:flex;gap:12px;height:100%;box-sizing:border-box;padding:15px 17px;}
  .bar{width:4px;flex:none;border-radius:4px;background:${accent};}
  .t{margin:0 0 5px;font-size:13px;font-weight:600;line-height:1.45;}
  .b{margin:0;font-size:12px;line-height:1.55;color:rgba(234,234,239,.72);
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  </style></head><body><div class="box"><div class="bar"></div><div>
  <p class="t">${head}</p><p class="b">${detail}</p></div></div></body></html>`;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    closeToast();
    toastWindow = new BrowserWindow({
      width: TOAST_WIDTH,
      height: TOAST_HEIGHT,
      x: Math.round(wa.x + wa.width - TOAST_WIDTH - 16),
      y: Math.round(wa.y + wa.height - TOAST_HEIGHT - 16),
      frame: false,
      // 不用 transparent 窗口：部分 Windows/显卡组合下透明合成会只画出一块纯色，
      // 文字完全不显示。这里直接给窗口上底色，宁可少一圈圆角也要保证看得见。
      backgroundColor: '#1c1e2b',
      roundedCorners: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    toastWindow.setAlwaysOnTop(true, 'screen-saver');
    // 不让提示窗挡住鼠标：它只是通知，不能拦用户操作它底下的窗口
    toastWindow.setIgnoreMouseEvents(true);
    // 页面加载完再显示：ready-to-show 在个别环境下不触发，会让提示窗永远不出现
    toastWindow
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => {
        try {
          toastWindow?.showInactive();
        } catch {
          /* 窗口可能已被下一次提示替换 */
        }
      })
      .catch((err) => console.warn('[toast] 提示窗内容加载失败：', err?.message || err));
    toastWindow.on('closed', () => {
      toastWindow = null;
    });
    toastTimer = setTimeout(() => closeToast(), 4200);
  } catch (err) {
    console.warn('[toast] 提示窗创建失败：', err?.message || err);
  }
}

/**
 * 托盘菜单的结果必须让用户看得见。
 * 以前每个 click 都是「请求发出去就不管了」，后端报错（比如换壁纸时提示
 * 「该范围内没有可用图片」）只写进日志，用户点完只觉得没生效。
 */
function trayNotify(title, content) {
  const body = String(content || '').trim();
  // 菜单顶部同时留一条「上次操作」：提示窗 4 秒就消失，菜单里的记录可以回看
  lastTrayNotice = `${title}${body ? `：${body}` : ''}`.slice(0, 60);
  try {
    Promise.resolve(trayMenuRefresher?.()).catch(() => {});
  } catch (err) {
    console.error('[tray] 刷新菜单失败：', err?.message || err);
  }
  showToastBanner(title, body);
}

/** 通过本地接口操作壁纸（托盘菜单与全局快捷键共用） */
async function wallpaperAction(kind) {
  if (!serverPort) {
    trayNotify('壁纸没换成', '本地服务还没起来，等几秒再试，或点「重启本地服务」');
    return null;
  }
  const path =
    kind === 'now'
      ? '/api/wallpaper/now'
      : kind === 'favorite'
        ? '/api/wallpaper/current/favorite'
        : '/api/wallpaper/current/dislike';
  try {
    const data = await fetchJson(`http://127.0.0.1:${serverPort}${path}`, { method: 'POST' }, 30000);
    // fetchJson 不看状态码：500 时它照样返回 { error }，必须自己判
    if (!data || data.error) throw new Error(data?.error || '服务没有返回结果');
    const name = String(data.title || '').slice(0, 40);
    if (kind === 'favorite') trayNotify('已收藏', name ? `已收藏「${name}」` : '已收藏当前壁纸');
    else if (kind === 'dislike') trayNotify('已跳过', name ? `换成了「${name}」` : '已跳过这一张，换下一张');
    else trayNotify('壁纸已更换', name ? `当前壁纸：${name}` : '已切换到新壁纸');
    return data;
  } catch (err) {
    console.error('[wallpaper] 操作失败：', err?.message || err);
    trayNotify('壁纸没换成', err?.message || '未知错误');
    return null;
  }
}

/** 托盘图标：不打开主窗口也能换壁纸、收藏当前壁纸 */
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(APP_ICON);
  } catch (err) {
    console.error('[tray] 托盘创建失败：', err?.message || err);
    return;
  }
  tray.setToolTip(`${APP_NAME} · 本地图片管理`);

  const refreshMenu = async () => {
    if (!tray || tray.isDestroyed()) return;
    // 端口还没就绪时去请求 http://127.0.0.1:0/... 只会刷一堆错误日志
    if (!serverPort) return;
    let cur = {};
    let auto = {};
    let live = {};
    try {
      cur = (await fetchJson(`http://127.0.0.1:${serverPort}/api/wallpaper/current`)) || {};
    } catch {}
    try {
      auto = (await fetchJson(`http://127.0.0.1:${serverPort}/api/wallpaper/auto`))?.config || {};
    } catch {}
    try {
      live = (await fetchJson(`http://127.0.0.1:${serverPort}/api/wallpaper/live`)) || {};
    } catch {}
    const title = String(cur.title || '').slice(0, 16);
    const menu = Menu.buildFromTemplate([
      ...(lastTrayNotice
        ? [{ label: `上次操作：${lastTrayNotice}`, enabled: false }, { type: 'separator' }]
        : []),
      { label: '打开主窗口', click: showMainWindow },
      {
        label: '框选截图…',
        click: () => {
          // 窗口隐藏 / 屏幕抓取被拦时这里会抛，不能静默吞掉
          void Promise.resolve(requestRegionShot())
            .catch((err) => trayNotify('截图没成功', err?.message || '屏幕抓取不可用，试试打开主窗口再截'))
            .finally(() => refreshMenu());
        },
      },
      {
        label: restartingServer ? '正在重启本地服务…' : '重启本地服务',
        enabled: !restartingServer,
        click: () => {
          void restartLocalServer().then((ok) => {
            if (ok) trayNotify('本地服务已重启', '现在可以继续换壁纸、收藏了');
            refreshMenu();
          });
        },
      },
      {
        label: '关闭窗口时最小化到托盘',
        type: 'checkbox',
        checked: getSettings().closeToTray !== false,
        click: async (item) => {
          const next = !!item.checked;
          // 先落本地快照：close 事件可能在这个请求返回前就触发，否则会「点一次不生效」
          setSettingsCache({ ...getSettingsSnapshot(), closeToTray: next });
          try {
            await fetchJson(
              `http://127.0.0.1:${serverPort}/api/settings`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ closeToTray: next }),
              },
              5000
            );
          } catch (err) {
            console.error('[tray] 保存托盘常驻设置失败：', err?.message || err);
            // 保存失败就回滚开关，别让界面显示的和实际行为不一致
            setSettingsCache({ ...getSettingsSnapshot(), closeToTray: !next });
            trayNotify('设置没保存', err?.message || '本地服务没响应');
            refreshMenu();
          }
        },
      },
      { type: 'separator' },
      { label: '换一张壁纸　Ctrl+Alt+W', click: () => wallpaperAction('now') },
      {
        label: title ? `收藏当前壁纸（${title}）` : '收藏当前壁纸',
        enabled: !!cur.imageId,
        click: () => wallpaperAction('favorite'),
      },
      {
        label: '不喜欢，换一张',
        enabled: !!cur.imageId,
        click: () => wallpaperAction('dislike'),
      },
      { type: 'separator' },
      {
        label: live.enabled ? '关闭动态壁纸' : '开启动态壁纸',
        click: async () => {
          const next = !live.enabled;
          try {
            // 只保存配置，真正的创建/销毁由 liveBus 广播触发（server → 主进程 → 窗口）
            await fetchJson(
              `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
              }
            );
            trayNotify(
              next ? '动态壁纸已开启' : '动态壁纸已关闭',
              next ? '桌面会按当前壁纸动起来；想停就在托盘菜单再点一次' : ''
            );
          } catch (err) {
            console.error('[tray] 动态壁纸切换失败：', err?.message || err);
            trayNotify('动态壁纸没切换', err?.message || '本地服务没响应，试试「重启本地服务」');
          }
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: auto.enabled ? '暂停定时切换' : '启用定时切换',
        click: async () => {
          const next = !auto.enabled;
          try {
            const data = await fetchJson(
              `http://127.0.0.1:${serverPort}/api/wallpaper/auto`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
              }
            );
            if (!data || data.error) throw new Error(data?.error || '服务没有返回结果');
            const every = data?.config?.intervalMinutes || auto.intervalMinutes;
            trayNotify(
              next ? '定时切换已开启' : '定时切换已暂停',
              next && every ? `每 ${every} 分钟换一张` : ''
            );
          } catch (err) {
            console.error('[tray] 切换定时失败：', err?.message || err);
            trayNotify('定时切换没生效', err?.message || '本地服务没响应');
          }
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          forceQuit = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };

  trayMenuRefresher = refreshMenu;
  tray.on('click', showMainWindow);
  refreshMenu();
  // 句柄要留着才能在退出时 clear：以前这个 interval 会活到进程结束
  if (trayTimer) clearInterval(trayTimer);
  trayTimer = setInterval(refreshMenu, 30000); // 让菜单里的「当前壁纸」保持最新
  console.info('[tray] 托盘已就绪（左键打开窗口 / 右键菜单）');
}

/**
 * 框选底图该抓哪块屏：以前固定抓主屏，多屏且窗口在副屏时，框选底图是另一块
 * 屏幕的画面，用户按「眼前看到的」去框，裁出来的区域完全错位。
 * 优先跟着主窗口走（框选遮罩就盖在窗口上），没有窗口再退化为光标所在屏。
 */
function shotDisplay() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const d = screen.getDisplayMatching(mainWindow.getBounds());
      if (d) return d;
    }
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    return screen.getPrimaryDisplay();
  }
}

/**
 * 抓「当前这块屏」的全分辨率画面，交给渲染进程做「区域框选」（Eagle 的截图是框选，不是整屏）。
 * 返回 dataURL + 实际像素尺寸 + 屏幕逻辑尺寸，前端按比例换算选区后自己裁剪上传。
 */
async function grabScreenImage() {
  const display = shotDisplay();
  const scale = display.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('没有可用的屏幕源');
  const img = src.thumbnail;
  const size = img.getSize();
  return {
    dataUrl: img.toDataURL(),
    width: size.width,
    height: size.height,
    scale,
    displayScale: scale,
    // 屏幕的逻辑尺寸，前端用它把「窗口内坐标」换算回这块屏的比例
    screenWidth: display.bounds.width,
    screenHeight: display.bounds.height,
    displayId: display.id,
  };
}

/**
 * 框选会话状态：抓底图前记下窗口原样（可见 / 最大化 / 最小化 / 全屏），框选结束再还原。
 * 同时修掉两个老毛病：先 show 再截会让底图里带着应用自己；遮罩只有小窗口那么大时，
 * 整屏底图被压进一个小方块里，框出来的位置和屏幕上看到的对不上。
 */
let shotWindowRestore = null;

/** 等窗口进入/退出全屏（事件可能不派发，用超时兜底） */
function waitWindowState(win, event, action, timeout = 600) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      win.removeListener(event, done);
      resolve();
    };
    win.once(event, done);
    action();
    setTimeout(done, timeout);
  });
}

/** 唤起主窗口并让它进入截图框选态（快捷键 / 托盘 / 界面按钮共用） */
function requestRegionShot() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 窗口被关到托盘后又销毁过：先重建，加载完再进框选
    if (!serverPort) return { ok: false, pending: false, error: '本地服务未就绪' };
    void createWindow()
      .then(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shot-request');
      })
      .catch((err) => console.error('[shot] 重建窗口后进入框选失败：', err?.message || err));
    return { ok: true, pending: true };
  }
  // 这里刻意不 showMainWindow()：窗口一露脸，抓到的底图里就有应用自己
  mainWindow.webContents.send('shot-request');
  return { ok: true, pending: true };
}

/**
 * 框选底图：先把自己藏起来再抓屏（否则底图里带着应用自身），抓完让窗口全屏再显示。
 * 必须是全屏而不是最大化——最大化留着标题栏和任务栏，视口比例和底图不一致，
 * 前端按视口换算出来的裁剪区域会和实际屏幕错位。
 */
async function grabScreenForShot() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const wasVisible = !!win && win.isVisible();
  shotWindowRestore = win
    ? {
        wasVisible,
        wasMaximized: win.isMaximized(),
        wasMinimized: win.isMinimized(),
        wasFullScreen: win.isFullScreen(),
      }
    : null;
  if (win && wasVisible) {
    win.hide();
    // 让合成器真的把窗口从屏幕上撤掉，否则底图里仍有半透明残影
    await new Promise((r) => setTimeout(r, 180));
  }
  try {
    const shot = await grabScreenImage();
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isFullScreen()) {
        await waitWindowState(win, 'enter-full-screen', () => win.setFullScreen(true));
      }
      win.show();
      win.focus();
    }
    return shot;
  } catch (err) {
    if (win) win.show();
    throw err;
  }
}

/** 框选结束（截完 / 取消 / 失败）：把窗口还原成进框选前的样子 */
async function endRegionShot() {
  const st = shotWindowRestore;
  shotWindowRestore = null;
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win || !st) return false;
  if (!st.wasFullScreen && win.isFullScreen()) {
    await waitWindowState(win, 'leave-full-screen', () => win.setFullScreen(false));
  }
  if (!st.wasMaximized && win.isMaximized()) win.unmaximize();
  if (st.wasMinimized) win.minimize();
  else if (!st.wasVisible) win.hide();
  return true;
}

/** 已成功注册的全局快捷键（键名 → 加速键），界面上会显示实际生效的那一组 */
const registeredHotkeys = {};
/** 候选键全被占用、实际没注册上的（键名 → 试过的候选键串），设置页要显示原因 */
const failedHotkeys = {};

/**
 * 全局快捷键：别的窗口聚焦时也能换壁纸。
 * 默认键可能被其它软件占用，这里按候选顺序回退，并把实际生效的键回传给界面。
 */
function registerGlobalShortcuts() {
  if (getSettings().globalShortcuts === false) {
    console.info('[shortcut] 已按设置关闭全局快捷键');
    return;
  }
  for (const k of Object.keys(failedHotkeys)) delete failedHotkeys[k];
  const handlers = {
    next: () => wallpaperAction('now'),
    favorite: () => wallpaperAction('favorite'),
    window: showMainWindow,
    screenshot: () => requestRegionShot(),
    live: async () => {
      try {
        const cfg = await getLiveCfg();
        const enabled = !(cfg.enabled === true);
        // 只保存配置，真正的创建/销毁由 liveBus 广播触发
        await fetchJson(
          `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) },
          5000
        ).catch(() => {});
      } catch (err) {
        console.error('[shortcut] 动态壁纸切换失败：', err?.message || err);
      }
    },
  };
  const candidates = {
    next: ['CommandOrControl+Alt+W', 'CommandOrControl+Alt+Shift+W', 'CommandOrControl+Shift+F10'],
    favorite: ['CommandOrControl+Alt+F', 'CommandOrControl+Alt+Shift+F', 'CommandOrControl+Shift+F11'],
    window: ['CommandOrControl+Alt+G', 'CommandOrControl+Alt+Shift+G', 'CommandOrControl+Shift+F12'],
    screenshot: ['CommandOrControl+Shift+S', 'CommandOrControl+Alt+S', 'CommandOrControl+Shift+F8'],
    live: ['CommandOrControl+Alt+V', 'CommandOrControl+Alt+Shift+V', 'CommandOrControl+Shift+F9'],
  };
  for (const [action, list] of Object.entries(candidates)) {
    for (const acc of list) {
      try {
        if (globalShortcut.register(acc, handlers[action])) {
          registeredHotkeys[action] = acc;
          break;
        }
      } catch (err) {
        console.warn('[shortcut] 注册异常：', acc, err?.message || err);
      }
    }
    if (!registeredHotkeys[action]) {
      // 以前只写一行 console：用户在设置里看到「已启用」，按下去毫无反应
      failedHotkeys[action] = list.join(' / ');
    }
  }
  const failedActions = Object.keys(failedHotkeys);
  if (failedActions.length) {
    const names = { next: '换壁纸', favorite: '收藏', window: '打开窗口', screenshot: '截图', live: '动态壁纸' };
    const detail = failedActions
      .map((a) => `${names[a] || a}（${failedHotkeys[a]}）`)
      .join('、');
    console.warn('[shortcut] 以下快捷键候选键全部被占用：', detail);
    showToastBanner('部分快捷键没能注册', `${detail} 已被其他程序占用，可在设置里看到具体冲突键。`);
  }
  console.info('[shortcut] 已注册：', JSON.stringify(registeredHotkeys));
}

/**
 * 重新注册全部全局快捷键。
 * 以前只在启动时注册一次：用户在设置里关掉「全局快捷键」后照样被拦按键，
 * 打开后又要重启应用才生效。现在设置变更时直接走这里，注销 → 清空 → 重注册。
 */
function refreshGlobalShortcuts() {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    console.warn('[shortcut] 注销旧快捷键失败：', err?.message || err);
  }
  for (const k of Object.keys(registeredHotkeys)) delete registeredHotkeys[k];
  for (const k of Object.keys(failedHotkeys)) delete failedHotkeys[k];
  registerGlobalShortcuts();
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 让设置页显示的「实际生效键位 / 冲突键位」立刻跟上
    mainWindow.webContents.send('hotkeys-changed', {
      hotkeys: registeredHotkeys,
      failed: failedHotkeys,
    });
  }
}

/* ----------------------------- 动态壁纸窗口 ----------------------------- */
// 把一扇无边框、不接收鼠标、不进任务栏的窗口挂到桌面图标层（WorkerW）后面，
// 做成真正的动态桌面。由设置页/托盘/快捷键控制开关。

let liveWindow = null;
let livePerfTimer = null;
/** 副屏位移补偿：挂到桌面层后窗口原点可能被系统当作 (0,0)，这里记录真实位置用于暂停判断 */
let liveBounds = { x: 0, y: 0, width: 0, height: 0 };

/** 覆盖整个虚拟屏幕（多屏拼接）的矩形 */
function virtualScreenBounds() {
  const displays = screen.getAllDisplays();
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* ============ 动态壁纸增量更新 / 实时参数 / 屏幕保护 ============ */
let liveMounted = false;
let liveSignature = '';
let saverWindow = null;
let saverTimer = null;

const LIVE_MODES = new Set(['slideshow', 'video', 'web', 'shader', 'interactive', 'audio']);
const LIVE_PARAM_KEYS = ['brightness', 'speed', 'intensity', 'depth'];

/** 只把数字参数推给已挂载的渲染页：拖滑块不重载页面、不重新挂载窗口 */
function pushLiveParams(params) {
  const safe = {};
  for (const k of LIVE_PARAM_KEYS) {
    const v = Number(params?.[k]);
    if (Number.isFinite(v)) safe[k] = Math.max(0, Math.min(300, Math.round(v)));
  }
  if (!Object.keys(safe).length) return;
  const js = `window.__live && window.__live.setParams && window.__live.setParams(${JSON.stringify(safe)})`;
  for (const w of [liveWindow, saverWindow]) {
    if (w && !w.isDestroyed()) w.webContents.executeJavaScript(js).catch(() => {});
  }
}

/**
 * 默认点击穿透；两种显式开启交互的情况才接收鼠标：
 * ① 交互式粒子壁纸（interactive=true）② 网页壁纸且用户关掉了 clickThrough。
 * Esc 一律把窗口恢复成穿透（见 createLiveWindow 的 before-input-event）。
 */
function applyLiveInteractive(cfg) {
  if (!liveWindow || liveWindow.isDestroyed()) return;
  const particle = cfg?.mode === 'interactive' && cfg?.interactive === true;
  const web = cfg?.mode === 'web' && cfg?.clickThrough === false;
  try {
    liveWindow.setIgnoreMouseEvents(!(particle || web));
  } catch {}
}

/** 内容签名：只有内容变了才让页面重建渲染器；单独改 params 不重建 */
function liveSignatureOf(cfg, useWeb) {
  return JSON.stringify({
    mode: cfg?.mode,
    webUrl: useWeb ? cfg?.webUrl : '',
    scope: cfg?.scope,
    playlistId: cfg?.playlistId,
    intervalSec: cfg?.intervalSec,
    videoPath: cfg?.videoPath,
    shaderPreset: cfg?.shaderPreset,
    shaderSource: cfg?.shaderSource,
    audioPath: cfg?.audioPath,
    audioSource: cfg?.audioSource,
  });
}

function screensaverConfig() {
  const c = getSettings()?.screensaver || {};
  return {
    enabled: c.enabled === true,
    idleMinutes: Math.max(1, Math.min(180, Number(c.idleMinutes) || 10)),
    mode: ['slideshow', 'shader', 'interactive', 'audio'].includes(c.mode) ? c.mode : 'slideshow',
    showClock: c.showClock !== false,
  };
}

async function showScreensaver() {
  if (saverWindow && !saverWindow.isDestroyed()) return;
  const c = screensaverConfig();
  const b = virtualScreenBounds();
  saverWindow = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: false, backgroundColor: '#000000',
    show: false, skipTaskbar: true, fullscreen: true,
    focusable: true, resizable: false, movable: false, hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  saverWindow.setAlwaysOnTop(true, 'screen-saver');
  saverWindow.setIgnoreMouseEvents(false); // 要能接收输入，让系统空闲计时归零
  const url = `http://127.0.0.1:${serverPort}/live?screensaver=1&mode=${encodeURIComponent(c.mode)}&token=${encodeURIComponent(apiToken)}`;
  try {
    await saverWindow.loadURL(url);
    saverWindow.show();
    saverWindow.focus();
    console.info('[screensaver] 已进入屏保');
  } catch (err) {
    console.warn('[screensaver] 加载屏保页失败：', err?.message || err);
    hideScreensaver();
  }
}

function hideScreensaver() {
  if (saverWindow && !saverWindow.isDestroyed()) {
    try {
      saverWindow.destroy();
    } catch {}
  }
  saverWindow = null;
}

/** 1 秒一次系统空闲检测：触发后全屏覆盖，用户一动键鼠立即退出 */
function startScreensaverWatch() {
  if (saverTimer) return;
  saverTimer = setInterval(async () => {
    const c = screensaverConfig();
    // 屏保用的是 Electron 全屏窗口，不需要 Win32 桌面层，三平台都可用
    if (!c.enabled || !serverPort) {
      if (saverWindow) hideScreensaver();
      return;
    }
    let idle;
    try {
      idle = powerMonitor.getSystemIdleTime();
    } catch {
      return;
    }
    if (saverWindow && !saverWindow.isDestroyed()) {
      if (idle < 2) hideScreensaver();
      return;
    }
    if (idle < c.idleMinutes * 60) return;
    // 全屏应用/游戏时不打扰，和动态壁纸的性能规则保持一致
    try {
      if (desktopApi && (await desktopApi.isFullscreenAppRunning())) return;
    } catch {
      /* 检测失败不阻塞屏保 */
    }
    await showScreensaver();
  }, 1000);
  saverTimer.unref?.();
}

function stopScreensaverWatch() {
  if (saverTimer) {
    clearInterval(saverTimer);
    saverTimer = null;
  }
  hideScreensaver();
}

function createLiveWindow() {
  if (liveWindow && !liveWindow.isDestroyed()) return liveWindow;
  const b = virtualScreenBounds();
  liveBounds = b;
  liveWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: false,
    show: false,
    skipTaskbar: true,
    // 交互壁纸要能收键盘（Esc 退出）：focusable=false 时 mounted 窗口拿不到按键。
    // 默认仍 setIgnoreMouseEvents(true)，不会拦截桌面点击。
    focusable: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    enableLargerThanScreen: true,
    webPreferences: {
      // 安全：这里绝不能挂 preload.cjs —— web 模式下本窗口加载的是用户配置的
      // 任意远程网址，挂了桥接等于把完整 desktopAPI（打开文件夹/下载/截图/
      // 微博登录…）暴露给不可信页面。壁纸渲染页(/live)是自绘 HTML，也不需要桥。
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  liveWindow.setBounds(b);
  liveWindow.setSkipTaskbar(true);
  liveWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 点击穿透：壁纸不拦截桌面操作
  liveWindow.setIgnoreMouseEvents(true);
  // Esc 是交互壁纸的统一逃生键：立即恢复点击穿透，并把配置落库，
  // 这样重启后不会被一个「关不掉的交互桌面」困住。
  liveWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    if (!liveWindow || liveWindow.isDestroyed()) return;
    try {
      liveWindow.setIgnoreMouseEvents(true);
    } catch {}
    const s = getSettings()?.liveWallpaper || {};
    const patch = {};
    if (s.interactive === true) patch.interactive = false;
    if (s.clickThrough === false) patch.clickThrough = true;
    if (!Object.keys(patch).length || !serverPort) return;
    fetchJson(
      `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
      5000
    ).catch(() => {});
  });
  // 主窗口关闭时这个窗口不能阻止退出；单独 destroy 即可
  liveWindow.on('closed', () => {
    liveWindow = null;
  });
  return liveWindow;
}

/** 把 Electron 窗口句柄还原成正确的 64 位整数（十进制字符串）。
 *  getNativeWindowHandle() 返回的是原生字节序（小端）Buffer，
 *  若 .toString('hex') 后直接用 [long]::Parse(hex) 解析会被当成大端，得到错误句柄。
 *  这里直接按小端读出数值并以十进制传给 C#，彻底规避字节序问题。 */
function nativeHandleDecimal(win) {
  const buf = win.getNativeWindowHandle();
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length >= 8) return b.readBigUInt64LE(0).toString();
  if (b.length === 4) return b.readUInt32LE(0).toString();
  return '0';
}

function destroyLiveWindow() {
  stopLivePerfRules();
  if (liveWindow && !liveWindow.isDestroyed()) {
    const h = nativeHandleDecimal(liveWindow);
    desktopApi?.detachLiveWindow(h).catch(() => {});
    try {
      liveWindow.destroy();
    } catch {}
  }
  liveWindow = null;
  liveMounted = false;
  liveSignature = '';
}

/** 把动态壁纸窗口挂到桌面层并铺满虚拟屏幕 */
async function mountLiveWindow() {
  if (!liveWindow || liveWindow.isDestroyed()) return false;
  const b = liveBounds;
  const h = nativeHandleDecimal(liveWindow);
  const ok = await desktopApi?.attachLiveWindow(h, b.width, b.height).catch((err) => {
    console.warn('[live] 挂载调用失败：', err?.message || err);
    return false;
  });
  if (ok) {
    // 注意：挂载（SetParent + WS_CHILD）之后不要再调用 setBounds/showInactive，
    // 否则 Chromium 会重新认领父窗口、把刚挂到 WorkerW 的窗口还原回顶层，导致重新变成顶层窗口。
    // Attach 内部的 SetWindowPos(SWP_SHOWWINDOW) 已经负责显示与铺满。
    startLivePerfRules();
  } else {
    console.warn('[live] 挂载到桌面层失败（系统可能不支持，窗口已隐藏）');
    try {
      liveWindow.hide();
    } catch {}
  }
  return !!ok;
}

/** 锁屏/休眠监听句柄：以前 stop 时不摘，开关十几次就触发 MaxListenersExceeded */
let livePowerHandlers = null;

let livePowerLocked = false;
let liveRemountMisses = 0;
let liveLastRemount = 0;
let liveLastPauseReasons = '';

/**
 * 性能规则 + 持续挂载守护（同一个 3 秒轮询，避免再起一个定时器）。
 * 暂停信号一次采样拿齐：GPU 占用 / 前台进程名 / 全屏应用 / 电池 / 锁屏。
 * 守护：资源管理器重建桌面层或 Chromium 重新认领父窗口时，连续两次检测到
 * 父句柄 != WorkerW 才重挂，且两次重挂至少隔 15 秒，避免桌面层抖动期反复闪屏。
 */
function startLivePerfRules() {
  stopLivePerfRules();
  const pause = (on) =>
    liveWindow?.webContents
      ?.executeJavaScript(`window.__live && window.__live.pause(${on})`)
      .catch(() => {});
  livePerfTimer = setInterval(async () => {
    if (!liveWindow || liveWindow.isDestroyed()) return;
    const cfg = await getLiveCfg();
    let snap = { gpu: -1, foreground: '', parent: 0, workerw: 0, fullscreen: false };
    if (desktopApi?.livePerfSnapshot) {
      try {
        snap = await desktopApi.livePerfSnapshot(
          nativeHandleDecimal(liveWindow),
          liveBounds.width,
          liveBounds.height
        );
      } catch (err) {
        console.warn('[live] 性能采样失败：', err?.message || err);
      }
    }
    const decision = shouldPauseLive(cfg, {
      onBattery: powerMonitor ? !powerMonitor.isOnAC : false,
      fullscreen: !!snap.fullscreen,
      gpu: Number(snap.gpu),
      locked: livePowerLocked,
      foreground: snap.foreground,
    });
    const reasons = decision.reasons.join(',');
    if (reasons !== liveLastPauseReasons) {
      console.info(`[live] 暂停=${decision.paused} 原因=${reasons || '无'}`);
      liveLastPauseReasons = reasons;
    }
    pause(decision.paused);

    if (liveMounted && liveMountBroken(snap)) {
      liveRemountMisses += 1;
      if (liveRemountMisses >= 2 && Date.now() - liveLastRemount > 15000) {
        liveRemountMisses = 0;
        liveLastRemount = Date.now();
        console.info('[live] 父窗口被重新认领，自动重挂到桌面层');
        const ok = await desktopApi?.attachLiveWindow(
          nativeHandleDecimal(liveWindow),
          liveBounds.width,
          liveBounds.height
        ).catch(() => false);
        if (!ok) console.warn('[live] 自动重挂失败，下个守护周期再试');
      }
    } else {
      liveRemountMisses = 0;
    }
  }, 3000);
  // 锁屏/休眠期间持续暂停；解锁/唤醒事件明确清除，不再让 3 秒轮询把它「恢复」回来
  livePowerHandlers = {
    lock: () => { livePowerLocked = true; pause(true); },
    unlock: () => { livePowerLocked = false; },
    suspend: () => { livePowerLocked = true; pause(true); },
    resume: () => { livePowerLocked = false; },
  };
  powerMonitor?.on('lock-screen', livePowerHandlers.lock);
  powerMonitor?.on('unlock-screen', livePowerHandlers.unlock);
  powerMonitor?.on('suspend', livePowerHandlers.suspend);
  powerMonitor?.on('resume', livePowerHandlers.resume);
}

function stopLivePerfRules() {
  if (livePerfTimer) {
    clearInterval(livePerfTimer);
    livePerfTimer = null;
  }
  if (livePowerHandlers) {
    powerMonitor?.removeListener('lock-screen', livePowerHandlers.lock);
    powerMonitor?.removeListener('unlock-screen', livePowerHandlers.unlock);
    powerMonitor?.removeListener('suspend', livePowerHandlers.suspend);
    powerMonitor?.removeListener('resume', livePowerHandlers.resume);
    livePowerHandlers = null;
  }
  livePowerLocked = false;
  liveRemountMisses = 0;
  liveLastPauseReasons = '';
}

/** 读最新动态壁纸配置（直接走本地接口，保证拿到刚保存的值） */
async function getLiveCfg() {
  if (!serverPort) return {};
  try {
    return (await fetchJson(`http://127.0.0.1:${serverPort}/api/wallpaper/live`, {}, 5000)) || {};
  } catch {
    return {};
  }
}

/** 系统音频回环源：用 desktopCapturer 取主屏幕的 sourceId，渲染页据此 getUserMedia 捕获桌面音频。
 * 结果缓存 30s，避免每次切配置都重新枚举屏幕（会闪一下采集提示）。 */
let cachedSysAudioId = '';
let cachedSysAudioAt = 0;
async function getDesktopAudioSourceId() {
  const now = Date.now();
  if (cachedSysAudioId && now - cachedSysAudioAt < 30000) return cachedSysAudioId;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowAudio: false });
    const id = sources[0]?.id || '';
    cachedSysAudioId = id;
    cachedSysAudioAt = now;
    return id;
  } catch (err) {
    console.warn('[live] 枚举系统音频源失败：', err?.message || err);
    return cachedSysAudioId;
  }
}

/** 根据配置创建 / 销毁动态壁纸窗口，并加载对应内容 */
async function applyLiveWallpaper() {
  const cfg = await getLiveCfg();
  if (!cfg || cfg.enabled === false) {
    destroyLiveWindow();
    return;
  }
  // 跨平台基础版：WorkerW 桌面层是 Windows 专有。Mac/Linux 不创建常驻窗口，
  // 明确回滚开关（不让设置显示「已开启」而桌面没动静）；静态壁纸 / 屏保仍可用。
  if (process.platform !== 'win32') {
    console.info('[live] 当前平台没有桌面层挂载能力，动态壁纸降级为静态壁纸');
    await rollbackLiveWallpaper('macOS / Linux 暂不支持桌面层挂载，请用「设为壁纸 / 定时自动切换」');
    return;
  }
  if (!liveWindow || liveWindow.isDestroyed()) {
    createLiveWindow();
  }
  // web 模式直接加载网址；其它模式用内置渲染页（/live 会按配置渲染）。
  // /live 页的 fetch 走 ?token= 传递鉴权（见 server/live-page.js）
  let useWeb = cfg.mode === 'web' && !!cfg.webUrl;
  const urlOpts = {
    allowLocalUrl: cfg.allowLocalUrl === true,
    trustedDir: String(cfg.trustedDir || ''),
  };
  if (useWeb && !isSafeLiveUrl(cfg.webUrl, urlOpts)) {
    console.warn('[live] 网页地址不在允许范围内：', cfg.webUrl);
    showToastBanner(
      '动态壁纸网址被拒绝',
      urlOpts.allowLocalUrl
        ? '只允许公网 http(s)、本机/内网 http(s)，以及可信目录内的 file:// 页面'
        : '默认只允许公网 http(s)；本地/内网页面需先在设置里打开开关'
    );
    useWeb = false;
  }
  let url;
  if (useWeb) {
    url = cfg.webUrl;
  } else {
    url = `http://127.0.0.1:${serverPort}/live?token=${encodeURIComponent(apiToken)}`;
    // 系统音频回环：把桌面源 id 注入渲染页，渲染页用 getUserMedia(chromeMediaSource=desktop) 捕获桌面声音
    if (cfg.audioSource === 'system') {
      const sysAudioId = await getDesktopAudioSourceId();
      if (sysAudioId) url += `&sysAudioId=${encodeURIComponent(sysAudioId)}`;
    }
  }
  const signature = liveSignatureOf(cfg, useWeb);
  const samePage =
    liveMounted &&
    !!liveWindow &&
    !liveWindow.isDestroyed() &&
    liveWindow.webContents.getURL() === url;
  if (samePage) {
    // 已挂到桌面层：只推参数 / 切交互穿透 / 必要时让页面自己重建渲染器。
    // 绝不重新 loadURL + 等 1200ms + 重新 SetParent：拖一次滑块就重挂一次会闪屏甚至丢壁纸。
    pushLiveParams(cfg.params || {});
    applyLiveInteractive(cfg);
    if (signature !== liveSignature) {
      liveWindow.webContents
        .executeJavaScript('window.__live && window.__live.apply && window.__live.apply()')
        .catch(() => {});
      liveSignature = signature;
    }
    return;
  }
  try {
    if (liveWindow.webContents.getURL() !== url) await liveWindow.loadURL(url);
    // 页面加载后再挂载，避免挂载时还没渲染
    await new Promise((r) => setTimeout(r, 1200));
    const mounted = await mountLiveWindow();
    liveMounted = !!mounted;
    if (!mounted) {
      // 挂载失败时以前只 hide 窗口：设置里还显示「已开启」、托盘也这么说，用户以为桌面在动
      await rollbackLiveWallpaper('系统没有允许把窗口挂到桌面层（可能不支持当前桌面环境）');
      return;
    }
    liveSignature = signature;
    applyLiveInteractive(cfg);
    pushLiveParams(cfg.params || {});
    // 让页面立即按最新配置渲染（覆盖模式切换：slideshow ↔ video 无需整窗重载）
    liveWindow.webContents
      .executeJavaScript(`window.__live && window.__live.apply && window.__live.apply()`)
      .catch(() => {});
  } catch (err) {
    console.error('[live] 启动失败：', err?.message || err);
    await rollbackLiveWallpaper(`动态壁纸没能启动：${err?.message || err}`);
  }
}

/** 启动失败就把 enabled 回滚成 false：不能让开关与实际行为长期不一致 */
async function rollbackLiveWallpaper(reason) {
  try {
    if (serverPort) {
      await fetchJson(
        `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) },
        5000
      );
    }
  } catch (err) {
    console.warn('[live] 回滚开关失败：', err?.message || err);
  }
  destroyLiveWindow();
  showToastBanner('动态壁纸没能开启', reason);
}

// 设置变更 / 托盘 / 快捷键 通过 IPC 触发（只负责保存，真正动作由 liveBus 广播）
/**
 * 微博登录小窗：打开 m.weibo.cn 登录页让用户登录，登录成功后自动把整段 Cookie 返回
 * 给渲染进程，省去用户手动 F12 复制的麻烦。
 *
 * 关键点（踩过坑）：SUB Cookie 在登录跳转过程中会提前出现，拿到后又被微博作废，
 * 必须等 Cookie 快照连续两次稳定、且用真实接口验证通过（ok=1）才算抓取成功；
 * 同时把登录会话的 User-Agent 一起返回——微博风控会把登录态与 UA 绑定，
 * 采集请求必须用同一个 UA（crawler.searchWeibo 通过 settings.weiboUserAgent 复用）。
 */
async function weiboLoginFlow() {
  if (weiboWin && !weiboWin.isDestroyed()) {
    weiboWin.show();
    weiboWin.focus();
    return { ok: false, msg: '登录窗口已打开，请完成登录' };
  }
  // 登录窗同样按屏幕给：小屏（1366×768）上 740 高会顶出屏幕，底部的「登录」按钮点不到
  const loginArea = screen.getPrimaryDisplay().workAreaSize;
  weiboWin = new BrowserWindow({
    width: Math.min(1020, Math.round(loginArea.width * 0.8)),
    height: Math.min(740, Math.round(loginArea.height * 0.88)),
    center: true,
    title: '登录微博（登录成功后自动获取 Cookie）',
    parent: mainWindow,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'weibo-login' },
  });
  const ses = weiboWin.webContents.session;
  // 第三方页面：权限、弹窗、跳转都要单独上锁（它用的是自己的 partition，
  // 默认 session 的守卫一点也不管它；以前这里摄像头/麦克风是全放行的）
  installPermissionGuard(ses);
  weiboWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  weiboWin.webContents.on('will-navigate', (e, target) => {
    if (isWeiboOrigin(target)) return;
    e.preventDefault();
    console.warn('[weibo] 已阻止登录窗跳转：', target);
  });
  // HTTP 头只允许 latin1：app.setName('图库') 会把中文应用名带进 Electron 默认 UA，
  // 直接用作 fetch 请求头会报 ByteString 错误（之前窗口不自动关闭的元凶），
  // 非 ASCII 字符统一百分号编码后再使用
  const ua = ses.getUserAgent().replace(/[^\x00-\xff]/g, (ch) => encodeURIComponent(ch));
  // 清掉上次残留的过期登录态，确保拿到的是本次登录的 Cookie
  await ses.clearStorageData({ storages: ['cookies'] }).catch(() => {});
  await weiboWin.loadURL('https://passport.weibo.cn/signin/login');

  let settled = false;
  return await new Promise((resolve) => {
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(r);
      if (weiboWin && !weiboWin.isDestroyed()) weiboWin.close();
    };
    let verifying = false;
    let lastVerifyAt = 0;
    // 用登录会话同款 UA 请求真实接口，ok=1 才算登录态有效
    const verifyCookie = async (str) => {
      try {
        const cid = '100103type%3D1%26q%3D' + encodeURIComponent('壁纸');
        const res = await fetch(`https://m.weibo.cn/api/container/getIndex?containerid=${cid}&page_type=searchall&page=1`, {
          headers: {
            'User-Agent': ua,
            Referer: `https://m.weibo.cn/search?containerid=${cid}`,
            'X-Requested-With': 'XMLHttpRequest',
            'MWeibo-Pwa': '1',
            Accept: 'application/json, text/plain, */*',
            Cookie: str,
          },
        });
        const json = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
        return json?.ok === 1;
      } catch {
        return false; // 网络抖动时不判定失败，继续轮询
      }
    };
    const grab = async () => {
      if (verifying) return;
      try {
        const cookies = await ses.cookies.get({});
        // 已登录标志：SUB 出现；只取 weibo.cn 系域的 Cookie
        // 注意：MLOGIN 在已登录会话里可能仍是 0，不能作为登录判据，最终以接口验证为准
        if (!cookies.some((c) => c.name === 'SUB')) return;
        const seen = new Set();
        const str = cookies
          .filter((c) => /weibo\.cn$/i.test(c.domain))
          .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
          // Electron 返回的 Cookie 值是解码后的原文，部分 Cookie（浏览页面后种下）含中文等
          // 非 ASCII 字符，直接放进请求头会报 ByteString 错误；HTTP 头要求 latin1，重新编码
          // 名称含非 ASCII 的属于畸形 Cookie（多为追踪器写入），无法安全放进请求头，直接跳过
          .map((c) => {
            if (!/^[\x00-\xff]*$/.test(c.name)) return '';
            return `${c.name}=${/^[\x00-\xff]*$/.test(c.value) ? c.value : encodeURIComponent(c.value)}`;
          })
          .filter(Boolean)
          .join('; ');
        if (!str) return;
        // 不做快照稳定性判断：m.weibo.cn 会周期性轮换 XSRF-TOKEN，Cookie 串一直在变，
        // 等它稳定会永远等不到。直接以接口验证为准（验证通过的那份串就是要保存的串）。
        if (Date.now() - lastVerifyAt < 3000) return; // 节流，避免高频打微博接口
        lastVerifyAt = Date.now();
        verifying = true;
        const ok = await verifyCookie(str);
        verifying = false;
        if (ok) finish({ ok: true, cookie: str, ua });
      } catch {}
    };
    const timer = setInterval(grab, 1500);
    // SPA 登录可能不触发 did-navigate，轮询兜底；两个导航钩子只是加快取到
    weiboWin.webContents.on('did-navigate', grab);
    weiboWin.webContents.on('did-frame-finish-load', grab);
    weiboWin.on('closed', () => {
      weiboWin = null;
      finish({ ok: false, msg: '已取消登录' });
    });
  });
}

// 设置变更 / 托盘 / 快捷键 通过 IPC 触发（只负责保存，真正动作由 liveBus 广播）
handleIpc('get-api-token', () => apiToken);
// 开机自启：写系统登录项（用户可在设置页开关；随设置持久化到 settings）
handleIpc('get-auto-launch', () => app.getLoginItemSettings().openAtLogin);
handleIpc('set-auto-launch', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});
// 检查更新：读 GitHub latest release 与本机版本比较，有新版就给出下载链接（不自动静默更新，
// 个人分发没有更新服务器；用户自己决定何时升级）
handleIpc('check-for-updates', async () => {
  try {
    const cfg = await fetchJson(
      `http://127.0.0.1:${serverPort}/api/settings`,
      { method: 'GET' },
      8000
    );
    const repo = String(cfg?.updateRepo || process.env.TUKU_UPDATE_REPO || '').trim();
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { ok: false, msg: '未配置更新源（设置 updateRepo，如 user/repo）' };
    }
    const rel = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, { method: 'GET' }, 15000);
    const latest = String(rel?.tag_name || '').replace(/^v/i, '');
    const current = app.getVersion();
    return {
      ok: true,
      hasUpdate: isNewer(latest, current),
      latest,
      current,
      url: rel?.html_url || `https://github.com/${repo}/releases/latest`,
    };
  } catch (err) {
    return { ok: false, msg: String(err?.message || err).slice(0, 160) };
  }
});
/* --------------------------- 应用内自动更新 --------------------------- */

/** 设置里的更新源（owner/repo）；没配就交给打包时写入的 app-update.yml */
async function updateRepoSetting() {
  try {
    const cfg = await fetchJson(`http://127.0.0.1:${serverPort}/api/settings`, { method: 'GET' }, 8000);
    const repo = String(cfg?.updateRepo || process.env.TUKU_UPDATE_REPO || '').trim();
    return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
  } catch {
    return '';
  }
}

handleIpc('update-check', async () => {
  const st = updateState();
  if (!st.supported) {
    // 开发态没有安装包可替换：明确告诉界面「去发布页下载」，别让按钮静默无反应
    return { ok: false, supported: false, msg: '开发模式不支持应用内更新，请用「检查更新」跳转发布页' };
  }
  // 用户主动点「检查更新」= 明确想再试一次：清掉连续失败计数，
  // 重新允许走强制流程（再失败仍会在第 2 次自动降级）
  resetUpdateFailures();
  return checkForUpdates({ repo: await updateRepoSetting() });
});
handleIpc('update-download', () => downloadUpdate());
handleIpc('update-install', () => installUpdate());
handleIpc('update-dismiss', () => dismissUpdate());
handleIpc('update-state', () => updateState());
/** 设置页「清零安装失败计数」：用户修好环境后主动恢复强制更新策略 */
handleIpc('update-reset-failures', () => {
  resetUpdateFailures();
  return { ok: true };
});

/** 强制更新遮罩里的「退出应用」：装不上时至少让用户能关掉，而不是卡死在遮罩里 */
handleIpc('app:quit', () => {
  forceQuit = true;
  setImmediate(() => app.quit());
  return { ok: true };
});

/**
 * 视频片段导出（首尾裁剪 → GIF / WebM）：渲染进程在浏览器里完成编码，
 * 主进程只负责弹「另存为」并写盘。data URL 必须严格匹配白名单 MIME，
 * 文件名只允许单层文件名，避免渲染层被注入后变成「往任意路径写任意文件」。
 */
handleIpc('save-export', async (_e, payload) => {
  const parsed = parseExportPayload(payload?.dataUrl, payload?.filename);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { buffer, ext, isGif, filename } = parsed;
  try {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存视频片段',
      defaultPath: path.join(app.getPath('downloads'), filename),
      filters: [{ name: isGif ? 'GIF 动图' : 'WebM 视频', extensions: [ext] }],
    });
    if (canceled || !filePath) return { ok: false, error: '已取消保存' };
    await fsp.writeFile(filePath, buffer);
    console.info('[export] 视频片段已保存', filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/** 动态壁纸配置里允许经 IPC 下发的字段（白名单）：渲染层被注入也改不了别的键，更写不进 file:// 地址 */
const LIVE_PATCH_FIELDS = [
  'enabled', 'mode', 'webUrl', 'intervalSec', 'videoPath', 'mute', 'volume',
  'kenBurns', 'scope', 'playlistId', 'minScore', 'pauseOnBattery', 'pauseOnFullscreen',
  'params', 'shaderPreset', 'shaderSource', 'interactive', 'audioPath', 'audioSource',
  'pauseOnGpu', 'gpuThreshold', 'pauseApps', 'allowLocalUrl', 'trustedDir', 'clickThrough',
];

/** 收敛渲染层传来的配置：白名单 + 类型/长度/数值夹取，避免把任意对象写进设置 */
function safeLivePatch(patch) {
  const safe = {};
  for (const k of LIVE_PATCH_FIELDS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) safe[k] = patch[k];
  }
  if (safe.mode !== undefined && !LIVE_MODES.has(String(safe.mode))) return { error: '未知的壁纸类型' };
  for (const k of ['webUrl', 'videoPath', 'audioPath']) {
    if (safe[k] !== undefined) safe[k] = String(safe[k]).slice(0, 1000);
  }
  if (safe.shaderSource !== undefined) safe.shaderSource = String(safe.shaderSource).slice(0, 12000);
  if (safe.shaderPreset !== undefined) safe.shaderPreset = String(safe.shaderPreset).slice(0, 60);
  if (safe.params !== undefined) {
    const p = safe.params && typeof safe.params === 'object' ? safe.params : {};
    const clean = {};
    for (const k of LIVE_PARAM_KEYS) {
      const v = Number(p[k]);
      if (Number.isFinite(v)) clean[k] = Math.max(0, Math.min(300, Math.round(v)));
    }
    safe.params = clean;
  }
  if (safe.gpuThreshold !== undefined) {
    const n = Number(safe.gpuThreshold);
    safe.gpuThreshold = Math.max(1, Math.min(100, Math.round(Number.isFinite(n) ? n : 85)));
  }
  if (safe.pauseApps !== undefined) safe.pauseApps = normalizePauseApps(safe.pauseApps);
  if (safe.trustedDir !== undefined) {
    const raw = String(safe.trustedDir).slice(0, 500);
    safe.trustedDir = raw && path.isAbsolute(raw) ? raw : '';
  }
  for (const k of ['pauseOnGpu', 'allowLocalUrl', 'clickThrough']) {
    if (safe[k] !== undefined) safe[k] = safe[k] === true || safe[k] === 'true' || safe[k] === 1;
  }
  return { safe };
}

handleIpc('live-wallpaper-control', async (_e, patch) => {
  const { safe, error } = safeLivePatch(patch);
  if (error) return { ok: false, error };
  if (typeof safe.webUrl === 'string' && safe.webUrl) {
    const current = getSettings()?.liveWallpaper || {};
    const allowLocalUrl = safe.allowLocalUrl ?? current.allowLocalUrl ?? false;
    const trustedDir = String(safe.trustedDir ?? current.trustedDir ?? '');
    if (!isSafeLiveUrl(safe.webUrl, { allowLocalUrl, trustedDir })) {
      return {
        ok: false,
        error: allowLocalUrl
          ? '网页地址只允许公网 / 本机 / 内网 http(s)，或可信目录内的 file:// 页面'
          : '默认只允许公网 http(s)；要使用本地或内网页面，请先打开「允许本地 / 内网网页」',
      };
    }
  }
  // 失败也要如实回 ok:false：以前无论成功失败都返回 { ok: true }
  const r = await fetchJson(
    `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(safe) },
    5000
  ).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  return r && r.ok === false ? { ok: false, error: r.error } : { ok: true };
});

/** 离线横幅的「立即重启」按钮：和托盘菜单走同一个重启函数，不新增第二套逻辑 */
handleIpc('restart-service', async () => {
  const ok = await restartLocalServer();
  return { ok };
});

/** 参数滑块即时预览：不落库，直接推给已挂载的桌面层窗口 / 屏保窗口 */
handleIpc('live-params', async (_e, patch) => {
  const clean = {};
  for (const k of LIVE_PARAM_KEYS) {
    const v = Number(patch?.[k]);
    if (Number.isFinite(v)) clean[k] = Math.max(0, Math.min(300, Math.round(v)));
  }
  if (!Object.keys(clean).length) return { ok: false, error: '参数不合法' };
  pushLiveParams(clean);
  return { ok: true };
});

/* --------------------------- 首装示例图播种 --------------------------- */

/**
 * 安装后第一次打开，把随包附带的示例图片放进默认素材目录（图片/TuKu）。
 * 装完就该看到「图库里有图」，而不是空库 + 一句「请选择文件夹」。
 * 只在默认目录为空时写入，且写一次标记就不再写 —— 用户删光图片后重启不会被塞回来。
 */
function seedSampleImages() {
  const dest = process.env.TUKU_DEFAULT_STORAGE_DIR;
  if (!dest) return;
  const marker = path.join(app.getPath('userData'), '.samples-seeded');
  if (fs.existsSync(marker)) return;
  const src = app.isPackaged
    ? path.join(process.resourcesPath, 'samples')
    : path.join(APP_ROOT_DIR, 'assets', 'samples');
  try {
    let existing = [];
    try {
      existing = fs.readdirSync(dest);
    } catch {
      existing = [];
    }
    // 目录里已经有东西（用户自己的素材）就不掺示例图
    if (!existing.length && fs.existsSync(src)) {
      fs.mkdirSync(dest, { recursive: true });
      let copied = 0;
      for (const f of fs.readdirSync(src)) {
        const from = path.join(src, f);
        if (!fs.statSync(from).isFile()) continue;
        fs.copyFileSync(from, path.join(dest, f));
        copied++;
      }
      console.info('[seed] 已放入示例图片', copied, '张 →', dest);
    }
  } catch (err) {
    console.warn('[seed] 示例图片准备失败：', err?.message || err);
  }
  // 标记照写：即使这次目录非空（用户自有素材），下次也不再尝试
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* 标记写不了就下次再判断一次，不影响启动 */
  }
}

app.whenReady().then(async () => {
  // 第二个实例不再初始化服务与窗口
  if (!gotSingleInstanceLock) return;

  cleanupCrashDumps();
  // 屏保空闲检测常驻；内部会等 serverPort 就绪，并按设置开关自行启停覆盖窗口
  startScreensaverWatch();
  // 服务就绪前先把启动页亮出来：首建库/大迁移时最长十几秒，不能什么都不显示。
  // 但开机自启（--hidden）不能弹：用户没有主动打开应用，开机后桌面上突然糊一个
  // 「正在启动本地服务」的加载框（服务就绪前会停留十几秒），会被当成电脑出问题了。
  // 自启时只在后台把服务拉起来，用户点托盘/快捷键时服务多半已就绪，直接开窗口。
  if (!START_HIDDEN) showSplash();

  /* -------- 这些监听只能注册一次（以前写在 createWindow 里） --------
     session 级 / app 级监听挂在 createWindow 内部时，主窗口每被托盘、快捷键或
     activate 重建一次就多挂一份 —— 一次下载会连续弹出 N 个「另存为」框。 */
  session.defaultSession.on('will-download', async (_e, item) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    let name = 'download';
    try {
      name = item.getFilename() || name;
    } catch {}
    // 先暂停：Electron 要求尽早 setSavePath，否则数据已经在临时目录里跑了；
    // 暂停后等对话框结果，取消就整个撤销，不会留下半截文件。
    try {
      item.pause();
    } catch {}
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '保存文件',
      defaultPath: path.join(app.getPath('downloads'), name),
      buttonLabel: '保存',
    });
    if (canceled || !filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
    item.resume();
    item.once('done', (_ev, state) => {
      if (state === 'completed') showToastBanner('下载完成', path.basename(filePath));
      else if (state === 'interrupted') showToastBanner('下载中断', name);
    });
  });

  app.on('child-process-gone', (_e, details) => {
    console.error('[desktop] 子进程退出:', details.type, details.reason, details.exitCode);
    // 服务进程的死活由 ServerHost 的 exit 事件管（会自动重启），这里只记录其它进程
  });

  // 必须在服务进程启动前完成：服务启动时会因为图库为空而自动扫描素材目录
  seedSampleImages();

  // 目录环境变量已在模块顶层设置。主进程只加载「不碰 SQLite」的模块：
  // config（路径/令牌）、desktop（窗口挂载）、proxy（代理规则 + Chromium 会话）。
  const [configMod, desktopMod, proxyMod] = await Promise.all([
    import('../server/config.js'),
    import('../server/desktop.js'),
    import('../server/proxy.js'),
  ]);
  ipcStorageRoot = configMod.STORAGE_DIR || '';
  apiToken = configMod.API_TOKEN || '';
  desktopApi = desktopMod;
  applyProxy = () => proxyMod.applyProxyNet(getSettings().network || {});
  registerProxyAuth = () => proxyMod.registerProxyAuthFor(() => getSettings().network || {});

  /* ------------------------- 服务进程：独立进程 + 崩溃自愈 ------------------------- */
  const externalDev = devServerUrl();
  if (externalDev) {
    // 开发模式：API 由 `npm run dev` 的 node 进程提供，令牌取自同一个 .api-token 文件
    serverPort = Number(process.env.TUKU_API_PORT || 3001);
    // 设置走 HTTP 拉一次快照（外部进程不会推 IPC）
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/settings`, {
        headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) setSettingsCache(await res.json());
    } catch (err) {
      console.warn('[desktop] 读取开发服设置失败：', err.message);
    }
  } else {
    serverHost = new ServerHost({
      entry: path.join(APP_ROOT_DIR, 'server', 'standalone.js'),
      desktop: true,
    });
    // 设置变了：快照更新 + 本地能力跟着生效（代理立即重应用、自启立即同步）
    serverHost.on('settings', (next) => {
      const prev = getSettings();
      setSettingsCache(next);
      // 快捷键开关变了要立刻重注册（默认视为开，只有显式 false 才是关）
      const onOff = (s) => s?.globalShortcuts !== false;
      if (onOff(prev) !== onOff(next)) refreshGlobalShortcuts();
      applyProxy().catch((err) => console.warn('[proxy] 应用代理失败：', err?.message || err));
      try {
        app.setLoginItemSettings({ openAtLogin: !!next.autoLaunch, args: ['--hidden'] });
      } catch (err) {
        console.error('[desktop] 同步开机自启失败:', err.message);
      }
    });
    // 动态壁纸配置变了：主进程负责创建/销毁壁纸窗口
    serverHost.on('live', (cfg) => {
      try {
        if (!cfg || cfg.enabled === false) destroyLiveWindow();
        else applyLiveWallpaper();
      } catch (err) {
        console.error('[live] 应用配置失败：', err?.message || err);
      }
    });
    // 崩溃重启后端口可能变，重新加载页面（返回同一端口时无感知）
    serverHost.on('restarted', (info) => {
      const changed = info.port !== serverPort;
      serverPort = info.port;
      apiToken = info.token || apiToken;
      setSettingsCache(info.settings || {});
      // 所有窗口一起换 origin：只重载 mainWindow 会让多开窗口变成白屏死窗口
      if (changed) reloadAllAppWindows();
      else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
      broadcastServiceState({ restarting: false, port: serverPort });
    });
    serverHost.on('dead', (msg) => {
      console.error('[desktop] 服务进程不可用：', msg);
      // 明确进入离线态：界面要显示横幅，不能「应用开着但接口全挂」还装作正常
      broadcastServiceState({ restarting: false, dead: true, error: String(msg || '') });
      void dialog
        .showMessageBox({
          type: 'error',
          title: '图库服务无法启动',
          message: msg,
          detail:
            '自动重启与换端口兜底都失败了。点「立即重启服务」再试一次；选择「继续用（离线）」仍可打开界面，但换壁纸、收藏、导入等接口暂时不可用。\n日志在应用数据目录的 desktop.log / server.log；若反复出现，请检查防火墙或安全软件是否拦截了本机监听。',
          buttons: ['立即重启服务', '继续用（离线）'],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) void restartLocalServer();
        })
        .catch((err) => console.error('[desktop] 服务不可用提示失败：', err?.message || err));
    });

    try {
      const info = await serverHost.start();
      serverPort = info.port;
      apiToken = info.token || apiToken;
      setSettingsCache(info.settings || {});
      console.info('[desktop] 服务进程就绪，端口', serverPort, 'pid', info.pid);
    } catch (err) {
      console.error('[desktop] 服务进程启动失败:', err);
      await failSplash(
        `本地服务未能启动：${err?.message || err}\n若反复出现，请检查防火墙或安全软件是否拦截了本机监听。`
      );
      return;
    }
  }

  buildMenu();
  registerProxyAuth();
  // 代理配错不能把整个启动链带崩（外层 catch 会直接退出应用，代价太大）
  try {
    await applyProxy();
  } catch (err) {
    console.warn('[proxy] 启动时应用代理失败：', err?.message || err);
  }

  // 启动时按设置同步开机自启（用户改了设置就立即生效，无需重启）
  try {
    app.setLoginItemSettings({ openAtLogin: !!getSettings().autoLaunch, args: ['--hidden'] });
  } catch (err) {
    console.error('[desktop] 设置开机自启失败:', err);
  }
  handleIpc('app-info', () => ({
    hotkeys: registeredHotkeys,
    failedHotkeys,
    shortcutEnabled: getSettings().globalShortcuts !== false,
    version: app.getVersion(),
    platform: process.platform,
  }));

  // 崩溃转储 / 运行日志目录：崩溃既不自动上报，至少要能让用户找到并导出来
  handleIpc('open-crash-dir', async () => {
    const dir = app.getPath('crashDumps');
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      /* 目录已存在 */
    }
    return shell.openPath(dir);
  });
  handleIpc('open-log-dir', async () => {
    const dir = getLogDir();
    if (!dir) return '暂无可用的日志目录';
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      /* 已存在 */
    }
    return shell.openPath(dir);
  });

  handleIpc('pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片保存文件夹',
      defaultPath: getSettings().storageDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 原生控件（<select> 下拉弹层等）跟随应用主题，避免暗色界面弹出自带白底的系统弹层
  nativeTheme.themeSource = 'dark';
  handleIpc('set-theme', (_e, theme) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'system';
    return nativeTheme.themeSource;
  });
  // get-theme 已移除：preload 从来没暴露过它，界面的主题来自设置项 /api/settings

  /* IPC 路径白名单：只放行应用实际管理的两个根目录（用户图片库 storageDir
   * 与应用数据 storage 根[缩略图/回收站]），防止渲染层被注入后借 IPC
   * 任意打开资源管理器 / 定位本机文件 */
  // 路径白名单：实现抽到 lib/pure.js（越界判断写错一次就等于任意文件读写）
  const pathAllowed = (p) => isPathInsideAny(p, [getSettings().storageDir, ipcStorageRoot]);

  handleIpc('open-folder', async (_e, p) => {
    const target = p || getSettings().storageDir;
    if (!pathAllowed(target)) {
      console.warn('[ipc] open-folder 拒绝白名单外路径:', p);
      return '路径不在应用管理的目录内，已拒绝打开';
    }
    try {
      const err = await shell.openPath(target);
      return err || null;
    } catch (e) {
      console.warn('[ipc] open-folder 打开失败：', e?.message || e);
      return String(e?.message || e);
    }
  });

  handleIpc('reveal-file', async (_e, p) => {
    if (!pathAllowed(p)) {
      console.warn('[ipc] reveal-file 拒绝白名单外路径:', p);
      return false;
    }
    shell.showItemInFolder(p);
    return true;
  });

  /* 原生拖拽导出（Eagle 核心用法）：把卡片拖到桌面 / 微信 / PS 直接落成文件。
   * 渲染层在 dragstart 里 preventDefault 后发消息过来，由主进程发起系统级拖拽；
   * 路径仍走白名单，防止被注入的渲染层借它把本机任意文件拖出去。 */
  ipcMain.on('drag-out', (e, p) => {
    if (!trustedSender(e)) {
      console.warn('[ipc] drag-out 拒绝非本应用页面的调用');
      return;
    }
    if (!pathAllowed(p) || !fs.existsSync(p)) {
      console.warn('[ipc] drag-out 拒绝白名单外路径:', p);
      return;
    }
    try {
      e.sender.startDrag({ file: path.resolve(p), icon: nativeImage.createFromPath(APP_ICON) });
    } catch (err) {
      console.warn('[ipc] drag-out 失败：', err?.message || err);
    }
  });

  // 吸管取色截图：直接抓本应用窗口内容（设备分辨率、无几何换算、零延迟）。
  // 之前用 desktopCapturer 截全屏再裁剪，在多屏/缩放环境下返回尺寸不可控，
  // 裁剪坐标错乱导致覆盖层画面整体缩小错位（「迷你窗口」bug）。
  handleIpc('screen-capture', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    try {
      const img = await mainWindow.webContents.capturePage();
      return { dataUrl: img.toDataURL() };
    } catch (err) {
      console.warn('[ipc] screen-capture 失败：', err?.message || err);
      return null;
    }
  });

  // 截图入库：界面按钮 / 托盘菜单 / 全局快捷键都走「区域框选」，不再整屏直传
  handleIpc('capture-screenshot', () => requestRegionShot());
  // 框选所需的全屏底图（渲染进程负责画选区并裁剪上传）
  handleIpc('grab-screen', async () => {
    try {
      return await grabScreenForShot();
    } catch (err) {
      console.warn('[ipc] grab-screen 失败：', err?.message || err);
      endRegionShot(); // 抓失败也得把窗口放回去，别留在隐藏状态
      return null;
    }
  });
  // 框选结束：还原窗口尺寸/显示状态
  handleIpc('end-shot', () => endRegionShot());

  // 选择单个文件（动态壁纸视频等）；filters 形如 [{ name: '视频', extensions: ['mp4','webm'] }]
  handleIpc('pick-file', async (_e, filters) => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件',
      defaultPath: getSettings().storageDir,
      properties: ['openFile'],
      filters: Array.isArray(filters) ? filters : [],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 微博 Cookie：打开内置登录窗口，登录后自动回传
  handleIpc('weibo-login', async () => {
    try {
      return await weiboLoginFlow();
    } catch (err) {
      console.error('[weibo] 登录窗口异常：', err?.message || err);
      return { ok: false, msg: String(err?.message || err).slice(0, 160) };
    }
  });

  // 用 Electron 下载管理器下载（弹「另存为」；不会产生空白窗口，也不影响当前页面）。
  // 只允许本机 server 的资源：被注入的渲染层不能借它把任意外部文件拉到用户磁盘
  handleIpc('download-file', async (e, url) => {
    // 下载由发起请求的那个窗口执行：多窗口下别把副窗口的下载挂到主窗口上
    const win = (e?.sender && BrowserWindow.fromWebContents(e.sender)) || mainWindow;
    if (!url || !win || win.isDestroyed()) return false;
    const absolute = /^https?:/i.test(url)
      ? new URL(url, `http://127.0.0.1:${serverPort}`).toString()
      : `http://127.0.0.1:${serverPort}${url.startsWith('/') ? '' : '/'}${url}`;
    if (!isLocalApiUrl(absolute, serverPort)) {
      // 必须带上实际端口：否则 127.0.0.1 上任意一个其它服务都能被渲染层借来下载文件
      console.warn('[ipc] download-file 拒绝非本机地址:', url);
      return false;
    }
    // 下载请求由主进程发起，带不上页面的 Authorization 头，改走 ?token=
    win.webContents.downloadURL(withApiToken(absolute));
    return true;
  });

  // 多窗口浏览：渲染层（命令面板 / 快捷键）请求再开一个窗口看同一份图库
  handleIpc('window:new', async () => {
    try {
      return await openAppWindow();
    } catch (err) {
      console.error('[desktop] 打开新窗口失败：', err?.message || err);
      return { ok: false, error: err?.message || '打开新窗口失败' };
    }
  });

  // 安装前：放行窗口关闭，并先把服务停干净 —— 否则 NSIS 要覆盖的正是
  // 子进程还占着的文件，在 Windows 上会直接装失败
  onBeforeInstall(async () => {
    forceQuit = true;
    await stopServerOnce();
  });

  // 安装没能启动：服务刚被我们停掉，必须拉回来 —— 否则用户点「本次先继续用」
  // 拿到的是一堆接口全挂的页面，跟卡死没区别
  onInstallFailed(async () => {
    forceQuit = false;
    if (!serverHost || serverHost.running) return;
    try {
      serverStopped = false;
      serverHost.restarts = [];
      const info = await serverHost.start();
      serverPort = info.port;
      apiToken = info.token || apiToken;
      setSettingsCache(info.settings || {});
      broadcastServiceState({ restarting: false, port: serverPort });
      reloadAllAppWindows();
      console.info('[update] 安装失败后已恢复本地服务，端口', serverPort);
    } catch (err) {
      console.error('[update] 安装失败后恢复服务失败：', err?.message || err);
    }
  });

  await createWindow();
  closeSplash();

  // 「用图库打开」：双击关联文件、把文件拖到 exe 上都走这里
  const startupFiles = pickImagePathsFromArgv(process.argv);
  if (startupFiles.length) void importPathsFromShell(startupFiles);
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    const files = pickImagePathsFromArgv([filePath]);
    if (files.length) void importPathsFromShell(files);
  });

  createTray();
  registerGlobalShortcuts();



  // 安装包下载完才提示：这时候才需要把窗口提上来（--hidden 启动时看不到遮罩）
  onUpdateReady(() => {
    showMainWindow();
  });

  // 后台静默检查更新：确认有新版就顺手下载，下载期间界面照常可用；
  // 只有包已经落到本地、能立刻安装时才会弹提示
  setTimeout(() => {
    void (async () => {
      try {
        const r = await startBackgroundUpdate({ repo: await updateRepoSetting() });
        if (r?.hasUpdate) console.info('[update] 后台下载新版本', r.latest);
      } catch (err) {
        console.warn('[update] 启动检查失败：', err?.message || err);
      }
    })();
  }, 3000);
  // 托盘创建失败 + 以 --hidden 启动 = 用户完全没有入口，兜底把窗口显示出来
  if (START_HIDDEN && !tray) {
    console.warn('[desktop] 托盘不可用，--hidden 启动时强制显示主窗口');
    showMainWindow();
  }
  // 若上次退出时开着动态壁纸，则自动恢复
  applyLiveWallpaper().catch((err) => console.warn('[live] 恢复动态壁纸失败：', err?.message || err));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((err) => console.error('[desktop] 激活重建窗口失败：', err?.message || err));
    }
  });
}).catch((err) => {
  // 启动链上任何一步抛错（动态 import、建窗、注册 IPC…）以前是裸的 unhandledRejection：
  // 进程活着、没有窗口、也没有任何提示。现在明确告知并退出，让用户能重试。
  console.error('[desktop] 启动失败：', err);
  try {
    dialog.showErrorBox('图库启动失败', `${err?.stack || err?.message || err}\n\n请重启应用；反复出现请把日志反馈给开发者。`);
  } catch {
    /* 连对话框都起不来就只能靠日志了 */
  }
  app.exit(1);
});

/**
 * 停服务只做一次。
 * 更新安装前会主动停一次（先把文件占用释放掉），will-quit 里还会再走一次；
 * 不拦住的话第二次会一直等一个已经退出的子进程。
 */
let serverStopped = false;
async function stopServerOnce() {
  if (serverStopped) return;
  serverStopped = true;
  try {
    await serverHost?.stop?.();
  } catch (err) {
    console.error('[desktop] 停服失败：', err?.message || err);
  }
}

let quitting = false;
app.on('will-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    console.warn('[shortcut] 退出前注销失败：', err?.message || err);
  }
  if (trayTimer) {
    clearInterval(trayTimer);
    trayTimer = null;
  }
  destroyLiveWindow();
  stopScreensaverWatch();
  closeToast();
  // 日志缓冲可能还有最后几行：退出前同步落一次
  try {
    flushLogs(true);
  } catch {
    /* 日志失败不能影响退出 */
  }
  // 以前是 void serverHost.stop()：fire-and-forget，主进程立刻退出，服务子进程
  // 来不及关库/落盘（下次启动可能撞锁、丢最后一批写入）。现在挡住退出，最多等 3 秒，
  // 超时也强退——绝不能变成「点了退出却关不掉」。
  const finish = () => {
    try {
      // 用 quit 而不是 exit：exit 跳过 before-quit/quit 整条链路，
      // 更新安装（quitAndInstall）与日志收尾都拿不到退出事件
      app.quit();
    } catch {
      /* 已经没了 */
    }
  };
  const timer = setTimeout(() => {
    console.warn('[desktop] 停服超时 3s，强制退出');
    finish();
  }, 3000);
  Promise.resolve()
    .then(() => stopServerOnce())
    .finally(() => {
      clearTimeout(timer);
      finish();
    });
});

app.on('window-all-closed', () => {
  // 以前无脑 app.quit()：窗口被销毁（崩溃/关闭）时，托盘、动态壁纸、定时切换
  // 会跟着一起没。现在只有用户真的要退出才退，否则留在托盘，从托盘可再打开。
  if (forceQuit) app.quit();
});
