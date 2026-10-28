/**
 * 主题（暗色 / 明亮）。
 * - 立即生效：写到 <html data-theme="...">，样式表按此切换变量
 * - 本地镜像：localStorage 让下次启动无需等接口返回就能用对主题（避免闪一下暗色）
 * - 持久化：同时存进服务端设置，换机器 / 清缓存后仍保留
 */
export type Theme = 'dark' | 'light';

const KEY = 'gem-theme';

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* 忽略隐私模式等异常 */
  }
  return 'light';
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
  // 桌面端：让原生控件（<select> 下拉弹层等）跟随应用主题，避免暗色界面弹白底弹层
  (window as unknown as { desktopAPI?: { setTheme?: (t: string) => void } }).desktopAPI
    ?.setTheme?.(theme);
}
