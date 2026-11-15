// @ts-check
/**
 * 本地服务子进程的启动、自愈与重启。
 *
 * 服务跑在独立 utilityProcess 里（见 server-host.js），主进程只保留设置快照 + 桌面层能力；
 * 绝不 import server/db.js —— SQLite 只能有一个属主进程。
 */
import { BrowserWindow, app, dialog } from 'electron';
import path from 'node:path';
import { ServerHost } from '../server-host.js';
import { setSettingsCache, getSettingsSnapshot as getSettings } from '../settings-cache.js';
import { APP_ROOT_DIR, devServerUrl } from './constants.js';
import { ctx } from './context.js';
import { failSplash } from './splash.js';
import { refreshGlobalShortcuts } from './shortcuts.js';
import { applyLiveWallpaper, destroyLiveWindow } from './live.js';

/**
 * 加载「不碰 SQLite」的服务端模块：config（路径/令牌）、desktop（窗口挂载）、proxy（代理规则 + Chromium 会话）。
 * 必须在服务进程启动前完成：目录环境变量已在主进程模块顶层设置。
 */
export async function loadHostModules() {
  const [configMod, desktopMod, proxyMod] = await Promise.all([
    import('../../server/config.js'),
    import('../../server/desktop.js'),
    import('../../server/proxy.js'),
  ]);
  ctx.ipcStorageRoot = configMod.STORAGE_DIR || '';
  ctx.apiToken = configMod.API_TOKEN || '';
  ctx.desktopApi = desktopMod;
  // applyProxyNet 返回「是否成功」布尔，这里只当副作用用，统一成 Promise<void>
  ctx.applyProxy = async () => {
    await proxyMod.applyProxyNet(getSettings().network || {});
  };
  ctx.registerProxyAuth = () => proxyMod.registerProxyAuthFor(() => getSettings().network || {});
}

/** 服务重启前/后通知所有渲染窗口：重启期间界面该显示遮罩，而不是让用户对着失败的请求发呆 */
export function broadcastServiceState(payload) {
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
export function reloadAllAppWindows() {
  const base = `http://127.0.0.1:${ctx.serverPort}`;
  const targets = new Set([ctx.mainWindow, ...ctx.appWindows]);
  for (const win of targets) {
    if (!win || win.isDestroyed()) continue;
    let url = base;
    try {
      // 保留各窗口原来的路由（#/xx 或 /search），只换端口
      const cur = new URL(win.webContents.getURL());
      if (cur.hostname === '127.0.0.1' || cur.hostname === 'localhost') {
        cur.protocol = 'http:';
        cur.port = String(ctx.serverPort);
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
export async function restartLocalServer() {
  if (ctx.restartingServer) return false;
  if (!ctx.serverHost) {
    // 开发模式下 API 由外部 node 进程提供，这里没有子进程可重启
    dialog.showErrorBox('无法重启本地服务', '当前是开发模式（API 不在应用内），请重启 npm run dev。');
    return false;
  }
  ctx.restartingServer = true;
  broadcastServiceState({ restarting: true });
  try {
    await ctx.serverHost.stop().catch(() => {});
    // 清空崩溃窗口内的失败计数与换端口兜底标记，否则刚起来再崩一次又立刻进 dead
    ctx.serverHost.revive();
    const info = await ctx.serverHost.start();
    ctx.serverPort = info.port;
    ctx.apiToken = info.token || ctx.apiToken;
    setSettingsCache(info.settings || {});
    broadcastServiceState({ restarting: false, dead: false, port: ctx.serverPort });
    reloadAllAppWindows();
    return true;
  } catch (err) {
    broadcastServiceState({ restarting: false, dead: true, error: String(err?.message || err) });
    dialog.showErrorBox('重启本地服务失败', `${err?.message || err}\n\n请完全退出应用后重新打开。`);
    return false;
  } finally {
    ctx.restartingServer = false;
  }
}

/**
 * 停服务只做一次。
 * 更新安装前会主动停一次（先把文件占用释放掉），will-quit 里还会再走一次；
 * 不拦住的话第二次会一直等一个已经退出的子进程。
 */
export async function stopServerOnce() {
  if (ctx.serverStopped) return;
  ctx.serverStopped = true;
  try {
    await ctx.serverHost?.stop?.();
  } catch (err) {
    console.error('[desktop] 停服失败：', err?.message || err);
  }
}

/**
 * 拉起本地服务。
 * 开发模式（--dev-url / TUKU_DEV_URL）下 API 由 `npm run dev` 的 node 进程提供，只拉设置快照；
 * 打包/正常启动则起 utilityProcess 子进程，并挂上设置、动态壁纸、崩溃重启三类事件。
 * @returns {Promise<boolean>} false = 启动失败且已提示用户（调用方应直接结束启动流程）
 */
export async function bootService() {
  const externalDev = devServerUrl();
  if (externalDev) {
    // 开发模式：API 由 `npm run dev` 的 node 进程提供，令牌取自同一个 .api-token 文件
    ctx.serverPort = Number(process.env.TUKU_API_PORT || 3001);
    // 设置走 HTTP 拉一次快照（外部进程不会推 IPC）
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.serverPort}/api/settings`, {
        headers: ctx.apiToken ? { Authorization: `Bearer ${ctx.apiToken}` } : {},
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) setSettingsCache(await res.json());
    } catch (err) {
      console.warn('[desktop] 读取开发服设置失败：', err.message);
    }
    return true;
  }

  const serverHost = new ServerHost({
    entry: path.join(APP_ROOT_DIR, 'server', 'standalone.js'),
    desktop: true,
  });
  ctx.serverHost = serverHost;
  // 设置变了：快照更新 + 本地能力跟着生效（代理立即重应用、自启立即同步）
  serverHost.on('settings', (next) => {
    const prev = getSettings();
    setSettingsCache(next);
    // 快捷键开关变了要立刻重注册（默认视为开，只有显式 false 才是关）
    const onOff = (s) => s?.globalShortcuts !== false;
    if (onOff(prev) !== onOff(next)) refreshGlobalShortcuts();
    ctx.applyProxy().catch((err) => console.warn('[proxy] 应用代理失败：', err?.message || err));
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
    const changed = info.port !== ctx.serverPort;
    ctx.serverPort = info.port;
    ctx.apiToken = info.token || ctx.apiToken;
    setSettingsCache(info.settings || {});
    // 所有窗口一起换 origin：只重载 mainWindow 会让多开窗口变成白屏死窗口
    if (changed) reloadAllAppWindows();
    else if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.reload();
    broadcastServiceState({ restarting: false, port: ctx.serverPort });
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
    ctx.serverPort = info.port;
    ctx.apiToken = info.token || ctx.apiToken;
    setSettingsCache(info.settings || {});
    console.info('[desktop] 服务进程就绪，端口', ctx.serverPort, 'pid', info.pid);
    return true;
  } catch (err) {
    console.error('[desktop] 服务进程启动失败:', err);
    await failSplash(
      `本地服务未能启动：${err?.message || err}\n若反复出现，请检查防火墙或安全软件是否拦截了本机监听。`
    );
    return false;
  }
}
