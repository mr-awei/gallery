import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { openIndex, encodeRecord, decodeRecord } from '../server/lib/clip-index.js';
import { scanBuckets, recSize, bucketOf, bucketBound } from '../server/lib/clip-scan.js';

// 守住「CLIP 不再把全表向量常驻内存」：向量必须落在磁盘分桶索引里，
// 查询经桶级上界剪枝 + 分块扫描，且重建/覆盖/删除/重启后结果仍与权威数据源一致。
// 目录名必须 ASCII：Windows 中文路径下 node:sqlite 的句柄会让 rmSync 卡死。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-clipindex-'));
const opened = [];
const DIM = 16;

function unit(arr) {
  const v = Float32Array.from(arr);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
const zeros = Array(DIM).fill(0);
const v1 = unit([1, ...zeros.slice(1)]);
const v2 = unit([0.9, 0.3, ...zeros.slice(2)]);
const v3 = unit([-1, ...zeros.slice(1)]);

const make = (name, src) => {
  const idx = openIndex(path.join(tmp, name), DIM, src);
  opened.push(idx);
  return idx;
};
const srcOf = (getRows) => ({
  count: () => getRows().length,
  iterate: function* () {
    yield* getRows();
  },
});
const topIds = (idx, q, minCos = 0.9) =>
  scanBuckets({ dim: DIM, buckets: idx.plan(q, minCos), query: q, k: 10, minCos }).map((h) => h.id);

test.after(() => {
  for (const idx of opened) idx.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄偶发占用，留给系统临时目录 */
  }
});

test('int16 量化误差可忽略，桶号由首维决定', () => {
  const buf = Buffer.alloc(recSize(DIM));
  const meta = encodeRecord(buf, 0, 7, v2, DIM);
  assert.equal(meta.bucket, bucketOf(v2[0]));
  const dec = decodeRecord(buf, 0, DIM);
  assert.equal(dec.id, 7);
  let maxErr = 0;
  for (let i = 0; i < DIM; i++) maxErr = Math.max(maxErr, Math.abs(dec.vec[i] - v2[i]));
  assert.ok(maxErr < 1e-4, `量化误差过大：${maxErr}`);
  assert.ok(bucketBound(1, 0.9, 1) >= 0.9);
  assert.ok(bucketBound(1, -1, -0.9) < 0, '反向桶应被上界剪掉');
});

test('磁盘索引：重建 → 查询 → 覆盖换桶 → 删除 → 重启一致', () => {
  let rows = [
    { id: 1, vec: v1 },
    { id: 2, vec: v2 },
    { id: 3, vec: v3 },
  ];
  const dir = path.join(tmp, 'lib-a');
  const src = srcOf(() => rows);
  const idx = make('lib-a', src);
  idx.ensure();
  assert.equal(idx.stats().total, 3);
  assert.deepEqual(topIds(idx, v1), [1, 2], '高相似命中应按 cos 排序且排除反向向量');

  const got = idx.get(2);
  assert.ok(got, 'cachedVector 依赖的逐条反量化必须可用');
  assert.ok(Math.abs(got[0] - v2[0]) < 1e-4);

  // 同 id 换到另一个桶：旧槽必须留墓碑，否则会出现重复 id
  rows = rows.map((r) => (r.id === 2 ? { id: 2, vec: v3 } : r));
  idx.upsert(2, v3);
  assert.deepEqual(topIds(idx, v1), [1]);
  assert.equal(idx.stats().total, 3);

  rows = rows.filter((r) => r.id !== 1);
  idx.remove(1);
  assert.equal(idx.get(1), null);
  assert.deepEqual(topIds(idx, v1), []);
  idx.close();

  // 模拟进程重启：count 一致时只扫描桶头重建轻量索引，不重新读 DB 全表
  const reopened = openIndex(dir, DIM, src);
  opened.push(reopened);
  reopened.ensure();
  assert.equal(reopened.stats().total, 2);
  assert.ok(reopened.get(2), '重启后 id → 槽位索引必须恢复');
  assert.equal(reopened.get(1), null);
});

test('权威数据源与索引 count 不一致时自动流式重建', () => {
  const rows = [{ id: 1, vec: v1 }];
  const src = srcOf(() => rows);
  const idx = make('lib-b', src);
  idx.ensure();
  assert.deepEqual(topIds(idx, v1), [1]);

  rows.push({ id: 9, vec: v2 }); // 模拟外部写库 / 崩溃在索引写一半
  idx.invalidate();
  idx.ensure();
  assert.deepEqual(topIds(idx, v1), [1, 9], '重建后新向量必须能被检索到');
});

test('相似搜索 worker 与主线程扫描结果一致', async () => {
  const rows = [
    { id: 1, vec: v1 },
    { id: 2, vec: v2 },
    { id: 3, vec: v3 },
  ];
  const idx = make('lib-c', srcOf(() => rows));
  idx.ensure();
  const buckets = idx.plan(v1, 0.9);
  const copy = Float32Array.from(v1);
  const payload = { dim: DIM, buckets, query: copy.buffer, k: 10, minCos: 0.9, excludeId: 0 };
  const worker = new Worker(new URL('../server/clip-search-worker.js', import.meta.url));
  const hits = await new Promise((resolve, reject) => {
    worker.once('message', (msg) => (msg.ok ? resolve(msg.hits) : reject(new Error(msg.error))));
    worker.once('error', reject);
    worker.postMessage({ seq: 1, payload }, [copy.buffer]);
  });
  await worker.terminate();
  assert.deepEqual(
    hits.map((h) => h.id),
    scanBuckets({ dim: DIM, buckets, query: v1, k: 10, minCos: 0.9 }).map((h) => h.id)
  );
  assert.deepEqual(hits.map((h) => h.id), [1, 2]);
});
