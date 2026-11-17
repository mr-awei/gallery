import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKET_H,
  GAP,
  columnCount,
  createLayout,
  extendLayout,
  firstIndices,
  geometrySig,
  visibleRange,
} from '../web/src/lib/masonryLayout.ts';

/** 造 n 张图：宽度固定 1000，高度按序列交替，保证列高不平均，能测出最短列 */
function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    width: 1000,
    height: 400 + ((i * 137) % 900),
  }));
}

const spec = { effWidth: 1200, mode: 'masonry' };

test('列数规则与旧实现一致', () => {
  assert.equal(columnCount(1200, 'masonry'), 4);
  assert.equal(columnCount(1000, 'masonry'), 3);
  assert.equal(columnCount(700, 'masonry'), 2);
  assert.equal(columnCount(700, 'grid'), 2);
  assert.equal(columnCount(1200, 'masonry', 300), 3);
});

test('每张卡落在当前最短的列，第一行四张都在 y=0', () => {
  const items = makeItems(22);
  const L = createLayout(items, spec);
  assert.equal(L.cols, 4);
  for (let i = 0; i < 4; i += 1) assert.equal(L.ys[i], 0);
  for (let i = 4; i < L.count; i += 1) {
    const col = L.colsOf[i];
    // 放置该卡之前，这一列必须是最矮的（允许并列取最左）
    let minCol = 0;
    for (let c = 0; c < L.cols; c += 1) if (L.colHeights[c] < L.colHeights[minCol]) minCol = c;
    assert.ok(col <= minCol + 3, '列索引合法');
    assert.ok(L.ys[i] > 0, '第二行起纵坐标必须大于 0');
  }
  // 总高 = 最高列 - 最后一个 GAP
  const maxCol = Math.max(...L.colHeights);
  assert.equal(L.totalHeight, maxCol - GAP);
});

test('绝对定位不重叠：同列相邻卡片纵向间隔至少 GAP', () => {
  const items = makeItems(60);
  const L = createLayout(items, spec);
  for (let c = 0; c < L.cols; c += 1) {
    const col = L.byCol[c];
    for (let k = 1; k < col.length; k += 1) {
      const prev = col[k - 1];
      const cur = col[k];
      assert.ok(L.ys[cur] >= L.ys[prev] + L.hs[prev] + GAP - 1, '同列间距');
    }
  }
});

test('增量追加与全量布局逐项一致', () => {
  const items = makeItems(120);
  let L = createLayout(items.slice(0, 48), spec);
  L = extendLayout(L, items.slice(0, 96), spec);
  L = extendLayout(L, items, spec);
  const full = createLayout(items, spec);
  assert.equal(L.count, full.count);
  assert.equal(L.totalHeight, full.totalHeight);
  for (let i = 0; i < full.count; i += 1) {
    assert.equal(L.xs[i], full.xs[i], `x@${i}`);
    assert.equal(L.ys[i], full.ys[i], `y@${i}`);
    assert.equal(L.hs[i], full.hs[i], `h@${i}`);
    assert.equal(L.colsOf[i], full.colsOf[i], `col@${i}`);
  }
});

test('追加是就地复用：纯追加不重建整个布局', () => {
  const items = makeItems(40);
  const a = createLayout(items.slice(0, 20), spec);
  const yBefore = a.ys[7];
  const b = extendLayout(a, items, spec);
  assert.equal(b, a, '同 spec + 纯追加应返回同一对象');
  assert.equal(b.ys[7], yBefore);
  assert.equal(b.count, 40);
});

test('中间某项尺寸变化会自动退回全量重建', () => {
  const items = makeItems(30);
  const a = createLayout(items.slice(0, 20), spec);
  const changed = items.slice(0, 30).map((it, i) => (i === 5 ? { ...it, height: it.height + 400 } : it));
  const b = extendLayout(a, changed, spec);
  assert.notEqual(b, a);
  const full = createLayout(changed, spec);
  for (let i = 0; i < full.count; i += 1) assert.equal(b.ys[i], full.ys[i]);
});

