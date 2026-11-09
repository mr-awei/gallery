/**
 * 极简 i18n：`t('中文', 'English')` 双语内联，不做 key → 词典表。
 *
 * 为什么不用 i18next：这个项目的文案几乎都是「一句中文配一句英文」就能表达，
 * 引入词典文件会立刻带来「key 命名、缺 key 回退、教程 150 条要不要翻」的一堆事。
 * 内联写法的代价是文案散在组件里，所以只用于**界面骨架**（导航、按钮、空状态），
 * 教程与长文档仍只提供中文 —— 这一点在设置页里写清楚，不假装「已支持英文」。
 *
 * 语言存 localStorage：换库、换机器都不该被语言设置绑架，也不该写进 gallery.db。
 */
import { useSyncExternalStore } from 'react';

export type Lang = 'zh' | 'en';

const KEY = 'tuku:lang';
let current: Lang = 'zh';

(function init() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'zh') current = saved;
  } catch {
    /* 隐私模式下 localStorage 不可用：按默认中文 */
  }
})();

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  current = lang === 'en' ? 'en' : 'zh';
  try {
    localStorage.setItem(KEY, current);
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
  for (const fn of listeners) fn();
}

export function subscribeLang(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 取当前语言对应的文案 */
export function t(zh: string, en: string): string {
  return current === 'en' ? en : zh;
}

/** 语言名，设置页下拉用 */
export const LANG_LABEL: Record<Lang, string> = { zh: '简体中文', en: 'English' };

/**
 * 订阅语言变化的 hook。组件里用它只为了「切语言时重渲染」，
 * 文案仍然直接调 t()，不需要把 t 传下去。
 */
export function useLang() {
  const lang = useSyncExternalStore(subscribeLang, getLang, getLang);
  return { lang, t, setLang };
}
