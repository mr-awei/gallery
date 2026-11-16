/**
 * 拼图的「哪张图放哪一格」。
 *
 * 版面坐标由服务端算（`/stitch/plan`），但「格子 → 图」的对应关系一直是隐含的：
 * ids 的第 i 张就进第 i 格。于是模板把主视觉给了第一张，用户想让竖构图占左边大图时
 * 只能重选一遍素材——换布局也一样。
 *
 * 现在前端单独存一份 order：`order[槽位] = 选图列表里的下标`。
 * 交换两格只是换映射，不需要重新上传/解码任何图；顺手把每格的构图（crops）
 * 一起换位，用户调好的「这张图露哪块」才不会串到别人身上。
 */

/** 交换两个槽位；同一个位置或越界时原样返回（同一个引用，别让 React 白重渲染） */
export function swapAt<T>(list: readonly T[], a: number, b: number): T[] {
  if (a === b) return list as T[];
  if (!Number.isInteger(a) || !Number.isInteger(b)) return list as T[];
  if (a < 0 || b < 0 || a >= list.length || b >= list.length) return list as T[];
  const out = list.slice();
  const tmp = out[a];
  out[a] = out[b];
  out[b] = tmp;
  return out;
}

/**
 * 把 order 修成 n 位、且是 0..n-1 的一个排列。
 * 选图数量变了（增删素材、重开对话框）时用它兜底：越界/重复的丢掉，缺的按升序补上。
 */
export function normalizeOrder(order: readonly number[], n: number): number[] {
  const size = Math.max(0, Math.floor(n));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of order) {
    if (out.length >= size) break;
    if (Number.isInteger(v) && v >= 0 && v < size && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (let i = 0; i < size; i++) {
    if (!seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

/** 把 order 应用到 items 上：槽位 i 拿 items[order[i]] */
export function applyOrder<T>(items: readonly T[], order: readonly number[]): T[] {
  const n = normalizeOrder(order, items.length);
  return n.map((i) => items[i]);
}
