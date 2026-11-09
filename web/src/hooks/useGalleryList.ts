import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api } from '../api';
import type { Filters, ImageItem } from '../types';

export const PAGE_SIZE = 48;

type Toast = (msg: string, kind?: 'info' | 'error') => void;

/**
 * 追加分页结果时按 id 去重。
 * offset 分页在导入期会整体后移：刚加载完第 2 页，前面又插进 30 张新图，
 * 第 3 页就会把第 2 页末尾那几张再返回一次。直接 concat 会让同一张图在网格里
 * 出现两次、React key 重复（卡片叠位、点击命中错的素材）。
 */
function mergeItems(prev: ImageItem[], next: ImageItem[]): ImageItem[] {
  const seen = new Set(prev.map((x) => x.id));
  const out = prev.slice();
  for (const it of next) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

/**
 * 图库列表：分页加载、请求代数（旧请求结果不得覆盖新结果）、
 * 「从大图定位回网格」的定点补载、手动刷新。
 *
 * filtersRef / folderIdRef 用 ref 读取而不是直接闭包取值：load 必须是稳定引用
 * （Gallery 被 memo 包住），而筛选条件又随时在变。
 */
export function useGalleryList({
  showToast,
  filtersRef,
  folderIdRef,
  refreshStats,
}: {
  showToast: Toast;
  filtersRef: MutableRefObject<Filters>;
  folderIdRef: MutableRefObject<number | null>;
  /** 稳定的取值器（统计 hook 在列表 hook 之后创建，用 ref 打通） */
  refreshStats: () => void;
}) {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  // 手动刷新序号：每次刷新自增，作为图片卡片的 key 之一，强制重挂载以清除
  // 「缩略图加载失败」的残留状态（否则卡片复用实例，刷新也无法恢复显示）
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [scrollTargetId, setScrollTargetId] = useState<number | null>(null);

  const totalRef = useRef(0);
  const pageRef = useRef(1);
  // 用户在深处浏览时来了新图：只提示一次，别反复把列表打回第 1 页
  const newAtTopRef = useRef(false);
  const reqId = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  // 退出大图后「定位回网格」的请求句柄：连续定位时取消上一次
  const revealAbort = useRef<AbortController | null>(null);

  const load = useCallback(
    async (page: number, reset: boolean) => {
      const id = ++reqId.current;
      // 切筛选 / 翻页时取消上一个还在路上的列表请求，避免旧结果占用连接与状态
      loadAbort.current?.abort();
      loadAbort.current = new AbortController();
      const signal = loadAbort.current.signal;
      setLoading(true);
      try {
        const res = folderIdRef.current
          ? await api.folderImages(folderIdRef.current, page, PAGE_SIZE, { signal })
          : await api.images(filtersRef.current, page, PAGE_SIZE, { signal });
        if (id !== reqId.current) return;
        setItems((prev) => (reset ? res.items : mergeItems(prev, res.items)));
        setTotal(res.total);
        totalRef.current = res.total;
        setHasMore(res.hasMore);
        // 页码只在成功后推进（由 loadMore 触发），失败不能把这一页永久跳过
        if (!reset) pageRef.current = page;
        else newAtTopRef.current = false;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return; // 被新请求取代，不算错误
        const msg = (err as Error).message;
        // 首屏请求失败必须清掉旧数据：否则切到「打不开的文件夹/筛选」后，
        // 界面仍显示上一个视图的图，用户对着错的内容继续批量操作
        if (id === reqId.current && reset) {
          setItems([]);
          setTotal(0);
          totalRef.current = 0;
          setHasMore(false);
        }
        showToast(msg);
      } finally {
        // 收起加载态要判代：旧请求被新请求 abort 后，它的 finally 仍会执行，
        // 若无条件 setLoading(false)，无限滚动的 IO 守卫会误判「空闲」而立刻追加
        // 下一页 —— 这个请求又把当前请求 abort 掉，其结果因代数过期被丢弃，
        // 就会丢一页数据。永久转圈不会发生：reqId.current 永远指向最新请求，
        // 它自己 settle 时一定会收尾。
        if (id === reqId.current) setLoading(false);
      }
    },
    [folderIdRef, filtersRef, showToast]
  );

  const loadMore = useCallback(() => {
    // 页码由 load() 在成功后提交：提前 +1 再请求，一旦失败这一页就被永久跳过，
    // 用户往下滚永远少一屏，且没有任何提示
    load(pageRef.current + 1, false);
  }, [load]);

  /**
   * 手动刷新：先把素材文件夹里尚未登记的图片补登记，再按当前筛选重拉第 1 页。
   * 只重读列表的话，用户往目录里放的新图永远进不了图库（曾被当成 P0）。
   */
  const refreshGallery = useCallback(async () => {
    pageRef.current = 1;
    setRefreshSeq((n) => n + 1);
    setRefreshing(true);
    try {
      const scan = await api.scanFolder().catch(() => null);
      await load(1, true);
      refreshStats();
      const saved = Number(scan?.saved) || 0;
      const dropped = Number(scan?.dropped) || 0;
      showToast(
        saved
          ? `已导入 ${saved} 张新图片${dropped ? `（${dropped} 张未通过尺寸/体积筛选）` : ''}`
          : `已刷新（当前筛选 ${totalRef.current} 张）`
      );
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [load, refreshStats, showToast]);

  /** 退出大图时：把图库列表补载到最后浏览的那张所在位置，并滚动过去 */
  const reveal = useCallback(
    async (id: number, pool: ImageItem[]) => {
      const pos = pool.findIndex((x) => x.id === id);
      if (pos < 0) return;
      // 该图已在已加载列表里（浏览范围没超出第一屏加载量）→ 直接滚动
      if (document.querySelector(`[data-image-id="${id}"]`)) {
        setScrollTargetId(id);
        return;
      }
      // 只请求目标页（必要时再加相邻一页），不再从第 1 页串行拉到底：
      // 在第 400 页的图上点「在网格中显示」以前要发 400 个请求，界面全程无反馈。
      const page = Math.max(1, Math.floor(pos / PAGE_SIZE) + 1);
      setLoading(true);
      const req = ++reqId.current;
      revealAbort.current?.abort();
      const ac = new AbortController();
      revealAbort.current = ac;
      try {
        const filters = filtersRef.current;
        let landed = page;
        let res = await api.images(filters, landed, PAGE_SIZE, { signal: ac.signal });
        if (req !== reqId.current) return;
        // 期间有新增导致列表整体后移：目标可能落到下一页，补查一次
        if (!res.items.some((x) => x.id === id) && landed * PAGE_SIZE < res.total) {
          landed += 1;
          res = await api.images(filters, landed, PAGE_SIZE, { signal: ac.signal });
          if (req !== reqId.current) return;
        }
        setItems(res.items);
        setTotal(res.total);
        totalRef.current = res.total;
        setHasMore((landed - 1) * PAGE_SIZE + res.items.length < res.total);
        pageRef.current = landed;
        setRefreshSeq((n) => n + 1);
        setScrollTargetId(id);
      } catch (err) {
        // 主动 abort 不算错误，别弹「网络请求失败」吓用户
        if ((err as Error)?.name !== 'AbortError') showToast((err as Error).message);
      } finally {
        if (req === reqId.current) setLoading(false);
      }
    },
    [filtersRef, showToast]
  );

  // 补载完成后等卡片渲染出来，再滚动居中（节点尚未渲染时重试几帧）
  useEffect(() => {
    if (!scrollTargetId) return;
    let tries = 0;
    const tick = () => {
      const el = document.querySelector(`[data-image-id="${scrollTargetId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        setScrollTargetId(null);
        return;
      }
      if (++tries < 30) requestAnimationFrame(tick);
      else setScrollTargetId(null);
    };
    requestAnimationFrame(tick);
  }, [scrollTargetId]);

  return {
    items,
    setItems,
    total,
    setTotal,
    totalRef,
    hasMore,
    setHasMore,
    loading,
    setLoading,
    pageRef,
    newAtTopRef,
    refreshSeq,
    setRefreshSeq,
    refreshing,
    load,
    loadMore,
    refreshGallery,
    reveal,
  };
}
