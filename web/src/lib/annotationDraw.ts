import type { AnnotationItem } from '../types';

/** 标注几何与导出绘制：坐标一律是相对原图的 0~1 比例 */
export type Ann = AnnotationItem;

/**
 * 标注粗细 / 字号的参考画布宽度。
 *
 * size 字段按「图宽 = ANN_REF_W CSS 像素」时看到的像素值存储，渲染与导出都乘
 * W / ANN_REF_W 还原。旧实现直接拿当前显示宽度当基准（k = 原图宽 / 显示宽），
 * 于是同一份标注在 4K 屏上画出的线细、在小窗口里画出的线粗，导出结果随屏幕变化。
 */
export const ANN_REF_W = 1000;

/** 当前渲染宽度相对参考宽度的倍数 */
export function annScale(W: number) {
  return W / ANN_REF_W;
}

/** 文字字号（CSS 像素，参考宽度下） */
export function annFontSize(size: number) {
  return Math.max(12, Math.round((size || 3) * 5 + 10));
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const clampNum = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 元素外接框；文字按字号估算、画笔按点集并集 */
export function boxOf(a: Ann, W: number, H: number) {
  if (a.kind === 'brush' || a.kind === 'pen') {
    const pts = a.points || [];
    if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
    let x1 = 1;
    let y1 = 1;
    let x2 = 0;
    let y2 = 0;
    for (const [x, y] of pts) {
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
    const pad = (a.size / ANN_REF_W) * 1.5;
    return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  }
  if (a.kind === 'arrow') {
    const sx = a.x ?? 0;
    const sy = a.y ?? 0;
    const tx = a.to?.x ?? sx;
    const ty = a.to?.y ?? sy;
    return { x: Math.min(sx, tx), y: Math.min(sy, ty), w: Math.abs(tx - sx), h: Math.abs(ty - sy) };
  }
  if (a.kind === 'text') {
    // 字号同样按参考宽度换算，框的估计值才不随屏幕变化
    const fs = (annFontSize(a.size) * annScale(W)) / Math.max(1, W);
    return {
      x: a.x ?? 0,
      y: a.y ?? 0,
      w: Math.min(1, (a.text || '').length * fs * 0.62),
      h: Math.min(1, fs * 1.3 * (W / Math.max(1, H))),
    };
  }
  return { x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? 0, h: a.h ?? 0 };
}

/**
 * 箭头几何：预览（SVG）和导出（canvas）共用同一份计算，两边形状才不会走样。
 *
 * 线身收到箭头底部而不是画到尖端：旧实现一直画到尖端 + 圆形线帽，
 * 粗线时圆头会从三角尖顶出来一小块，从右往左画时看着像「箭头歪了」。
 * 头长也改成跟线宽成比例：细线不会顶个大脑袋，粗线不会显得秃。
 */
export function arrowGeom(a: Ann, W: number, H: number) {
  const sx = (a.x ?? 0) * W;
  const sy = (a.y ?? 0) * H;
  const tx = (a.to?.x ?? a.x ?? 0) * W;
  const ty = (a.to?.y ?? a.y ?? 0) * H;
  const width = Math.max(1, a.size * annScale(W));
  const ang = Math.atan2(ty - sy, tx - sx);
  const head = Math.max(width * 3.4, 9);
  const spread = Math.PI / 7;
  return {
    sx,
    sy,
    tx,
    ty,
    width,
    ang,
    head,
    // 线身停在头部内侧，避免圆头戳出三角尖
    bodyX: tx - Math.cos(ang) * head * 0.78,
    bodyY: ty - Math.sin(ang) * head * 0.78,
    leftX: tx - head * Math.cos(ang - spread),
    leftY: ty - head * Math.sin(ang - spread),
    rightX: tx - head * Math.cos(ang + spread),
    rightY: ty - head * Math.sin(ang + spread),
  };
}

/**
 * 按手柄方向改框，保持对角固定。
 * 拖过对边（w/h 变负）时按翻转处理：把框折到另一侧并取绝对值，
 * 而不是把宽度夹成 0 —— 旧实现在左侧手柄往右拖超过右边后会留下一条 4px 的线。
 */
export function resizeBox(box: { x: number; y: number; w: number; h: number }, handle: string, dx: number, dy: number) {
  let { x, y, w, h } = box;
  if (handle.includes('w')) {
    x += dx;
    w -= dx;
  }
  if (handle.includes('e')) w += dx;
  if (handle.includes('n')) {
    y += dy;
    h -= dy;
  }
  if (handle.includes('s')) h += dy;
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  return { x, y, w: Math.max(0.004, w), h: Math.max(0.004, h) };
}

/** 画笔整体缩放：点集按新旧框比例映射 */
export function mapPoints(
  pts: [number, number][],
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number }
) {
  const sx = to.w / Math.max(1e-6, from.w);
  const sy = to.h / Math.max(1e-6, from.h);
  return pts.map(([px, py]) => [to.x + (px - from.x) * sx, to.y + (py - from.y) * sy] as [number, number]);
}

export function hitTest(items: Ann[], p: { x: number; y: number }, W: number, H: number): Ann | null {
  // 容差按两个方向各自的屏幕像素换算：宽图上 H 只有两百来像素，
  // 拿 4/W 当纵向容差等于 1px，细箭头几乎点不中（改之前就是这样，反手画的箭头选不上）
  const padX = 5 / Math.max(1, W);
  const padY = 5 / Math.max(1, H);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const b = boxOf(items[i], W, H);
    if (p.x >= b.x - padX && p.x <= b.x + b.w + padX && p.y >= b.y - padY && p.y <= b.y + b.h + padY) {
      return items[i];
    }
  }
  return null;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('底图加载失败'));
    img.src = url;
  });
}

