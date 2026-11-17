// @ts-check
/**
 * 屏幕保护：闲置到设定时间后全屏覆盖，用户一动键鼠立即退出。
 * 用的是 Electron 全屏窗口，不需要 Win32 桌面层，三平台都可用。
 */
import { BrowserWindow, powerMonitor } from 'electron';
import { getSettingsSnapshot as getSettings } from '../settings-cache.js';
import { ctx } from './context.js';
import { virtualScreenBounds } from './live.js';

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
  if (ctx.saverWindow && !ctx.saverWindow.isDestroyed()) return;
  const c = screensaverConfig();
  const b = virtualScreenBounds();
  ctx.saverWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    show: false,
    skipTaskbar: true,
    fullscreen: true,
    focusable: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  ctx.saverWindow.setAlwaysOnTop(true, 'screen-saver');
  ctx.saverWindow.setIgnoreMouseEvents(false); // 要能接收输入，让系统空闲计时归零
  const url = `http://127.0.0.1:${ctx.serverPort}/live?screensaver=1&mode=${encodeURIComponent(c.mode)}&token=${encodeURIComponent(ctx.apiToken)}`;
  try {
    await ctx.saverWindow.loadURL(url);
    ctx.saverWindow.show();
    ctx.saverWindow.focus();
    console.info('[screensaver] 已进入屏保');
  } catch (err) {
    console.warn('[screensaver] 加载屏保页失败：', err?.message || err);
    hideScreensaver();
  }
}

function hideScreensaver() {
  if (ctx.saverWindow && !ctx.saverWindow.isDestroyed()) {
    try {
      ctx.saverWindow.destroy();
    } catch {
      /* 窗口已销毁或正在退出，这类清理失败无需处理 */
    }
  }
  ctx.saverWindow = null;
}

/** 1 秒一次系统空闲检测：触发后全屏覆盖，用户一动键鼠立即退出 */
export function startScreensaverWatch() {
  if (ctx.saverTimer) return;
  ctx.saverTimer = setInterval(async () => {
    const c = screensaverConfig();
    // 屏保用的是 Electron 全屏窗口，不需要 Win32 桌面层，三平台都可用
    if (!c.enabled || !ctx.serverPort) {
      if (ctx.saverWindow) hideScreensaver();
      return;
    }
    let idle;
    try {
      idle = powerMonitor.getSystemIdleTime();
    } catch {
      return;
    }
    if (ctx.saverWindow && !ctx.saverWindow.isDestroyed()) {
      if (idle < 2) hideScreensaver();
      return;
    }
    if (idle < c.idleMinutes * 60) return;
    // 全屏应用/游戏时不打扰，和动态壁纸的性能规则保持一致
    try {
      if (ctx.desktopApi && (await ctx.desktopApi.isFullscreenAppRunning())) return;
    } catch {
      /* 检测失败不阻塞屏保 */
    }
    await showScreensaver();
  }, 1000);
  ctx.saverTimer.unref?.();
}

export function stopScreensaverWatch() {
  if (ctx.saverTimer) {
    clearInterval(ctx.saverTimer);
    ctx.saverTimer = null;
  }
  hideScreensaver();
}
