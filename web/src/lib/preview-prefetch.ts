import { BASE, api } from '../api';

/**
 * 灯箱主图（1920 预览图）的「悬停预取」。
 *
 * 为什么需要：灯箱主图不是网格里的缩略图，而是服务端现生成的 1920 JPEG。
 * 实测 5472×3648 的 5D4 照片一张要 ~280ms（读盘 30~50ms + 解码 + 编码），
 * 磁盘上还没有缓存时，点开就是这几百毫秒白等 —— 表现就是「点开大图很慢」。
 *
 * 鼠标停在卡片上的这半秒，用户大概率下一秒就会点开它：这时候把生成任务插到
 * 预取队首，同时把字节拉进浏览器缓存，点开就变成命中（几毫秒）。
 *
 * 为什么延迟 120ms：划着鼠标扫过一整排卡片时不能把每张都塞进生成队列，
 * 那会把队列排满、反而拖慢真正要看的那张。停留超过 120ms 才算「意图」。
 */

interface PrefetchTarget {
  id: number;
  mediaKind?: string;
  /** DTO 里的预览图地址（带 ?v= 文件指纹，命中浏览器缓存） */
  previewUrl?: string;
}

/** 只有这些类型才有服务端预览图（视频/音频/字体/PDF 等在灯箱里走 MediaViewer） */
const BITMAP_KINDS = new Set(['image', 'gif', 'raw', 'design']);
const INTENT_DELAY_MS = 120;
/** 只留最近若干张的 Image 引用：对象本身持有解码结果，留太多会吃内存；HTTP 缓存不受影响 */
const MAX_HOLD = 12;

const held = new Map<number, HTMLImageElement>();
const timers = new Map<number, number>();

export function previewSrc(item: PrefetchTarget) {
  return `${BASE}${item.previewUrl || `/api/images/${item.id}/preview`}`;
}

/** 只把预览图字节拉进浏览器缓存（服务端已经批量预热过时用，省掉每张一次 warm 请求） */
export function downloadPreview(item: PrefetchTarget) {
  const kind = item.mediaKind || 'image';
  if (!BITMAP_KINDS.has(kind)) return;
  const url = previewSrc(item);
  if (held.get(item.id)?.src === url) return;
  const im = new Image();
  im.decoding = 'async';
  im.src = url;
  held.set(item.id, im);
  if (held.size > MAX_HOLD) {
    const oldest = held.keys().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
}

/** 立刻预取（键盘聚焦这类明确意图用，不用等 120ms）：先插队生成，再下载字节 */
export function prefetchPreviewNow(item: PrefetchTarget) {
  // 服务端把这张挪到预取队首：停留的这半秒足够现做完成
  api.warmPreviews([item.id]).catch(() => undefined);
  downloadPreview(item);
}

/** 悬停进入：停留 120ms 后预取；离开时取消 */
export function schedulePrefetchPreview(item: PrefetchTarget) {
  cancelPrefetchPreview(item.id);
  const t = window.setTimeout(() => {
    timers.delete(item.id);
    prefetchPreviewNow(item);
  }, INTENT_DELAY_MS);
  timers.set(item.id, t);
}

export function cancelPrefetchPreview(id: number) {
  const t = timers.get(id);
  if (t) {
    window.clearTimeout(t);
    timers.delete(id);
  }
}

/**
 * 展开到任意「点开就能进灯箱」的缩略图元素上：`<div {...previewHoverProps(item)} />`。
 * 图库/搜索/智能相册走 ImageCard 已经内置，剩下的入口（底部胶片条、堆叠查看器、
 * 首页最近/最大、清单、书签、人物照片墙、列表视图）都用这个，行为保持一致。
 */
export function previewHoverProps(item: PrefetchTarget) {
  return {
    onPointerEnter: () => schedulePrefetchPreview(item),
    onPointerLeave: () => cancelPrefetchPreview(item.id),
  };
}
