/**
 * 主题（暗色 / 明亮）。
 * - 立即生效：写到 <html data-theme="...">，样式表按此切换变量
 * - 本地镜像：localStorage 让下次启动无需等接口返回就能用对主题（避免闪一下暗色）
 * - 持久化：同时存进服务端设置，换机器 / 清缓存后仍保留
 */
import { ALLOWED_VARS, type ThemePackTheme } from './lib/theme-pack-vars';
export type { ThemePackTheme } from './lib/theme-pack-vars';

export type Theme = 'dark' | 'light';

const KEY = 'tuku-theme';
const PACK_KEY = 'tuku-theme-pack';

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

/** 应用主题包：只覆盖白名单变量，null = 恢复内置主题 */
export function applyThemePack(pack: ThemePackTheme | null) {
  const root = document.documentElement;
  for (const k of ALLOWED_VARS) root.style.removeProperty(k);
  root.style.removeProperty('--ui-font');
  if (!pack) {
    try {
      localStorage.removeItem(PACK_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  applyTheme(pack.base === 'dark' ? 'dark' : 'light');
  for (const [k, v] of Object.entries(pack.variables || {})) {
    if ((ALLOWED_VARS as readonly string[]).includes(k)) root.style.setProperty(k, String(v));
  }
  // 与服务端 SAFE_FONT 同一套白名单：主题包是别人给的文件，setProperty 前再守一道
  if (pack.fontFamily && /^[\p{L}\p{N} ,.'"_-]{0,120}$/u.test(pack.fontFamily)) {
    root.style.setProperty('--ui-font', pack.fontFamily);
  }
  try {
    localStorage.setItem(PACK_KEY, JSON.stringify(pack));
  } catch {
    /* ignore */
  }
}

export function getStoredThemePack(): ThemePackTheme | null {
  try {
    const raw = localStorage.getItem(PACK_KEY);
    return raw ? (JSON.parse(raw) as ThemePackTheme) : null;
  } catch {
    return null;
  }
}

/** 启动前先恢复上次导入的主题包，避免闪回内置配色 */
export function restoreThemePack() {
  const pack = getStoredThemePack();
  if (pack) applyThemePack(pack);
}
