import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api, quiet } from '../api';
import type { Filters, ImageItem } from '../types';

export type LightboxState = { items: ImageItem[]; index: number } | null;

/**
 * 大图（灯箱）导航池。
 *
 * 打开大图时后台把「当前筛选下的全量列表」补进导航池：平时只加载第一页（48 张），
 * 大图浏览若只在这页里导航，数量和范围都会误导。万级库 ≈ 数百页，串行逐页拉会打出
 * 70+ 连发请求，所以延迟 1.5s（让大图和缩略图先加载）+ 并发 5 路分块拉取，
 * 每页到齐即合并，失败页直接放弃补全。
 */
export function useLightbox({ filtersRef }: { filtersRef: MutableRefObject<Filters> }) {
  const [lb, setLb] = useState<LightboxState>(null);
  // 大图导航池补全代数：期间用户再次打开大图 / 关闭后，旧补全回调不得覆盖新池
  const lbFillSeq = useRef(0);
  // 补全请求的取消句柄：关闭大图 / 重开必须 abort，否则关掉后几百个请求还在继续跑
  const lbFillAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (lb) return;
    lbFillAbort.current?.abort();
    lbFillAbort.current = null;
  }, [lb]);

  const openItem = useCallback(
    (item: ImageItem, pool?: ImageItem[], full = false) => {
      // 重开大图：上一轮补全立刻作废，别让旧请求稍后改写列表
      lbFillAbort.current?.abort();
      lbFillAbort.current = null;
      const list = pool && pool.some((x) => x.id === item.id) ? pool : [item];
      const index = list.findIndex((x) => x.id === item.id);
      setLb({ items: list, index: Math.max(0, index) });
      if (!full || !pool) return;

      const seq = ++lbFillSeq.current;
      const ac = new AbortController();
      lbFillAbort.current = ac;
      const { signal } = ac;
      const filters = filtersRef.current; // 快照：补全期间用户切筛选时保持页间一致
      const replacePool = (all: ImageItem[]) => {
        setLb((prev) => {
          if (!prev || seq !== lbFillSeq.current) return prev; // 已关闭 / 已重开大图
          const curId = prev.items[prev.index]?.id;
          const nextIndex = Math.max(0, all.findIndex((x) => x.id === curId));
          return { items: all, index: nextIndex };
        });
      };
      (async () => {
        await new Promise((r) => setTimeout(r, 1500));
        if (signal.aborted || seq !== lbFillSeq.current) return;
        const first = await api.images(filters, 1, 120, { signal });
        if (signal.aborted || seq !== lbFillSeq.current) return;
        if (first.total <= list.length) return; // 本来就是全量，无需替换
        // 上限 200 页（24000 张）：更大的库也只补一段连续前缀，
        // 不能因为「打开了张图」就打出上千个请求
        const pages = Math.min(Math.ceil(first.total / 120), 200);
        const results: (ImageItem[] | null)[] = new Array(pages).fill(null);
        results[0] = first.items;
        if (pages === 1) return replacePool(first.items);
        let next = 2;
        const worker = async () => {
          while (next <= pages) {
            // 循环体内也要检查：只在最后检查的话，关闭大图后已排队的页仍会全部打出去
            if (signal.aborted || seq !== lbFillSeq.current) return;
            const p = next++;
            try {
              results[p - 1] = (await api.images(filters, p, 120, { signal })).items;
            } catch {
              return; // 一页失败（含被 abort）就放弃补全，保留已有池
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(5, pages - 1) }, worker));
        if (signal.aborted || seq !== lbFillSeq.current || results.some((r) => !r)) return;
        replacePool(results.flat() as ImageItem[]);
      })().catch(quiet);
    },
    [filtersRef]
  );

  return { lb, setLb, openItem };
}
