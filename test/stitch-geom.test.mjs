import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp, coverGeom, zoomAt } from '../web/src/lib/stitchGeom.ts';

/** 4:3 的格子，像素口径（交互路径就是这么传的） */
const BOX_W = 400;
const BOX_H = 300;

test('clamp 正常夹取，越界与 NaN 都不会漏出去', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

test('倍率夹在 [min(zMin,1), 4]：比 zMin 还小就抬到 zMin，超上限按 4，非法按 1', () => {
  const item = { width: 800, height: 600 };
  assert.equal(coverGeom(item, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 0.2 }, 0.4).z, 0.4);
  assert.equal(coverGeom(item, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 9 }, 0.4).z, 4);
  assert.equal(coverGeom(item, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: Number.NaN }, 1).z, 1);
});

test('像素口径：拖动 N 像素只产生 N/rw 的焦点变化（不会一拖就跳边）', () => {
  const item = { width: 800, height: 600 };
  // 4:3 的图放进 4:3 的格子，放大到 2×：rw=800、rh=600
  const g = coverGeom(item, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 2 }, 1);
  assert.equal(g.rw, 800);
  assert.equal(g.rh, 600);
  // 居中时 left = 200 - 0.5*800 = -200，正好落在 [-400, 0] 中间
  assert.equal(g.left, -200);
  const left = clamp(g.left + 10, g.minL, g.maxL); // 往右拖 10px（图跟手，left 同向增大）
  const fx = (BOX_W / 2 - left) / g.rw;
  assert.ok(Math.abs(fx - (0.5 - 10 / 800)) < 1e-9, `拖 10px 只该挪 10/800，实际 ${fx}`);
});

test('余量边界：贴边后再拖同一方向不动，反向立刻能拉回来', () => {
  const item = { width: 800, height: 600 };
  const g = coverGeom(item, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 2 }, 1);
  const atEdge = clamp(g.left - 10000, g.minL, g.maxL);
  assert.equal(atEdge, g.minL); // 到底了，不越界
  const back = clamp(atEdge + 30, g.minL, g.maxL);
  assert.equal(back, g.minL + 30); // 反向 30px 就是 30px，不会瞬移到另一头
  assert.equal(g.minL, -400);
  assert.equal(g.maxL, 0);
});

test('同比例的图 + z=1：两向都没余量，判 dry（拖不动是几何必然）', () => {
  const g = coverGeom({ width: 800, height: 600 }, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 1 }, 1);
  assert.equal(g.dry, true);
  assert.equal(g.minL, 0);
  assert.equal(g.maxL, 0);
  assert.equal(g.minT, 0);
  assert.equal(g.maxT, 0);
  assert.equal(g.left, 0);
  assert.equal(g.top, 0);
});

test('等比放大后就不再 dry，两向都有余量', () => {
  const g = coverGeom({ width: 800, height: 600 }, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 1.25 }, 1);
  assert.equal(g.dry, false);
  assert.ok(g.minL < 0 && g.maxL === 0);
  assert.ok(g.minT < 0 && g.maxT === 0);
});

test('dry 与口径无关：比例口径同样判得出来（渲染路径靠它加光标类）', () => {
  // 3:2 的画布 + 3:2 的图，z=1 时铺满且无余量
  const g = coverGeom({ width: 1500, height: 1000 }, 1.5, 1, { fx: 0.5, fy: 0.5, z: 1 }, 1);
  assert.equal(g.dry, true);
  const px = coverGeom({ width: 1500, height: 1000 }, 450, 300, { fx: 0.5, fy: 0.5, z: 1 }, 1);
  assert.equal(px.dry, true);
});

test('联系表式 z<1：图比格子小，只能在格子里挪，左上不为负', () => {
  const g = coverGeom({ width: 800, height: 600 }, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 0.5 }, 0.5);
  assert.equal(g.dry, false);
  assert.equal(g.minL, 0);
  assert.equal(g.maxL, BOX_W - g.rw);
  assert.ok(g.left >= 0 && g.left <= g.maxL);
});