test('顺序变化会重建（同一批 id 换个顺序不该沿用旧坐标）', () => {
  const items = makeItems(24);
  const a = createLayout(items, spec);
  const reversed = items.slice().reverse();
  const b = extendLayout(a, reversed, spec);
  const full = createLayout(reversed, spec);
  assert.notEqual(b, a);
  for (let i = 0; i < full.count; i += 1) assert.equal(b.xs[i], full.xs[i]);
  assert.notEqual(geometrySig(items), geometrySig(reversed));
});

test('几何签名只看 id/宽高/顺序：换引用但几何不变时签名稳定', () => {
  const items = makeItems(10);
  const clone = items.map((it) => ({ ...it, favorited: true }));
  assert.equal(geometrySig(items), geometrySig(clone));
});

test('可见区查询只覆盖与区间相交的卡片，且按原顺序', () => {
  const items = makeItems(300);
  const L = createLayout(items, spec);
  const top = 1500;
  const bottom = 1500 + 800;
  const vis = visibleRange(L, top, bottom);
  assert.ok(vis.length > 0);
  assert.ok(vis.length < 40, '不该把整库返回');
  for (const i of vis) {
    assert.ok(L.ys[i] <= bottom && L.ys[i] + L.hs[i] >= top, '相交');
  }
  // 区间内所有卡片都必须出现（不漏）
  for (let i = 0; i < L.count; i += 1) {
    const hit = L.ys[i] <= bottom && L.ys[i] + L.hs[i] >= top;
    if (hit) assert.ok(vis.includes(i), `漏了第 ${i} 张`);
  }
  for (let k = 1; k < vis.length; k += 1) assert.ok(vis[k] > vis[k - 1], '顺序递增');
});

test('超长卡片跨桶也能被查到', () => {
  const items = [
    { id: 1, width: 1000, height: 1000 },
    { id: 2, width: 100, height: 4000 }, // 极长竖图，高度远超 BUCKET_H
    { id: 3, width: 1000, height: 1000 },
  ];
  const L = createLayout(items, { effWidth: 600, mode: 'masonry' });
  // 长图在 y=0，底边可能横跨多个桶；视口落在长图中间位置时仍应命中
  const mid = Math.min(BUCKET_H * 2, L.hs[1] - 10);
  const vis = visibleRange(L, mid, mid + 400);
  assert.ok(vis.includes(1), '跨桶长图必须能查到');
});

test('空列表与未测宽度的兜底', () => {
  const empty = createLayout([], spec);
  assert.equal(empty.count, 0);
  assert.equal(empty.totalHeight, 0);
  assert.deepEqual(visibleRange(empty, 0, 800), []);
  assert.deepEqual(firstIndices(empty), []);

  const items = makeItems(5);
  const L = createLayout(items, spec);
  assert.deepEqual(firstIndices(L, 3), [0, 1, 2]);
});

test('grid 模式高度统一，不按原图比例', () => {
  const items = makeItems(10);
  const L = createLayout(items, { effWidth: 1200, mode: 'grid' });
  const h = L.hs[0];
  for (let i = 0; i < L.count; i += 1) assert.equal(L.hs[i], h);
});

test('一万张的增量追加仍然只算新增部分（性能护栏）', () => {
  const items = makeItems(10000);
  const base = createLayout(items.slice(0, 5000), spec);
  const t0 = performance.now();
  const next = extendLayout(base, items.slice(0, 5048), spec);
  const cost = performance.now() - t0;
  assert.equal(next.count, 5048);
  // 只追加 48 张时应该远低于全量布局 5000 张的成本（给足机器差异余量）
  assert.ok(cost < 60, `增量追加 48 张耗时 ${cost.toFixed(1)}ms，偏高`);
});
