import { app, BrowserWindow, Menu, Tray, globalShortcut, dialog, ipcMain, shell, screen, powerMonitor, nativeTheme, crashReporter, desktopCapturer, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initLogger } from './logger.js';
import { ServerHost } from './server-host.js';
import { getSettingsSnapshot, setSettingsCache } from './settings-cache.js';
import { checkForUpdates, downloadUpdate, installUpdate, updateState } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT_DIR = path.resolve(__dirname, '..');

/**
 * 开机自启写入的登录项参数里带了 --hidden，但以前没有任何代码消费它：
 * 开机自启 = 一登录就把主窗口糊到用户脸上。这里统一判定，启动时只留托盘。
 */
const START_HIDDEN = process.argv.includes('--hidden');

export const APP_NAME = '图库';
export const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');

app.setName(APP_NAME);
app.setAppUserModelId('com.tuku.gallery.wallpaper');

/* ------------------------- 崩溃捕获与日志落盘（最先初始化） ------------------------- */
// minidump 只落本地 userData/CrashReports，不上传（隐私优先）；配合日志可定位白屏 / 闪退
try {
  crashReporter.start({ uploadToServer: false });
} catch {
  /* 部分平台不支持，忽略 */
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
// 默认图片保存位置：用户「图片」目录下的「图库」文件夹。
// 不再写死具体路径——任何人安装后都能在设置页改成自己想要的任意文件夹。
process.env.TUKU_DEFAULT_STORAGE_DIR = path.join(app.getPath('pictures'), '图库');

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
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
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

/** URL 是否指向本机的图库服务（host 必须精确相等，不能用 includes —— 127.0.0.1.attacker.example 会命中） */
function isLocalApiUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
    return !serverPort || Number(u.port || 80) === Number(serverPort);
  } catch {
    return false;
  }
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
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url);
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
  try {
    return trustedOrigins().has(new URL(target).origin);
  } catch {
    return false;
  }
}

