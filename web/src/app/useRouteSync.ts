import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { buildRoute, parseRoute, sameRoute, type RouteState } from '../lib/route';
import type { Filters, View } from '../types';

type Options = {
  initialRoute: RouteState;
  view: View;
  filters: Filters;
  folderId: number | null;
  setView: Dispatch<SetStateAction<View>>;
  setFilters: Dispatch<SetStateAction<Filters>>;
  setFolderId: Dispatch<SetStateAction<number | null>>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
};

/**
 * URL ←→ 状态双向同步（两个 effect，顺序与拆分前一致）。
 * 切视图（侧栏点导航）推一条历史，可以后退回来；改筛选只 replace 当前条，
 * 否则每敲一个字都会塞一条历史，后退键要按几十次才回得去。
 */
export function useRouteSync({
  initialRoute,
  view,
  filters,
  folderId,
  setView,
  setFilters,
  setFolderId,
  setSelected,
}: Options) {
  const lastRouteRef = useRef<RouteState>(initialRoute);

  useEffect(() => {
    const next: RouteState = { view, filters, folderId };
    if (sameRoute(lastRouteRef.current, next)) return;
    const qs = buildRoute(view, filters, folderId);
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    try {
      if (lastRouteRef.current.view !== view) {
        window.history.pushState({ tukuRoute: true }, '', url);
      } else {
        window.history.replaceState({ tukuRoute: true }, '', url);
      }
    } catch {
      /* file:// 或受限环境下改不了地址栏，界面照常工作 */
    }
    lastRouteRef.current = next;
  }, [view, filters, folderId]);

  /* 浏览器后退 / 前进：把地址栏里的状态搬回界面（列表由 queryKey 效应自动重载） */
  useEffect(() => {
    const onPop = () => {
      const r = parseRoute(window.location.search);
      lastRouteRef.current = r;
      setFolderId(r.folderId);
      setFilters(r.filters);
      setView(r.view);
      setSelected(new Set());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
