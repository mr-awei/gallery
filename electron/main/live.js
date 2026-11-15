// @ts-check
/**
 * 动态壁纸窗口：把一扇无边框、不接收鼠标、不进任务栏的窗口挂到桌面图标层（WorkerW）后面，
 * 做成真正的动态桌面。由设置页/托盘/快捷键控制开关，真正的创建/销毁由 liveBus 广播触发。
 */
import { BrowserWindow, desktopCapturer, powerMonitor, screen } from 'electron';
import { isSafeLiveUrl, liveMountBroken, shouldPauseLive } from '../lib/pure.js';
import { getSettingsSnapshot as getSettings } from '../settings-cache.js';
import { ctx } from './context.js';
import { fetchJson } from './ipc-base.js';
import { showToastBanner } from './toast.js';

export const LIVE_MODES = new Set(['slideshow', 'video', 'web', 'shader', 'interactive', 'audio']);
export const LIVE_PARAM_KEYS = ['brightness', 'speed', 'intensity', 'depth'];

/** 覆盖整个虚拟屏幕（多屏拼接）的矩形 */
export function virtualScreenBounds() {
  const displays = screen.getAllDisplays();
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 只把数字参数推给已挂载的渲染页：拖滑块不重载页面、不重新挂载窗口 */
export function pushLiveParams(params) {
  const safe = {};
  for (const k of LIVE_PARAM_KEYS) {
    const v = Number(params?.[k]);
    if (Number.isFinite(v)) safe[k] = Math.max(0, Math.min(300, Math.round(v)));
  }
  if (!Object.keys(safe).length) return;
  const js = `window.__live && window.__live.setParams && window.__live.setParams(${JSON.stringify(safe)})`;
  for (const w of [ctx.liveWindow, ctx.saverWindow]) {
    if (w && !w.isDestroyed()) w.webContents.executeJavaScript(js).catch(() => {});
  }
}

/**
 * 默认点击穿透；两种显式开启交互的情况才接收鼠标：
 * ① 交互式粒子壁纸（interactive=true）② 网页壁纸且用户关掉了 clickThrough。
 * Esc 一律把窗口恢复成穿透（见 createLiveWindow 的 before-input-event）。
 */
function applyLiveInteractive(cfg) {
  if (!ctx.liveWindow || ctx.liveWindow.isDestroyed()) return;
  const particle = cfg?.mode === 'interactive' && cfg?.interactive === true;
  const web = cfg?.mode === 'web' && cfg?.clickThrough === false;
  try {
    ctx.liveWindow.setIgnoreMouseEvents(!(particle || web));
  } catch {
    /* 窗口已销毁或正在退出，这类清理失败无需处理 */
  }
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

function createLiveWindow() {
  if (ctx.liveWindow && !ctx.liveWindow.isDestroyed()) return ctx.liveWindow;
  const b = virtualScreenBounds();
  ctx.liveBounds = b;
  ctx.liveWindow = new BrowserWindow({
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
  ctx.liveWindow.setBounds(b);
  ctx.liveWindow.setSkipTaskbar(true);
  ctx.liveWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 点击穿透：壁纸不拦截桌面操作
  ctx.liveWindow.setIgnoreMouseEvents(true);
  // Esc 是交互壁纸的统一逃生键：立即恢复点击穿透，并把配置落库，
  // 这样重启后不会被一个「关不掉的交互桌面」困住。
  ctx.liveWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    if (!ctx.liveWindow || ctx.liveWindow.isDestroyed()) return;
    try {
      ctx.liveWindow.setIgnoreMouseEvents(true);
    } catch {
      /* 窗口已销毁或正在退出，这类清理失败无需处理 */
    }
    const s = getSettings()?.liveWallpaper || {};
    const patch = {};
    if (s.interactive === true) patch.interactive = false;
    if (s.clickThrough === false) patch.clickThrough = true;
    if (!Object.keys(patch).length || !ctx.serverPort) return;
    fetchJson(
      `http://127.0.0.1:${ctx.serverPort}/api/wallpaper/live`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
      5000
    ).catch(() => {});
  });
  // 主窗口关闭时这个窗口不能阻止退出；单独 destroy 即可
  ctx.liveWindow.on('closed', () => {
    ctx.liveWindow = null;
  });
  return ctx.liveWindow;
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

export function destroyLiveWindow() {
  stopLivePerfRules();
  if (ctx.liveWindow && !ctx.liveWindow.isDestroyed()) {
    const h = nativeHandleDecimal(ctx.liveWindow);
    ctx.desktopApi?.detachLiveWindow(h).catch(() => {});
    try {
      ctx.liveWindow.destroy();
    } catch {
      /* 窗口已销毁或正在退出，这类清理失败无需处理 */
    }
  }
  ctx.liveWindow = null;
  ctx.liveMounted = false;
  ctx.liveSignature = '';
}

/** 把动态壁纸窗口挂到桌面层并铺满虚拟屏幕 */
async function mountLiveWindow() {
  if (!ctx.liveWindow || ctx.liveWindow.isDestroyed()) return false;
  const b = ctx.liveBounds;
  const h = nativeHandleDecimal(ctx.liveWindow);
  const ok = await ctx.desktopApi?.attachLiveWindow(h, b.width, b.height).catch((err) => {
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
      ctx.liveWindow.hide();
    } catch {
      /* 窗口已销毁或正在退出，这类清理失败无需处理 */
    }
  }
  return !!ok;
}

/**
 * 性能规则 + 持续挂载守护（同一个 3 秒轮询，避免再起一个定时器）。
 * 暂停信号一次采样拿齐：GPU 占用 / 前台进程名 / 全屏应用 / 电池 / 锁屏。
 * 守护：资源管理器重建桌面层或 Chromium 重新认领父窗口时，连续两次检测到
 * 父句柄 != WorkerW 才重挂，且两次重挂至少隔 15 秒，避免桌面层抖动期反复闪屏。
 */
function startLivePerfRules() {
  stopLivePerfRules();
  const pause = (on) =>
    ctx.liveWindow?.webContents?.executeJavaScript(`window.__live && window.__live.pause(${on})`).catch(() => {});
  ctx.livePerfTimer = setInterval(async () => {
    if (!ctx.liveWindow || ctx.liveWindow.isDestroyed()) return;
    const cfg = await getLiveCfg();
    let snap = { gpu: -1, foreground: '', parent: 0, workerw: 0, fullscreen: false };
    if (ctx.desktopApi?.livePerfSnapshot) {
      try {
        snap = await ctx.desktopApi.livePerfSnapshot(
          nativeHandleDecimal(ctx.liveWindow),
          ctx.liveBounds.width,
          ctx.liveBounds.height
        );
      } catch (err) {
        console.warn('[live] 性能采样失败：', err?.message || err);
      }
    }
    const decision = shouldPauseLive(cfg, {
      onBattery: powerMonitor ? powerMonitor.isOnBatteryPower() : false,
      fullscreen: !!snap.fullscreen,
      gpu: Number(snap.gpu),
      locked: ctx.livePowerLocked,
      foreground: snap.foreground,
    });
    const reasons = decision.reasons.join(',');
    if (reasons !== ctx.liveLastPauseReasons) {
      console.info(`[live] 暂停=${decision.paused} 原因=${reasons || '无'}`);
      ctx.liveLastPauseReasons = reasons;
    }
    pause(decision.paused);

    if (ctx.liveMounted && liveMountBroken(snap)) {
      ctx.liveRemountMisses += 1;
      if (ctx.liveRemountMisses >= 2 && Date.now() - ctx.liveLastRemount > 15000) {
        ctx.liveRemountMisses = 0;
        ctx.liveLastRemount = Date.now();
        console.info('[live] 父窗口被重新认领，自动重挂到桌面层');
        const ok = await ctx.desktopApi
          ?.attachLiveWindow(nativeHandleDecimal(ctx.liveWindow), ctx.liveBounds.width, ctx.liveBounds.height)
          .catch(() => false);
        if (!ok) console.warn('[live] 自动重挂失败，下个守护周期再试');
      }
    } else {
      ctx.liveRemountMisses = 0;
    }
  }, 3000);
  // 锁屏/休眠期间持续暂停；解锁/唤醒事件明确清除，不再让 3 秒轮询把它「恢复」回来
  ctx.livePowerHandlers = {
    lock: () => {
      ctx.livePowerLocked = true;
      pause(true);
    },
    unlock: () => {
      ctx.livePowerLocked = false;
    },
    suspend: () => {
      ctx.livePowerLocked = true;
      pause(true);
    },
    resume: () => {
      ctx.livePowerLocked = false;
    },
  };
  powerMonitor?.on('lock-screen', ctx.livePowerHandlers.lock);
  powerMonitor?.on('unlock-screen', ctx.livePowerHandlers.unlock);
  powerMonitor?.on('suspend', ctx.livePowerHandlers.suspend);
  powerMonitor?.on('resume', ctx.livePowerHandlers.resume);
}

/** 锁屏/休眠监听句柄：以前 stop 时不摘，开关十几次就触发 MaxListenersExceeded */
function stopLivePerfRules() {
  if (ctx.livePerfTimer) {
    clearInterval(ctx.livePerfTimer);
    ctx.livePerfTimer = null;
  }
  if (ctx.livePowerHandlers) {
    powerMonitor?.removeListener('lock-screen', ctx.livePowerHandlers.lock);
    powerMonitor?.removeListener('unlock-screen', ctx.livePowerHandlers.unlock);
    powerMonitor?.removeListener('suspend', ctx.livePowerHandlers.suspend);
    powerMonitor?.removeListener('resume', ctx.livePowerHandlers.resume);
    ctx.livePowerHandlers = null;
  }
  ctx.livePowerLocked = false;
  ctx.liveRemountMisses = 0;
  ctx.liveLastPauseReasons = '';
}

/** 读最新动态壁纸配置（直接走本地接口，保证拿到刚保存的值） */
export async function getLiveCfg() {
  if (!ctx.serverPort) return {};
  try {
    return (await fetchJson(`http://127.0.0.1:${ctx.serverPort}/api/wallpaper/live`, {}, 5000)) || {};
  } catch {
    return {};
  }
}

/** 系统音频回环源：用 desktopCapturer 取主屏幕的 sourceId，渲染页据此 getUserMedia 捕获桌面音频。
 * 结果缓存 30s，避免每次切配置都重新枚举屏幕（会闪一下采集提示）。 */
async function getDesktopAudioSourceId() {
  const now = Date.now();
  if (ctx.cachedSysAudioId && now - ctx.cachedSysAudioAt < 30000) return ctx.cachedSysAudioId;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const id = sources[0]?.id || '';
    ctx.cachedSysAudioId = id;
    ctx.cachedSysAudioAt = now;
    return id;
  } catch (err) {
    console.warn('[live] 枚举系统音频源失败：', err?.message || err);
    return ctx.cachedSysAudioId;
  }
}

/** 根据配置创建 / 销毁动态壁纸窗口，并加载对应内容 */
export async function applyLiveWallpaper() {
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
  if (!ctx.liveWindow || ctx.liveWindow.isDestroyed()) {
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
    url = `http://127.0.0.1:${ctx.serverPort}/live?token=${encodeURIComponent(ctx.apiToken)}`;
    // 系统音频回环：把桌面源 id 注入渲染页，渲染页用 getUserMedia(chromeMediaSource=desktop) 捕获桌面声音
    if (cfg.audioSource === 'system') {
      const sysAudioId = await getDesktopAudioSourceId();
      if (sysAudioId) url += `&sysAudioId=${encodeURIComponent(sysAudioId)}`;
    }
  }
  const signature = liveSignatureOf(cfg, useWeb);
  const samePage =
    ctx.liveMounted &&
    !!ctx.liveWindow &&
    !ctx.liveWindow.isDestroyed() &&
    ctx.liveWindow.webContents.getURL() === url;
  if (samePage) {
    // 已挂到桌面层：只推参数 / 切交互穿透 / 必要时让页面自己重建渲染器。
    // 绝不重新 loadURL + 等 1200ms + 重新 SetParent：拖一次滑块就重挂一次会闪屏甚至丢壁纸。
    pushLiveParams(cfg.params || {});
    applyLiveInteractive(cfg);
    if (signature !== ctx.liveSignature) {
      ctx.liveWindow.webContents
        .executeJavaScript('window.__live && window.__live.apply && window.__live.apply()')
        .catch(() => {});
      ctx.liveSignature = signature;
    }
    return;
  }
  try {
    if (ctx.liveWindow.webContents.getURL() !== url) await ctx.liveWindow.loadURL(url);
    // 页面加载后再挂载，避免挂载时还没渲染
    await new Promise((r) => setTimeout(r, 1200));
    const mounted = await mountLiveWindow();
    ctx.liveMounted = !!mounted;
    if (!mounted) {
      // 挂载失败时以前只 hide 窗口：设置里还显示「已开启」、托盘也这么说，用户以为桌面在动
      await rollbackLiveWallpaper('系统没有允许把窗口挂到桌面层（可能不支持当前桌面环境）');
      return;
    }
    ctx.liveSignature = signature;
    applyLiveInteractive(cfg);
    pushLiveParams(cfg.params || {});
    // 让页面立即按最新配置渲染（覆盖模式切换：slideshow ↔ video 无需整窗重载）
    ctx.liveWindow.webContents
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
    if (ctx.serverPort) {
      await fetchJson(
        `http://127.0.0.1:${ctx.serverPort}/api/wallpaper/live`,
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
