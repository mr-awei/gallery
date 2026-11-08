/**
 * 纯 JS GIF89a 编码器（视频截帧导出用）。
 *
 * 项目刻意不引入 ffmpeg，也没有 gifenc / omggif 之类的依赖；把视频片段抽成帧后
 * 需要一份能直接在渲染进程跑的 GIF 编码器。这里实现 GIF89a 的最小可用子集：
 *  - 全局颜色表：216 色立方 + 40 级灰阶，5bit/通道查表量化，无抖动（速度优先）
 *  - LZW：变长码 9→12 bit、字典满发 clear code、LSB-first 位打包、255 字节子块
 *  - 动画：Netscape2.0 循环扩展 + 每帧 Graphic Control Extension（1/100 秒延时）
 *  - 全帧覆盖（disposal=1），不处理透明通道：半透明像素按黑底合成
 *
 * 编码结果是 Uint8Array，可直接转 Blob / data URL 交给下载通道。
 */

export interface GifFrame {
  width: number;
  height: number;
  /** RGBA，长度必须是 width*height*4 */
  data: Uint8ClampedArray | Uint8Array;
  /** 本帧停留毫秒；默认 100ms */
  delayMs?: number;
}

const LEVELS = [0, 51, 102, 153, 204, 255] as const;
const COLOR_COUNT = LEVELS.length ** 3; // 216
const GRAY_COUNT = 256 - COLOR_COUNT; // 40

/** 全局颜色表（256×3）。前 216 项是 6×6×6 色立方，后 40 项是灰阶 */
export const GIF_PALETTE: Uint8Array = (() => {
  const p = new Uint8Array(256 * 3);
  let i = 0;
  for (const r of LEVELS) {
    for (const g of LEVELS) {
      for (const b of LEVELS) {
        p[i++] = r;
        p[i++] = g;
        p[i++] = b;
      }
    }
  }
  for (let n = 0; n < GRAY_COUNT; n++) {
    const v = Math.round(((n + 0.5) * 255) / GRAY_COUNT);
    p[i++] = v;
    p[i++] = v;
    p[i++] = v;
  }
  return p;
})();

/** 5bit/通道 → 调色板下标的查找表（32768 项）。避免逐像素做 256 次最近色计算 */
const INDEX_LUT: Uint8Array = (() => {
  const lut = new Uint8Array(32 * 32 * 32);
  for (let r5 = 0; r5 < 32; r5++) {
    const r = Math.round((r5 * 255) / 31);
    for (let g5 = 0; g5 < 32; g5++) {
      const g = Math.round((g5 * 255) / 31);
      for (let b5 = 0; b5 < 32; b5++) {
        const b = Math.round((b5 * 255) / 31);
        const ri = Math.min(5, Math.round(r / 51));
        const gi = Math.min(5, Math.round(g / 51));
        const bi = Math.min(5, Math.round(b / 51));
        const cr = LEVELS[ri];
        const cg = LEVELS[gi];
        const cb = LEVELS[bi];
        const dc = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        const luma = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
        const gn = Math.min(GRAY_COUNT - 1, Math.max(0, Math.floor((luma * GRAY_COUNT) / 256)));
        const gv = Math.round(((gn + 0.5) * 255) / GRAY_COUNT);
        const dg = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
        lut[(r5 << 10) | (g5 << 5) | b5] = dg < dc ? COLOR_COUNT + gn : ri * 36 + gi * 6 + bi;
      }
    }
  }
  return lut;
})();

/** RGBA 帧 → 调色板下标序列（alpha<128 按黑底合成） */
function quantize(frame: GifFrame): Uint8Array {
  const { width, height, data } = frame;
  const out = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    if (data[i + 3] < 128) {
      out[p] = 0;
      continue;
    }
    out[p] = INDEX_LUT[((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)];
  }
  return out;
}

/** 单个图像的 LZW 数据流（不含 minCodeSize / 子块分帧） */
function lzwEncode(indices: Uint8Array): number[] {
  const MIN = 8;
  const CLEAR = 1 << MIN;
  const END = CLEAR + 1;
  let codeSize = MIN + 1;
  let nextCode = END + 1;
  let dict = new Map<number, number>();
  let acc = 0;
  let accBits = 0;
  const bytes: number[] = [];

  const emit = (code: number) => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      bytes.push(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
  };

  emit(CLEAR);
  if (indices.length) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (nextCode === 4096) {
        emit(CLEAR);
        dict = new Map<number, number>();
        codeSize = MIN + 1;
        nextCode = END + 1;
      } else {
        // 解码器在收到上一个码后才扩位，编码器必须同步：加新码前先看是否该扩位
        if (nextCode >= 1 << codeSize) codeSize++;
        dict.set(key, nextCode++);
      }
      prefix = k;
    }
    emit(prefix);
  }
  emit(END);
  if (accBits > 0) bytes.push(acc & 0xff);
  return bytes;
}

function pushU16(out: number[], n: number) {
  out.push(n & 0xff, (n >> 8) & 0xff);
}

function pushAscii(out: number[], s: string) {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
}

function pushSubBlocks(out: number[], data: number[]) {
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
}

/**
 * 把若干 RGBA 帧编码成动画 GIF 字节。
 * 所有帧必须同尺寸；不同尺寸直接抛错，避免产出无法解码的文件。
 */
export function encodeGif(frames: GifFrame[], options: { loop?: number } = {}): Uint8Array {
  if (!frames.length) throw new Error('没有可导出的帧');
  const width = frames[0].width;
  const height = frames[0].height;
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('帧尺寸不合法');
  for (const f of frames) {
    if (f.width !== width || f.height !== height) throw new Error('所有帧尺寸必须一致');
    if (f.data.length < width * height * 4) throw new Error('帧像素数据不完整');
  }

  const out: number[] = [];
  pushAscii(out, 'GIF89a');
  pushU16(out, width);
  pushU16(out, height);
  // GCT=1 / color resolution=7 / sort=0 / GCT size=7(256 项)
  out.push(0xf7, 0x00, 0x00);
  for (const v of GIF_PALETTE) out.push(v);

  // Netscape2.0：loop=0 表示无限循环
  const loop = Number.isFinite(options.loop) ? Math.max(0, Math.floor(options.loop!)) : 0;
  out.push(0x21, 0xff, 0x0b);
  pushAscii(out, 'NETSCAPE2.0');
  out.push(0x03, 0x01);
  pushU16(out, loop);
  out.push(0x00);

  for (const f of frames) {
    const delay = Math.max(2, Math.round((f.delayMs ?? 100) / 10));
    // GCE：disposal=1（保留，下一帧整幅覆盖）、无透明色
    out.push(0x21, 0xf9, 0x04, 0x04);
    pushU16(out, Math.min(65535, delay));
    out.push(0x00, 0x00);
    // Image Descriptor：无局部色表、非隔行
    out.push(0x2c);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, width);
    pushU16(out, height);
    out.push(0x00);
    out.push(8); // LZW minimum code size
    pushSubBlocks(out, lzwEncode(quantize(f)));
  }
  out.push(0x3b); // Trailer
  return Uint8Array.from(out);
}

/** 字节 → data URL（分块，避免大数组一次性展开导致栈溢出） */
export function bytesToDataUrl(bytes: Uint8Array, mime = 'image/gif'): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Blob → data URL */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取导出数据失败'));
    reader.readAsDataURL(blob);
  });
}
