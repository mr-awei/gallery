import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { detectFocus, parseRatioSpec } from '../server/lib/focus.js';

/**
 * 焦点检测的「通用性」测试。
 *
 * 整改前肤色是权重最高的一项（0.9，比梯度还高），等于变相「人脸优先」：
 * 暖色场景（沙地、木地板、红砖、火烧云）会被整片当成人脸拽走，
 * 主体被裁掉三分之一；没有人脸的图则只剩半套线索。
 *
 * 这里用合成图把各种图型钉死：主体可以是蓝的、绿的、灰的、红的（一律不靠肤色），
 * 断言也换成「主体被框保留了多少」这种硬指标 —— 只检查「框大概在中间」是挡不住退化的。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemvault-focus-'));
const W = 800;
const H = 600;

async function png(svg, name) {
  const file = path.join(dir, name);
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

/** 主体被框完整保留的比例（1 = 一点没切） */
function recall(rect, subj) {
  const ax0 = rect.x * W;
  const ay0 = rect.y * H;
  const ax1 = (rect.x + rect.w) * W;
  const ay1 = (rect.y + rect.h) * H;
  const [sx, sy, sw, sh] = subj;
  const ix = Math.max(0, Math.min(ax1, sx + sw) - Math.max(ax0, sx));
  const iy = Math.max(0, Math.min(ay1, sy + sh) - Math.max(ay0, sy));
  return (ix * iy) / (sw * sh);
}

const centerOf = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

test('parseRatioSpec：常见写法与非法输入', () => {
  assert.deepEqual(parseRatioSpec('2:3'), [2, 3]);
  assert.deepEqual(parseRatioSpec('2/3'), [2, 3]);
  assert.deepEqual(parseRatioSpec('0.75'), [0.75, 1]);
  assert.equal(parseRatioSpec(''), null);
  assert.equal(parseRatioSpec('abc'), null);
  assert.equal(parseRatioSpec('0:1'), null);
});

test('白底商品图：蓝色主体（无肤色）也要完整留下', async () => {
  const file = await png(
    `<svg width="${W}" height="${H}">
       <rect width="${W}" height="${H}" fill="#f7f7f7"/>
       <rect x="480" y="340" width="220" height="160" fill="#2f6fd0"/>
     </svg>`,
    'product-blue.png'
  );
  const r = await detectFocus(file, { ratioW: 1, ratioH: 1 });
  assert.ok(recall(r.rect, [480, 340, 220, 160]) > 0.99, `主体被切: ${JSON.stringify(r.rect)}`);
  // 主体在右下，框不能还杵在正中
  assert.ok(centerOf(r.rect).x > 0.45, `框没往主体偏: ${JSON.stringify(r.rect)}`);
});

test('暖色场景不当成人脸：沙地上蓝物体不能被肤色拽走', async () => {
  const file = await png(
    `<svg width="${W}" height="${H}">
       <rect width="${W}" height="${H}" fill="#d9a15b"/>
       <rect x="90" y="230" width="170" height="150" fill="#2f6fd0"/>
     </svg>`,
    'warm-scene.png'
  );
  const r = await detectFocus(file, { ratioW: 1, ratioH: 1 });
  // 整改前这里会整片沙地吃满肤色权重，主体只剩 66%
  assert.ok(recall(r.rect, [90, 230, 170, 150]) > 0.99, `主体被切: ${JSON.stringify(r.rect)}`);
});

test('深底绿色主体（无肤色）落在左上', async () => {
  const file = await png(
    `<svg width="${W}" height="${H}">
       <rect width="${W}" height="${H}" fill="#242428"/>
       <rect x="100" y="60" width="200" height="220" fill="#3fa34d"/>
     </svg>`,
    'dark-green.png'
  );
  const r = await detectFocus(file, { ratioW: 1, ratioH: 1 });
  assert.ok(recall(r.rect, [100, 60, 200, 220]) > 0.99, `主体被切: ${JSON.stringify(r.rect)}`);
  assert.ok(centerOf(r.rect).x < 0.6, `框没往主体偏: ${JSON.stringify(r.rect)}`);
});

