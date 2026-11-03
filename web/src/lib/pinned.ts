import { useCallback, useEffect, useState } from 'react';

/**
 * 「工具栏自定义」的持久化：每处工具栏存一份 key 列表到 localStorage。
 * 存 localStorage 而不是库设置，是因为这是纯个人界面偏好，
 * 换图库/换电脑后按设备各自适应屏幕大小更合理。
 */
const PREFIX = 'gem.toolbar.';

export function loadPinned(name: string, defaults: string[]): string[] {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    if (!raw) return defaults;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return defaults;
    const clean = arr.filter((x): x is string => typeof x === 'string');
    // 全部被删掉也是合法状态（用户就是想把菜单项都塞回「更多」）
    return clean;
  } catch {
    return defaults;
  }
}

export function savePinned(name: string, keys: string[]): void {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(keys));
  } catch {
    /* 隐私模式 / 配额满：忽略即可，退回默认 */
  }
}

/** pinned 列表 + 写穿透；同一个 key 在多个组件里用到时用事件广播同步 */
const listeners = new Set<() => void>();

export function usePinnedActions(name: string, defaults: string[]) {
  const [pinned, setPinned] = useState<string[]>(() => loadPinned(name, defaults));

  useEffect(() => {
    const sync = () => setPinned(loadPinned(name, defaults));
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
    // defaults 是字面量数组，比较长度 + 内容即可，避免每次渲染重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, defaults.join('|')]);

  const update = useCallback(
    (keys: string[]) => {
      savePinned(name, keys);
      setPinned(keys);
      listeners.forEach((fn) => fn());
    },
    [name]
  );

  return [pinned, update] as const;
}
