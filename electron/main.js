// @ts-check
/**
 * Electron 主进程入口：只保留「应用生命周期 + 组装」。
 *
 * 具体能力按职责拆在 electron/main/ 下：
 *   constants.js   常量与 devServerUrl
 *   context.js     跨模块共享状态（主窗口 / 端口 / 托盘 / 壁纸窗口…）
 *   crash.js       崩溃转储
 *   windows.js     主窗口 / 多开窗口 / 窗口位置记忆 / 关窗藏托盘
 *   splash.js      启动页
 *   shot.js        区域框选截图
 *   toast.js       操作结果提示窗
 *   ipc-base.js    IPC 闸门（调用方校验、令牌、本机请求、权限白名单）
 *   ipc-app.js     桌面能力类 IPC
 *   ipc-live.js    动态壁纸配置 IPC
 *   service.js     本地服务子进程（启动 / 自愈 / 重启）
 *   live.js        动态壁纸窗口
 *   screensaver.js 屏保
 *   shortcuts.js   全局快捷键
 *   tray.js        托盘
 *   wallpaper.js   壁纸操作
 *   weibo.js       微博登录窗
 *   updates.js     自动更新
 *   seed.js        首装示例图
 */
import { app, Menu, BrowserWindow, dialog, session } from 'electron';
import path from 'node:path';
import { flushLogs, initLogger } from './logger.js';
import { getSettingsSnapshot as getSettings } from './settings-cache.js';
import { APP_DIR_NAME, APP_ROOT_DIR, START_HIDDEN } from './main/constants.js';
import { ctx } from './main/context.js';
import { cleanupCrashDumps, initCrashReporting } from './main/crash.js';
import { registerAppIpc } from './main/ipc-app.js';
import { registerLiveIpc } from './main/ipc-live.js';
import { applyLiveWallpaper, destroyLiveWindow } from './main/live.js';
import { startScreensaverWatch, stopScreensaverWatch } from './main/screensaver.js';
import { seedSampleImages } from './main/seed.js';
import { bootService, loadHostModules, stopServerOnce } from './main/service.js';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './main/shortcuts.js';
import { showSplash, closeSplash } from './main/splash.js';
import { closeToast, showToastBanner } from './main/toast.js';
import { createTray, stopTrayTimer } from './main/tray.js';
import { registerHotfixIpc, startHotfixCheck, stopHotfixCheck } from './main/hotfix-ipc.js';
import {
  registerUpdateIpc,
  startBackgroundUpdateCheck,
  wireUpdateLifecycle,
  wireUpdateReady,
} from './main/updates.js';
import { createWindow, importPathsFromShell, pickImagePathsFromArgv, showMainWindow } from './main/windows.js';

// 兼容旧出口：以前这两个常量直接写在 main.js 顶部
export { APP_ICON, APP_NAME } from './main/constants.js';

app.setName(APP_DIR_NAME);

// 绿色版（electron-builder portable 目标）会把 exe 解到临时目录运行，若仍用默认
// userData，绿色版与安装版会共用同一个库目录与设置：一边升级 schema、另一边还在写，
// 混用版本直接互相破坏。portable 会注入 PORTABLE_EXECUTABLE_DIR，把数据放到 exe 旁边。
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, `${APP_DIR_NAME}Data`));
  } catch (err) {
    console.warn('[desktop] 绿色版数据目录设置失败，沿用默认 userData：', err?.message || err);
  }
}

// 必须与 electron-builder 的 appId / 安装快捷方式 AUMID 完全一致，否则 Windows 上
// Notification / 托盘气泡（Win10+ 走 toast）会被系统静默丢弃 —— 表现就是「点了没反馈」
//
// 但开发模式要单独一个 id：dev 跑的是 electron.exe，若与安装版共用 AUMID，任务栏会把
// 两者并进同一个按钮组，图标沿用已安装 exe 的那枚（旧图标），窗口自己的 icon 怎么设都不显示。
app.setAppUserModelId(app.isPackaged ? 'com.tuku.gallery' : 'com.tuku.gallery.dev');

