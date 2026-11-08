/**
 * 生成 Chrome 扩展图标（extension/icon16|32|48|128.png）。
 *
 * 为什么需要：manifest 里 `icons: {}` 是空的，`icon48.png` 也不存在，
 * 于是工具栏只显示浏览器的灰色拼图占位，`chrome.notifications.create({ iconUrl: 'icon48.png' })`
 * 拿不到图 —— 采集完成的通知要么不弹，要么弹一个没有图标的空白条。
 *
 * 用法：node scripts/manual/gen-extension-icons.mjs
 * 需要 devDependency 里的 sharp（项目自带，服务端图片管线就用它）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'extension');
const SIZES = [16, 32, 48, 128];

// 128×128 设计稿：渐变圆角底 + 白色相框（小圆点当太阳、两个三角当山）
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff4d8d"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="128" height="128" rx="30" fill="url(#bg)"/>
  <rect x="24" y="32" width="80" height="64" rx="12" fill="#ffffff"/>
  <circle cx="45" cy="53" r="7" fill="#ff4d8d"/>
  <path d="M33 88 L56 60 L74 88 Z" fill="#7c3aed"/>
  <path d="M66 88 L84 64 L97 88 Z" fill="#a855f7"/>
</svg>`;

for (const size of SIZES) {
  const dest = path.join(OUT_DIR, `icon${size}.png`);
  // 先在高分辨率下栅格化再缩：16px 直接渲染会糊成一团
  await sharp(Buffer.from(SVG)).resize(size, size, { fit: 'cover' }).png().toFile(dest);
  console.log(`[icons] ${dest}`);
}
console.log('[icons] 完成：把 icon16/32/48/128.png 写进 manifest.json 的 icons');
