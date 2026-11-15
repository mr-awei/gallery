// @ts-check
/**
 * 生成应用图标（窗口/任务栏/安装包）与浏览器扩展图标。
 *
 * 设计约束（2026-11 重画，替换原来的紫色宝石）：
 * - 一个方块、最多三个形状。16px 的任务栏尺寸下还要认得出——渐变宝石 + 描边 + 星点
 *   在 16px 会糊成一枚粉色色块，这就是上一版「丑」的根因；
 * - 图形语言跟界面一致：品牌渐变（#ff4d8d → #a855f7）+ 白色相片叠层；
 * - 不用「心形」也不写字：心形已被收藏功能占用，字标在小尺寸不可读。
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
fs.mkdirSync(OUT, { recursive: true });

const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const EXT_SIZES = [16, 32, 48, 128];

/**
 * @param {number} s 像素尺寸（只影响输出位图，坐标始终在 512 视口里）
 * @param {{simple?: boolean}} [opt] 小尺寸去掉叠层与高光，只留「相片 + 山 + 太阳」
 */
function svg(s, opt = {}) {
  const simple = !!opt.simple;
  return `<svg width="${s}" height="${s}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff4d8d"/>
      <stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f3ecff"/>
    </linearGradient>
    <linearGradient id="hill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f43f5e"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
    <clipPath id="card"><rect x="-124" y="-130" width="248" height="260" rx="36"/></clipPath>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  ${simple ? '' : '<rect x="10" y="10" width="492" height="492" rx="107" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="6"/>'}
  <g transform="translate(254 258) scale(${simple ? 1.22 : 1})">
    ${simple ? '' : '<rect x="-92" y="-142" width="212" height="228" rx="34" transform="rotate(14)" fill="#ffffff" fill-opacity="0.5"/>'}
    <g transform="translate(-6 4)">
      <rect x="-124" y="-130" width="248" height="260" rx="36" fill="url(#sky)"/>
      <g clip-path="url(#card)">
        ${simple ? '' : '<circle cx="-52" cy="-58" r="21" fill="#ff4d8d"/>'}
        <path d="M-124 130 V58 L-50 -20 L4 36 L38 0 L124 86 V130 Z" fill="url(#hill)"/>
      </g>
    </g>
  </g>
</svg>`;
}

/** @param {number} size @param {boolean} simple */
async function pngBuffer(size, simple = false) {
  return sharp(Buffer.from(svg(size, { simple })), { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// 窗口与网页用的大图
fs.writeFileSync(path.join(OUT, 'icon.png'), await pngBuffer(512));

// 多尺寸 ICO（直接内嵌 PNG，Windows Vista+ 支持）
/** @param {number[]} sizes */
async function buildIco(sizes) {
  const images = [];
  for (const s of sizes) images.push(await pngBuffer(s, s <= 32));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const dirEntries = [];
  for (let i = 0; i < images.length; i++) {
    const data = images[i];
    const size = sizes[i];
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
  return Buffer.concat([header, ...dirEntries, ...images]);
}

const ico = await buildIco(ICO_SIZES);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);

// 浏览器扩展图标（保持同一套图形语言）
const extDir = path.join(ROOT, 'extension');
for (const s of EXT_SIZES) {
  fs.writeFileSync(path.join(extDir, `icon${s}.png`), await pngBuffer(s, s <= 32));
}

console.log('icon.png 512');
console.log('icon.ico', ico.length, 'bytes,', ICO_SIZES.length, 'sizes:', ICO_SIZES.join(','));
console.log('extension icons:', EXT_SIZES.join(','));
