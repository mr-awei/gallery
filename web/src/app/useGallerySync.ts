import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { View } from '../types';
import type { LoadGallery } from './types';

type Options = {
  queryKey: string;
  load: LoadGallery;
  refreshStats: () => void;
  pageRef: MutableRefObject<number>;
  contentRef: MutableRefObject<HTMLDivElement | null>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  view: View;
  activeLibId: number | null;
};

/**
 * 内容区与数据源的同步效应（五个，顺序与拆分前一致）：
 * 换筛选/文件夹就回顶重载并清空选择 → 量页头高度给页内吸顶用 → 换库清选择
 * → 从别的视图回图库时对账一次 → 窗口重新获得焦点补刷统计。
 */
export function useGallerySync({
  queryKey,
  load,
  refreshStats,
  pageRef,
  contentRef,
  setSelected,
  view,
  activeLibId,
}: Options) {
  useEffect(() => {
    pageRef.current = 1;
    // 重置数据源（筛选 / 文件夹 / 收藏切换）时滚回顶部，避免虚拟窗口错位
    contentRef.current?.scrollTo({ top: 0 });
    // 选中集合必须跟着数据源一起清空：批量删除直接取 [...selected]，
    // 不清空的话「选中 30 张 → 切到另一个文件夹 → 点删除」会删掉用户看不见的另一批图
    setSelected(new Set());
    load(1, true);
  }, [queryKey, load, pageRef, contentRef, setSelected]);

  /* 页头现在常驻吸顶（styles/components.css 的 .page-head 规则）。页内自己也有吸顶元素
   * 的页面（设置页左栏 / 整理页任务横幅 / 教程页分类）得从页头下沿开始吸，否则会被页头
   * 盖住。页头高度随窗口宽度换行变化，写死 px 一定错位 —— 实测高度写成 --head-h 给它们用。
   *
   * 数值要减掉 .content 的 padding-top：sticky 的停靠线是从滚动容器的内容框算的，
   * 页头自己用负 top 顶到 padding 之上贴着容器上沿，所以「页头下沿」在别人的坐标里
   * 等于 页头高度 - padding-top。页面是 lazy 加载的，切页那一帧还查不到页头，重试几帧。 */
  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    host.style.setProperty('--head-h', '0px');
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    let timer = 0;
    /** 页头挂上就开始量；已量过返回 true */
    const attach = () => {
      const head = host.querySelector<HTMLElement>('.page-head, .tut-head');
      if (!head) return false;
      const padTop = parseFloat(getComputedStyle(host).paddingTop) || 0;
      const apply = () =>
        host.style.setProperty(
          '--head-h',
          `${Math.max(0, Math.round(head.getBoundingClientRect().height - padTop))}px`
        );
      apply();
      ro?.disconnect();
      ro = new ResizeObserver(apply);
      ro.observe(head);
      mo?.disconnect();
      mo = null;
      return true;
    };
    if (!attach()) {
      // 页面是 lazy 加载的，页头要等分包到位才挂上：监听 DOM 变化，再用定时器兜底
      mo = new MutationObserver(() => {
        if (attach()) {
          window.clearTimeout(timer);
          timer = 0;
        }
      });
      mo.observe(host, { childList: true, subtree: true });
      timer = window.setTimeout(() => {
        attach();
        mo?.disconnect();
        mo = null;
      }, 5000);
    }
    return () => {
      window.clearTimeout(timer);
      mo?.disconnect();
      ro?.disconnect();
    };
  }, [view, contentRef]);

  // 换库同理：旧库的 id 在新库里指向别的图
  useEffect(() => {
    setSelected(new Set());
  }, [activeLibId, setSelected]);

  /**
   * 从别的视图（采集 / 任务中心 / 设置）回到列表时对账一次。
   * queryKey 没变，上面那个效应不会重跑 —— 采集刚入库的图就永远不出现，
   * 用户只能手动点刷新（这正是「列表不自动刷新」的根因之一）。
   */
  const prevViewRef = useRef(view);
  useEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = view;
    if (view !== 'gallery' || prev === 'gallery') return;
    pageRef.current = 1;
    load(1, true);
    refreshStats();
  }, [view, load, refreshStats, pageRef]);

  // 窗口重新获得焦点（托盘恢复 / 多窗口来回切）时补一次刷新，防止错过推送
  useEffect(() => {
    const onWake = () => refreshStats();
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [refreshStats]);
}
