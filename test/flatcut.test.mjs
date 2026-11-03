import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { removeFlatBackground } from '../server/lib/flatcut.js';

/**
 * 纯底图抠图：白底/灰底/彩底棚拍图不该依赖 AI 模型。
 *
 * 最容易做错的一点是「所有接近背景色的像素都算背景」——那样主体内部的
 * 白色高光、镜面反射会被打出洞（保温桶、白鞋、瓷器全中招）。
 * 这里专门用「蓝框里套一块白」的图把它钉住。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemvault-flatcut-'));
const W = 800;
const H = 600;

async function png(svg, name) {
  const file = path.join(dir, name);
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

async function run(svg, name) {
  const r = await removeFlatBackground(await png(svg, name));
  const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const p = (y * info.width + x) * 4;
    return { r: data[p], g: data[p + 1], b: data[p + 2], a: data[p + 3] };
  };
  return { ...r, info, px };
}

test('白底图：背景透明、主体保留、尺寸不变', async () => {
  const r = await run(
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><rect x="200" y="150" width="400" height="300" fill="#2f6fd0"/></svg>`,
    'white.png'
  );
  assert.equal(r.info.width, W);
  assert.equal(r.info.height, H);
  assert.equal(r.info.channels, 4);
  assert.ok(r.px(5, 5).a < 12, `角落应该透明: ${r.px(5, 5).a}`);
  assert.ok(r.px(400, 300).a > 240, `主体应该保留: ${r.px(400, 300).a}`);
  // 400×300 / (800×600) = 25%
  assert.ok(Math.abs(r.coverage - 0.25) < 0.02, `前景占比不对: ${r.coverage}`);
  assert.equal(r.warning, '');
});

test('灰底图（不写死白色）', async () => {
  const r = await run(
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#8a8a8a"/><rect x="150" y="150" width="300" height="300" fill="#e0b23c"/></svg>`,
    'grey.png'
  );
  assert.ok(r.px(5, 5).a < 12, `灰底角落应该透明: ${r.px(5, 5).a}`);
  assert.ok(r.px(300, 300).a > 240, `主体应该保留: ${r.px(300, 300).a}`);
});

test('彩底图（蓝底 / 绿幕这类也能抠）', async () => {
  const r = await run(
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#1e3a8a"/><circle cx="400" cy="300" r="160" fill="#f0e6d2"/></svg>`,
    'blue.png'
  );
  assert.ok(r.px(5, 5).a < 12, `蓝底角落应该透明: ${r.px(5, 5).a}`);
  assert.ok(r.px(400, 300).a > 240, `主体应该保留: ${r.px(400, 300).a}`);
});

test('主体内部的白高光不能被挖洞（只吃与边缘连通的背景）', async () => {
  const r = await run(
    `<svg width="${W}" height="${H}">
       <rect width="${W}" height="${H}" fill="#ffffff"/>
       <rect x="200" y="150" width="400" height="300" fill="#2f6fd0"/>
       <rect x="320" y="230" width="160" height="140" fill="#ffffff"/>
     </svg>`,
    'highlight.png'
  );
  assert.ok(r.px(5, 5).a < 12, '外侧背景应该透明');
  // 框内那块白如果被当成背景，这里会是 0
  assert.ok(r.px(400, 300).a > 240, `主体内部的白色高光被挖掉了: ${r.px(400, 300).a}`);
  // 蓝色边框仍在
  assert.ok(r.px(230, 300).a > 240, '边框应该保留');
});

test('主体贴边：贴住画布边缘的部分不被误删', async () => {
  const r = await run(
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><rect x="0" y="100" width="${W}" height="400" fill="#c0392b"/></svg>`,
    'edge.png'
  );
  assert.ok(r.px(400, 300).a > 240, '贴边主体应该保留');
  assert.ok(r.px(400, 20).a < 12, '上边白底应该透明');
  assert.ok(r.px(400, 580).a < 12, '下边白底应该透明');
});

test('背景不均匀时给出 warning，而不是假装成功', async () => {
  const r = await run(
    `<svg width="${W}" height="${H}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9b9b9b"/>
       </linearGradient></defs>
       <rect width="${W}" height="${H}" fill="url(#g)"/>
       <circle cx="400" cy="300" r="120" fill="#2f6fd0"/>
     </svg>`,
    'gradient.png'
  );
  assert.ok(r.warning.length > 0, '渐变背景应该提示抠不干净');
});

test('纯色图（没有主体）：提醒而不是产出全透明', async () => {
  const r = await run(`<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/></svg>`, 'blank.png');
  assert.ok(r.coverage < 0.01, `不该抠出主体: ${r.coverage}`);
  assert.ok(r.warning.length > 0, '应该提示没抠出主体');
});
