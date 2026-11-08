import { useEffect, useRef } from 'react';
import { subscribeEvents } from '../events';

/**
 * 任务进度订阅：SSE `job` 快照优先，SSE 断线/服务未推时才低频兜底轮询。
 *
 * 以前每个面板各自 800ms / 1s 打一次状态接口，设置页同时开几个面板就是请求风暴；
 * 现在服务端任务运行期间每 5s 推一次快照（空闲只在变化时推），前端：
 *  - 收到推送就更新 lastSeen，兜底轮询因此不会触发（SSE 正常时 0 个轮询请求）；
 *  - 连续 10s 没收到任何推送才拉一次接口；
 *  - 页面隐藏时完全不发请求，重新可见时补一次。
 */
export function useJobProgress(
  onSnapshot: (data: any) => void,
  poll: () => void | Promise<void>,
  enabled: boolean,
  fallbackMs = 10_000
) {
  const snapRef = useRef(onSnapshot);
  snapRef.current = onSnapshot;
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const lastSeen = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const delay = Math.max(5000, fallbackMs);
    const off = subscribeEvents('job', (data: any) => {
      lastSeen.current = Date.now();
      snapRef.current(data);
    });
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - lastSeen.current < delay) return;
      void pollRef.current();
    }, delay);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastSeen.current >= delay) void pollRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, fallbackMs]);
}
