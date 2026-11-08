/**
 * HEIC / HEIF 解码（iPhone 默认拍照格式）。
 *
 * sharp 自带的 libheif 只编了 AV1（AVIF）解码器，没编 HEVC —— 同一张 iPhone 照片
 * 能出 AVIF 缩略图却打不开 HEIC，就是这里缺一块。这里用 libheif-js（WASM 版，
 * 内含 libde265 的 HEVC 解码器）补上，代价是首次解码要加载约 3MB 的 WASM。
 *
 * 只会用来看缩略图/大图预览；不做色彩管理之外的任何加工。
 */
import fs from 'node:fs';
import sharp from 'sharp';

let libPromise = null;

function loadLib() {
  if (!libPromise) {
    libPromise = import('libheif-js/wasm-bundle.js').then((m) => m.default || m);
  }
  return libPromise;
}

/** 文件头是不是 HEIF 家族（ftyp 品牌 heic/heix/hevc/mif1…） */
export function looksLikeHeif(head) {
  if (!head || head.length < 12) return false;
  if (head.toString('latin1', 4, 8) !== 'ftyp') return false;
  const brand = head.toString('latin1', 8, 12);
  return /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|hif1)$/i.test(brand);
}

/**
 * 解码成 RGBA（libheif 只出这个格式）。
 * @returns {Promise<{data: Buffer, width: number, height: number}|null>}
 */
export async function decodeHeifBuffer(buf) {
  if (!buf?.length) return null;
  const libheif = await loadLib();
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let images;
  try {
    images = new libheif.HeifDecoder().decode(bytes);
  } catch {
    // 不是 HEIF / 容器损坏：交给调用方按「格式不支持」处理
    return null;
  }
  if (!images?.length) return null;

  // iPhone 的 HEIC 常带「缩略图 + 主图」两张：取面积最大的那张
  let best = images[0];
  for (const im of images) {
    if (im.get_width() * im.get_height() > best.get_width() * best.get_height()) best = im;
  }
  const width = best.get_width();
  const height = best.get_height();
  if (!width || !height) return null;

  const out = { data: new Uint8ClampedArray(width * height * 4), width, height };
  const filled = await new Promise((resolve) => {
    try {
      best.display(out, (res) => resolve(res || null));
    } catch {
      resolve(null);
    }
  });
  if (!filled?.data?.length) return null;
  return {
    data: Buffer.from(filled.data.buffer, filled.data.byteOffset, filled.data.byteLength),
    width,
    height,
  };
}

/** 从磁盘解码（同步读文件，解码在 WASM 里跑） */
export async function decodeHeifFile(absPath) {
  let buf;
  try {
    buf = await fs.promises.readFile(absPath);
  } catch {
    return null;
  }
  return decodeHeifBuffer(buf);
}

/** 解码后立刻交给 sharp 缩放：12MP 的 RGBA 是 48MB，不能在内存里多留 */
export async function heifSharp(absPath) {
  const img = await decodeHeifFile(absPath);
  if (!img) return null;
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
}
