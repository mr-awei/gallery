// @ts-check
/**
 * 启动页：首次建库 / 大库迁移时服务可能十几秒才就绪。以前这段时间什么都没有，
 * 用户看到鼠标转圈会以为没打开，于是重复双击（又被单实例锁吞掉）。
 */
import { BrowserWindow, app, dialog } from 'electron';
import { APP_ICON } from './constants.js';
import { ctx } from './context.js';

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

export function showSplash() {
  if (ctx.splashWindow && !ctx.splashWindow.isDestroyed()) return ctx.splashWindow;
  try {
    ctx.splashWindow = new BrowserWindow({
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
    ctx.splashWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(splashHtml('正在启动本地服务…'))}`
    );
    ctx.splashWindow.on('closed', () => {
      ctx.splashWindow = null;
    });
  } catch (err) {
    console.warn('[desktop] 启动页创建失败：', err?.message || err);
  }
  return ctx.splashWindow;
}

export function closeSplash() {
  if (ctx.splashWindow && !ctx.splashWindow.isDestroyed()) ctx.splashWindow.close();
  ctx.splashWindow = null;
}

/** 启动失败：关掉启动页，给出原因与「重试 / 退出」——不能让用户干等或直接消失 */
export async function failSplash(message) {
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