/* ------------------------- 崩溃捕获与日志落盘（最先初始化） ------------------------- */
initCrashReporting();
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
// 默认图片保存位置：用户「图片」目录下的 TuKu 文件夹。
// 不用中文目录名——素材路径会进 DB、进日志、进备份，ASCII 少一堆编码麻烦。
// 不再写死具体路径——任何人安装后都能在设置页改成自己想要的任意文件夹。
process.env.TUKU_DEFAULT_STORAGE_DIR = path.join(app.getPath('pictures'), 'TuKu');

// 只允许一个实例：第二次启动直接退出，并把已有窗口带到前台
// （两个实例会同时读写同一个数据库与图片文件，容易互相锁住）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // 直接从开始菜单再点一次时，主窗口可能已经被销毁（进程还在托盘）：
    // showMainWindow 自带「窗口缺失就重建」。
    showMainWindow();
    // 拖到 exe 上 / 双击关联文件打开：第二个实例把文件路径带进来
    const files = pickImagePathsFromArgv(argv);
    if (files.length) void importPathsFromShell(files);
  });
}

app
  .whenReady()
  .then(async () => {
    // 第二个实例不再初始化服务与窗口
    if (!gotSingleInstanceLock) return;

    cleanupCrashDumps();
    // 屏保空闲检测常驻；内部会等 serverPort 就绪，并按设置开关自行启停覆盖窗口
    startScreensaverWatch();
    // 服务就绪前先把启动页亮出来：首建库/大迁移时最长十几秒，不能什么都不显示。
    // 但开机自启（--hidden）不能弹：用户没有主动打开应用，开机后桌面上突然糊一个
    // 「正在启动本地服务」的加载框（服务就绪前会停留十几秒），会被当成电脑出问题了。
    // 自启时只在后台把服务拉起来，用户点托盘/快捷键时服务多半已就绪，直接开窗口。
    if (!START_HIDDEN) showSplash();

    /* -------- 这些监听只能注册一次（以前写在 createWindow 里） --------
       session 级 / app 级监听挂在 createWindow 内部时，主窗口每被托盘、快捷键或
       activate 重建一次就多挂一份 —— 一次下载会连续弹出 N 个「另存为」框。 */
    session.defaultSession.on('will-download', async (_e, item) => {
      const win = BrowserWindow.getFocusedWindow() || ctx.mainWindow;
      let name = 'download';
      try {
        name = item.getFilename() || name;
      } catch {
        /* 窗口已销毁或正在退出，这类清理失败无需处理 */
      }
      // 先暂停：Electron 要求尽早 setSavePath，否则数据已经在临时目录里跑了；
      // 暂停后等对话框结果，取消就整个撤销，不会留下半截文件。
      try {
        item.pause();
      } catch {
        /* 窗口已销毁或正在退出，这类清理失败无需处理 */
      }
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), name),
        buttonLabel: '保存',
      });
      if (canceled || !filePath) {
        item.cancel();
        return;
      }
      item.setSavePath(filePath);
      item.resume();
      item.once('done', (_ev, state) => {
        if (state === 'completed') showToastBanner('下载完成', path.basename(filePath));
        else if (state === 'interrupted') showToastBanner('下载中断', name);
      });
    });

    app.on('child-process-gone', (_e, details) => {
      console.error('[desktop] 子进程退出:', details.type, details.reason, details.exitCode);
      // 服务进程的死活由 ServerHost 的 exit 事件管（会自动重启），这里只记录其它进程
    });

    // 必须在服务进程启动前完成：服务启动时会因为图库为空而自动扫描素材目录
    seedSampleImages();

    // 目录环境变量已在模块顶层设置。主进程只加载「不碰 SQLite」的模块：
    // config（路径/令牌）、desktop（窗口挂载）、proxy（代理规则 + Chromium 会话）。
    await loadHostModules();

    /* ------------------------- 服务进程：独立进程 + 崩溃自愈 ------------------------- */
    const started = await bootService();
    if (!started) return;

    // 不显示原生菜单栏（顶部「文件 / 视图 / 帮助」由应用内界面承担）。
    // 常用的开发者快捷键改为窗口级快捷键，保持调试便利。
    Menu.setApplicationMenu(null);
    ctx.registerProxyAuth();
    // 代理配错不能把整个启动链带崩（外层 catch 会直接退出应用，代价太大）
    try {
      await ctx.applyProxy();
    } catch (err) {
      console.warn('[proxy] 启动时应用代理失败：', err?.message || err);
    }

    // 启动时按设置同步开机自启（用户改了设置就立即生效，无需重启）
    try {
      app.setLoginItemSettings({ openAtLogin: !!getSettings().autoLaunch, args: ['--hidden'] });
    } catch (err) {
      console.error('[desktop] 设置开机自启失败:', err);
    }

    registerAppIpc();
    registerLiveIpc();
    registerUpdateIpc();
    registerHotfixIpc();

    wireUpdateLifecycle();

    await createWindow();
    closeSplash();

    // 「用图库打开」：双击关联文件、把文件拖到 exe 上都走这里
    const startupFiles = pickImagePathsFromArgv(process.argv);
    if (startupFiles.length) void importPathsFromShell(startupFiles);
    app.on('open-file', (e, filePath) => {
      e.preventDefault();
      const files = pickImagePathsFromArgv([filePath]);
      if (files.length) void importPathsFromShell(files);
    });

    createTray();
    registerGlobalShortcuts();

    // 安装包下载完才提示：这时候才需要把窗口提上来（--hidden 启动时看不到遮罩）
    wireUpdateReady();

    // 后台静默检查更新：确认有新版就顺手下载，下载期间界面照常可用；
    // 只有包已经落到本地、能立刻安装时才会弹提示
    startBackgroundUpdateCheck();
    // 热更：只下载不打扰，生效时机由设置决定（默认下次启动）
    startHotfixCheck();

    // 托盘创建失败 + 以 --hidden 启动 = 用户完全没有入口，兜底把窗口显示出来
    if (START_HIDDEN && !ctx.tray) {
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
  })
  .catch((err) => {
    // 启动链上任何一步抛错（动态 import、建窗、注册 IPC…）以前是裸的 unhandledRejection：
    // 进程活着、没有窗口、也没有任何提示。现在明确告知并退出，让用户能重试。
    console.error('[desktop] 启动失败：', err);
    try {
      dialog.showErrorBox(
        '图库启动失败',
        `${err?.stack || err?.message || err}\n\n请重启应用；反复出现请把日志反馈给开发者。`
      );
    } catch {
      /* 连对话框都起不来就只能靠日志了 */
    }
    app.exit(1);
  });