/**
 * 把标注合成到 canvas 上（按原图像素绘制）。
 * 粗细按 ANN_REF_W 换算，与「画标注时窗口多大」无关 —— 这才是同一份标注
 * 在任何屏幕、任何窗口尺寸下导出都一致的前提。
 */
export function drawAnnotations(ctx: CanvasRenderingContext2D, items: Ann[]) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const k = annScale(W);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const a of items) {
    const b = boxOf(a, W, H);
    const x = b.x * W;
    const y = b.y * H;
    const w = b.w * W;
    const h = b.h * H;
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    if (a.kind === 'rect') {
      ctx.lineWidth = Math.max(1, a.size * k);
      ctx.strokeRect(x, y, w, h);
    } else if (a.kind === 'highlight') {
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    } else if (a.kind === 'mosaic') {
      if (w < 2 || h < 2) continue;
      const block = Math.max(6, Math.round(a.size * k * 3));
      const bw = Math.max(1, Math.round(w / block));
      const bh = Math.max(1, Math.round(h / block));
      const off = document.createElement('canvas');
      off.width = bw;
      off.height = bh;
      const octx = off.getContext('2d');
      if (!octx) continue;
      octx.drawImage(ctx.canvas, x, y, w, h, 0, 0, bw, bh);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, bw, bh, x, y, w, h);
      ctx.restore();
    } else if (a.kind === 'arrow') {
      const g = arrowGeom(a, W, H);
      ctx.lineWidth = g.width;
      ctx.beginPath();
      ctx.moveTo(g.sx, g.sy);
      ctx.lineTo(g.bodyX, g.bodyY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(g.tx, g.ty);
      ctx.lineTo(g.leftX, g.leftY);
      ctx.lineTo(g.rightX, g.rightY);
      ctx.closePath();
      ctx.fill();
    } else if (a.kind === 'brush' || a.kind === 'pen') {
      const pts = a.points || [];
      if (pts.length < 2) continue;
      ctx.lineWidth = Math.max(1, a.size * k);
      ctx.beginPath();
      pts.forEach(([px, py], i) => {
        if (i === 0) ctx.moveTo(px * W, py * H);
        else ctx.lineTo(px * W, py * H);
      });
      ctx.stroke();
    } else if (a.kind === 'text') {
      const fs = Math.max(12, Math.round((a.size || 3) * 5 + 10)) * k;
      ctx.font = `600 ${fs}px "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(a.text || '', x, y);
    }
  }
  ctx.restore();
}

/** 原图 + 标注合成为 PNG Blob（输出到原图分辨率，与当前显示尺寸无关） */
export async function composeAnnotated(url: string, items: Ann[]): Promise<Blob> {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, 0, 0);
  drawAnnotations(ctx, items);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), 'image/png');
  });
}
