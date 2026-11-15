// @ts-check
/**
 * 区域框选截图（Eagle 的截图是框选，不是整屏）。
 *
 * 两个老毛病在这里修掉：先 show 再截会让底图里带着应用自己；遮罩只有小窗口那么大时，
 * 整屏底图被压进一个小方块里，框出来的位置和屏幕上看到的对不上。
 */
import { desktopCapturer, screen } from 'electron';
import { ctx } from './context.js';
import { createWindow } from './windows.js';

/**
 * 框选底图该抓哪块屏：以前固定抓主屏，多屏且窗口在副屏时，框选底图是另一块
 * 屏幕的画面，用户按「眼前看到的」去框，裁出来的区域完全错位。
 * 优先跟着主窗口走（框选遮罩就盖在窗口上），没有窗口再退化为光标所在屏。
 */
function shotDisplay() {
  try {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      const d = screen.getDisplayMatching(ctx.mainWindow.getBounds());
      if (d) return d;
    }
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    return screen.getPrimaryDisplay();
  }
}

/**
 * 抓「当前这块屏」的全分辨率画面，交给渲染进程做「区域框选」。
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

/** 等窗口进入/退出全屏（事件可能不派发，用超时兜底） */
function waitWindowState(win, event, action, timeout = 600) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      win.removeListener(event, done);
      resolve(undefined);
    };
    win.once(event, done);
    action();
    setTimeout(done, timeout);
  });
}

/** 唤起主窗口并让它进入截图框选态（快捷键 / 托盘 / 界面按钮共用） */
export function requestRegionShot() {
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) {
    // 窗口被关到托盘后又销毁过：先重建，加载完再进框选
    if (!ctx.serverPort) return { ok: false, pending: false, error: '本地服务未就绪' };
    void createWindow()
      .then(() => {
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send('shot-request');
      })
      .catch((err) => console.error('[shot] 重建窗口后进入框选失败：', err?.message || err));
    return { ok: true, pending: true };
  }
  // 这里刻意不 showMainWindow()：窗口一露脸，抓到的底图里就有应用自己
  ctx.mainWindow.webContents.send('shot-request');
  return { ok: true, pending: true };
}

/**
 * 框选底图：先把自己藏起来再抓屏（否则底图里带着应用自身），抓完让窗口全屏再显示。
 * 必须是全屏而不是最大化——最大化留着标题栏和任务栏，视口比例和底图不一致，
 * 前端按视口换算出来的裁剪区域会和实际屏幕错位。
 */
export async function grabScreenForShot() {
  const win = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null;
  const wasVisible = !!win && win.isVisible();
  ctx.shotWindowRestore = win
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
export async function endRegionShot() {
  const st = ctx.shotWindowRestore;
  ctx.shotWindowRestore = null;
  const win = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null;
  if (!win || !st) return false;
  if (!st.wasFullScreen && win.isFullScreen()) {
    await waitWindowState(win, 'leave-full-screen', () => win.setFullScreen(false));
  }
  if (!st.wasMaximized && win.isMaximized()) win.unmaximize();
  if (st.wasMinimized) win.minimize();
  else if (!st.wasVisible) win.hide();
  return true;
}
