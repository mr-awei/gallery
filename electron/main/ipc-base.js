// @ts-check
/**
 * IPC 基础设施：调用方校验、令牌注入、本机请求、权限白名单、退出确认。
 * 这里只有「闸门」，不含任何具体业务通道（见 ipc-app.js / ipc-live.js）。
 */
import { dialog, ipcMain } from 'electron';
import { isLocalApiUrl as isLocalApiUrlFor, originAllowed } from '../lib/pure.js';
import { ctx } from './context.js';
import { devServerUrl } from './constants.js';

/** 给本机 API 的 URL 追加 ?token=（下载直链等无法自定义 header 的请求用） */
export function withApiToken(url) {
  const apiToken = ctx.apiToken;
  if (!apiToken || !/^https?:/i.test(url)) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('token')) u.searchParams.set('token', apiToken);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * URL 是否指向本机的图库服务（实现见 lib/pure.js，便于单测）
 * @param {string} raw
 * @param {number} [port] 校验用的端口，默认当前服务端口
 */
export function isLocalApiUrl(raw, port = ctx.serverPort) {
  return isLocalApiUrlFor(raw, port);
}

/** 允许页面停留/跳转的 origin：本地服务（窗口本体、/live 壁纸页）+ 开发服务器 */
export function trustedOrigins() {
  const set = new Set();
  if (ctx.serverPort) {
    set.add(`http://127.0.0.1:${ctx.serverPort}`);
    set.add(`http://localhost:${ctx.serverPort}`);
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

export function isTrustedOrigin(target) {
  return originAllowed(target, trustedOrigins());
}

/**
 * IPC 调用方校验：只接受本应用主窗口（且同为本机页面）发起的调用。
 * 以前 18 个 handle 谁调都答——一旦主窗口被导航到外部页面、或被其它窗口
 * 拿到渲染进程上下文，就能直接调 open-folder / weibo-login / download-file。
 * @param {import('electron').IpcMainInvokeEvent | import('electron').IpcMainEvent | null | undefined} e
 */
export function trustedSender(e) {
  if (!e) return false;
  // 多窗口：任一应用窗口都算可信（仍校验是本机页面）
  const owner = [...ctx.appWindows].find((w) => !w.isDestroyed() && w.webContents === e.sender);
  if (!owner) return false;
  const url = String(e.senderFrame?.url || '');
  if (!url) return true; // 主框架无 URL（极早期调用）时只靠 sender 身份
  // 与导航白名单同一套精确 origin 比对（含端口）：以前这里用正则放行任意端口，
  // 本机别的服务占一个端口就能冒充「可信调用方」
  return isTrustedOrigin(url);
}

/**
 * 带调用方校验的 ipcMain.handle
 * @param {string} channel
 * @param {(...args: any[]) => any} listener
 */
export function handleIpc(channel, listener) {
  ipcMain['handle'](channel, async (e, ...args) => {
    if (!trustedSender(e)) {
      console.warn('[ipc] 拒绝非本应用页面的调用:', channel, e?.senderFrame?.url || '');
      return null;
    }
    return listener(e, ...args);
  });
}

/** 敏感权限白名单：只给自家页面，且只给真正需要的几项。
 * 补 'media'：动态壁纸音频可视化（麦克风 / 系统音频回环）需要 getUserMedia，
 * 但只放行自家 localhost 源（isTrustedOrigin 已把关），不波及远程 web 壁纸页。 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications', 'media']);

/** 已装守卫的 session：微博登录窗/壁纸窗用的是各自 partition，全局布尔只护得住第一个窗口 */
const guardedSessions = new WeakSet();

/** @param {import('electron').Session} ses */
export function installPermissionGuard(ses) {
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

/** 微博登录窗允许停留的站点：登录流程会跨 passport / login.sina / 静态资源几跳 */
const WEIBO_HOST_RE = /(^|\.)(weibo\.(cn|com)|sina\.(com\.cn|cn)|sinaimg\.cn)$/i;

/** @param {string} target */
export function isWeiboOrigin(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return WEIBO_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 本机接口请求（带 Bearer 令牌）
 * @param {string} url
 * @param {any} [init]
 * @param {number} [timeoutMs]
 */
export async function fetchJson(url, init = {}, timeoutMs = 2500) {
  // Node fetch 不带 Sec-Fetch 头，必须显式带 Bearer 令牌过 /api 鉴权
  const headers = { ...(init.headers || {}) };
  if (ctx.apiToken) headers.Authorization = `Bearer ${ctx.apiToken}`;
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

/** 正在进行的后台任务名（图片采集 / 本地导入 / 画质增强） */
export async function busyTasks() {
  /** @type {string[]} */
  const tasks = [];
  if (!ctx.serverPort) return tasks;
  // 三个探测都是「服务刚起来可能还没就绪」的场景：失败等于「没在跑」，
  // 但不能全静默——服务反复挂掉时托盘永远显示空闲，排障时没有任何线索
  const probe = async (url, label) => {
    try {
      const r = await fetchJson(`http://127.0.0.1:${ctx.serverPort}${url}`);
      if (r?.running) tasks.push(label);
    } catch (e) {
      console.info(`[busy] ${label} 状态读取失败:`, e?.message || e);
    }
  };
  await probe('/api/crawl/status', '图片采集');
  await probe('/api/import/status', '本地素材导入');
  await probe('/api/enhance/job', '画质增强');
  return tasks;
}

/** 任务进行中时拦截退出（任务管理器、强制关机等系统级手段无法拦截，属正常） */
export async function confirmExitWhileBusy() {
  if (ctx.forceQuit) return true;
  const tasks = await busyTasks();
  if (!tasks.length) return true;
  const { response } = await dialog.showMessageBox(
    /** @type {import('electron').BrowserWindow} */ (ctx.mainWindow),
    {
      type: 'warning',
      title: '任务进行中',
      message: `有任务正在进行：${tasks.join('、')}`,
      detail: '现在退出会中断任务，可能导致部分图片未完成下载或入库。确定要退出吗？',
      buttons: ['继续运行（不退出）', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
  );
  return response === 1;
}
