import { readFileSync, writeFileSync } from 'node:fs';

const trayZh = {
  tooltip: '{app} · 本地图片管理',
  lastAction: '上次操作：{msg}',
  openMain: '打开主窗口',
  regionShot: '框选截图…',
  shotFailed: '截图没成功',
  shotFailedDetail: '屏幕抓取不可用，试试打开主窗口再截',
  restarting: '正在重启本地服务…',
  restartService: '重启本地服务',
  serviceRestarted: '本地服务已重启',
  serviceRestartedDetail: '现在可以继续换壁纸、收藏了',
  closeToTray: '关闭窗口时最小化到托盘',
  saveFailed: '设置没保存',
  serviceNoResponse: '本地服务没响应',
  changeWallpaper: '换一张壁纸　Ctrl+Alt+W',
  favoriteCurrent: '收藏当前壁纸',
  favoriteCurrentWith: '收藏当前壁纸（{title}）',
  dislike: '不喜欢，换一张',
  liveOn: '开启动态壁纸',
  liveOff: '关闭动态壁纸',
  liveEnabled: '动态壁纸已开启',
  liveDisabled: '动态壁纸已关闭',
  liveEnabledDetail: '桌面会按当前壁纸动起来；想停就在托盘菜单再点一次',
  liveFailed: '动态壁纸没切换',
  autoPause: '暂停定时切换',
  autoEnable: '启用定时切换',
  autoOn: '定时切换已开启',
  autoPaused: '定时切换已暂停',
  autoEvery: '每 {n} 分钟换一张',
  autoFailed: '定时切换没生效',
  noResult: '服务没有返回结果',
  quit: '退出',
};

const trayEn = {
  tooltip: '{app} · Local photo manager',
  lastAction: 'Last action: {msg}',
  openMain: 'Open main window',
  regionShot: 'Capture region…',
  shotFailed: 'Screenshot failed',
  shotFailedDetail: 'Screen capture unavailable. Try opening the main window first.',
  restarting: 'Restarting local service…',
  restartService: 'Restart local service',
  serviceRestarted: 'Local service restarted',
  serviceRestartedDetail: 'You can change and favorite wallpapers again.',
  closeToTray: 'Minimize to tray when closing',
  saveFailed: 'Settings not saved',
  serviceNoResponse: 'Local service not responding',
  changeWallpaper: 'Next wallpaper　Ctrl+Alt+W',
  favoriteCurrent: 'Favorite current wallpaper',
  favoriteCurrentWith: 'Favorite current wallpaper ({title})',
  dislike: 'Not this one, next',
  liveOn: 'Enable live wallpaper',
  liveOff: 'Disable live wallpaper',
  liveEnabled: 'Live wallpaper enabled',
  liveDisabled: 'Live wallpaper disabled',
  liveEnabledDetail: 'Your desktop animates the current wallpaper. Click again in the tray menu to stop.',
  liveFailed: 'Live wallpaper not switched',
  autoPause: 'Pause scheduled rotation',
  autoEnable: 'Enable scheduled rotation',
  autoOn: 'Scheduled rotation enabled',
  autoPaused: 'Scheduled rotation paused',
  autoEvery: 'Switch every {n} min',
  autoFailed: 'Scheduled rotation not applied',
  noResult: 'Service returned no result',
  quit: 'Quit',
};

for (const [file, tray] of [['zh-CN', trayZh], ['en-US', trayEn]]) {
  const p = `web/src/locales/${file}.json`;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.tray = { ...(j.tray || {}), ...tray };
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
  console.log(file, 'tray keys:', Object.keys(j.tray).length);
}
