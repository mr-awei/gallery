import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ImageItem } from '../types';
import {
  type LayoutSpec,
  type MasonryLayout,
  emptyLayout,
  extendLayout,
  firstIndices,
  geometrySig,
  visibleRange,
} from '../lib/masonryLayout';
import i18n from '../i18n';

/**
 * 绝对定位瀑布流 + 窗口虚拟滚动。
 *
 * 替换原先的 CSS `column-count` 瀑布流：多列布局会把 DOM 按列重排，
 * 列数变化或插入新项时整个列的内容重新分配，滚动位置随之跳动（整列闪动）；
 * 而且几百上千张卡片的 img 节点全量常驻，长图库滚动明显卡顿。
 *
 * 这里改为：
 * 1. 坐标计算在 lib/masonryLayout.ts 里用 Float64Array 顺序写入，卡片位置只与
 *    自身及之前的卡片有关，插入新项不再引发整列 DOM 位移；
 * 2. 只渲染视口上下 OVERSCAN 像素范围内的卡片（按底边分桶索引定位），
 *    万级图库常驻 DOM 数恒定，滚动只触发窗口内外几十张卡片的增删；
 * 3. 分页追加只算新增项（增量布局），滚动不重排序，追加不重算全库。
 */

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
  /**
   * roving tabindex：整块网格只留一个 Tab 停点（当前活动格），其余卡片 -1。
   * 不开时卡片各自 tabIndex=0，按 Tab 会逐张走完整库——几万张时等于不可用。
   * 方向键在格子间移动的落点由 activeIdx 记录，滚出视口后停点自动交给可见区第一张。
   */
  roving?: boolean;
}


