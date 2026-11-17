import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebounceQueue } from '../web/src/lib/debounce-queue.ts';

/** 手动时钟：不依赖真实定时器，也不依赖浏览器环境 */
function fakeScheduler() {
  const jobs = new Map();
  let seq = 0;
  return {
    set(fn, ms) {
      const id = ++seq;
      jobs.set(id, { fn, ms });
      return id;
    },
    clear(id) {
      jobs.delete(id);
    },
    runAll() {
      for (const [id, job] of [...jobs]) {
        jobs.delete(id);
        job.fn();
      }
    },
    get pending() {
      return jobs.size;
    },
    get delays() {
      return [...jobs.values()].map((j) => j.ms);
    },
  };
}

test('连续输入合并成一次提交，且多个字段都不丢', async () => {
  const clock = fakeScheduler();
  const calls = [];
  const q = createDebounceQueue((p) => calls.push(p), clock);
  q.push({ host: 'a' }, 300);
  q.push({ port: 78 }, 300);
  q.push({ username: 'u' }, 300);
  assert.equal(clock.pending, 1, '三次输入只应留一个待触发的 timer');
  assert.deepEqual(clock.delays, [300]);
  clock.runAll();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [{ host: 'a', port: 78, username: 'u' }]);
});

test('空队列 flush 不提交，dispose 会补发未落盘的改动', async () => {
  const clock = fakeScheduler();
  const calls = [];
  const q = createDebounceQueue((p) => calls.push(p), clock);
  q.flush();
  assert.equal(calls.length, 0);
  q.push({ enabled: true }, 300);
  q.dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [{ enabled: true }]);
  assert.equal(clock.pending, 0);
});

test('提交串行化：上一个请求没回来，下一个不会抢先发出', async () => {
  const clock = fakeScheduler();
  const order = [];
  let release;
  const first = new Promise((r) => {
    release = r;
  });
  let n = 0;
  const q = createDebounceQueue(async (p) => {
    const seq = ++n;
    order.push(`start:${seq}`);
    if (seq === 1) await first;
    order.push(`done:${seq}:${JSON.stringify(p)}`);
  }, clock);
  q.push({ host: 'a' }, 10);
  clock.runAll();
  q.push({ host: 'b' }, 10);
  clock.runAll();
  // 第二个提交必须等第一个 resolve 之后才开始
  await Promise.resolve();
  assert.deepEqual(order, ['start:1']);
  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['start:1', 'done:1:{"host":"a"}', 'start:2', 'done:2:{"host":"b"}']);
});
