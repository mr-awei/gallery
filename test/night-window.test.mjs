import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, inWindow, parseClock, parseTasks } from '../server/lib/night-window.js';

test('parseClock 接受 HH:MM，非法输入回落', () => {
  assert.equal(parseClock('02:00'), 120);
  assert.equal(parseClock('2:05'), 125);
  assert.equal(parseClock(' 23:59 '), 1439);
  assert.equal(parseClock('24:00'), 1440);
  assert.equal(parseClock('25:00', 99), 99);
  assert.equal(parseClock('12:75', 99), 99);
  assert.equal(parseClock('abc', 99), 99);
  assert.equal(parseClock('', 99), 99);
  assert.equal(parseClock(undefined, 99), 99);
});

test('formatClock 补零，24:00 保留', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(120), '02:00');
  assert.equal(formatClock(1439), '23:59');
  assert.equal(formatClock(1440), '24:00');
});

test('普通时段 02:00–06:00 左闭右开', () => {
  const s = 120;
  const e = 360;
  assert.equal(inWindow(119, s, e), false, '01:59 不在');
  assert.equal(inWindow(120, s, e), true, '02:00 在');
  assert.equal(inWindow(359, s, e), true, '05:59 在');
  assert.equal(inWindow(360, s, e), false, '06:00 不在（结束点开区间）');
  assert.equal(inWindow(600, s, e), false, '10:00 不在');
});

test('跨午夜时段 22:00–06:00 两头都算', () => {
  const s = 22 * 60;
  const e = 6 * 60;
  assert.equal(inWindow(21 * 60 + 59, s, e), false, '21:59 不在');
  assert.equal(inWindow(22 * 60, s, e), true, '22:00 在');
  assert.equal(inWindow(23 * 60 + 59, s, e), true, '23:59 在');
  assert.equal(inWindow(0, s, e), true, '00:00 在');
  assert.equal(inWindow(5 * 60 + 59, s, e), true, '05:59 在');
  assert.equal(inWindow(6 * 60, s, e), false, '06:00 不在');
  assert.equal(inWindow(12 * 60, s, e), false, '12:00 不在');
});

test('起止相同视为全天', () => {
  for (const m of [0, 120, 720, 1439]) assert.equal(inWindow(m, 120, 120), true);
});

test('parseTasks 只留合法任务，空则两项都跑', () => {
  assert.deepEqual(parseTasks('semantic,face'), ['semantic', 'face']);
  assert.deepEqual(parseTasks('face'), ['face']);
  assert.deepEqual(parseTasks('face,bogus'), ['face']);
  assert.deepEqual(parseTasks(''), ['semantic', 'face']);
  assert.deepEqual(parseTasks(null), ['semantic', 'face']);
});
