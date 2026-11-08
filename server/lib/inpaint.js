/**
 * 擦除 / 修复（inpaint）。
 *
 * 能力边界要说清楚：这是**内容感知扩散**，不是生成式 AI。用「最近已知像素」给待修复
 * 区域播种，再在该区域内反复做加权邻域平滑，适合划痕、水印、电线、小物件；
 * 大面积缺失只能得到平滑过渡，界面与文档都不许说成「AI 生成」。
 *
 * 大图先在长边 1200 的工作副本上修复，再放大映射回原图的擦除区域；
 * 未擦除的像素一个字节都不动。这样无论原图多大，耗时都有上界。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getImage } from '../library.js';
import { encode, persistEdit } from './edit.js';

export const INPAINT_MAX_EDGE = 1200;
export const MASK_MAX_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = '89504e470d0a1a0a';

/** 只接受前端画笔导出的 PNG data URL，别让这个入口变成任意文件写入 */
export function parseMaskDataUrl(raw) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(raw || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > MASK_MAX_BYTES) return null;
  if (buf.subarray(0, 8).toString('hex') !== PNG_MAGIC) return null;
  return buf;
}

/** 灰度蒙版 → 0/1；白色笔画算「要擦掉」，黑底算「保留」 */
export function maskFromGrey(gray, width, height, threshold = 32) {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = gray[i] > threshold ? 1 : 0;
  return out;
}

/**
 * 纯像素修复：两遍 chamfer 距离变换找最近的已知像素做初值，
 * 再只对孔洞像素做 N 轮 8 邻域加权 Jacobi 平滑。
 * 只遍历孔洞索引（通常远小于整图），所以大图的迭代成本与整图无关。
 */
export function inpaintRgba(data, width, height, mask, options = {}) {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const N = W * H;
  const src = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (src.length < N * 4) throw new Error('像素数据长度不足');
  const out = Buffer.from(src.subarray(0, N * 4));
  const holes = [];
  for (let i = 0; i < N; i++) if (mask[i]) holes.push(i);
  if (!holes.length) return out;

  const dist = new Float32Array(N).fill(Infinity);
  const origin = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) {
      dist[i] = 0;
      origin[i] = i;
    }
  }
  const relax = (i, j, step) => {
    const d = dist[j] + step;
    if (d < dist[i]) {
      dist[i] = d;
      origin[i] = origin[j];
    }
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) relax(i, i - W, 1);
      if (x > 0 && y > 0) relax(i, i - W - 1, 1.414);
      if (x < W - 1 && y > 0) relax(i, i - W + 1, 1.414);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (x < W - 1) relax(i, i + 1, 1);
      if (y < H - 1) relax(i, i + W, 1);
      if (x < W - 1 && y < H - 1) relax(i, i + W + 1, 1.414);
      if (x > 0 && y < H - 1) relax(i, i + W - 1, 1.414);
    }
  }
  for (const i of holes) {
    const s = origin[i];
    if (s < 0) continue;
    out[i * 4] = src[s * 4];
    out[i * 4 + 1] = src[s * 4 + 1];
    out[i * 4 + 2] = src[s * 4 + 2];
  }

  const iterations = Math.max(1, Math.min(80, Math.round(Number(options.iterations) || 24)));
  let prev = Buffer.from(out);
  let cur = Buffer.from(out);
  for (let k = 0; k < iterations; k++) {
    [prev, cur] = [cur, prev];
    for (const i of holes) {
      const x = i % W;
      const y = (i / W) | 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = (ny * W + nx) * 4;
          const w = dx && dy ? 0.7 : 1;
          r += prev[j] * w;
          g += prev[j + 1] * w;
          b += prev[j + 2] * w;
          sum += w;
        }
      }
      if (!sum) continue;
      cur[i * 4] = r / sum;
      cur[i * 4 + 1] = g / sum;
      cur[i * 4 + 2] = b / sum;
    }
  }
  return cur;
}

