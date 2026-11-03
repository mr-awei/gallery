/**
 * 设计文件 / RAW 的缩略图提取。
 *
 * sharp 读不了 PSD、Sketch、RAW，但这些格式**自己就带着一张预览图**：
 *  - PSD/PSB：合成图（composite）能直接解出来，@webtoon/psd 纯 JS 解析
 *  - Sketch / XD / Figma：本质是 zip，里面就有 previews/preview.png
 *  - RAW：传感器数据前面塞了一张全尺寸 JPEG 预览（相机生成）
 *  - AI / EPS：PDF/PostScript 兼容格式里通常嵌了位图或缩略图
 *
 * 所以不需要 Photoshop、ImageMagick、dcraw 这些外部二进制 —— 只做「把预览图
 * 找出来，交给 sharp 缩放」。找不到就返回 null，由调用方决定降级（不生成缩略图）。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { extOf } from './media-kind.js';
import { decodePsdComposite } from './psd-decode.js';

/** 相机 RAW：都遵循 TIFF/ISO-BMFF 容器，内部带 JPEG 预览 */
const RAW_EXTS = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'sr2', 'srf', 'dng', 'orf', 'raf',
  'rw2', 'pef', 'srw', '3fr', 'erf', 'kdc', 'mrw', 'x3f', 'rwl', 'iiq',
]);

/** 打包成 zip 的设计文件：预览图在固定几个位置 */
const ZIP_PREVIEW_EXTS = new Set(['sketch', 'xd', 'fig']);

export function isRawExt(ext) {
  return RAW_EXTS.has(String(ext || '').toLowerCase());
}

export function isZipPreviewExt(ext) {
  return ZIP_PREVIEW_EXTS.has(String(ext || '').toLowerCase());
}

/**
 * 找出文件里最大的一段 JPEG（SOI FFD8FF … EOI FFD9）。
 * RAW 的预览、AI/EPS 内嵌位图都靠这个兜底；< 8KB 的当图标忽略。
 */
export function largestJpeg(buf) {
  let best = null;
  let bestLen = 0;
  let i = 0;
  const n = buf.length;
  while (i < n - 3) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      let j = i + 2;
      let found = -1;
      while (j < n - 1) {
        if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
          found = j;
          break;
        }
        j++;
      }
      // 后面没有 EOI 了：再找也是残段
      if (found === -1) break;
      const len = found + 2 - i;
      if (len > bestLen) {
        bestLen = len;
        best = buf.subarray(i, found + 2);
      }
      i = found + 2;
    } else {
      i++;
    }
  }
  // 1KB 以下基本是文件尾部的残段或图标，拿去当预览只会得到糊图
  return bestLen >= 1024 ? best : null;
}

/** PSD/PSB：解出合成图（RGBA）交给 sharp */
async function psdSharp(file) {
  const { default: Psd } = await import('@webtoon/psd');
  const b = fs.readFileSync(file);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const psd = Psd.parse(ab);
  const data = await psd.composite();
  if (!data || !psd.width || !psd.height) return null;
  const ch = data.length / (psd.width * psd.height);
  if (ch !== 3 && ch !== 4) return null;
  const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return sharp(raw, { raw: { width: psd.width, height: psd.height, channels: ch } });
}

/** Sketch / XD / Figma：从 zip 里拿画布预览 */
async function zipSharp(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const preferred = [
    'previews/preview.png',
    'preview.png',
    'thumbnail.png',
    'previews/preview.jpg',
    'previews/preview.jpeg',
  ];
  for (const name of preferred) {
    const f = zip.file(name);
    if (f) return sharp(Buffer.from(await f.async('nodebuffer')), { failOn: 'none' });
  }
  // 兜底：zip 里最大的那张图（候选最多看 40 个，避免解压一整个设计文件）
  const cands = Object.keys(zip.files)
    .filter((n) => /\.(png|jpe?g)$/i.test(n) && !zip.files[n].dir)
    .slice(0, 40);
  let bestBuf = null;
  for (const n of cands) {
    const b = Buffer.from(await zip.file(n).async('nodebuffer'));
    if (!bestBuf || b.length > bestBuf.length) bestBuf = b;
  }
  return bestBuf ? sharp(bestBuf, { failOn: 'none' }) : null;
}

/**
 * 生成设计文件 / RAW 的缩略图。
 * @returns {Promise<{buffer: Buffer, width: number, height: number}|null>} 原始像素尺寸（不是缩略图尺寸）
 */
export async function designThumbJpeg(absPath, { width = 640, quality = 80 } = {}) {
  if (!absPath) return null;
  const ext = extOf(absPath);
  if (!ext) return null;

  let input = null;
  if (ext === 'psd' || ext === 'psb') {
    // 先走自研解码（合成图就在 Image Data 段，快且对异常文件更宽容），
    // 解不出来再交给 @webtoon/psd（支持图层/索引色等更复杂的情况）
    try {
      const d = decodePsdComposite(fs.readFileSync(absPath));
      if (d) input = sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } });
    } catch (err) {
      console.warn('[design-thumb] PSD 自研解码失败', path.basename(absPath), err?.message);
    }
    if (!input) {
      try {
        input = await psdSharp(absPath);
      } catch (err) {
        console.warn('[design-thumb] PSD 库解析失败，改用内嵌 JPEG', path.basename(absPath), err?.message);
      }
    }
  } else if (isZipPreviewExt(ext)) {
    try {
      input = await zipSharp(absPath);
    } catch (err) {
      console.warn('[design-thumb] 压缩包预览提取失败', path.basename(absPath), err?.message);
    }
  }

  if (!input) {
    // RAW / AI / EPS / 其他：扫内嵌 JPEG
    try {
      const jpg = largestJpeg(fs.readFileSync(absPath));
      if (jpg) input = sharp(jpg, { failOn: 'none' });
    } catch (err) {
      console.warn('[design-thumb] 内嵌预览扫描失败', path.basename(absPath), err?.message);
    }
  }
  if (!input) return null;

  try {
    const meta = await input.metadata();
    const buffer = await input
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    return { buffer, width: meta.width || 0, height: meta.height || 0 };
  } catch (err) {
    console.warn('[design-thumb] 缩略图编码失败', path.basename(absPath), err?.message);
    return null;
  }
}
