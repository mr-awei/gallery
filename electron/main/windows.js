// @ts-check
/**
 * 窗口层：主窗口 / 多开的浏览窗口、窗口位置记忆、窗口级快捷键、托盘常驻时的关窗行为。
 * 「用本应用打开」的文件导入也放在这里（它只依赖窗口与服务端口）。
 */
import { BrowserWindow, app, dialog, screen, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ICON, APP_NAME, START_HIDDEN, devServerUrl } from './constants.js';
import { ctx } from './context.js';
import { confirmExitWhileBusy, installPermissionGuard, isTrustedOrigin, withApiToken } from './ipc-base.js';
import { showToastBanner } from './toast.js';
import { getSettingsSnapshot as getSettings } from '../settings-cache.js';

// preload 仍在 electron/ 根目录（由 electron-builder 打进包），这里按相对路径指过去
const PRELOAD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'preload.cjs');

/** 窗口级快捷键（替代原菜单加速键） */
export function registerShortcuts(win) {
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
export function pickImagePathsFromArgv(argv) {
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
export async function importPathsFromShell(files) {
  if (!files?.length) return;
  if (!ctx.serverPort) {
    showToastBanner('暂时无法导入', '本地服务还没就绪，请稍后再试');
    return;
  }
  if (ctx.shellImporting) {
    showToastBanner('导入进行中', '上一批「用图库打开」的文件还在入库，请稍候');
    return;
  }
  ctx.shellImporting = true;
  let ok = 0;
  let failed = 0;
  try {
    for (const file of files) {
      try {
        const buf = await fsp.readFile(file);
        const url = withApiToken(
          `http://127.0.0.1:${ctx.serverPort}/api/import/upload?filename=${encodeURIComponent(path.basename(file))}`
        );
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            ...(ctx.apiToken ? { Authorization: `Bearer ${ctx.apiToken}` } : {}),
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
    ctx.shellImporting = false;
  }
  if (ok || failed) {
    showToastBanner(
      '已用图库打开',
      failed ? `成功 ${ok} 个，失败 ${failed} 个（格式或体积不符合入库规则）` : `成功导入 ${ok} 个文件`
    );
  }
}

/**
 * 加载主页面，失败时等本地服务自愈再重试。
 *
 * 以前只 loadURL 一次：服务子进程恰好在首屏请求发出时崩掉（例如显卡执行器原生崩溃），
 * 这一次加载就必然失败 —— 尽管 server-host 一秒后就把服务重启好了，用户看到的却是
 * 「图库启动失败 / ERR_CONNECTION_RESET」并被直接退出。端口在重启后还会变，
 * 所以每轮都重新取 ctx.serverPort，而不是重试同一个 URL。
 */
async function loadMainUrlWithRetry() {
  const deadline = Date.now() + 30_000;
  let lastErr = null;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const target = devServerUrl() || `http://127.0.0.1:${ctx.serverPort}`;
    try {
      await ctx.mainWindow.loadURL(target);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[desktop] 页面加载失败（第 ${attempt + 1} 次），等待本地服务：`,
        err instanceof Error ? err.message : err
      );
      await new Promise((r) => setTimeout(r, Math.min(400 + attempt * 200, 1200)));
    }
  }
  throw lastErr || new Error('主页面加载超时');
}

/**
 * 主窗口：托盘常驻、忙碌确认退出、崩溃兜底都只属于这一个窗口。
 */
export async function createWindow() {
  if (!ctx.serverPort) {
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

  ctx.mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: Math.min(1024, initialBounds.width),
    minHeight: Math.min(680, initialBounds.height),
    center: !restore,
    title: `${APP_NAME} · 本地图片管理`,
    icon: APP_ICON,
    backgroundColor: '#0a0a12',
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 必须在 loadURL 之前登记：页面最早的 IPC（例如启动时应用主题的 set-theme）
  // 在窗口加载过程中就会发出来，登记晚了会被 trustedSender 当成外部页面拒掉
  ctx.appWindows.add(ctx.mainWindow);

  // 位置/大小记忆：拖动/缩放停下来 400ms 后写盘，关窗时再补一次
  let boundsTimer = null;
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveWindowState(ctx.mainWindow), 400);
  };
  ctx.mainWindow.on('resize', persistBounds);
  ctx.mainWindow.on('move', persistBounds);
  ctx.mainWindow.on('close', () => saveWindowState(ctx.mainWindow));
  if (restore && saved.maximized) ctx.mainWindow.maximize();

  registerShortcuts(ctx.mainWindow);

  // 权限白名单（主窗口与 /live 壁纸页共用默认 session）
  installPermissionGuard(ctx.mainWindow.webContents.session);

  // 同窗口跳转白名单：外链交给系统浏览器，绝不让带 preload 桥的窗口离开本地服务
  ctx.mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isTrustedOrigin(target)) return;
    event.preventDefault();
    console.warn('[desktop] 已阻止窗口跳转：', target);
    if (/^https?:/i.test(target)) void shell.openExternal(target);
  });
  ctx.mainWindow.webContents.on('will-redirect', (event, target) => {
    if (isTrustedOrigin(target)) return;
    event.preventDefault();
    console.warn('[desktop] 已阻止重定向：', target);
  });

  const devUrl = devServerUrl();
  const url = devUrl || `http://127.0.0.1:${ctx.serverPort}`;
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
    ctx.mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
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
        await ctx.mainWindow.loadURL(url);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastErr) {
      console.error('[desktop] 开发服务器未就绪：', lastErr.message);
      await ctx.mainWindow.loadURL(`http://127.0.0.1:${ctx.serverPort}`).catch(() => {});
    }
  } else {
    await loadMainUrlWithRetry();
  }
  if (START_HIDDEN) {
    // 开机自启：界面已经加载好但先不显示，用户点托盘/快捷键再露出来
    console.info('[desktop] --hidden 启动：窗口保持隐藏，仅托盘可见');
  } else {
    ctx.mainWindow.show();
  }

  // 不新建窗口：下载类链接交给下载管理器，其他链接交给系统浏览器
  // （原来 window.open 会拉出一个空白窗口）
  ctx.mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.includes('/api/')) {
      ctx.mainWindow.webContents.downloadURL(target);
    } else if (/^https?:/i.test(target)) {
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  /* ------------- 渲染进程兜底：崩溃自动重载、卡死给出口、加载失败重试 ------------- */
  let renderCrashes = 0;
  let lastCrashAt = 0;
  ctx.mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[desktop] 渲染进程崩溃:', details.reason, details.exitCode);
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    if (now - lastCrashAt > 5 * 60_000) renderCrashes = 0; // 时间窗重置
    lastCrashAt = now;
    renderCrashes += 1;
    if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
    if (renderCrashes > 3) {
      // 以前这里弹完错误框就 return：窗口停在白屏、主进程和托盘还活着，
      // 用户既看不到界面也退不掉，只能去任务管理器杀进程（「半死状态」）。
      // 现在必须给出可执行的出口：重载一次（计数清零）或直接退出。
      void dialog
        .showMessageBox(ctx.mainWindow, {
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
            ctx.forceQuit = true;
            app.quit();
            return;
          }
          renderCrashes = 0;
          lastCrashAt = 0;
          if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.reload();
        })
        .catch((err) => console.error('[desktop] 崩溃提示框失败：', err?.message || err));
      return;
    }
    // 崩溃后窗口是白屏，重载一次通常就能恢复（筛选状态在 URL 里，不会丢）
    setTimeout(() => {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.reload();
    }, 400);
  });

  // 事件循环被长任务卡住时给用户两条路，而不是一直转圈
  ctx.mainWindow.on('unresponsive', async () => {
    console.warn('[desktop] 窗口无响应');
    if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(ctx.mainWindow, {
      type: 'warning',
      title: '界面无响应',
      message: '界面长时间没有响应',
      detail: '可能正在处理大图或执行批量任务。可以再等一会儿，或强制重载界面（未保存的编辑会丢失）。',
      buttons: ['继续等待', '重载界面'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1 && ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.reload();
  });

  let loadRetries = 0;
  ctx.mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 主动中断（重载/跳转），不算失败
    console.error('[desktop] 页面加载失败:', code, desc, url);
    if (loadRetries >= 3) return;
    loadRetries += 1;
    setTimeout(() => {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.loadURL(url).catch(() => {});
    }, 500 * loadRetries);
  });
  ctx.mainWindow.webContents.on('did-finish-load', () => {
    loadRetries = 0;
  });

  // 兼容新旧两种签名（Electron 44 起改为事件对象）
  ctx.mainWindow.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const level = typeof ev?.level === 'number' ? ev.level : args[1];
    const message = ev?.message ?? args[2] ?? '';
    const line = ev?.lineNumber ?? args[3] ?? 0;
    const sourceId = ev?.sourceId ?? args[4] ?? '';
    if (level >= 3) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });

  ctx.mainWindow.on('close', async (e) => {
    if (ctx.forceQuit) return;
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
    ctx.forceQuit = true;
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.destroy();
    app.quit();
  });

  ctx.mainWindow.on('closed', () => {
    ctx.appWindows.delete(ctx.mainWindow);
    ctx.mainWindow = null;
  });
}

