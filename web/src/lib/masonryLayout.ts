/**
 * 瀑布流布局计算：纯数值、无 DOM、可单测。
 *
 * 为什么要单独一层：原先坐标计算写在 MasonryGrid 的 useMemo 里，
 * 每次 items 变化都要「重建几万个对象 → 全量排序 → 重算每列索引」，
 * 分页追加 48 张也要把已加载的几万张全部重算一遍（万级库一次 10~20ms，
 * 滚动追加时能感觉到卡顿）。这里把它换成三件事：
 *
 * 1. 位置存进 Float64Array / Uint8Array，不再为每张图分配 {x,y,w,h,col} 对象；
 * 2. 追加时只算新增项（extendLayout 先校验前 count 项的 id/宽高快照，
 *    一致就直接从断点继续），分页追加的代价从 O(n) 降到 O(新增数)；
 * 3. 可见卡片用「底边分桶」索引（每 BUCKET_H 像素一个桶），
 *    查询只走与视口相交的几个桶，不再每帧二分排序数组。
 *
 * 布局签名也只算两个 32 位哈希（FNV-1a），替代原先 `items.map().join('|')`
 * 那种「每次变化都拼出几 MB 字符串」的做法。
 */

export const GAP = 14;
/** 瀑布流列宽基数（与旧 CSS 断点 4/3/2 列的视觉密度一致） */
export const COL_TARGET = 250;
/** grid 模式列宽（对应旧 CSS minmax(230px, 1fr)） */
export const GRID_COL_MIN = 230;
/** 可见区索引的竖直分桶高度（px） */
export const BUCKET_H = 512;

export interface LayoutItemLike {
  id?: number | string;
  width: number;
  height: number;
}

export interface LayoutSpec {
  effWidth: number;
  mode: 'masonry' | 'grid';
  colWidth?: number;
}

export interface MasonryLayout {
  /** 布局时的几何参数：与本次调用不一致就必须全量重建 */
  spec: LayoutSpec;
  cols: number;
  colW: number;
  /** 已布局条数 */
  count: number;
  /** 数组容量（扩容时翻倍，避免每追加一张就重分配） */
  capacity: number;
  xs: Float64Array;
  ys: Float64Array;
  hs: Float64Array;
  colsOf: Uint8Array;
  colHeights: Float64Array;
  /** 每列的索引（按 y 递增）：方向键上下 / 左右导航用 */
  byCol: number[][];
  /** 底边所在桶 → 卡片索引；查询可见区只碰相交的桶 */
  buckets: number[][];
  bucketH: number;
  totalHeight: number;
  /** 已出现的最大卡片高度：查可见区时用它放宽下界 */
  maxH: number;
  /** 已布局项的 id/宽/高 快照（每项 3 个槽），用于判断能否增量追加 */
  keys: Float64Array;
}

