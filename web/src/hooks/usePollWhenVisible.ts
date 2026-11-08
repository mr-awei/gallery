import { useEffect, useRef } from 'react';

/**
 * 低频兜底轮询：页面隐藏时完全不发请求，重新可见时补一次；间隔下限 5s。
 * 用于那些服务端没有专门 SSE 事件的列表（如任务历史 / 操作日志）。
 */
export function usePollWhenVisible(fn: () => void, delayMs = 5000, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const delay = Math.max(5000, delayMs);
    const run = () => {
      if (!document.hidden) fnRef.current();
    };
    const timer = window.setInterval(run, delay);
    const onVisible = () => {
      if (!document.hidden) fnRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, delayMs]);
}