/**
 * 多窗口浏览：再开一个窗口看同一份图库（共享同一个本地服务与数据库）。
 *
 * 刻意不复用 createWindow：主窗口那套「关窗藏托盘 / 忙碌确认退出 / 崩溃兜底」只属于
 * 那一个窗口；副窗口关掉就该真的关掉，否则用户开了一堆窗口却退不干净。
 */
export async function openAppWindow() {
  if (!ctx.serverPort) return { ok: false, error: '本地服务尚未就绪，请稍后再试' };
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
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ctx.appWindows.add(win);
  win.on('closed', () => ctx.appWindows.delete(win));

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
    await win.loadURL(devUrl || `http://127.0.0.1:${ctx.serverPort}`);
  } catch (err) {
    win.destroy();
    return { ok: false, error: err?.message || '窗口加载失败' };
  }
  win.show();
  return { ok: true };
}

/**
 * 关窗是否只藏到托盘。
 * 托盘创建失败（无 GUI/图标缺失）时必须退回「关窗=退出」，否则用户既看不到窗口
 * 也没有托盘入口，等于把应用变成后台幽灵进程。
 */
export function shouldHideToTray() {
  if (!ctx.tray || ctx.tray.isDestroyed()) return false;
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return false;
  return getSettings().closeToTray !== false;
}

/** 关窗 → 藏进托盘，首次提示「还在后台运行」 */
export function hideToTray() {
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
  ctx.mainWindow.hide();
  // 第一次藏起来必须说一声：托盘图标常在任务栏小箭头里，不说用户会以为应用已退出
  if (!ctx.trayHintShown && ctx.tray && !ctx.tray.isDestroyed()) {
    ctx.trayHintShown = true;
    try {
      ctx.tray.displayBalloon({
        title: `${APP_NAME} 仍在后台运行`,
        content: '窗口已收到托盘：定时换壁纸与全局快捷键继续生效，右键托盘图标可退出。',
        icon: APP_ICON,
      });
    } catch (err) {
      console.warn('[tray] 气泡提示失败：', err?.message || err);
    }
  }
}

export function showMainWindow() {
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) {
    // 窗口被销毁（崩溃 / 关闭后留在托盘）时，托盘与全局快捷键必须能把它重建出来，
    // 否则这些入口全部静默失效，看起来就是「点托盘没反应」。
    if (ctx.serverPort) {
      void createWindow().catch((err) => console.error('[desktop] 重建窗口失败：', err?.message || err));
    }
    return;
  }
  if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore();
  ctx.mainWindow.show();
  ctx.mainWindow.focus();
}
