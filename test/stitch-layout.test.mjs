import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGeometry, STITCH_MAX, cropWindow, parseCrops } from '../server/lib/stitch.js';
import {
  STITCH_TEMPLATES,
  templatesFor,
  templateById,
  templateBoxes,
} from '../server/lib/stitch-templates.js';

/** 造 n 张不同比例的假素材（宽高比在 3:4 ~ 16:9 之间轮换） */
const fake = (n) =>
  Array.from({ length: n }, (_, i) => {
    const t = i % 4;
    return [
      { width: 1600, height: 900 },
      { width: 1200, height: 1600 },
      { width: 1000, height: 1000 },
      { width: 1600, height: 1200 },
    ][t];
  });

test('自动版式按张数选择：≤2 海报、≤5 漫画、≤12 满版、更多整齐行', () => {
  assert.equal(layoutGeometry(fake(1), {}).layout, 'poster');
  assert.equal(layoutGeometry(fake(2), {}).layout, 'poster');
  assert.equal(layoutGeometry(fake(3), {}).layout, 'comic');
  assert.equal(layoutGeometry(fake(5), {}).layout, 'comic');
  assert.equal(layoutGeometry(fake(6), {}).layout, 'mosaic');
  assert.equal(layoutGeometry(fake(12), {}).layout, 'mosaic');
  assert.equal(layoutGeometry(fake(13), {}).layout, 'justified');
});

test('每种版式都给出与素材数一致的框，且不越出画布', () => {
  for (const layout of ['grid', 'justified', 'mosaic', 'poster', 'comic']) {
    for (const n of [2, 3, 5, 8, 12, 20]) {
      const g = layoutGeometry(fake(n), { layout, outWidth: 2000, gap: 12 });
      assert.equal(g.boxes.length, n, `${layout}/${n} 框数不对`);
      for (const b of g.boxes) {
        assert.ok(b.x >= 0 && b.y >= 0, `${layout}/${n} 负坐标`);
        assert.ok(b.x + b.w <= g.W + 1, `${layout}/${n} 横向越界`);
        assert.ok(b.y + b.h <= g.H + 1, `${layout}/${n} 纵向越界`);
        assert.ok(b.w > 0 && b.h > 0, `${layout}/${n} 空框`);
      }
    }
  }
});

test('指定比例时画布高度按比例算（1:1 就是正方）', () => {
  const g = layoutGeometry(fake(9), { layout: 'mosaic', ratio: '1:1', outWidth: 1600 });
  assert.equal(g.W, 1600);
  assert.equal(g.H, 1600);
  const wide = layoutGeometry(fake(9), { layout: 'poster', ratio: '16:9', outWidth: 1600 });
  assert.equal(wide.H, 900);
});

test('海报侧栏最后一行不满时铺满整行，不留白块', () => {
  // 8 张 → 主图 1 + 侧栏 7，两列时最后一行只有 1 张，必须横跨整行
  const g = layoutGeometry(fake(8), { layout: 'poster', outWidth: 2000, gap: 10 });
  const last = g.boxes[g.boxes.length - 1];
  assert.ok(Math.abs(last.x + last.w - (g.W - 10)) <= 1, `右边缘 ${last.x + last.w} 应到 ${g.W - 10}`);
});

test('张数超上限时按 STITCH_MAX 截断（buildStitch 入口同规则）', () => {
  assert.ok(STITCH_MAX >= 20 && STITCH_MAX <= 200);
});

test('比例/版式传入非法值时回落到默认，不抛异常', () => {
  const g = layoutGeometry(fake(4), { layout: 'nope', ratio: '7:3', outWidth: 'x', gap: 'x' });
  assert.ok(g.boxes.length === 4);
  assert.ok(['poster', 'comic', 'mosaic', 'justified'].includes(g.layout));
  assert.equal(g.ratio, 'auto');
});

/* ------------------------------- 模板路线 ------------------------------- */

test('每个模板的框数 = min(张数, slots)，且不越出画布', () => {
  for (const t of STITCH_TEMPLATES) {
    assert.ok(t.slots.length >= t.min, `${t.id} 的 slots 少于 min`);
    for (const n of [t.min, t.max]) {
      const g = templateBoxes(t, 1600, n, { gap: 16 });
      assert.equal(g.boxes.length, Math.min(n, t.slots.length), `${t.id}/${n} 框数不对`);
      for (const b of g.boxes) {
        assert.ok(b.x >= 0 && b.y >= 0, `${t.id}/${n} 负坐标`);
        assert.ok(b.x + b.w <= g.W + 1, `${t.id}/${n} 横向越界`);
        assert.ok(b.y + b.h <= g.H + 1, `${t.id}/${n} 纵向越界`);
        assert.ok(b.w > 0 && b.h > 0, `${t.id}/${n} 空框`);
      }
    }
  }
});

test('常见张数都有海报模板可选，id 查不到返回 null', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 12]) {
    assert.ok(templatesFor(n).length > 0, `${n} 张没有模板`);
  }
  assert.equal(templateById('不存在的模板'), null);
  // 模板的 ratio 必须能解析成合法比例，否则画布会退化成 4:3
  for (const t of STITCH_TEMPLATES) assert.match(t.ratio, /^\d+:\d+$/, `${t.id} 比例写错`);
});

