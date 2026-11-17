import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * 侧栏宽度：右缘把手拖拽调整并持久化，双击恢复默认。
 * 宽度写入 --sidebar-w 变量（.sidebar 的 width/flex-basis 都引用它），
 * 窄屏媒体查询直接覆盖 width，不受内联变量影响。
 */
export const DEFAULT_SIDEBAR_W = 232;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 440;
const STORAGE_KEY = 'tuku:sidebar-w';

export function useSidebarWidth() {
  const [sidebarW, setSidebarW] = useState(() => {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : DEFAULT_SIDEBAR_W;
  });
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);

  // 由位移直接算当前宽度——不依赖 state/ref 的异步更新时序，up 时也能取到准确终值
  const widthAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = resizeRef.current;
    if (!st) return sidebarW;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, st.startW + e.clientX - st.startX));
  };

  const onResizerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startW: sidebarW };
    e.currentTarget.setPointerCapture(e.pointerId); // 后续 move/up 都派发给把手，滑出也不丢
    document.body.classList.add('sidebar-resizing');
  };

  const onResizerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    setSidebarW(widthAt(e));
  };

  const onResizerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    const finalW = widthAt(e); // 先取值再清状态
    resizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove('sidebar-resizing');
    setSidebarW(finalW);
    localStorage.setItem(STORAGE_KEY, String(finalW));
  };

  /** 双击把手：恢复默认宽度 */
  const resetWidth = useCallback(() => {
    setSidebarW(DEFAULT_SIDEBAR_W);
    localStorage.setItem(STORAGE_KEY, String(DEFAULT_SIDEBAR_W));
  }, []);

  return { sidebarW, DEFAULT_SIDEBAR_W, onResizerDown, onResizerMove, onResizerUp, resetWidth };
}
