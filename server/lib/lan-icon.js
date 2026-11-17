// @ts-check
/**
 * PWA 图标：不依赖 sharp，也不往仓库塞二进制。
 * 用 zlib 直接编码 RGBA PNG，保证在任何运行形态（含 utilityProcess / asar）下都能出图，
 * 而且输出完全确定、可单测。
 */
import { deflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.alloc(4 + data.length);
  crcInput.write(type, 0, 'ascii');
  data.copy(crcInput, 4);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/** 圆角矩形 + 白色「相框/山峰」图形；坐标全部按比例算，尺寸无关 */
function pixel(x, y, size) {
  const u = x / size;
  const v = y / size;
  const r = 0.22;
  // 圆角：四个角用 1/4 圆裁掉
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return [0, 0, 0, 0];

  const frame = u > 0.2 && u < 0.8 && v > 0.24 && v < 0.76;
  const inner = u > 0.25 && u < 0.75 && v > 0.29 && v < 0.71;
  if (frame && !inner) return [255, 255, 255, 255];
  if (inner) {
    // 一座小山 + 一个太阳：白色实心几何，小尺寸下也能认出来
    const sun = (u - 0.63) ** 2 + (v - 0.42) ** 2 < 0.004;
    const hill = v > 0.71 - 0.4 * (u - 0.25) && u < 0.52;
    const hill2 = v > 0.71 - 0.3 * (0.75 - u) && u >= 0.52;
    if (sun || hill || hill2) return [255, 255, 255, 255];
    return [255, 77, 141, 255];
  }
  return [255, 77, 141, 255];
}

/**
 * 生成 size×size 的 PNG。
 * @param {number} size
 * @returns {Buffer}
 */
export function lanIconPng(size = 192) {
  const n = Math.max(16, Math.min(1024, Math.trunc(size)));
  const stride = n * 4 + 1;
  const raw = Buffer.alloc(stride * n);
  for (let y = 0; y < n; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter type: none
    for (let x = 0; x < n; x += 1) {
      const [r, g, b, a] = pixel(x, y, n);
      const p = row + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