test('focus 越界会被夹回 [0,1]，不会把图推出格子', () => {
  const item = { width: 800, height: 600 };
  const lo = coverGeom(item, BOX_W, BOX_H, { fx: -3, fy: 2, z: 2 }, 1);
  assert.equal(lo.left, lo.maxL);
  assert.equal(lo.top, lo.minT);
});

test('零尺寸不会算出 NaN 样式（首帧还没量到格子时）', () => {
  const g = coverGeom({ width: 800, height: 600 }, 0, 0, { fx: 0.5, fy: 0.5, z: 1 }, 1);
  assert.equal(g.dry, true);
  assert.ok(!/NaN/.test(g.style.width + g.style.height + g.style.transform), g.style.transform);
});

test('渲染样式只用比值：比例口径与像素口径得到同一套百分比', () => {
  const item = { width: 800, height: 600 };
  const px = coverGeom(item, 400, 300, { fx: 0.4, fy: 0.6, z: 1.5 }, 1);
  const ratio = coverGeom(item, 400 / 300, 1, { fx: 0.4, fy: 0.6, z: 1.5 }, 1);
  const num = (s) => s.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  const [a, b] = [num(px.style.transform), num(ratio.style.transform)];
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `第 ${i} 个数值不一致：${a[i]} vs ${b[i]}`);
  }
});

test('滚轮放大：光标压住的那个图点不动（锚点不漂）', () => {
  const item = { width: 800, height: 600 };
  const before = { fx: 0.5, fy: 0.5, z: 2 };
  const px = 0.8;
  const py = 0.4;
  const next = zoomAt(item, BOX_W, BOX_H, before, 1, 1.14, px, py);
  assert.ok(next, '应该返回新 crop');
  assert.ok(Math.abs(next.z - 2.28) < 1e-9);

  const g0 = coverGeom(item, BOX_W, BOX_H, before, 1);
  const g1 = coverGeom(item, BOX_W, BOX_H, next, 1);
  const u0 = (BOX_W * px - g0.left) / g0.rw; // 光标下的图点（相对位置）
  const v0 = (BOX_H * py - g0.top) / g0.rh;
  const u1 = (BOX_W * px - g1.left) / g1.rw;
  const v1 = (BOX_H * py - g1.top) / g1.rh;
  assert.ok(Math.abs(u1 - u0) < 1e-9, `横向锚点漂了：${u0} → ${u1}`);
  assert.ok(Math.abs(v1 - v0) < 1e-9, `纵向锚点漂了：${v0} → ${v1}`);
});

test('滚轮放大：光标压在格子中心时焦点不跟着乘，图仍居中', () => {
  const item = { width: 800, height: 600 };
  const next = zoomAt(item, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 1 }, 1, 1.14, 0.5, 0.5);
  assert.ok(next);
  assert.ok(Math.abs(next.fx - 0.5) < 1e-12, `fx 不该漂：${next.fx}`);
  assert.ok(Math.abs(next.fy - 0.5) < 1e-12, `fy 不该漂：${next.fy}`);
  const g = coverGeom(item, BOX_W, BOX_H, next, 1);
  // 图比格子大出来多少就居中退多少，上下左右余量对半
  assert.ok(Math.abs(g.left - (BOX_W - g.rw) / 2) < 1e-9);
  assert.ok(Math.abs(g.top - (BOX_H - g.rh) / 2) < 1e-9);
});

test('滚轮到头（4× 或 zMin）返回 null，不产生抖动', () => {
  const item = { width: 800, height: 600 };
  assert.equal(zoomAt(item, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 4 }, 1, 1.14, 0.5, 0.5), null);
  assert.equal(zoomAt(item, BOX_W, BOX_H, { fx: 0.5, fy: 0.5, z: 0.4 }, 0.4, 0.88, 0.5, 0.5), null);
});

test('滚轮缩到 zMin 时不会把焦点甩出 [0,1]', () => {
  const item = { width: 800, height: 600 };
  const next = zoomAt(item, BOX_W, BOX_H, { fx: 0.1, fy: 0.9, z: 0.44 }, 0.4, 0.88, 0.9, 0.1);
  assert.ok(next);
  assert.equal(next.z, 0.4);
  assert.ok(next.fx >= 0 && next.fx <= 1);
  assert.ok(next.fy >= 0 && next.fy <= 1);
});
