#!/usr/bin/env node
/**
 * 手工验收脚本：直接把真实素材渲染成拼图，用来肉眼比对版式。
 *
 * 用法：
 *   node scripts/manual/stitch-preview.mjs --template cinema-trio --n 3 --out tmp/cinema-trio.jpg
 *   node scripts/manual/stitch-preview.mjs --template eight-hero --n 9 --crops auto --gap 24
 *
 * 只读库、只写 out 文件，不动任何素材。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { renderTemplate } from '../../server/lib/stitch.js';
import { templateById } from '../../server/lib/stitch-templates.js';

const argv = process.argv.slice(2);
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const lib = argOf('lib', 'E:/邓紫棋/.tuku/lib_mw3jtuhx/gallery.db');
const n = Number(argOf('n', '3')) || 3;
const tplId = argOf('template', 'cinema-trio');
const out = argOf('out', `tmp/stitch-${tplId}.jpg`);
const gap = argOf('gap', '');
const crops = argOf('crops', '');
const title = argOf('title', '');
const sub = argOf('subtitle', '');
const billing = argOf('billing', '');
const width = Number(argOf('width', '1400')) || 1400;

const db = new DatabaseSync(lib, { readOnly: true });
// 挑不同宽高的图，才看得出裁切是否合理
const rows = db
  .prepare(
    `SELECT id, abs_path, title AS name, width, height FROM images
     WHERE abs_path IS NOT NULL
       AND (lower(abs_path) LIKE '%.jpg' OR lower(abs_path) LIKE '%.jpeg' OR lower(abs_path) LIKE '%.png')
     ORDER BY (width * 1.0 / MAX(height, 1)) DESC LIMIT ?`
  )
  .all(n + 6);
db.close();

if (rows.length < n) {
  console.error(`库里可用素材只有 ${rows.length} 张，不够 ${n} 张`);
  process.exit(1);
}

// 取比例跨度大的一组：最宽 + 最窄 + 中间
const picked = [];
const step = Math.max(0, rows.length - n) / Math.max(1, n - 1);
for (let i = 0; i < n; i++) picked.push(rows[Math.min(rows.length - 1, Math.round(i * step))]);
const files = picked.filter((r) => fs.existsSync(r.abs_path));
if (!files.length) {
  console.error('选中的素材文件都不在盘上');
  process.exit(1);
}

const tpl = templateById(tplId);
if (!tpl) {
  console.error('模板不存在:', tplId);
  process.exit(1);
}

const t0 = Date.now();
const r = await renderTemplate(files, tpl, {
  outWidth: width,
  gap: gap === '' ? undefined : Number(gap),
  seamless: argOf('seamless', '') === '' ? undefined : argOf('seamless', ''),
  border: argOf('border', '') === '' ? undefined : Number(argOf('border')),
  shadow: argOf('shadow', '') === '' ? undefined : Number(argOf('shadow')),
  crops,
  title,
  subtitle: sub,
  billing,
  format: path.extname(out).toLowerCase() === '.png' ? 'png' : 'jpeg',
  quality: 92,
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, r.buffer);
console.log(
  `${out}  ${r.width}x${r.height}  ${(r.buffer.length / 1024).toFixed(0)}KB  ${Date.now() - t0}ms  count=${r.count}`
);
