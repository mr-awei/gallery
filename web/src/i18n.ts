/**
 * 统一多语言入口。
 * - react 组件侧：import { useTranslation } from 'react-i18next'
 * - 非组件侧（工具函数 / API 调用 / Electron preload）：import { t } from './i18n'
 * - Electron 主进程侧：共用同一份 locales JSON（主进程不 import 这个文件，
 *   而是直接 require 下面的 ./locales/*.json 自己维护一个轻量字典）
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json' with { type: 'json' };
import enUS from './locales/en-US.json' with { type: 'json' };

type Dict = Record<string, unknown>;

const resources = {
  'zh-CN': { translation: zhCN as Dict },
  'en-US': { translation: enUS as Dict },
};

/** 从 localStorage 读语言偏好，没有就跟随浏览器 */
function pickInitialLang(): string {
  // 非浏览器环境（Node 单测 / 服务端）没有 localStorage 与真实 navigator。
  // Node 22+ 的全局 navigator.language 默认是 en-US，会把单测断言带偏；直接走中文默认值。
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const stored = localStorage.getItem('tuku.lang');
    if (stored && resources[stored as keyof typeof resources]) return stored;
  } catch { /* ignore */ }
  const raw = navigator.language || 'zh-CN';
  if (raw.toLowerCase().startsWith('en')) return 'en-US';
  return 'zh-CN';
}

i18n.use(initReactI18next).init({
  resources,
  lng: pickInitialLang(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  // 允许组件渲染 <em>t('key', { ns: 'namespace' })</em> 形式，但默认不用 namespace
});

export default i18n;
export const t = i18n.t.bind(i18n);

/**
 * 把界面语言同步给主进程（托盘菜单 / 原生对话框的文案）。
 * 浏览器模式没有 desktopAPI，静默跳过。
 */
function syncMainLocale(lang: string): void {
  try {
    const api = (window as unknown as { desktopAPI?: { setLocale?: (l: 'zh-CN' | 'en-US') => Promise<boolean> } })
      .desktopAPI;
    void api?.setLocale?.(lang.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN');
  } catch {
    /* 没有桌面桥 */
  }
}

syncMainLocale(i18n.language);

export function changeLocale(lang: 'zh-CN' | 'en-US'): void {
  i18n.changeLanguage(lang);
  try { localStorage.setItem('tuku.lang', lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
  syncMainLocale(lang);
}
export function currentLocale(): string { return i18n.language; }
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