/** 与旧实现一致的列数规则：显式列宽优先，其次按模式断点 */
export function columnCount(width: number, mode: 'masonry' | 'grid', colWidth?: number) {
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

function colWidthOf(effWidth: number, cols: number) {
  return Math.floor((effWidth - GAP * (cols - 1)) / cols);
}

function alloc(capacity: number, cols: number, spec: LayoutSpec, bucketH: number): MasonryLayout {
  return {
    spec,
    cols,
    colW: colWidthOf(spec.effWidth, cols),
    count: 0,
    capacity,
    xs: new Float64Array(capacity),
    ys: new Float64Array(capacity),
    hs: new Float64Array(capacity),
    colsOf: new Uint8Array(capacity),
    colHeights: new Float64Array(cols),
    byCol: Array.from({ length: cols }, () => [] as number[]),
    buckets: [],
    bucketH,
    totalHeight: 0,
    maxH: 0,
    keys: new Float64Array(capacity * 3),
  };
}

/** 空布局（宽度还没测到时）：调用方据此渲染空容器 */
export function emptyLayout(spec: LayoutSpec): MasonryLayout {
  return alloc(0, Math.max(1, columnCount(Math.max(spec.effWidth, 320), spec.mode, spec.colWidth)), spec, BUCKET_H);
}

function grow(L: MasonryLayout, need: number) {
  if (need <= L.capacity) return;
  let cap = L.capacity || 8;
  while (cap < need) cap = Math.ceil(cap * 1.5);
  const xs = new Float64Array(cap);
  const ys = new Float64Array(cap);
  const hs = new Float64Array(cap);
  const colsOf = new Uint8Array(cap);
  const keys = new Float64Array(cap * 3);
  xs.set(L.xs);
  ys.set(L.ys);
  hs.set(L.hs);
  colsOf.set(L.colsOf);
  keys.set(L.keys);
  L.xs = xs;
  L.ys = ys;
  L.hs = hs;
  L.colsOf = colsOf;
  L.keys = keys;
  L.capacity = cap;
}

/** 就地把第 i 项放进最短列，并登记到桶 / 列索引 / 快照 */
function place(L: MasonryLayout, it: LayoutItemLike, i: number) {
  const w0 = it.width > 0 ? it.width : 3;
  const h0 = it.height > 0 ? it.height : 4;
  const h = L.spec.mode === 'grid' ? Math.round(L.colW * (4 / 3)) : Math.round(L.colW * (h0 / w0));
  let best = 0;
  for (let c = 1; c < L.cols; c += 1) if (L.colHeights[c] < L.colHeights[best]) best = c;
  const y = L.colHeights[best];
  L.xs[i] = best * (L.colW + GAP);
  L.ys[i] = y;
  L.hs[i] = h;
  L.colsOf[i] = best;
  L.colHeights[best] = y + h + GAP;
  L.byCol[best].push(i);
  const b = ((y + h) / L.bucketH) | 0;
  while (L.buckets.length <= b) L.buckets.push([]);
  L.buckets[b].push(i);
  if (h > L.maxH) L.maxH = h;
  const k = i * 3;
  L.keys[k] = typeof it.id === 'number' ? it.id : Number(it.id) || 0;
  L.keys[k + 1] = it.width | 0;
  L.keys[k + 2] = it.height | 0;
  L.count = i + 1;
}

function refreshHeight(L: MasonryLayout) {
  let max = 0;
  for (let c = 0; c < L.cols; c += 1) if (L.colHeights[c] > max) max = L.colHeights[c];
  L.totalHeight = Math.max(0, max - GAP);
}

/** 全量布局 */
export function createLayout(items: readonly LayoutItemLike[], spec: LayoutSpec): MasonryLayout {
  const cols = Math.max(1, columnCount(spec.effWidth, spec.mode, spec.colWidth));
  const L = alloc(Math.max(8, Math.ceil(items.length * 1.2)), cols, spec, BUCKET_H);
  for (let i = 0; i < items.length; i += 1) {
    grow(L, i + 1);
    place(L, items[i], i);
  }
  refreshHeight(L);
  return L;
}

function sameSpec(a: LayoutSpec, b: LayoutSpec) {
  return a.effWidth === b.effWidth && a.mode === b.mode && (a.colWidth || 0) === (b.colWidth || 0);
}

/**
 * 在已有布局上继续（分页追加的主要路径）。
 * 前 count 项的 id/宽高必须与快照逐项一致才允许增量 —— 只有「纯追加」才可能一致；
 * 顺序变化、某张图重新探测了尺寸都会落到全量重建，宁可多算一次也不让坐标错位。
 */
export function extendLayout(
  prev: MasonryLayout | null,
  items: readonly LayoutItemLike[],
  spec: LayoutSpec
): MasonryLayout {
  if (!prev || !sameSpec(prev.spec, spec)) return createLayout(items, spec);
  if (items.length < prev.count) return createLayout(items, spec);
  for (let i = 0; i < prev.count; i += 1) {
    const it = items[i];
    const k = i * 3;
    const id = typeof it.id === 'number' ? it.id : Number(it.id) || 0;
    if (prev.keys[k] !== id || prev.keys[k + 1] !== (it.width | 0) || prev.keys[k + 2] !== (it.height | 0)) {
      return createLayout(items, spec);
    }
  }
  if (items.length === prev.count) return prev;
  grow(prev, items.length);
  for (let i = prev.count; i < items.length; i += 1) place(prev, items[i], i);
  refreshHeight(prev);
  return prev;
}

/**
 * 视口内（含余量）的卡片索引，按原顺序。
 * 只遍历底边落在 [top, bottom + maxH] 的桶，再把跨桶/跨视口的边界项过滤掉。
 */
export function visibleRange(L: MasonryLayout, top: number, bottom: number): number[] {
  if (!L.count || bottom < 0) return [];
  const H = L.bucketH;
  const b0 = Math.max(0, Math.floor(top / H));
  const b1 = Math.min(L.buckets.length - 1, Math.floor((bottom + L.maxH) / H));
  const out: number[] = [];
  for (let b = b0; b <= b1; b += 1) {
    const list = L.buckets[b];
    if (!list) continue;
    for (let k = 0; k < list.length; k += 1) {
      const i = list[k];
      const y = L.ys[i];
      if (y > bottom) continue;
      if (y + L.hs[i] < top) continue;
      out.push(i);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 前 n 项的索引（视口还没测到时的兜底渲染） */
export function firstIndices(L: MasonryLayout, n = 24): number[] {
  const out: number[] = [];
  for (let i = 0; i < L.count && out.length < n; i += 1) out.push(i);
  return out;
}

/**
 * 布局签名：只认「顺序 + id + 宽高」。
 * 收藏 / 改标题 / 重新选中都会让 items 换身份但几何没变，签名不变就不必重算。
 */
export function geometrySig(items: readonly LayoutItemLike[]): string {
  let a = 2166136261;
  let b = 16777619;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const id = typeof it.id === 'number' ? it.id : Number(it.id) || 0;
    a = Math.imul(a ^ id, 16777619);
    a = Math.imul(a ^ (it.width | 0), 16777619);
    a = Math.imul(a ^ (it.height | 0), 16777619);
    b = Math.imul(b + (it.width | 0) + 7, 2654435761) ^ (it.height | 0);
  }
  return `${items.length}:${a >>> 0}:${b >>> 0}`;
}
