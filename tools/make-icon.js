import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { APP_ROOT } from '../server/config.js';

/**
 * 生成应用图标：玫红→紫渐变圆角方块 + 白色心形
 * 输出 icon.png（多尺寸）与 Windows 用的 icon.ico
 */

const OUT_DIR = path.join(APP_ROOT, 'build');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const svg = (size) => {
  const r = Math.round(size * 0.22);
  const heart = `M ${size * 0.5} ${size * 0.68}
    C ${size * 0.28} ${size * 0.52}, ${size * 0.18} ${size * 0.42}, ${size * 0.18} ${size * 0.32}
    C ${size * 0.18} ${size * 0.2}, ${size * 0.3} ${size * 0.16}, ${size * 0.38} ${size * 0.22}
    C ${size * 0.44} ${size * 0.26}, ${size * 0.48} ${size * 0.3}, ${size * 0.5} ${size * 0.34}
    C ${size * 0.52} ${size * 0.3}, ${size * 0.56} ${size * 0.26}, ${size * 0.62} ${size * 0.22}
    C ${size * 0.7} ${size * 0.16}, ${size * 0.82} ${size * 0.2}, ${size * 0.82} ${size * 0.32}
    C ${size * 0.82} ${size * 0.42}, ${size * 0.72} ${size * 0.52}, ${size * 0.5} ${size * 0.68} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff4d8d"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
  <path d="${heart}" fill="#ffffff" fill-opacity="0.96"/>
</svg>`;
};

const SIZES = [256, 128, 64, 48, 32, 16];
const pngs = [];
for (const size of SIZES) {
  const buf = await sharp(Buffer.from(svg(size))).png().toBuffer();
  pngs.push({ size, buf });
}
await sharp(pngs[0].buf).toFile(path.join(OUT_DIR, 'icon.png'));
console.log('icon.png', pngs[0].buf.length);

/* 组装 ICO（内嵌 PNG，Windows Vista+ 原生支持） */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const base = i * 16;
    dir.writeUInt8(e.size === 256 ? 0 : e.size, base);
    dir.writeUInt8(e.size === 256 ? 0 : e.size, base + 1);
    dir.writeUInt8(0, base + 2);
    dir.writeUInt8(0, base + 3);
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(32, base + 6);
    dir.writeUInt32LE(e.buf.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += e.buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

const ico = buildIco(pngs);
const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, ico);
console.log('icon.ico', ico.length, '->', icoPath);
