import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ImageItem } from '../types';

/**
 * 绝对定位瀑布流 + 窗口虚拟滚动。
 *
 * 替换原先的 CSS `column-count` 瀑布流：多列布局会把 DOM 按列重排，
 * 列数变化或插入新项时整个列的内容重新分配，滚动位置随之跳动（整列闪动）；
 * 而且几百上千张卡片的 img 节点全量常驻，长图库滚动明显卡顿。
 *
 * 这里改为：
 * 1. JS 显式计算每张卡片的最短列坐标（绝对定位），卡片位置只与自身及
 *    之前的卡片有关，插入新项不再引发整列 DOM 位移；
 * 2. 只渲染视口上下 OVERSCAN 像素范围内的卡片（按卡片底边二分定位区间），
 *    万级图库常驻 DOM 数恒定，滚动只触发窗口内外几十张卡片的增删。
 */

const GAP = 14;
/** 瀑布流列宽基数（与旧 CSS 断点 4/3/2 列的视觉密度一致） */
const COL_TARGET = 250;
/** grid 模式列宽（对应旧 CSS minmax(230px, 1fr)） */
const GRID_COL_MIN = 230;
/** 视口外预渲染余量（px）：覆盖竖版长卡片，避免滚动边缘闪现 */
const OVERSCAN = 900;

interface Props {
  items: ImageItem[];
  renderItem: (item: ImageItem) => React.ReactNode;
  /** 'masonry' = 原比例瀑布流；'grid' = 3:4 统一裁切网格 */
  mode?: 'masonry' | 'grid';
  /** 缩略图尺寸（列宽 px，Eagle 的缩略图滑块），缺省用各模式的默认密度 */
  colWidth?: number;
  /** 变化时重测布局。注意：卡片不再因此重挂载（key 只用图片 id）——
   * 清除加载失败态的需求由卡片层通过 resetKey 实现，避免整页图片重新请求与闪烁 */
  layoutKey?: string | number;
  /** 视口内卡片变化时回调（已 debounce）：用来把这几张的灯箱预览图插队预热。
   *  服务端整页按顺序预取，用户滚到页尾时那张往往还没轮到，点开就要现做。 */
  onVisibleIds?: (ids: number[]) => void;
}

interface Pos {
  x: number;
  y: number;
  w: number;
  h: number;
}

function columnCount(width: number, mode: 'masonry' | 'grid', colWidth?: number) {
  if (colWidth && colWidth > 0) {
    // 尺寸滑块：按目标列宽算列数，最少 1 列、最多 12 列
    return Math.max(1, Math.min(12, Math.floor((width + GAP) / (colWidth + GAP))));
  }
  if (mode === 'grid') {
    return Math.max(2, Math.floor((width + GAP) / (GRID_COL_MIN + GAP)));
  }
  if (width >= 1180) return 4;
  if (width >= 860) return 3;
  return 2;
}

