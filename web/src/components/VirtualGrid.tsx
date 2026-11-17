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
  const docTopRef = useRef(0);
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
    if (scroller) {
      docTopRef.current = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    } else {
      docTopRef.current = rect.top + window.scrollY;
    }
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
  }, []);

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
    if (!geo.rows) return [];
    const top = docTopRef.current + scrollTop - gap;
    const bottom = docTopRef.current + scrollTop + (viewH || 800) + gap;
    // 行 → 局部坐标：容器内的行顶 = r * rowH
    const firstRow = Math.max(0, Math.floor((top - docTopRef.current) / geo.rowH) - overscanRows);
    const lastRow = Math.min(geo.rows - 1, Math.ceil((bottom - docTopRef.current) / geo.rowH) + overscanRows);
    const out: number[] = [];
    for (let r = firstRow; r <= lastRow; r++) {
      for (let c = 0; c < geo.cols; c++) {
        const idx = r * geo.cols + c;
        if (idx >= count) break;
        out.push(idx);
      }
    }
    if (out.length) return out;
    // 偏移测量失效时的兜底：绝不能返回空数组（表现为「有数据但整页空白」）
    const rows = Math.max(1, Math.min(fallbackRows, geo.rows));
    return Array.from({ length: Math.min(count, rows * geo.cols) }, (_, i) => i);
  }, [count, geo, scrollTop, viewH, gap, overscanRows, fallbackRows]);

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
