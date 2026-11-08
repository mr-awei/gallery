/**
 * 路由解析 / 生成的单元测试。
 * Node 25 可直接加载 TS（类型擦除），因此不需要为前端纯逻辑额外装测试框架。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FILTERS, buildRoute, parseRoute, sameRoute, VIEWS } from '../web/src/lib/route.ts';

const F = (patch = {}) => ({ ...DEFAULT_FILTERS, ...patch });

test('空查询串 = 仪表盘 + 默认筛选', () => {
  const r = parseRoute('');
  assert.equal(r.view, 'dashboard');
  assert.equal(r.folderId, null);
  assert.deepEqual(r.filters, DEFAULT_FILTERS);
});

test('未知视图回落到仪表盘（坏链接不卡死）', () => {
  assert.equal(parseRoute('?v=hacker').view, 'dashboard');
  assert.equal(parseRoute('?v=').view, 'dashboard');
});

test('所有合法视图都能往返', () => {
  for (const v of VIEWS) {
    const q = buildRoute(v, DEFAULT_FILTERS, null);
    const back = parseRoute(q ? `?${q}` : '');
    assert.equal(back.view, v, `视图 ${v} 往返失败`);
  }
});

test('筛选字段解析：数组、数值、别名', () => {
  const r = parseRoute('?v=gallery&q=猫&source=weibo,bing&fav=only&ori=landscape&bucket=color&tag=壁纸&sort=oldest&seen=unseen&minRating=3&hue=red&colorHex=%23ff0000&colorTol=20&kind=video&pending=noTags&folder=7');
  assert.equal(r.view, 'gallery');
  assert.equal(r.filters.q, '猫');
  assert.deepEqual(r.filters.source, ['weibo', 'bing']);
  assert.equal(r.filters.favorite, 'only');
  assert.equal(r.filters.orientation, 'landscape');
  assert.deepEqual(r.filters.bucket, ['color']);
  assert.equal(r.filters.tag, '壁纸');
  assert.equal(r.filters.sort, 'oldest');
  assert.equal(r.filters.seen, 'unseen');
  assert.equal(r.filters.minRating, 3);
  assert.equal(r.filters.hue, 'red');
  assert.equal(r.filters.colorHex, '#ff0000');
  assert.equal(r.filters.colorTol, 20);
  assert.equal(r.filters.kind, 'video');
  assert.equal(r.filters.pending, 'noTags');
  assert.equal(r.folderId, 7);
});

test('非法 pending / 非法 folder 被忽略', () => {
  const r = parseRoute('?v=gallery&pending=bogus&folder=abc');
  assert.equal(r.filters.pending, undefined);
  assert.equal(r.folderId, null);
  assert.equal(parseRoute('?folder=-3').folderId, null);
  assert.equal(parseRoute('?folder=0').folderId, null);
});

test('生成时省略默认值，URL 保持短', () => {
  assert.equal(buildRoute('dashboard', DEFAULT_FILTERS, null), '');
  assert.equal(buildRoute('gallery', DEFAULT_FILTERS, null), 'v=gallery');
  assert.equal(buildRoute('gallery', F({ q: 'x' }), null), 'v=gallery&q=x');
  assert.equal(buildRoute('gallery', F({ source: ['a', 'b'] }), 9), 'v=gallery&source=a%2Cb&folder=9');
});

test('数组字段为空时不写进 URL', () => {
  assert.equal(buildRoute('gallery', F({ source: [] }), null), 'v=gallery');
});

test('sameRoute 按生成的 URL 判等', () => {
  const a = { view: 'gallery', filters: F({ q: 'x' }), folderId: 2 };
  const b = { view: 'gallery', filters: F({ q: 'x' }), folderId: 2 };
  const c = { view: 'gallery', filters: F({ q: 'y' }), folderId: 2 };
  assert.equal(sameRoute(a, b), true);
  assert.equal(sameRoute(a, c), false);
});

test('解析 → 生成 → 再解析保持一致', () => {
  const search = '?v=favorites&tag=风景&ori=landscape&bucket=color,gray&minRating=2&folder=12';
  const q1 = buildRoute(parseRoute(search).view, parseRoute(search).filters, parseRoute(search).folderId);
  const q2 = buildRoute(parseRoute(`?${q1}`).view, parseRoute(`?${q1}`).filters, parseRoute(`?${q1}`).folderId);
  assert.equal(q1, q2);
  assert.equal(parseRoute(`?${q1}`).folderId, 12);
});