export default function MasonryGrid({
  items,
  renderItem,
  mode = 'masonry',
  colWidth,
  layoutKey,
  onVisibleIds,
  roving = false,
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
  /** roving tabindex 的「当前活动格」；-1 表示还没进过网格 */
  const [activeIdx, setActiveIdx] = useState(-1);

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
  const layoutSig = useMemo(() => geometrySig(items), [items]);
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
   * 布局：几何参数或数据变化时才重算。
   * 分页追加（图库是每次 48 张）走 extendLayout 的增量路径 —— 只算新增的那些，
   * 已经布局好的几万张既不重算坐标也不重新排序（此前每追加一页就全量重排一次）。
   * 顺序变化 / 某张图重新探测了尺寸会退回全量重建，坐标不会错位。
   */
  const layoutRef = useRef<MasonryLayout | null>(null);
  const layout = useMemo(() => {
    const spec: LayoutSpec = { effWidth, mode, colWidth };
    const next = effWidth ? extendLayout(layoutRef.current, itemsRef.current, spec) : emptyLayout(spec);
    layoutRef.current = next;
    return next;
  }, [layoutSig, effWidth, mode, colWidth]);

  /** 可见区间（含 OVERSCAN）：走底边分桶索引，只碰与视口相交的桶 */
  const visible = useMemo(() => {
    if (!layout.count) return [] as number[];
    // 视口高度/文档偏移还没测到（切页、窗口恢复瞬间）时，先渲染前一批卡片，
    // 绝不让「有数据却一片空白」出现
    if (!viewH) return firstIndices(layout, 24);
    const top = docTopRef.current + scrollTop - OVERSCAN;
    const bottom = docTopRef.current + scrollTop + viewH + OVERSCAN;
    const out = visibleRange(layout, top, bottom);
    // 偏移测量失效（把所有卡片排除）时兜底：按滚动量就近取一批，
    // 不再无条件回到文档顶部（那会让已滚到下方的用户看到一片空白）
    if (out.length) return out;
    const near = visibleRange(layout, scrollTop - OVERSCAN, scrollTop + (viewH || 800) + OVERSCAN);
    return near.length ? near : firstIndices(layout, 24);
  }, [layout, scrollTop, viewH]);

  /**
   * 把焦点移到第 idx 张卡。目标可能因虚拟化尚未挂载，
   * 所以先把它滚进窗口、下一帧再聚焦（找不到就再等一帧）。
   */
  const focusIndex = useCallback(
    (idx: number) => {
      const wrap = wrapRef.current;
      if (!wrap || idx < 0 || idx >= layout.count) return;
      const h = layout.hs[idx];
      const scroller = scrollElRef.current;
      const top = docTopRef.current + layout.ys[idx];
      if (scroller) {
        const rel = top - scroller.scrollTop;
        if (rel < 0 || rel > scroller.clientHeight - h) {
          scroller.scrollTop = Math.max(0, top - 80);
        }
      } else if (top < window.scrollY || top > window.scrollY + window.innerHeight - h) {
        window.scrollTo(0, Math.max(0, top - 80));
      }
      let tries = 0;
      const tick = () => {
        const cell = wrap.querySelector<HTMLElement>(`.m-cell[data-idx="${idx}"]`);
        const card = cell?.querySelector<HTMLElement>('[data-image-id]') || cell;
        if (card) {
          card.focus({ preventScroll: true });
          return;
        }
        if (tries++ < 4) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [layout]
  );

  /** 方向键导航：上下走同列，左右换相邻列并取纵坐标最近的一张 */
  const moveFocus = useCallback(
    (from: number, dir: 'left' | 'right' | 'up' | 'down') => {
      if (from < 0 || from >= layout.count) return;
      const curY = layout.ys[from];
      const curCol = layout.colsOf[from];
      const col = layout.byCol[curCol] || [];
      let next = -1;
      if (dir === 'up' || dir === 'down') {
        if (dir === 'up') {
          for (let k = col.length - 1; k >= 0; k -= 1) {
            if (layout.ys[col[k]] < curY - 1) {
              next = col[k];
              break;
            }
          }
        } else {
          for (let k = 0; k < col.length; k += 1) {
            if (layout.ys[col[k]] > curY + 1) {
              next = col[k];
              break;
            }
          }
        }
      } else {
        const targetCol = layout.byCol[curCol + (dir === 'left' ? -1 : 1)];
        if (targetCol) {
          let bestD = Infinity;
          for (const i of targetCol) {
            const d = Math.abs(layout.ys[i] - curY);
            if (d < bestD) {
              bestD = d;
              next = i;
            }
          }
        }
      }
      if (next >= 0) focusIndex(next);
    },
    [layout, focusIndex]
  );

  /**
   * 网格键盘：卡片本身已有 Enter / Space / F / D，这里补上「在格子之间走」。
   * 之前只能在卡片间 Tab 逐张跳，万级图库根本走不动，读屏与纯键盘用户没有可用路径。
   */
  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const key = e.key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End')
        return;
      const cell = (e.target as HTMLElement | null)?.closest?.('.m-cell') as HTMLElement | null;
      const from = Number(cell?.dataset.idx);
      if (!cell || !Number.isInteger(from)) return;
      e.preventDefault();
      if (key === 'Home') focusIndex(0);
      else if (key === 'End') focusIndex(layout.count - 1);
      else moveFocus(from, key === 'ArrowLeft' ? 'left' : key === 'ArrowRight' ? 'right' : key === 'ArrowUp' ? 'up' : 'down');
    },
    [focusIndex, moveFocus, layout.count]
  );

  // 可见区变化（滚动停止 700ms）后上报一次，让服务端优先预取这几张的预览图
  const visibleIds = visible.map((i) => items[i]?.id).filter((id): id is number => typeof id === 'number');
  const visibleSig = visibleIds.join(',');
  useEffect(() => {
    if (!onVisibleIds || !visibleSig) return;
    const ids = visibleSig.split(',').map(Number);
    const t = window.setTimeout(() => onVisibleIds(ids), 700);
    return () => window.clearTimeout(t);
  }, [visibleSig, onVisibleIds]);

  /**
   * Tab 停点：活动格还在虚拟窗口内就用它，滚出窗口后交给可见区第一张。
   * 在渲染期算而不是用 effect 同步 —— 否则每滚一帧都要 setState 一次，
   * 大库滚动时正好和虚拟窗口自身的重渲染撞在一起。
   */
  const tabStop = roving && visible.length ? (visible.includes(activeIdx) ? activeIdx : visible[0]) : -1;

  // 注意：items 为空时也必须渲染容器 —— 此前在这里 return null 会让 ref 缺失，
  // 挂载期唯一一次宽度测量被跳过且永不重试，是「数据到位后整页空白」的根因（P0）
  return (
    <div
      className="masonry-js"
      data-tour="gallery-grid"
      /* 不用 role=grid：瀑布流的卡片位置与行列无关，硬套 gridcell 反而让读屏按行播报错位。
         卡片自身是 role=button，这里只补一句整体说明。 */
      aria-label={roving ? i18n.t('kb4082429') : undefined}
      style={{ position: 'relative', height: layout.totalHeight || undefined }}
      onKeyDown={onGridKeyDown}
      onFocus={
        roving
          ? (e) => {
              // focus 会冒泡（等价 focusin）：点选/方向键/程序聚焦都能同步活动格
              const cell = (e.target as HTMLElement | null)?.closest?.('.m-cell') as HTMLElement | null;
              const idx = Number(cell?.dataset.idx);
              if (cell && Number.isInteger(idx) && idx !== activeIdx) setActiveIdx(idx);
            }
          : undefined
      }
      ref={wrapRef}
    >
      {visible.map((i) => {
        const node = renderItem(items[i]);
        return (
          <div
            /* key 必须用主键 id：库中可能存在同 path 的多条记录（文件被重复导入），
             * 用 path 当 key 会冲突，React DOM 复用错乱 → 多张卡叠在同一坐标 */
            key={items[i].id ?? items[i].path}
            className="m-cell"
            data-idx={i}
            style={{
              position: 'absolute',
              left: layout.xs[i],
              top: layout.ys[i],
              width: layout.colW,
              height: layout.hs[i],
            }}
          >
            {roving && React.isValidElement(node)
              ? React.cloneElement(node as React.ReactElement<{ tabIndex?: number }>, {
                  tabIndex: i === tabStop ? 0 : -1,
                })
              : node}
          </div>
        );
      })}
    </div>
  );
}