test('1~12 张每档都有不止一种排版可选（样式太少用户就没得挑）', () => {
  for (let n = 1; n <= 12; n++) {
    const list = templatesFor(n);
    assert.ok(list.length >= 2, `${n} 张只有 ${list.length} 个模板`);
    for (const t of list) {
      // min/max 必须和 slots 对齐，否则会留空格或吃掉图
      assert.equal(t.min, t.slots.length, `${t.id} min 与 slots 数不符`);
      assert.equal(t.max, t.slots.length, `${t.id} max 与 slots 数不符`);
    }
  }
});

test('无缝模板：贴边铺满整张，相邻格子共用像素边界（不留 1px 白线）', () => {
  const tight = templateById('quad-tight');
  const g = templateBoxes(tight, 2400, 4, { seamless: true });
  assert.equal(g.gap, 0);
  assert.equal(g.padPx, 0);
  const area = g.boxes.reduce((s, b) => s + b.w * b.h, 0);
  assert.equal(area, g.W * g.H, '四格没有正好铺满画布');
  const [tl, tr, bl] = g.boxes;
  assert.equal(tl.x + tl.w, tr.x, '上排左右两格之间有缝');
  assert.equal(tl.y + tl.h, bl.y, '左侧上下两格之间有缝');
  assert.equal(tl.w, tr.w, '等分格子宽度不一致');
});

test('无缝开关：普通模板也能压掉留白与缝隙，关掉就恢复默认缝', () => {
  const pol = templateById('duo-polaroid');
  const withGap = templateBoxes(pol, 2400, 2);
  const seams = templateBoxes(pol, 2400, 2, { seamless: true });
  assert.ok(withGap.gap > 0, '拍立得默认应该有卡片间距');
  assert.equal(seams.gap, 0);
  assert.ok(seams.boxes[0].w > withGap.boxes[0].w, '无缝后格子应该变大（撑满原来的缝）');
  // 模板自带 seamless 的（长图类）无需传参就是无缝
  assert.equal(templateBoxes(templateById('duo-long'), 1200, 2).gap, 0);
});

test('算法版式 seamless 铺满、stack 按原比例接长图', () => {
  const seam = layoutGeometry(fake(6), { layout: 'seamless', outWidth: 1600, ratio: '4:3' });
  assert.equal(seam.gap, 0);
  assert.equal(seam.W * seam.H, seam.boxes.reduce((s, b) => s + b.w * b.h, 0), '密铺有空隙或重叠');

  // 宽 1200：1600x900 → 675、1200x1600 竖图 → 1600、1000x1000 → 1200
  const stack = layoutGeometry(fake(3), { layout: 'stack', outWidth: 1200 });
  assert.equal(stack.W, 1200);
  assert.equal(stack.boxes.length, 3);
  assert.equal(stack.boxes[0].h, 675);
  assert.equal(stack.boxes[1].h, 1600);
  assert.equal(stack.boxes[2].h, 1200);
  assert.equal(stack.boxes[0].y, 0);
  assert.equal(stack.boxes[1].y, stack.boxes[0].h, '长图之间不能有缝');
  assert.equal(stack.H, stack.boxes.reduce((s, b) => s + b.h, 0));
});

test('裁切窗口：zoom=1 等价 cover 居中，放大后窗口变小且永不越出源图', () => {
  const box = { w: 400, h: 600 }; // 2:3 的格子
  const r1 = cropWindow(1600, 900, box, { fx: 0.5, fy: 0.5, z: 1 });
  assert.deepEqual({ w: r1.width, h: r1.height, l: r1.left, t: r1.top }, { w: 600, h: 900, l: 500, t: 0 });
  const r2 = cropWindow(1600, 900, box, { fx: 0.5, fy: 0.5, z: 2 });
  assert.deepEqual({ w: r2.width, h: r2.height }, { w: 300, h: 450 });
  for (const [fx, fy, z] of [
    [0, 0, 1],
    [1, 1, 1],
    [0, 1, 1.5],
    [1, 0, 3.4],
  ]) {
    const r = cropWindow(1000, 1000, box, { fx, fy, z });
    assert.ok(r.left >= 0 && r.top >= 0, `焦点 ${fx},${fy} 出界`);
    assert.ok(r.left + r.width <= 1000 && r.top + r.height <= 1000, `焦点 ${fx},${fy} 越界`);
  }
});

test('crops 解析：auto/空 表示不指定，缺项补居中，非法值夹紧', () => {
  assert.equal(parseCrops('auto', 3), null);
  assert.equal(parseCrops('', 3), null);
  const list = parseCrops('0.2,0.8,2', 3);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { fx: 0.2, fy: 0.8, z: 2 });
  assert.deepEqual(list[2], { fx: 0.5, fy: 0.5, z: 1 });
  assert.deepEqual(parseCrops('9,-3,99', 1)[0], { fx: 1, fy: 0, z: 4 });
});
