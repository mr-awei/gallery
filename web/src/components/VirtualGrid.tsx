import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * 等尺寸网格的窗口虚拟滚动。
 *
 * MasonryGrid 解决的是「图片原比例瀑布流」，但人物页 / 时间线的格子是固定尺寸的
 * （正方形缩略图、或正方形 + 两行文字），以前都是 `items.map()` 全量铺 DOM ——
 * 一天的相册几千张就排几千个 <img>，滚动掉帧、内存随滚动持续增长。
 *
 * 这里按「行」做窗口：列数由容器宽度和列宽目标算出来（等价于原来的
 * `grid-template-columns: repeat(auto-fill, minmax(colWidth, 1fr))`），
 * 行高固定，所以总高 = 行数 × 行高，可见行区间一次除法就能算出来。
 * 只渲染可见行上下 overscanRows 行，DOM 常驻量恒定。
 *
 * 滚动容器探测与 MasonryGraph 同一套逻辑（含「灯箱把 .content 改成
 * overflow:hidden 时不能把容器置空」的坑），改这里时两处要一起改。
 */

const DEFAULT_GAP = 8;
const DEFAULT_OVERSCAN_ROWS = 2;

interface Props<T> {
  items: T[];
  keyOf: (item: T, index: number) => React.Key;
  renderItem: (item: T, index: number) => React.ReactNode;
  /** 单元格宽高比（宽 / 高），1 = 正方形 */
  ratio?: number;
  /** 目标列宽（px）：列数 = floor((容器宽 + gap) / (列宽 + gap))，与 CSS auto-fill 一致 */
  colWidth?: number;
  gap?: number;
  /** 格子以外的固定附加高度（如人物卡片下方两行文字），只参与行高计算 */
  extraHeight?: number;
  /** 最多列数，避免超大屏把格子拉成一条 */
  maxCols?: number;
  /** 视口外额外渲染的行数 */
  overscanRows?: number;
  className?: string;
  /** 有数据但算不出可见区间时的兜底行数（沿用 MasonryGrid 的兜底思路） */
  fallbackRows?: number;
}

export default function VirtualGrid<T>({
  items,
  keyOf,
  renderItem,
  ratio = 1,
  colWidth = 148,
  gap = DEFAULT_GAP,
  extraHeight = 0,
  maxCols = 24,
  overscanRows = DEFAULT_OVERSCAN_ROWS,
  className,
  fallbackRows = 3,
}: Props<T>) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(() => (typeof window === 'undefined' ? 0 : window.scrollY));
  const [viewH, setViewH] = useState(() => (typeof window === 'undefined' ? 0 : window.innerHeight));
  const scrollElRef = useRef<HTMLElement | null>(null);
  /**
   * 容器在滚动内容里的纵向位置。必须进 state：上面那些月份/日期陆续加载图片后
   * 整体会被往下顶，只放 ref 的话可见行一直按挂载时的位置算。
   */
  const [docTop, setDocTop] = useState(0);
  const rafRef = useRef(0);

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
    // 探测不到时沿用已知容器：灯箱锁滚动期间 overflow:hidden 会让探测失败，
    // 置空后所有 scrollTop 都读成 window.scrollY（恒 0），虚拟窗口会永远停在顶部
    if (!scroller && scrollElRef.current?.isConnected) scroller = scrollElRef.current;
    scrollElRef.current = scroller;
    const v = scroller
      ? rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop
      : rect.top + window.scrollY;
    setDocTop(v);
  }, []);

  /**
   * 滚动中的轻量重测：只用已探明的容器做 rect 相减，不做祖先 getComputedStyle 遍历，
   * 避免每帧强制样式计算（时间线里同时挂着好几个网格）。
   */
  const refreshDocTop = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const scroller = scrollElRef.current;
    const rect = wrap.getBoundingClientRect();
    setDocTop(
      scroller
        ? rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop
        : rect.top + window.scrollY
    );
  }, []);

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

  const count = items.length;

  useLayoutEffect(() => {
    measure();
  }, [count, ratio, colWidth, gap, extraHeight, measure]);

  useEffect(() => {
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const scroller = scrollElRef.current;
        setScrollTop(scroller ? scroller.scrollTop : window.scrollY);
        setViewH(scroller ? scroller.clientHeight : window.innerHeight);
        // 滚动时重测一次：上面那一屏的图片加载完会把本网格往下顶，docTop 跟着变
        refreshDocTop();
      });
    };
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
  }, [refreshDocTop]);

  const effWidth = width || (typeof window === 'undefined' ? 0 : Math.max(320, window.innerWidth - 280));

  const geo = useMemo(() => {
    if (!effWidth) return { cols: 1, cellW: colWidth, rowH: colWidth / ratio + extraHeight + gap, rows: 0 };
    const cols = Math.max(1, Math.min(maxCols, Math.floor((effWidth + gap) / (colWidth + gap))));
    const cellW = Math.floor((effWidth - gap * (cols - 1)) / cols);
    const rowH = Math.round(cellW / ratio + extraHeight) + gap;
    return { cols, cellW, rowH, rows: Math.ceil(count / cols) };
  }, [effWidth, colWidth, gap, ratio, extraHeight, maxCols, count]);

  const totalHeight = Math.max(0, geo.rows * geo.rowH - gap);

  const visible = useMemo(() => {
    if (!count) return [] as number[];
    // 宽度还没量出来时也算一行，别让「有数据」的网格直接空白
    const rows = geo.rows || 1;
    /*
      视口窗口换算到「容器内坐标」：scrollTop 是滚动容器的偏移，docTop 是容器在滚动
      内容里的位置，两者相减才是「视口顶落在容器第几像素」。以前直接用 scrollTop，
      位置靠下的网格 firstRow 会算到视口之外 → 头上有张数、下面一张都不渲染。
    */
    const viewTop = scrollTop - docTop;
    const viewBottom = viewTop + (viewH || 800);
    const firstRow = Math.max(0, Math.floor(viewTop / geo.rowH) - overscanRows);
    const lastRow = Math.min(rows - 1, Math.ceil(viewBottom / geo.rowH) + overscanRows);
    const out: number[] = [];
    for (let r = firstRow; r <= lastRow; r++) {
      for (let c = 0; c < geo.cols; c++) {
        const idx = r * geo.cols + c;
        if (idx >= count) break;
        out.push(idx);
      }
    }
    if (out.length) return out;
    // 兜底：偏移测量还没生效时，从当前行起渲染几行，绝不能返回空数组
    const start = Math.min(firstRow, Math.max(0, rows - 1));
    const take = Math.max(1, Math.min(fallbackRows, rows - start));
    const from = start * geo.cols;
    return Array.from({ length: Math.max(0, Math.min(count - from, take * geo.cols)) }, (_, i) => from + i);
  }, [count, geo, docTop, scrollTop, viewH, gap, overscanRows, fallbackRows]);

  return (
    <div
      className={className}
      ref={wrapRef}
      style={{ position: 'relative', height: totalHeight || undefined }}
    >
      {visible.map((i) => {
        const row = Math.floor(i / geo.cols);
        const col = i % geo.cols;
        return (
          <div
            key={keyOf(items[i], i)}
            style={{
              position: 'absolute',
              left: col * (geo.cellW + gap),
              top: row * geo.rowH,
              width: geo.cellW,
              height: geo.rowH - gap,
            }}
          >
            {renderItem(items[i], i)}
          </div>
        );
      })}
    </div>
  );
}
