import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'build');
fs.mkdirSync(OUT, { recursive: true });

const SIZES = [256, 128, 64, 48, 32, 16];

const svg = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6a2cf5"/>
      <stop offset="0.55" stop-color="#a23cf0"/>
      <stop offset="1" stop-color="#f857a6"/>
    </linearGradient>
    <linearGradient id="tuku" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#ffd9f2"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="14" y="14" width="484" height="484" rx="100" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="10"/>
  <g transform="translate(256 252)">
    <path d="M0 -168 L104 -44 L0 178 L-104 -44 Z" fill="url(#tuku)"/>
    <path d="M-104 -44 L104 -44 L0 178 Z" fill="#e7b6ff" opacity="0.45"/>
    <path d="M0 -168 L104 -44 L0 178 L-104 -44 Z" fill="none" stroke="#ffffff" stroke-width="12" stroke-opacity="0.95"/>
    <path d="M0 -168 L0 178 M-104 -44 L104 -44" stroke="#ffffff" stroke-width="6" stroke-opacity="0.55"/>
    <path d="M-104 -44 L0 -8 L104 -44 M0 -8 L0 178" stroke="#ffffff" stroke-width="5" stroke-opacity="0.4"/>
  </g>
  <g transform="translate(372 150)" fill="#ffd166">
    <path d="M0 -26 L9 -8 L28 -8 L13 4 L18 23 L0 11 L-18 23 L-13 4 L-28 -8 L-9 -8 Z" opacity="0.9"/>
  </g>
</svg>`;

async function pngBuffer(size) {
  return sharp(Buffer.from(svg(size)))
    .resize(size, size)
    .png()
    .toBuffer();
}

// 单尺寸大图（用于窗口 / 网页）
const main = await pngBuffer(512);
fs.writeFileSync(path.join(OUT, 'icon.png'), main);

// 多尺寸 ICO（直接内嵌 PNG，Windows Vista+ 支持）
const images = [];
for (const s of SIZES) images.push(await pngBuffer(s));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const dirEntries = [];
for (let i = 0; i < images.length; i++) {
  const data = images[i];
  const size = SIZES[i];
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height
  e.writeUInt8(0, 2); // colors
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(data.length, 8); // bytes in res
  e.writeUInt32LE(offset, 12); // image offset
  offset += data.length;
  dirEntries.push(e);
}

const ico = Buffer.concat([header, ...dirEntries, ...images]);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);

console.log('icon.png', main.length, 'bytes');
console.log('icon.ico', ico.length, 'bytes,', images.length, 'sizes:', SIZES.join(','));
