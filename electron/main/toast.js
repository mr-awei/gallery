// @ts-check
/**
 * 右下角自绘提示窗 + 托盘操作反馈。
 *
 * 为什么不用系统通知：Windows 的 toast / 托盘气泡依赖 AUMID、安装快捷方式、
 * 系统通知开关三件事同时成立，任何一项不满足就被**静默丢弃**。用户点完托盘
 * 什么也没看到，只能认为「点了没生效」。自绘窗口不依赖这些前提。
 */
import { BrowserWindow, screen } from 'electron';
import { escapeHtml } from '../lib/pure.js';
import { ctx } from './context.js';

const TOAST_WIDTH = 380;
const TOAST_HEIGHT = 96;

export function closeToast() {
  if (ctx.toastTimer) {
    clearTimeout(ctx.toastTimer);
    ctx.toastTimer = null;
  }
  if (ctx.toastWindow && !ctx.toastWindow.isDestroyed()) ctx.toastWindow.destroy();
  ctx.toastWindow = null;
}

/**
 * 右下角自绘提示窗：4 秒自动消失，点击穿透、不抢焦点、不占任务栏。
 * @param {string} title
 * @param {string} [body]
 */
export function showToastBanner(title, body) {
  if (ctx.quitting) return;
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
    ctx.toastWindow = new BrowserWindow({
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
    ctx.toastWindow.setAlwaysOnTop(true, 'screen-saver');
    // 不让提示窗挡住鼠标：它只是通知，不能拦用户操作它底下的窗口
    ctx.toastWindow.setIgnoreMouseEvents(true);
    // 页面加载完再显示：ready-to-show 在个别环境下不触发，会让提示窗永远不出现
    ctx.toastWindow
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => {
        try {
          ctx.toastWindow?.showInactive();
        } catch {
          /* 窗口可能已被下一次提示替换 */
        }
      })
      .catch((err) => console.warn('[toast] 提示窗内容加载失败：', err?.message || err));
    ctx.toastWindow.on('closed', () => {
      ctx.toastWindow = null;
    });
    ctx.toastTimer = setTimeout(() => closeToast(), 4200);
  } catch (err) {
    console.warn('[toast] 提示窗创建失败：', err?.message || err);
  }
}

/**
 * 托盘菜单的结果必须让用户看得见。
 * 以前每个 click 都是「请求发出去就不管了」，后端报错（比如换壁纸时提示
 * 「该范围内没有可用图片」）只写进日志，用户点完只觉得没生效。
 * @param {string} title
 * @param {string} [content]
 */
export function trayNotify(title, content) {
  const body = String(content || '').trim();
  // 菜单顶部同时留一条「上次操作」：提示窗 4 秒就消失，菜单里的记录可以回看
  ctx.lastTrayNotice = `${title}${body ? `：${body}` : ''}`.slice(0, 60);
  try {
    Promise.resolve(ctx.trayMenuRefresher?.()).catch(() => {});
  } catch (err) {
    console.error('[tray] 刷新菜单失败：', err?.message || err);
  }
  showToastBanner(title, body);
}
