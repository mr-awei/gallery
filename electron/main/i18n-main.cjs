// @ts-check
/**
 * Electron 主进程侧的轻量字典（托盘菜单 / 原生对话框）。
 *
 * 为什么不复用 web 的 locales JSON：打包配置只带 electron/ server/ dist/web/，
 * 没有 web/src，require 对应文件在安装包里会直接失败。主进程需要的词条很少
 * （约 40 条），内联在这里反而更稳、也不会跟前端词条互相牵连。
 *
 * 用法：
 *   const { t, tf, switchLocale } = require('./i18n-main.cjs');
 *   t('dialog.save');                          // => '保存'
 *   tf('tray.lastAction', { msg: '已复制' });   // => '上次操作：已复制'
 */
const zhCN = {
  tray: {
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
  },
  dialog: {
    saveFile: '保存文件',
    save: '保存',
    saveCanceled: '已取消保存',
    saveClip: '保存视频片段',
    saveDiagnostics: '保存诊断包',
    gif: 'GIF 动图',
    webm: 'WebM 视频',
    noLogDir: '暂无可用的日志目录',
    pickStorageDir: '选择图片保存文件夹',
    pickFile: '选择文件',
  },
};

const enUS = {
  tray: {
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
  },
  dialog: {
    saveFile: 'Save file',
    save: 'Save',
    saveCanceled: 'Save canceled',
    saveClip: 'Save video clip',
    saveDiagnostics: 'Save diagnostics bundle',
    gif: 'GIF animation',
    webm: 'WebM video',
    noLogDir: 'No log directory available',
    pickStorageDir: 'Choose image folder',
    pickFile: 'Choose file',
  },
};

/** @type {Record<string, any>} */
const STORE = { 'zh-CN': zhCN, 'en-US': enUS };

/** @type {'zh-CN' | 'en-US'} */
let current = 'zh-CN';

/**
 * 点路径取值：dict['a.b.c'] => dict.a.b.c
 * @param {any} dict
 * @param {string} path
 */
function getByPath(dict, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return acc[key];
    return undefined;
  }, dict);
}

/**
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
function translate(key, fallback) {
  const v = getByPath(STORE[current], key);
  if (typeof v === 'string') return v;
  if (fallback != null) return fallback;
  if (current !== 'zh-CN') {
    const zh = getByPath(STORE['zh-CN'], key);
    if (typeof zh === 'string') return zh;
  }
  return key;
}

/**
 * @param {string} lang
 * @returns {string}
 */
function switchLocale(lang) {
  if (STORE[lang]) current = /** @type {'zh-CN' | 'en-US'} */ (lang);
  return current;
}

/** @returns {string} */
function getLocale() { return current; }

/**
 * 带占位符替换的翻译：tf('tray.lastAction', { msg: 'xxx' })
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
function translateFormat(key, vars) {
  let s = translate(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split('{' + k + '}').join(String(v));
    }
  }
  return s;
}

module.exports = { t: translate, tf: translateFormat, switchLocale, getLocale };