/** 敏感权限白名单：只给自家页面，且只给真正需要的几项 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);

let permissionGuardInstalled = false;
function installPermissionGuard(ses) {
  if (permissionGuardInstalled) return;
  permissionGuardInstalled = true;
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

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: Math.min(1024, winWidth),
    minHeight: Math.min(680, winHeight),
    center: true,
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
  console.log('[desktop] 加载', url);
  if (devUrl) {
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
    console.log('[desktop] --hidden 启动：窗口保持隐藏，仅托盘可见');
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

  // 下载时自己弹「另存为」：显式决定保存位置，取消就取消下载
  mainWindow.webContents.session.on('will-download', async (_e, item) => {
    let name = 'download';
    try {
      name = item.getFilename() || name;
    } catch {}
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '保存文件',
      defaultPath: path.join(app.getPath('downloads'), name),
      buttonLabel: '保存',
    });
    if (canceled || !filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
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

  app.on('child-process-gone', (_e, details) => {
    console.error('[desktop] 子进程退出:', details.type, details.reason, details.exitCode);
    // 服务进程的死活由 ServerHost 的 exit 事件管（会自动重启），这里只记录其它进程
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
  appWindows.add(mainWindow);
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
  try {
    await serverHost.stop().catch(() => {});
    // 清空崩溃窗口内的失败计数，否则刚起来再崩一次又立刻进 dead
    serverHost.restarts = [];
    const info = await serverHost.start();
    serverPort = info.port;
    apiToken = info.token || apiToken;
    setSettingsCache(info.settings || {});
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow
        .loadURL(`http://127.0.0.1:${serverPort}`)
        .catch((err) => console.error('[desktop] 重启后重载窗口失败：', err?.message || err));
    }
    return true;
  } catch (err) {
    dialog.showErrorBox(
      '重启本地服务失败',
      `${err?.message || err}\n\n请完全退出应用后重新打开。`
    );
    return false;
  } finally {
    restartingServer = false;
  }
}

/** 通过本地接口操作壁纸（托盘菜单与全局快捷键共用） */
async function wallpaperAction(kind) {
  if (!serverPort) return null;
  const path =
    kind === 'now'
      ? '/api/wallpaper/now'
      : kind === 'favorite'
        ? '/api/wallpaper/current/favorite'
        : '/api/wallpaper/current/dislike';
  try {
    return await fetchJson(`http://127.0.0.1:${serverPort}${path}`, { method: 'POST' }, 30000);
  } catch (err) {
    console.error('[wallpaper] 操作失败：', err?.message || err);
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
      { label: '打开主窗口', click: showMainWindow },
      { label: '框选截图…', click: () => requestRegionShot() },
      {
        label: restartingServer ? '正在重启本地服务…' : '重启本地服务',
        enabled: !restartingServer,
        click: () => {
          void restartLocalServer().then(() => refreshMenu());
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
          try {
            // 只保存配置，真正的创建/销毁由 liveBus 广播触发
            await fetchJson(
              `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !live.enabled }),
              }
            );
          } catch (err) {
            console.error('[tray] 动态壁纸切换失败：', err?.message || err);
          }
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: auto.enabled ? '暂停定时切换' : '启用定时切换',
        click: async () => {
          try {
            await fetchJson(
              `http://127.0.0.1:${serverPort}/api/wallpaper/auto`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !auto.enabled }),
              }
            );
          } catch (err) {
            console.error('[tray] 切换定时失败：', err?.message || err);
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

  tray.on('click', showMainWindow);
  refreshMenu();
  setInterval(refreshMenu, 30000); // 让菜单里的「当前壁纸」保持最新
  console.log('[tray] 托盘已就绪（左键打开窗口 / 右键菜单）');
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

/**
 * 全局快捷键：别的窗口聚焦时也能换壁纸。
 * 默认键可能被其它软件占用，这里按候选顺序回退，并把实际生效的键回传给界面。
 */
function registerGlobalShortcuts() {
  if (getSettings().globalShortcuts === false) {
    console.log('[shortcut] 已按设置关闭全局快捷键');
    return;
  }
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
    if (!registeredHotkeys[action]) console.warn('[shortcut] 候选键全部被占用：', action);
  }
  console.log('[shortcut] 已注册：', JSON.stringify(registeredHotkeys));
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
  registerGlobalShortcuts();
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 让设置页显示的「实际生效键位」立刻跟上
    mainWindow.webContents.send('hotkeys-changed', registeredHotkeys);
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
    focusable: false,
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
}

/** 把动态壁纸窗口挂到桌面层并铺满虚拟屏幕 */
async function mountLiveWindow() {
  if (!liveWindow || liveWindow.isDestroyed()) return false;
  const b = liveBounds;
  const h = nativeHandleDecimal(liveWindow);
  console.log('[live-debug] mount hwnd=', h, 'w=', b.width, 'h=', b.height);
  const ok = await desktopApi?.attachLiveWindow(h, b.width, b.height).catch((e) => { console.log('[live-debug] attach err', e?.message); return false; });
  console.log('[live-debug] attach ok=', ok);
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

/** 性能规则：全屏应用 / 笔记本用电池 / 锁屏 时自动暂停动态壁纸 */
function startLivePerfRules() {
  stopLivePerfRules();
  const pause = (on) =>
    liveWindow?.webContents
      ?.executeJavaScript(`window.__live && window.__live.pause(${on})`)
      .catch(() => {});
  livePerfTimer = setInterval(async () => {
    if (!liveWindow || liveWindow.isDestroyed()) return;
    const cfg = await getLiveCfg();
    let shouldPause = false;
    if (cfg.pauseOnBattery && powerMonitor && !powerMonitor.isOnAC) shouldPause = true;
    if (cfg.pauseOnFullscreen && desktopApi) {
      try {
        if (await desktopApi.isFullscreenAppRunning()) shouldPause = true;
      } catch {}
    }
    pause(shouldPause);
  }, 3000);
  // 锁屏/休眠暂停，解锁后由轮询自动恢复
  powerMonitor?.on('lock-screen', () => pause(true));
  powerMonitor?.on('suspend', () => pause(true));
}

function stopLivePerfRules() {
  if (livePerfTimer) {
    clearInterval(livePerfTimer);
    livePerfTimer = null;
  }
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

/** 根据配置创建 / 销毁动态壁纸窗口，并加载对应内容 */
async function applyLiveWallpaper() {
  if (process.platform !== 'win32') {
    console.log('[live] 动态壁纸目前仅支持 Windows，已跳过');
    return;
  }
  const cfg = await getLiveCfg();
  if (!cfg || cfg.enabled === false) {
    destroyLiveWindow();
    return;
  }
  if (!liveWindow || liveWindow.isDestroyed()) {
    createLiveWindow();
  }
  // web 模式直接加载网址；其它模式用内置渲染页（/live 会按配置渲染）。
  // /live 页的 fetch 走 ?token= 传递鉴权（见 server/live-page.js）
  const url =
    cfg.mode === 'web' && cfg.webUrl
      ? cfg.webUrl
      : `http://127.0.0.1:${serverPort}/live?token=${encodeURIComponent(apiToken)}`;
  try {
    if (liveWindow.webContents.getURL() !== url) await liveWindow.loadURL(url);
    // 页面加载后再挂载，避免挂载时还没渲染
    await new Promise((r) => setTimeout(r, 1200));
    await mountLiveWindow();
    // 让页面立即按最新配置渲染（覆盖模式切换：slideshow ↔ video 无需整窗重载）
    liveWindow.webContents
      .executeJavaScript(`window.__live && window.__live.apply && window.__live.apply()`)
      .catch(() => {});
  } catch (err) {
    console.error('[live] 启动失败：', err?.message || err);
  }
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
    const isNewer = (a, b) => {
      const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
      }
      return false;
    };
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
  return checkForUpdates({ repo: await updateRepoSetting() });
});
handleIpc('update-download', () => downloadUpdate());
handleIpc('update-install', () => installUpdate());
handleIpc('update-state', () => updateState());

handleIpc('live-wallpaper-control', async (_e, patch) => {
  // 失败也要如实回 ok:false：以前无论成功失败都返回 { ok: true }
  const r = await fetchJson(
    `http://127.0.0.1:${serverPort}/api/wallpaper/live`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch || {}) },
    5000
  ).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  return r && r.ok === false ? { ok: false, error: r.error } : { ok: true };
});

app.whenReady().then(async () => {
  // 第二个实例不再初始化服务与窗口
  if (!gotSingleInstanceLock) return;

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
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (changed) mainWindow.loadURL(`http://127.0.0.1:${serverPort}`).catch(() => {});
        else mainWindow.webContents.reload();
      }
    });
    serverHost.on('dead', (msg) => {
      console.error('[desktop] 服务进程不可用：', msg);
      dialog.showErrorBox(
        '图库服务无法启动',
        `${msg}\n\n可先在托盘图标右键选「重启本地服务」再试一次；仍不行请完全退出后重新打开。\n日志在应用数据目录的 desktop.log / server.log；若反复出现，请检查防火墙或安全软件是否拦截了本机监听。`
      );
    });

    try {
      const info = await serverHost.start();
      serverPort = info.port;
      apiToken = info.token || apiToken;
      setSettingsCache(info.settings || {});
      console.log('[desktop] 服务进程就绪，端口', serverPort, 'pid', info.pid);
    } catch (err) {
      console.error('[desktop] 服务进程启动失败:', err);
      dialog.showErrorBox(
        '图库服务启动失败',
        `本地服务未能启动：${err?.message || err}\n\n请重启应用；若反复出现，请检查防火墙或安全软件是否拦截了本机监听。`
      );
      app.exit(1);
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
    shortcutEnabled: getSettings().globalShortcuts !== false,
    version: app.getVersion(),
    platform: process.platform,
  }));

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
  handleIpc('get-theme', () => nativeTheme.themeSource);

  /* IPC 路径白名单：只放行应用实际管理的两个根目录（用户图片库 storageDir
   * 与应用数据 storage 根[缩略图/回收站]），防止渲染层被注入后借 IPC
   * 任意打开资源管理器 / 定位本机文件 */
  const pathAllowed = (p) => {
    if (typeof p !== 'string' || !p.trim()) return false;
    const roots = [getSettings().storageDir, ipcStorageRoot].filter(Boolean).map((r) => path.resolve(r));
    if (!roots.length) return false;
    const target = path.resolve(p);
    return roots.some((root) => {
      const rel = path.relative(root, target);
      // rel 为空 = 就是根目录本身（「打开存储文件夹」按钮就是这么调的），必须放行
      if (rel === '') return true;
      return !(rel === '..' || rel.startsWith(`..${path.sep}`)) && !path.isAbsolute(rel);
    });
  };

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
    if (!isLocalApiUrl(absolute)) {
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

  await createWindow();

  createTray();
  registerGlobalShortcuts();
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
  destroyLiveWindow();
  // 以前是 void serverHost.stop()：fire-and-forget，主进程立刻退出，服务子进程
  // 来不及关库/落盘（下次启动可能撞锁、丢最后一批写入）。现在挡住退出，最多等 3 秒，
  // 超时也强退——绝不能变成「点了退出却关不掉」。
  const finish = () => {
    try {
      app.exit(0);
    } catch {
      /* 已经没了 */
    }
  };
  const timer = setTimeout(() => {
    console.warn('[desktop] 停服超时 3s，强制退出');
    finish();
  }, 3000);
  Promise.resolve()
    .then(() => serverHost?.stop?.())
    .catch((err) => console.error('[desktop] 停服失败：', err?.message || err))
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
