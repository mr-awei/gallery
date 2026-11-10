// @ts-check
/**
 * 非破坏编辑的纯几何运算（不碰 db / sharp / 文件系统）。
 * 单独一个文件是为了能直接单测：旋转换向、裁切取框、成品尺寸推算这三件事
 * 一旦算错，用户看到的图会「少一块」或者构图偏，且不会报任何错。
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/**
 * 套用操作链后的成品尺寸（不读图片，按操作推算）。
 * 裁切框用「当前画面」的归一化坐标记录，所以必须按顺序推算。
 * @param {{ width?: number, height?: number }} row
 * @param {{ kind: string, params?: { rect?: { w: number, h: number }, outWidth?: number, outHeight?: number } }[]} ops
 */
export function effectiveSize(row, ops) {
  let w = Number(row?.width) || 0;
  let h = Number(row?.height) || 0;
  for (const op of ops || []) {
    if (op.kind === 'rotate') {
      // 顺时针/逆时针都是 90°，宽高互换
      [w, h] = [h, w];
    } else if (op.kind === 'crop') {
      const r = op.params?.rect;
      if (r && w && h) {
        w = Math.max(1, Math.round(r.w * w));
        h = Math.max(1, Math.round(r.h * h));
      }
      const ow = Number(op.params?.outWidth) || 0;
      const oh = Number(op.params?.outHeight) || 0;
      if (ow >= 16 && oh >= 16) {
        w = ow;
        h = oh;
      }
    }
  }
  return { width: w, height: h };
}

/**
 * 90° 旋转（像素搬运）。
 * @param {{ data: Buffer, width: number, height: number, channels: number }} img
 * @param {string} dir 'cw' | 'ccw'
 */
export function rotateRaw(img, dir = 'cw') {
  const { data, width: w, height: h, channels: ch } = img;
  const cw = dir !== 'ccw';
  const outW = h;
  const outH = w;
  const out = Buffer.allocUnsafe(w * h * ch);
  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    for (let x = 0; x < w; x++) {
      const si = (rowBase + x) * ch;
      const dx = cw ? h - 1 - y : y;
      const dy = cw ? x : w - 1 - x;
      const di = (dy * outW + dx) * ch;
      for (let c = 0; c < ch; c++) out[di + c] = data[si + c];
    }
  }
  return { data: out, width: outW, height: outH, channels: ch };
}

/**
 * 按归一化框裁切（框是相对「当前画面」的）。
 * @param {{ data: Buffer, width: number, height: number, channels: number }} img
 * @param {{ rect?: { x?: number, y?: number, w?: number, h?: number } }} [params]
 */
export function cropRaw(img, params) {
  const r = params?.rect;
  if (!r || !(Number(r.w) > 0) || !(Number(r.h) > 0)) return img;
  const { data, width: w, height: h, channels: ch } = img;
  const left = Math.min(Math.round(clamp(r.x, 0, 1) * w), Math.max(0, w - 1));
  const top = Math.min(Math.round(clamp(r.y, 0, 1) * h), Math.max(0, h - 1));
  const cw = Math.max(1, Math.min(Math.round(clamp(r.w, 0, 1) * w), w - left));
  const chh = Math.max(1, Math.min(Math.round(clamp(r.h, 0, 1) * h), h - top));
  const out = Buffer.allocUnsafe(cw * chh * ch);
  for (let y = 0; y < chh; y++) {
    const si = ((top + y) * w + left) * ch;
    data.copy(out, y * cw * ch, si, si + cw * ch);
  }
  return { data: out, width: cw, height: chh, channels: ch };
}
