/**
 * 画布导出：PNG / PDF。
 *
 * 参考 PureRef / Miro 的做法：导出的是「整张画布的视觉结果」，不是数据；
 * 因此这里按世界坐标重绘一遍，而不是截 DOM —— 截 DOM 会被视口裁掉，
 * 屏外的素材永远导不出来。
 *
 * PDF 没有引入第三方库：Canvas 先转 JPEG，再按最小 PDF 结构内嵌一张图，
 * 体积小、无依赖，也避免为了一个导出功能把安装包撑大。
 */
import type { CanvasDoc } from './canvas-board';
import { shapePolygon } from './canvas-board';
import type { ImageItem } from '../types';

const BG = '#12121a';
const MARGIN = 60;
const MAX_SIDE = 4096;

type Bounds = { x: number; y: number; w: number; h: number };

function docBounds(doc: CanvasDoc): Bounds {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const add = (x: number, y: number, w: number, h: number) => {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + w);
    y2 = Math.max(y2, y + h);
  };
  for (const c of doc.cards) add(c.x, c.y, c.w, c.h);
  for (const n of doc.notes) add(n.x, n.y, n.w, n.h);
  for (const s of doc.shapes) add(s.x, s.y, s.w, s.h);
  for (const l of doc.links) add(l.x, l.y, l.w, l.h);
  for (const a of doc.arrows) {
    add(Math.min(a.x1, a.x2), Math.min(a.y1, a.y2), Math.abs(a.x2 - a.x1), Math.abs(a.y2 - a.y1));
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 800, h: 600 };
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para) {
      out.push('');
      continue;
    }
    let line = '';
    for (const ch of para) {
      const next = line + ch;
      if (ctx.measureText(next).width > maxW && line) {
        out.push(line);
        line = ch;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

async function drawDoc(doc: CanvasDoc, items: Record<number, ImageItem>, maxSide = MAX_SIDE) {
  const b = docBounds(doc);
  const width = b.w + MARGIN * 2;
  const height = b.h + MARGIN * 2;
  const scale = Math.min(2, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境不支持画布导出');
  ctx.scale(scale, scale);
  ctx.translate(-b.x + MARGIN, -b.y + MARGIN);
  ctx.fillStyle = BG;
  ctx.fillRect(b.x - MARGIN, b.y - MARGIN, width, height);

  // 形状在最底层，避免盖住素材
  for (const s of doc.shapes) {
    ctx.save();
    ctx.beginPath();
    if (s.shape === 'ellipse') {
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
    } else if (s.shape === 'rect') {
      roundRect(ctx, s.x, s.y, s.w, s.h, 12);
    } else {
      // 多边形与画布共用同一份归一化顶点（0–100），导出结果和屏幕上一致
      const pts = shapePolygon(s.shape) || [];
      pts.forEach(([px, py], i) => {
        const x = s.x + (px / 100) * s.w;
        const y = s.y + (py / 100) * s.h;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fillStyle = s.color;
    ctx.globalAlpha = 0.14;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // 连线
  for (const a of doc.arrows) {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(a.x2, a.y2);
    ctx.stroke();
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const size = 9;
    ctx.beginPath();
    ctx.moveTo(a.x2, a.y2);
    ctx.lineTo(a.x2 - size * Math.cos(ang - 0.4), a.y2 - size * Math.sin(ang - 0.4));
    ctx.lineTo(a.x2 - size * Math.cos(ang + 0.4), a.y2 - size * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 图片：按 contain 放进卡片，和画布上的显示一致
  const images = await Promise.all(
    doc.cards.map((c) => {
      const it = items[c.id];
      const url = it?.previewUrl || it?.url || it?.thumbUrl || '';
      return url ? loadImage(url) : Promise.resolve(null);
    })
  );
  for (let i = 0; i < doc.cards.length; i++) {
    const c = doc.cards[i];
    const img = images[i];
    ctx.save();
    roundRect(ctx, c.x, c.y, c.w, c.h, 10);
    ctx.clip();
    ctx.fillStyle = '#1c1c26';
    ctx.fillRect(c.x, c.y, c.w, c.h);
    if (img) {
      const r = Math.min(c.w / img.naturalWidth, c.h / img.naturalHeight);
      const w = img.naturalWidth * r;
      const h = img.naturalHeight * r;
      ctx.drawImage(img, c.x + (c.w - w) / 2, c.y + (c.h - h) / 2, w, h);
    }
    ctx.restore();
  }

  // 链接卡
  for (const l of doc.links) {
    ctx.save();
    roundRect(ctx, l.x, l.y, l.w, l.h, 12);
    ctx.fillStyle = '#1d1d28';
    ctx.fill();
    ctx.strokeStyle = '#ffffff22';
    ctx.stroke();
    ctx.fillStyle = '#ececf6';
    ctx.font = '600 14px system-ui, sans-serif';
    const lines = wrapText(ctx, l.title || l.url, l.w - 28).slice(0, 3);
    let ty = l.y + 34;
    for (const line of lines) {
      ctx.fillText(line, l.x + 14, ty);
      ty += 20;
    }
    ctx.fillStyle = '#8f8fab';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(l.url.slice(0, 60), l.x + 14, l.y + l.h - 16);
    ctx.restore();
  }

  // 便签
  for (const n of doc.notes) {
    ctx.save();
    ctx.beginPath();
    if (n.noteShape === 'ellipse') {
      ctx.ellipse(n.x + n.w / 2, n.y + n.h / 2, n.w / 2, n.h / 2, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = n.color;
      ctx.fillRect(n.x, n.y, n.w, n.h);
    } else {
      roundRect(ctx, n.x, n.y, n.w, n.h, n.noteShape === 'rect' ? 4 : 10);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.clip();
    }
    const size = n.fontSize || 14;
    const lineH = Math.round(size * 1.5);
    ctx.fillStyle = n.textColor || '#241f16';
    ctx.font = `${size}px system-ui, sans-serif`;
    const lines = wrapText(ctx, n.text, n.w - 24).slice(0, Math.max(1, Math.floor((n.h - 20) / lineH)));
    let ty = n.y + size + 10;
    for (const line of lines) {
      ctx.fillText(line, n.x + 12, ty);
      ty += lineH;
    }
    ctx.restore();
  }

  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('导出失败'))), type, quality);
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportCanvasPng(doc: CanvasDoc, items: Record<number, ImageItem>): Promise<Blob> {
  const canvas = await drawDoc(doc, items);
  return toBlob(canvas, 'image/png');
}

/**
 * 导出前预览：同一套绘制逻辑，只是限制最大边（默认 1400px）。
 * 单独抽出来是为了「所见即所得」——预览和最终 PNG 用同一条渲染路径，
 * 不会出现预览好看、下载后发现少了一块的情况。
 */
export async function renderCanvasPreview(
  doc: CanvasDoc,
  items: Record<number, ImageItem>,
  maxSide = 1400
): Promise<string> {
  const canvas = await drawDoc(doc, items, maxSide);
  return canvas.toDataURL('image/jpeg', 0.86);
}

export async function exportCanvasPdf(doc: CanvasDoc, items: Record<number, ImageItem>): Promise<Blob> {
  const canvas = await drawDoc(doc, items);
  const jpegBlob = await toBlob(canvas, 'image/jpeg', 0.9);
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
  return buildPdf(jpeg, canvas.width, canvas.height);
}

/** 最小可用 PDF：一页、一张 JPEG。page 尺寸按 96dpi → 72pt 换算。 */
function buildPdf(jpeg: Uint8Array, pxW: number, pxH: number): Blob {
  const w = (pxW * 72) / 96;
  const h = (pxH * 72) / 96;
  const enc = new TextEncoder();
  const chunks: BlobPart[] = [];
  let size = 0;
  const offsets: number[] = [0];
  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    // TS 5.7 把 Uint8Array 的 buffer 收窄成 ArrayBufferLike，BufferSource 需要显式转一次
    chunks.push(bytes as unknown as BlobPart);
    size += bytes.length;
  };
  const obj = (body: string) => {
    offsets.push(size);
    push(body);
  };

  push('%PDF-1.4\n');
  obj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  obj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  obj(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'
  );
  offsets.push(size);
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
  );
  push(jpeg);
  push('\nendstream\nendobj\n');
  const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im0 Do Q`;
  obj(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefStart = size;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
