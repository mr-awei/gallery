import { useEffect, useRef } from 'react';
import { createDebounceQueue } from '../lib/debounce-queue';

/**
 * 设置页输入的合并提交：把「逐字符 onChange → 立刻打接口」改成 300ms 防抖。
 * - 连续输入只提交最后一次，多个字段的 patch 合并成一次请求（不会丢字段）；
 * - 提交串行化：前一个请求没回来不发下一个，避免旧响应回来覆盖新值（后发先至）；
 * - 卸载时若有未落盘的改动会补发一次，输完立刻关页面也不至于静默丢设置。
 * 合并逻辑在 lib/debounce-queue.ts（纯函数），有独立单测覆盖。
 */
export function useDebouncedCommit<T extends object>(
  commit: (patch: Partial<T>) => void | Promise<void>,
  delay = 300
) {
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const queueRef = useRef<ReturnType<typeof createDebounceQueue<T>> | null>(null);
  if (!queueRef.current) {
    queueRef.current = createDebounceQueue<T>((p) => commitRef.current(p));
  }
  const queue = queueRef.current;
  useEffect(() => () => queue.dispose(), [queue]);
  return {
    push: (p: Partial<T>) => queue.push(p, delay),
    flush: () => queue.flush(),
  };
}