test('白底浅灰主体（低饱和低对比）也能定位', async () => {
  const file = await png(
    `<svg width="${W}" height="${H}">
       <rect width="${W}" height="${H}" fill="#ffffff"/>
       <rect x="520" y="300" width="220" height="200" fill="#d2d4da"/>
     </svg>`,
    'white-grey.png'
  );
  const r = await detectFocus(file, { ratioW: 1, ratioH: 1 });
  assert.ok(recall(r.rect, [520, 300, 220, 200]) > 0.99, `主体被切: ${JSON.stringify(r.rect)}`);
});

test('人像：肤色仍是加分项', async () => {
  const file = await png(
    `<svg width="${W}" height="${H}">
       <rect width="${W}" height="${H}" fill="#9db4cc"/>
       <ellipse cx="560" cy="300" rx="120" ry="150" fill="#e8b48f"/>
       <ellipse cx="560" cy="200" rx="110" ry="80" fill="#3a2a22"/>
     </svg>`,
    'portrait.png'
  );
  const r = await detectFocus(file, { ratioW: 2, ratioH: 3 });
  assert.ok(recall(r.rect, [440, 150, 240, 300]) > 0.99, `脸被切: ${JSON.stringify(r.rect)}`);
});

test('横幅裁 16:9：主体在下缘要往下让，在上缘要往上让', async () => {
  const mk = (y, name) =>
    png(
      `<svg width="${W}" height="${H}">
         <rect width="${W}" height="${H}" fill="#eef1f5"/>
         <rect x="300" y="${y}" width="200" height="170" fill="#1f7a5a"/>
       </svg>`,
      name
    );
  const low = await detectFocus(await mk(380, 'low.png'), { ratioW: 16, ratioH: 9 });
  const high = await detectFocus(await mk(40, 'high.png'), { ratioW: 16, ratioH: 9 });
  assert.ok(recall(low.rect, [300, 380, 200, 170]) > 0.99, `下方主体被切: ${JSON.stringify(low.rect)}`);
  assert.ok(recall(high.rect, [300, 40, 200, 170]) > 0.99, `上方主体被切: ${JSON.stringify(high.rect)}`);
  assert.ok(low.rect.y > high.rect.y + 0.1, `上下主体结果没拉开: low=${low.rect.y} high=${high.rect.y}`);
});

test('截图：整片文字区要被完整收进来，而不是挑中间一小块', async () => {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push(`<rect x="80" y="${100 + i * 34}" width="640" height="18" rx="3" fill="#1b1b1b"/>`);
  }
  const file = await png(
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${rows.join('')}</svg>`,
    'screenshot.png'
  );
  const r = await detectFocus(file, { ratioW: 4, ratioH: 3 });
  assert.ok(r.rect.w > 0.9 && r.rect.h > 0.9, `文字区没被整体覆盖: ${JSON.stringify(r.rect)}`);
});

test('纯色图：没有信息就老实居中', async () => {
  const file = await png(
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#808080"/></svg>`,
    'flat.png'
  );
  const r = await detectFocus(file, { ratioW: 1, ratioH: 1 });
  const c = centerOf(r.rect);
  assert.ok(Math.abs(c.x - 0.5) < 0.02 && Math.abs(c.y - 0.5) < 0.02, `纯色图没居中: ${JSON.stringify(r.rect)}`);
});

test('横向长图裁 9:16：窗口比例与请求一致', async () => {
  const file = await png(
    `<svg width="1200" height="400">
       <rect width="1200" height="400" fill="#dfe7f2"/>
       <rect x="900" y="140" width="180" height="150" fill="#d94f2b"/>
     </svg>`,
    'wide.png'
  );
  const r = await detectFocus(file, { ratioW: 9, ratioH: 16 });
  const px = r.rect.w * 1200;
  const py = r.rect.h * 400;
  assert.ok(Math.abs(px / py - 9 / 16) < 0.05, `窗口比例不对: ${JSON.stringify(r.rect)}`);
  assert.ok(r.rect.x > 0.5, `没往右侧主体偏: ${JSON.stringify(r.rect)}`);
});
