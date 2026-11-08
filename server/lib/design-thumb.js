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
import { extOf, isDesignExt, isHeifExt, isRawExt } from './media-kind.js';
import { decodePsdComposite } from './psd-decode.js';
import { readEmbeddedPreviews } from './raw-preview.js';
import { heifSharp } from './heif.js';

/** 打包成 zip 的设计文件：预览图在固定几个位置 */
const ZIP_PREVIEW_EXTS = new Set(['sketch', 'xd', 'fig']);

export { isRawExt };

export function isZipPreviewExt(ext) {
  return ZIP_PREVIEW_EXTS.has(String(ext || '').toLowerCase());
}

/** 设计文件（PSD/PSB/AI/EPS/Sketch…）：sharp 解不了，同样靠自带预览 */
export function isDesignPreviewExt(ext) {
  return isDesignExt(ext);
}

/** 需要走「抽预览」而不是 sharp 的格式（含 HEIC：sharp 没编 HEVC 解码器） */
export function isDesignLikePath(absPath) {
  const e = extOf(absPath);
  return isRawExt(e) || isDesignExt(e) || isHeifExt(e);
}

/**
 * 读一段 JPEG 的采样精度（SOF 段里第一个字节）。
 * 8 = 普通 JPEG，12/14/16 = 无损/高精度 JPEG（libvips 明确不支持）。
 */
function jpegPrecision(buf, start, end) {
  let i = start + 2;
  while (i < end - 4) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = buf[i + 1];
    if (m === 0xff) {
      i += 1; // 填充字节
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xda) return 0; // 到 SOS 还没见到 SOF：当未知
    if (i + 4 > end) return 0;
    const len = buf.readUInt16BE(i + 2);
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15（排除 DHT=C4 / JPG=C8 / DAC=CC）
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return buf[i + 4];
    }
    if (len < 2) return 0;
    i += 2 + len;
  }
  return 0;
}

/**
 * 找出文件里最大的一段 **8 位** JPEG（SOI FFD8FF … EOI FFD9）。
 *
 * 为什么必须筛精度：Canon CR2 / Nikon NEF 里最大那段 JPEG 往往是「无损压缩的原始
 * 数据」——它是 14 位精度的 JPEG，libvips 直接报 `Unsupported JPEG data precision 14`。
 * 以前只按体积取最大，于是所有 CR2 都提取失败、缩略图永远没有（卡片显示「文件缺失」）。
 * 相机真正用来预览的那张是 8 位、通常 1~3MB，筛掉高精度段后就只剩它。
 */
export function jpegCandidates(buf) {
  const out = [];
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
      const precision = jpegPrecision(buf, i, found);
      if (len >= 1024 && (precision === 8 || precision === 0)) out.push(buf.subarray(i, found + 2));
      i = found + 2;
    } else {
      i++;
    }
  }
  // 体积降序：相机预览通常最大；万一还有更小的可用段，后面再试
  return out.sort((a, b) => b.length - a.length);
}

/** 最大的那一段（兼容旧调用方） */
export function largestJpeg(buf) {
  return jpegCandidates(buf)[0] || null;
}

/** 依次尝试候选段，返回第一段真正能解出宽高的 sharp 实例 */
async function firstDecodable(candidates) {
  for (const c of candidates.slice(0, 6)) {
    try {
      const s = sharp(c, { failOn: 'none' });
      const m = await s.metadata();
      if (m.width && m.height) return s;
    } catch {
      /* 这一段坏了，试下一段 */
    }
  }
  return null;
}

/** DNG 里那种「未压缩 RGB 8bit」的整幅预览：直接当原始像素交给 sharp */
async function firstRawDecodable(segments) {
  for (const seg of segments.slice(0, 3)) {
    try {
      const s = sharp(seg.data, { raw: { width: seg.width, height: seg.height, channels: 3 } });
      const m = await s.metadata();
      if (m.width && m.height) return s;
    } catch {
      /* 尺寸/通道对不上，跳过 */
    }
  }
  return null;
}

/** RAW 动辄 40~80MB：预览总在文件前部，只读前 48MB 就够，别整文件读进内存 */
const RAW_SCAN_BYTES = 48 * 1024 * 1024;

function readHead(file, bytes = RAW_SCAN_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
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
  } else if (isHeifExt(ext)) {
    // iPhone 的 HEIC：sharp 解不了（libvips 没编 HEVC），走 WASM 版 libheif
    try {
      input = await heifSharp(absPath);
    } catch (err) {
      console.warn('[design-thumb] HEIC 解码失败', path.basename(absPath), err?.message);
    }
  }

  if (!input && !isHeifExt(ext)) {
    // 先按容器结构精确定位（TIFF 目录 / RAF 头 / CR3 盒子）：只读目录和预览那几段
    try {
      const { jpeg, rgb } = await readEmbeddedPreviews(absPath, ext);
      input = await firstDecodable(jpeg);
      if (!input) input = await firstRawDecodable(rgb);
    } catch (err) {
      console.warn('[design-thumb] 容器解析失败，改用扫描', path.basename(absPath), err?.message);
    }
  }

  if (!input && !isHeifExt(ext)) {
    // 兜底：盲扫内嵌 JPEG（X3F / MRW 这类结构特殊的老格式就靠这一手）。
    // RAW 只读文件头部（预览在里面，没必要把 80MB 全读进内存）
    try {
      const buf = isRawExt(ext) ? readHead(absPath) : fs.readFileSync(absPath);
      input = await firstDecodable(jpegCandidates(buf));
      if (!input && buf !== undefined) {
        console.warn('[design-thumb] 没有可用预览', path.basename(absPath));
      }
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
