/**
 * HNSW 回归：不是「能跑」，而是「找得到」。
 * 用固定种子造 800 个随机 32 维单位向量，与暴力最近邻比对召回率。
 * 门槛设 0.85：低于这个值说明图退化成了链，检索体验会明显变差。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hnsw } from '../server/lib/hnsw.js';

/** 可复现的伪随机（避免用 Math.random 让失败无法复现） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVec(rand, dim) {
  const v = new Float32Array(dim);
  let n = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = rand() * 2 - 1;
    n += v[i] * v[i];
  }
  const len = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= len;
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

test('HNSW 召回率与暴力搜索一致（Recall@10 ≥ 0.85）', () => {
  const rand = mulberry32(20261109);
  const dim = 32;
  const N = 800;
  const index = new Hnsw({ M: 16, efConstruction: 120, efSearch: 64 });
  const vecs = new Map();
  for (let i = 1; i <= N; i++) {
    const v = unitVec(rand, dim);
    vecs.set(i, v);
    index.insert(i, v);
  }
  assert.equal(index.size, N);

  let hit = 0;
  const queries = 40;
  for (let qi = 0; qi < queries; qi++) {
    const q = unitVec(rand, dim);
    const ann = index.search(q, 10, 64).map((h) => h.id);
    const brute = [...vecs.entries()]
      .map(([id, v]) => ({ id, sim: dot(v, q) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 10)
      .map((h) => h.id);
    for (const id of ann) if (brute.includes(id)) hit++;
  }
  const recall = hit / (queries * 10);
  assert.ok(recall >= 0.85, `召回率过低：${recall.toFixed(3)}`);
});

test('空索引与维度不一致的边界行为', () => {
  const index = new Hnsw();
  assert.deepEqual(index.search(new Float32Array(8), 5), []);
  index.insert(1, new Float32Array(8).fill(0.5));
  assert.equal(index.search(new Float32Array(8).fill(0.5), 1)[0].id, 1);
  assert.throws(() => index.insert(2, new Float32Array(4)), /维度不一致/);
});

test('重复插入同一 id 不会让图膨胀', () => {
  const index = new Hnsw();
  const v = new Float32Array(8).fill(0.35);
  index.insert(7, v);
  index.insert(7, v);
  assert.equal(index.size, 1);
});
