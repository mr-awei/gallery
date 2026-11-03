import { useCallback, useEffect, useState } from 'react';

/**
 * 集中式快捷键表。
 *
 * 之前每个页面各写各的 `e.key === 'x'`，用户想换键位只能改代码。
 * 这里把「主窗口里的全局动作」收成一张表：默认值 + 用户自定义（localStorage）
 * + 冲突检测。Lightbox / 标注 / 工作台内部的键位仍归各自组件（它们是场景专用，
 * 混进来只会让冲突检测变糊）。
 */

export type KeyAction =
  | 'palette'
  | 'filter'
  | 'search'
  | 'quickPreview'
  | 'selectAll'
  | 'delete'
  | 'undo'
  | 'newWindow'
  | 'help';

export const KEY_ACTIONS: { id: KeyAction; label: string; desc: string }[] = [
  { id: 'palette', label: '命令面板', desc: '搜索命令 / 跳转页面' },
  { id: 'filter', label: '筛选器搜索', desc: '按类型 / 星级 / 色系 / 文件夹快速定位' },
  { id: 'search', label: '聚焦搜索框', desc: '光标跳进顶部搜索框' },
  { id: 'quickPreview', label: '快速预览', desc: '预览鼠标下的素材（大图内再按一次关闭）' },
  { id: 'selectAll', label: '全选（当前筛选）', desc: '不只是已加载的一页' },
  { id: 'delete', label: '删除选中', desc: '移入回收站' },
  { id: 'undo', label: '撤销编辑', desc: '回滚最近一次覆盖写回' },
  { id: 'newWindow', label: '新建窗口', desc: '同一图库再开一个窗口（桌面端）' },
  { id: 'help', label: '快捷键帮助', desc: '打开 / 关闭这个说明面板' },
];

export const DEFAULT_KEYMAP: Record<KeyAction, string> = {
  palette: 'Ctrl+K',
  filter: 'Alt+F',
  search: 'Ctrl+F',
  quickPreview: 'Space',
  selectAll: 'Ctrl+A',
  delete: 'Delete',
  undo: 'Ctrl+Z',
  newWindow: 'Ctrl+N',
  help: '?',
};

const STORAGE_KEY = 'gem:keymap';
/** 键位变更事件：同窗口内其它组件（含多开窗口）立即生效 */
const CHANGE_EVENT = 'gem:keymap-changed';

/** 事件 → 规范化键位串（'Ctrl+Shift+Z' / 'Space' / '?'） */
export function bindingOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = e.ctrlKey || e.metaKey;
  if (mod) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  // 符号类按键的 Shift 已经体现在字符本身上（? = Shift+/），再记一次会永远匹配不上
  const isLetterOrDigit = /^[a-zA-Z0-9]$/.test(e.key);
  if (e.shiftKey && (e.key.length !== 1 || isLetterOrDigit)) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k === 'Escape') k = 'Esc';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

/** 归一化用户存的键位串，保证比较时大小写与空格一致 */
export function normalizeBinding(binding: string): string {
  return binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (/^ctrl$/i.test(p)) return 'Ctrl';
      if (/^alt$/i.test(p)) return 'Alt';
      if (/^shift$/i.test(p)) return 'Shift';
      if (/^space$/i.test(p)) return 'Space';
      if (/^esc(ape)?$/i.test(p)) return 'Esc';
      if (p === '?' || p === '/' || p.length > 1) return p;
      return p.toUpperCase();
    })
    .join('+');
}

export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  if (!binding) return false;
  return bindingOf(e) === normalizeBinding(binding);
}

/** 展示用：把 Ctrl 在 macOS 上显示成 ⌘（仅影响文案，匹配依旧按 Ctrl/Meta 处理） */
export function displayBinding(binding: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  return mac ? binding.replace(/Ctrl/g, '⌘') : binding;
}

function load(): Record<KeyAction, string> {
  const base = { ...DEFAULT_KEYMAP };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Record<KeyAction, string>>;
    for (const a of KEY_ACTIONS) {
      const v = saved[a.id];
      if (typeof v === 'string' && v.trim()) base[a.id] = normalizeBinding(v);
    }
  } catch {
    // 存的是坏 JSON（手改/localStorage 被清）：直接退回默认，不让快捷键整体失灵
  }
  return base;
}

function persist(map: Record<KeyAction, string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 无 localStorage（隐私模式）时仅本会话生效
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** 冲突检测：同一键位被两个动作占用时返回后者的 id */
export function findConflict(
  map: Record<KeyAction, string>,
  action: KeyAction,
  binding: string
): KeyAction | null {
  const nb = normalizeBinding(binding);
  for (const a of KEY_ACTIONS) {
    if (a.id === action) continue;
    if (normalizeBinding(map[a.id]) === nb) return a.id;
  }
  return null;
}

export function useKeymap() {
  const [keymap, setKeymapState] = useState<Record<KeyAction, string>>(load);

  useEffect(() => {
    const onChanged = () => setKeymapState(load());
    window.addEventListener(CHANGE_EVENT, onChanged);
    // 多窗口：localStorage 的 storage 事件不会在本窗口触发，但会传给另一个窗口
    window.addEventListener('storage', onChanged);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChanged);
      window.removeEventListener('storage', onChanged);
    };
  }, []);

  const setKey = useCallback((action: KeyAction, binding: string) => {
    setKeymapState((prev) => {
      const next = { ...prev, [action]: normalizeBinding(binding) };
      persist(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    const next = { ...DEFAULT_KEYMAP };
    persist(next);
    setKeymapState(next);
  }, []);

  return { keymap, setKey, reset };
}
