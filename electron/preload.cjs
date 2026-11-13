// @ts-check
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  revealFile: (p) => ipcRenderer.invoke('reveal-file', p),
  // 走 Electron 下载管理器（弹「另存为」），避免 window.open 产生空白窗口
  download: (url) => ipcRenderer.invoke('download-file', url),
  // 原生拖拽导出：把卡片拖到资源管理器/微信/PS 时落成真实文件（不是 URL）
  dragOut: (p) => ipcRenderer.send('drag-out', p),
  // 桌面端信息：实际生效的全局快捷键等（被其它软件占用时会自动换备用键）
  appInfo: () => ipcRenderer.invoke('app-info'),
  // 保存并应用动态壁纸配置（主进程据此创建/销毁桌面层窗口）
  controlLiveWallpaper: (patch) => ipcRenderer.invoke('live-wallpaper-control', patch),
  // 选择单个文件（如动态壁纸视频）
  pickFile: (filters) => ipcRenderer.invoke('pick-file', filters),
  // 视频片段导出：渲染进程编码出 data URL，主进程弹「另存为」写盘
  saveExport: (payload) => ipcRenderer.invoke('save-export', payload),
  // 壁纸参数实时预览：拖滑块时即时推给桌面层窗口，不重开窗口
  setLiveParams: (params) => ipcRenderer.invoke('live-params', params),
  // 微博 Cookie：打开内置登录窗口，登录成功后自动回传整段 Cookie
  weiboLogin: () => ipcRenderer.invoke('weibo-login'),
  // 同步原生控件（下拉弹层等）主题：dark / light / system
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  // 全屏截图（吸管取色）：返回 { dataUrl, x, y, width, height, scale }
  screenCapture: () => ipcRenderer.invoke('screen-capture'),
  // 截图入库（Eagle 式）：唤起主窗口进入区域框选态，返回 { ok, pending }
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
  // 框选底图：{ dataUrl, width, height, scale }
  grabScreen: () => ipcRenderer.invoke('grab-screen'),
  // 框选结束（截完/取消）：把窗口还原成进框选前的尺寸与显示状态
  endShot: () => ipcRenderer.invoke('end-shot'),
  // 主进程请求开始框选（全局快捷键 / 托盘触发），返回取消订阅函数
  onShotRequest: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('shot-request', handler);
    return () => ipcRenderer.removeListener('shot-request', handler);
  },
  // 全局快捷键重新注册后广播实际生效的键位（设置页开关快捷键时即时更新提示）
  onHotkeysChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('hotkeys-changed', handler);
    return () => ipcRenderer.removeListener('hotkeys-changed', handler);
  },
  // 本地 API 鉴权令牌（渲染进程的 fetch 需要带 Bearer 头）
  getApiToken: () => ipcRenderer.invoke('get-api-token'),
  // 多窗口浏览：再开一个窗口看同一份图库（共享本地服务与数据库）
  openNewWindow: () => ipcRenderer.invoke('window:new'),
  // 崩溃转储 / 运行日志目录（排查问题时让用户把文件发给开发者）
  openCrashDir: () => ipcRenderer.invoke('open-crash-dir'),
  openLogDir: () => ipcRenderer.invoke('open-log-dir'),
  // 「关于」页：按枚举名打开程序自己的目录（userData / logs / crashDumps）
  openAppDir: (key) => ipcRenderer.invoke('open-app-dir', key),
  // 开机自启开关（读/写系统登录项）
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  // 检查更新：{ ok, hasUpdate, latest, current, url } 或 { ok: false, msg }
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  // 应用内更新（electron-updater，仅安装版可用）
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  // 「本次先继续用」：装不上时的出口，下次启动仍会重新检查
  updateDismiss: () => ipcRenderer.invoke('update-dismiss'),
  // 「下次打开时安装」：本次照常用，下次启动必须先装完（不装就退出）
  updateDefer: () => ipcRenderer.invoke('update-defer'),
  updateState: () => ipcRenderer.invoke('update-state'),
  // 更新状态变化（检查/下载进度/已下载/出错），返回取消订阅函数
  onUpdateState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update-state', handler);
    return () => ipcRenderer.removeListener('update-state', handler);
  },
  // 本地服务重启中/已恢复：{ restarting, port?, error? }，返回取消订阅函数
  onServiceState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('service-state', handler);
    return () => ipcRenderer.removeListener('service-state', handler);
  },
  // 离线横幅上的「立即重启」：与托盘菜单共用主进程的重启流程
  restartService: () => ipcRenderer.invoke('restart-service'),
  updateResetFailures: () => ipcRenderer.invoke('update-reset-failures'),
  // 强制更新遮罩的兜底出口：下载/安装反复失败时让用户能退出应用
  quit: () => ipcRenderer.invoke('app:quit'),
});