export default function MasonryGrid({
  items,
  renderItem,
  mode = 'masonry',
  colWidth,
  layoutKey,
  onVisibleIds,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  // 视口高度给初值：为 0 时虚拟窗口算不出可见区间，数据到位也不会渲染任何卡片
  // （表现为「有数据但整页空白 + 底部已经到底啦」）
  const [viewH, setViewH] = useState(() => (typeof window === 'undefined' ? 0 : window.innerHeight));
  const scrollElRef = useRef<HTMLElement | null>(null);
  const docTopRef = useRef(0);
  const rafRef = useRef(0);

  /** 探测滚动容器：向上找 overflow-y 滚动的祖先（弹窗内嵌场景），否则整页滚动 */
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    let scroller: HTMLElement | null = null;
    let node: HTMLElement | null = wrap.parentElement;
    while (node && node !== document.body) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === 'auto' || oy === 'scroll') {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }
    /**
     * 探测不到时必须沿用已知容器，绝不能退回「整页滚动」：
     * 灯箱把 .content 临时改成 overflow:hidden，这一刻 overflowY = hidden → 探测失败，
     * 若把 scroller 置空，之后所有 scrollTop 都读成 window.scrollY（恒 0），
     * 虚拟窗口就永远算在文档顶部 —— 用户看到的就是「退出预览后整页空白，
     * 非要再滑一下才恢复」。
     */
    if (!scroller && scrollElRef.current?.isConnected) scroller = scrollElRef.current;
    scrollElRef.current = scroller;
    if (scroller) {
      docTopRef.current = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    } else {
      docTopRef.current = rect.top + window.scrollY;
    }
  }, []);

  // 容器宽度变化时重建布局（ResizeObserver，比 window resize 更精确地覆盖弹窗宽度动画）
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      setWidth(wrap.clientWidth);
      measure();
    });
    ro.observe(wrap);
    setWidth(wrap.clientWidth);
    measure();
    return () => ro.disconnect();
  }, [measure]);

  /**
   * 布局签名：位置只与「顺序 + 宽高」有关。
   * 点收藏 / 改标题 / 重新选中都会让 items 换身份但几何完全没变，
   * 以前会白算一遍几万个坐标再排一次序（万级图库一次 10~20ms）。
   * itemsRef 保证签名不变时拿到的是最新数组（同几何 = 同布局，索引照样对得上）。
   */
  const layoutSig = useMemo(
    () => items.map((it) => `${it.id}:${it.width}x${it.height}`).join('|'),
    [items]
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // items / 布局键变化后总高度改变，重测文档偏移
  useLayoutEffect(() => {
    measure();
  }, [layoutSig, layoutKey, measure]);

  // 数据到位后延迟重测一次：切页/窗口刚恢复时首帧尺寸可能尚未稳定，
  // 会让虚拟窗口算出空区间（数据在、界面空白）
  useEffect(() => {
    const t = window.setTimeout(() => {
      measure();
      const scroller = scrollElRef.current;
      setViewH(scroller ? scroller.clientHeight : window.innerHeight);
      setScrollTop(scroller ? scroller.scrollTop : window.scrollY);
    }, 120);
    return () => window.clearTimeout(t);
  }, [layoutSig, layoutKey, measure]);

  useEffect(() => {
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const scroller = scrollElRef.current;
        if (scroller) {
          setScrollTop(scroller.scrollTop);
          setViewH(scroller.clientHeight);
        } else {
          setScrollTop(window.scrollY);
          setViewH(window.innerHeight);
        }
      });
    };
    /**
     * 用 capture 监听 document：scroll 不冒泡，但捕获阶段能拿到任意滚动容器的滚动，
     * 包括「容器被遮罩临时改成 overflow:hidden、重绑时探测不到」的时段。
     * 只绑一次，不随容器变化失效。
     */
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /**
   * 每次渲染后跟真实滚动位置对一次账。
   * 遮罩关闭、虚拟列表重算、浏览器夹住滚动位置这些时刻 scroll 事件可能丢，
   * 事件一旦丢，state 与真实位置就会长期不一致（空白页），而修好读取路径后
   * 这里能在一帧内自愈，不需要用户再滑一下。
   */
  useLayoutEffect(() => {
    const scroller = scrollElRef.current;
    // 灯箱锁滚动期间（overflow:hidden）浏览器可能把 scrollTop 夹到 0，
    // 这时的值不是用户真实意图，跳过校正，等关闭后由 Lightbox 写回并派发 scroll
    if (scroller && getComputedStyle(scroller).overflowY === 'hidden') return;
    const top = scroller ? scroller.scrollTop : window.scrollY;
    const vh = scroller ? scroller.clientHeight : window.innerHeight;
    if (Math.abs(top - scrollTop) > 2) setScrollTop(top);
    if (Math.abs(vh - viewH) > 2) setViewH(vh);
    // 必须有依赖数组：没有它每次渲染都会 getComputedStyle + 读 scrollTop/clientHeight，
    // 与滚动 rAF 里的 setState 形成「渲染 → 量布局 → setState」循环，千张图滚动掉帧。
    // layoutSig 变化（数据/宽度变化）时仍对一次账，保住「事件丢了也能自愈」的意图。
  }, [scrollTop, viewH, layoutSig]);

  /**
   * 布局：每张卡片的绝对坐标 + 容器总高。
   * 宽度未测到（width=0）时用「窗口宽度 - 侧栏」兜底 —— 此前挂载时 items 为空、
   * 组件 return null 导致 ref 缺失，宽度测量整个生命周期只跑一次且被跳过，
   * 数据到位后 width 恒为 0、虚拟窗口永远算不出卡片，图库整页空白（P0）。
   */
  const effWidth = width || (typeof window === 'undefined' ? 0 : Math.max(320, window.innerWidth - 280));

  /**
   * 布局签名：位置只与「顺序 + 宽高」有关。
   * 点收藏 / 改标题 / 重新选中都会让 items 换身份但几何完全没变，
   * 以前会白算一遍几万个坐标再排一次序（万级图库一次 10~20ms，且每帧重排）。
   * itemsRef 保证签名不变时拿到的是最新数组（同几何 = 同布局，索引照样对得上）。
   */
  const { positions, totalHeight, sortedByBottom } = useMemo(() => {
    if (!effWidth) return { positions: [] as Pos[], totalHeight: 0, sortedByBottom: [] as number[] };
    const cols = columnCount(effWidth, mode, colWidth);
    const colW = Math.floor((effWidth - GAP * (cols - 1)) / cols);
    const colHeights = new Array(cols).fill(0);
    const pos: Pos[] = itemsRef.current.map((it) => {
      const w0 = it.width > 0 ? it.width : 3;
      const h0 = it.height > 0 ? it.height : 4;
      const h = mode === 'grid' ? Math.round(colW * (4 / 3)) : Math.round(colW * (h0 / w0));
      let best = 0;
      for (let c = 1; c < cols; c++) if (colHeights[c] < colHeights[best]) best = c;
      const p = { x: best * (colW + GAP), y: colHeights[best], w: colW, h };
      colHeights[best] += h + GAP;
      return p;
    });
    const total = Math.max(0, Math.max(...colHeights) - GAP);
    // 供虚拟窗口二分：按卡片底边排序的索引
    const byBottom = pos.map((p, i) => i).sort((a, b) => pos[a].y + pos[a].h - (pos[b].y + pos[b].h));
    return { positions: pos, totalHeight: total, sortedByBottom: byBottom };
  }, [layoutSig, effWidth, mode, colWidth]);

  /** 可见区间（含 OVERSCAN）：按卡片底边在排序数组上二分 */
  const visible = useMemo(() => {
    if (!positions.length) return [] as number[];
    // 视口高度/文档偏移还没测到（切页、窗口恢复瞬间）时，先渲染前一批卡片，
    // 绝不让「有数据却一片空白」出现
    if (!viewH) return positions.map((_, i) => i).slice(0, 24);
    const top = docTopRef.current + scrollTop - OVERSCAN;
    const bottom = docTopRef.current + scrollTop + viewH + OVERSCAN;
    let lo = 0;
    let hi = sortedByBottom.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const idx = sortedByBottom[mid];
      if (positions[idx].y + positions[idx].h < top) lo = mid + 1;
      else hi = mid;
    }
    const out: number[] = [];
    for (let k = lo; k < sortedByBottom.length; k++) {
      const idx = sortedByBottom[k];
      if (positions[idx].y > bottom) break;
      out.push(idx);
    }
    // 偏移测量失效（二分把所有卡片排除）时兜底：按滚动量就近取一批，
    // 不再无条件回到文档顶部（那会让已滚到下方的用户看到一片空白）
    if (out.length) return out;
    const nearTop = scrollTop - OVERSCAN;
    const nearBottom = scrollTop + (viewH || 800) + OVERSCAN;
    const near: number[] = [];
    for (let i = 0; i < positions.length && near.length < 40; i++) {
      if (positions[i].y >= nearTop && positions[i].y <= nearBottom) near.push(i);
    }
    return near.length ? near : positions.map((_, i) => i).slice(0, 24);
  }, [positions, sortedByBottom, scrollTop, viewH]);

  // 可见区变化（滚动停止 700ms）后上报一次，让服务端优先预取这几张的预览图
  const visibleIds = visible.map((i) => items[i]?.id).filter((id): id is number => typeof id === 'number');
  const visibleSig = visibleIds.join(',');
  useEffect(() => {
    if (!onVisibleIds || !visibleSig) return;
    const ids = visibleSig.split(',').map(Number);
    const t = window.setTimeout(() => onVisibleIds(ids), 700);
    return () => window.clearTimeout(t);
  }, [visibleSig, onVisibleIds]);

  // 注意：items 为空时也必须渲染容器 —— 此前在这里 return null 会让 ref 缺失，
  // 挂载期唯一一次宽度测量被跳过且永不重试，是「数据到位后整页空白」的根因（P0）
  return (
    <div
      className="masonry-js"
      data-tour="gallery-grid"
      style={{ position: 'relative', height: totalHeight || undefined }}
      ref={wrapRef}
    >
      {visible.map((i) => {
        const p = positions[i];
        return (
          <div
            /* key 必须用主键 id：库中可能存在同 path 的多条记录（文件被重复导入），
             * 用 path 当 key 会冲突，React DOM 复用错乱 → 多张卡叠在同一坐标 */
            key={items[i].id ?? items[i].path}
            className="m-cell"
            style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h }}
          >
            {renderItem(items[i])}
          </div>
        );
      })}
    </div>
  );
}