/** 单张擦除：读原图 → 解析蒙版 → 修复 → 走与调色/裁切相同的写回 + 撤销链路 */
export async function inpaintImage(id, opts = {}) {
  const row = getImage(id);
  if (!row?.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在');
  const maskBuf = parseMaskDataUrl(opts.mask);
  if (!maskBuf) throw new Error('蒙版不是合法的 PNG：请重新涂出要擦除的区域');

  const { data: rgba, info } = await sharp(row.abs_path, { failOn: 'none', animated: false })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  if (!W || !H || info.channels !== 4) throw new Error('无法读取图片像素');
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata().catch(() => ({}));
  const format = String(meta?.format || 'jpeg').toLowerCase();
  if ((Number(meta?.pages) || 1) > 1) throw new Error('多帧动图暂不支持擦除，请先导出其中一帧');
  if (!['png', 'webp', 'avif', 'jpeg', 'jpg'].includes(format)) {
    throw new Error(`${format || '未知'} 格式暂不支持擦除，请先转成 PNG / JPEG / WebP`);
  }

  const greyHi = await sharp(maskBuf)
    .resize(W, H, { fit: 'fill', kernel: 'nearest' })
    .greyscale()
    .raw()
    .toBuffer();
  const maskHi = maskFromGrey(greyHi, W, H);
  let covered = 0;
  for (let i = 0; i < maskHi.length; i++) covered += maskHi[i];
  if (!covered) throw new Error('蒙版是空的：请先用画笔涂出要擦除的区域');
  const coverage = covered / (W * H);
  if (coverage > 0.6) {
    throw new Error('擦除区域超过整图 60%：内容感知扩散无法保证效果，请缩小范围或改用裁切');
  }

  const scale = Math.min(1, INPAINT_MAX_EDGE / Math.max(W, H));
  const lw = Math.max(1, Math.round(W * scale));
  const lh = Math.max(1, Math.round(H * scale));
  const lowRgba = scale < 1
    ? await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
        .resize(lw, lh, { kernel: 'lanczos3' }).raw().toBuffer()
    : rgba;
  const lowGrey = scale < 1
    ? await sharp(greyHi, { raw: { width: W, height: H, channels: 1 } })
        .resize(lw, lh, { kernel: 'nearest' }).raw().toBuffer()
    : greyHi;
  const fixed = inpaintRgba(lowRgba, lw, lh, maskFromGrey(lowGrey, lw, lh), {
    iterations: Math.max(1, Math.min(80, Math.round(Number(opts.strength) || 24))),
  });

  let outBuf = fixed;
  if (scale < 1) {
    const up = await sharp(fixed, { raw: { width: lw, height: lh, channels: 4 } })
      .resize(W, H, { kernel: 'lanczos3' }).raw().toBuffer();
    outBuf = Buffer.from(rgba);
    for (let i = 0; i < W * H; i++) {
      if (!maskHi[i]) continue; // 未擦除区域逐像素保持原样
      outBuf[i * 4] = up[i * 4];
      outBuf[i * 4 + 1] = up[i * 4 + 1];
      outBuf[i * 4 + 2] = up[i * 4 + 2];
    }
  }
  const encoded = await encode(
    sharp(outBuf, { raw: { width: W, height: H, channels: 4 } }),
    format === 'jpg' ? 'jpeg' : format
  );
  const result = await persistEdit(
    id,
    row,
    encoded.data,
    { width: encoded.info.width, height: encoded.info.height },
    {
      saveMode: opts.saveMode === 'copy' ? 'copy' : 'overwrite',
      // 另存时没指定目录就放到原图旁边，别让用户为了一个按钮再开一次目录选择器
      targetDir: opts.targetDir || (opts.saveMode === 'copy' ? path.dirname(row.abs_path) : undefined),
      addToLibrary: !!opts.addToLibrary,
    },
    '擦除修复'
  );
  return { ...result, coverage: Math.round(coverage * 1000) / 1000 };
}
