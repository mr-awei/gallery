import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDay, nextMonth } from '../server/lib/timeline-window.js';

test('nextMonth 普通月份', () => {
  assert.equal(nextMonth('2026-10'), '2026-11');
});

test('nextMonth 十二月跨年', () => {
  assert.equal(nextMonth('2026-12'), '2027-01');
});

test('nextDay 月内', () => {
  assert.equal(nextDay('2026-10-05'), '2026-10-06');
});

test('nextDay 月末跨月', () => {
  assert.equal(nextDay('2026-10-31'), '2026-11-01');
  assert.equal(nextDay('2026-11-30'), '2026-12-01');
});

test('nextDay 年末跨年', () => {
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
});

test('nextDay 闰年 2 月', () => {
  assert.equal(nextDay('2028-02-28'), '2028-02-29');
  assert.equal(nextDay('2028-02-29'), '2028-03-01');
});

test('区间上界必须严格大于下界（否则当天/当月最后一张会被排除）', () => {
  // taken_at 是 'YYYY-MM-DD HH:MM:SS'，字符串比较下 '2026-10-05 23:59:59' < '2026-10-06' 成立
  assert.ok('2026-10-05 23:59:59' < nextDay('2026-10-05'));
  assert.ok('2026-10-31 23:59:59' < `${nextMonth('2026-10')}-01`);
});