let quitting = false;
app.on('will-quit', (e) => {
  if (quitting) return;
  quitting = true;
  ctx.quitting = true;
  e.preventDefault();
  unregisterGlobalShortcuts();
  stopTrayTimer();
  stopHotfixCheck();
  destroyLiveWindow();
  stopScreensaverWatch();
  closeToast();
  // 日志缓冲可能还有最后几行：退出前同步落一次
  try {
    flushLogs(true);
  } catch {
    /* 日志失败不能影响退出 */
  }
  // 以前是 void serverHost.stop()：fire-and-forget，主进程立刻退出，服务子进程
  // 来不及关库/落盘（下次启动可能撞锁、丢最后一批写入）。现在挡住退出，最多等 3 秒，
  // 超时也强退——绝不能变成「点了退出却关不掉」。
  const finish = () => {
    try {
      // 用 quit 而不是 exit：exit 跳过 before-quit/quit 整条链路，
      // 更新安装（quitAndInstall）与日志收尾都拿不到退出事件
      app.quit();
    } catch {
      /* 已经没了 */
    }
  };
  const timer = setTimeout(() => {
    console.warn('[desktop] 停服超时 3s，强制退出');
    finish();
  }, 3000);
  Promise.resolve()
    .then(() => stopServerOnce())
    .finally(() => {
      clearTimeout(timer);
      finish();
    });
});

app.on('window-all-closed', () => {
  // 以前无脑 app.quit()：窗口被销毁（崩溃/关闭）时，托盘、动态壁纸、定时切换
  // 会跟着一起没。现在只有用户真的要退出才退，否则留在托盘，从托盘可再打开。
  if (ctx.forceQuit) app.quit();
});
