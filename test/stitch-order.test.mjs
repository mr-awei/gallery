import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, normalizeOrder, swapAt } from '../web/src/lib/stitchOrder.ts';

test('swapAt 交换两个槽位，原数组不动', () => {
  const list = ['a', 'b', 'c'];
  const out = swapAt(list, 0, 2);
  assert.deepEqual(out, ['c', 'b', 'a']);
  assert.deepEqual(list, ['a', 'b', 'c'], '不许改原数组');
});

test('swapAt 同一个位置 / 越界 / 非整数都原样返回同一个引用', () => {
  const list = [1, 2, 3];
  assert.equal(swapAt(list, 1, 1), list);
  assert.equal(swapAt(list, -1, 1), list);
  assert.equal(swapAt(list, 0, 3), list);
  assert.equal(swapAt(list, 0.5, 1), list);
});

test('swapAt 换两次就回到原样（互换是可逆的）', () => {
  const list = [0, 1, 2, 3];
  const once = swapAt(list, 1, 3);
  const back = swapAt(once, 1, 3);
  assert.deepEqual(back, list);
});

test('normalizeOrder 修成 0..n-1 的排列：丢越界、丢重复、补缺位', () => {
  assert.deepEqual(normalizeOrder([2, 0, 1], 3), [2, 0, 1], '合法排列原样保留');
  assert.deepEqual(normalizeOrder([2, 9, 2], 3), [2, 0, 1], '越界与重复丢掉，缺的按升序补');
  assert.deepEqual(normalizeOrder([], 2), [0, 1], '空 order 补成顺序摆放');
  assert.deepEqual(normalizeOrder([0, 1, 2], 2), [0, 1], '选图变少就截断');
  assert.deepEqual(normalizeOrder([1], 3), [1, 0, 2], '选图变多就补到后面');
});

test('normalizeOrder 对垃圾输入也不炸', () => {
  assert.deepEqual(normalizeOrder([Number.NaN, -1, 1.5, 0], 2), [0, 1]);
  assert.deepEqual(normalizeOrder([0], 0), []);
  assert.deepEqual(normalizeOrder([0], -3), []);
});

test('applyOrder 按槽位取图：order[槽] = 素材下标', () => {
  const items = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  // 用户把第 3 张拖到第 1 格
  assert.deepEqual(
    applyOrder(items, [2, 1, 0]).map((x) => x.id),
    ['C', 'B', 'A']
  );
  // order 与选图数量不匹配时先修好再取，绝不会取到 undefined
  assert.deepEqual(
    applyOrder(items, [5]).map((x) => x.id),
    ['A', 'B', 'C']
  );
  assert.equal(applyOrder(items, [0, 0, 0]).length, 3);
});
