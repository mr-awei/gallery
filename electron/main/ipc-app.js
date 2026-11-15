// @ts-check
/**
 * 桌面能力类 IPC 通道：文件/目录、导出、截图、主题、开机自启、诊断包、多窗口。
 * 每条通道都经过 ipc-base 的 handleIpc 做调用方校验。
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildDiagnosticsZip } from '../diagnostics.js';
import { getLogDir } from '../logger.js';
import { isPathInsideAny, parseExportPayload } from '../lib/pure.js';
import { getSettingsSnapshot as getSettings } from '../settings-cache.js';
import { OFFICIAL_REPO } from '../updater.js';
import { APP_ICON } from './constants.js';
import { ctx } from './context.js';
import { handleIpc, isLocalApiUrl, trustedSender, withApiToken } from './ipc-base.js';
import { restartLocalServer } from './service.js';
import { endRegionShot, grabScreenForShot, requestRegionShot } from './shot.js';
import { weiboLoginFlow } from './weibo.js';
import { openAppWindow } from './windows.js';

export function registerAppIpc() {
  handleIpc('get-api-token', () => ctx.apiToken);

  // 开机自启：写系统登录项（用户可在设置页开关；随设置持久化到 settings）
  handleIpc('get-auto-launch', () => app.getLoginItemSettings().openAtLogin);
  handleIpc('set-auto-launch', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
  });

  /** 强制更新遮罩里的「退出应用」：装不上时至少让用户能关掉，而不是卡死在遮罩里 */
  handleIpc('app:quit', () => {
    ctx.forceQuit = true;
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

  /** 离线横幅的「立即重启」按钮：和托盘菜单走同一个重启函数，不新增第二套逻辑 */
  handleIpc('restart-service', async () => {
    const ok = await restartLocalServer();
    return { ok };
  });

  // 关于页面要用的全部「本机事实」都在这里给出，渲染进程不自己猜（也不写死版本号）
  handleIpc('app-info', () => ({
    hotkeys: ctx.registeredHotkeys,
    failedHotkeys: ctx.failedHotkeys,
    shortcutEnabled: getSettings().globalShortcuts !== false,
    version: app.getVersion(),
    platform: process.platform,
    /** x64 / arm64：同一个系统上装错架构的包会白屏，得让用户能核对 */
    arch: process.arch,
    /** 安装版才会自动更新：开发态/绿色版要给出不同文案 */
    packaged: app.isPackaged,
    versions: {
      electron: process.versions.electron || '',
      chromium: process.versions.chrome || '',
      node: process.versions.node || '',
      v8: process.versions.v8 || '',
    },
    paths: {
      userData: app.getPath('userData'),
      logs: getLogDir() || '',
      crashDumps: app.getPath('crashDumps'),
      // 资源库数据（各库的 gallery.db）在素材目录下，这里只给程序自己的数据目录
    },
    /** 更新通道：正式 Release（tag 构建）才会进更新源，rolling 预发布不会 */
    updateChannel: 'release',
    officialRepo: OFFICIAL_REPO,
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

  /**
   * 导出诊断包：把日志/环境/崩溃清单打成 zip，让用户一次性发过来。
   * 只读本应用自己的目录，不碰素材；密钥在打包时已打码。
   */
  handleIpc('export-diagnostics', async () => {
    try {
      const buf = await buildDiagnosticsZip({
        app,
        logDir: getLogDir(),
        crashDir: app.getPath('crashDumps'),
        userData: app.getPath('userData'),
        settings: getSettings(),
        serverPort: ctx.serverPort,
      });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const { canceled, filePath } = await dialog.showSaveDialog(ctx.mainWindow, {
        title: '保存诊断包',
        defaultPath: path.join(app.getPath('desktop'), `tuku-diagnostics-${stamp}.zip`),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      await fsp.writeFile(filePath, buf);
      return { ok: true, path: filePath, bytes: buf.length };
    } catch (err) {
      return { ok: false, error: String(/** @type {any} */ (err)?.message || err) };
    }
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

  /* 「关于」页的三个目录按钮：只接受枚举名，路径在主进程里解析。
   * 不走 open-folder 是因为那条通道按库目录白名单限制，程序数据目录本来就不在白名单里，
   * 而放开白名单又等于给渲染层任意打开本机目录的能力。 */
  handleIpc('open-app-dir', async (_e, key) => {
    const dirs = {
      userData: app.getPath('userData'),
      logs: getLogDir(),
      crashDumps: app.getPath('crashDumps'),
    };
    const dir = dirs[String(key || '')];
    if (!dir) return '未知的目录类型';
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      /* 已存在 */
    }
    return shell.openPath(dir);
  });

  handleIpc('pick-folder', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
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
  const pathAllowed = (p) => isPathInsideAny(p, [getSettings().storageDir, ctx.ipcStorageRoot]);

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
    if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return null;
    try {
      const img = await ctx.mainWindow.webContents.capturePage();
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
    if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
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
    const win = (e?.sender && BrowserWindow.fromWebContents(e.sender)) || ctx.mainWindow;
    if (!url || !win || win.isDestroyed()) return false;
    const absolute = /^https?:/i.test(url)
      ? new URL(url, `http://127.0.0.1:${ctx.serverPort}`).toString()
      : `http://127.0.0.1:${ctx.serverPort}${url.startsWith('/') ? '' : '/'}${url}`;
    if (!isLocalApiUrl(absolute, ctx.serverPort)) {
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
}
