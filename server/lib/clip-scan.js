// @ts-check
/**
 * CLIP 磁盘向量索引的扫描内核：纯函数，不依赖 DB / Electron / worker。
 * worker 线程与主线程兜底共用这一份实现，保证两条路径算出来的 topK 完全一致。
 *
 * 索引是「分桶 + int16 量化」的磁盘文件：
 * - 按归一化向量第 0 维分成 BUCKETS 个桶，桶元数据记录该桶 v0 的真实范围 [lo, hi]；
 * - 查询先用球面分解的上界跳过整个桶，再逐条用前半维点积 + 尾范数上界剪枝；
 * - 全程按 64KB 块 readSync，任何时刻内存里只有一块向量，不随库大小增长。
 *
 * 上界为什么无假阴性：单位向量 q、v 有
 *   cos(q,v) = q0*v0 + Σ_{j≥1} qj*vj ≤ max(q0*v0) + ‖q_rest‖·‖v_rest‖
 *            = max(q0*v0) + sqrt(1-q0²)·sqrt(1-v0²)
 * 量化只带来 ~1e-5 级误差，剪枝额外放 EPS 容差，宁可多算也不漏真近邻。
 */
import fs from 'node:fs';

export const MAGIC = 'TUKUVEC1';
export const HEADER_BYTES = 16;
export const REC_META = 16;
export const QUANT_MAX = 32767;
export const BUCKETS = 16;
/** 剪枝容差：抵消 int16 量化误差，保证不会因上界偏小漏掉临界命中 */
export const EPS = 0.002;
export const READ_BLOCK = 64 * 1024;

export const recSize = (dim) => REC_META + dim * 2;

export function bucketOf(v0) {
  return Math.max(0, Math.min(BUCKETS - 1, Math.floor(((Number(v0) || 0) + 1) * 0.5 * BUCKETS)));
}

/** 某个 [lo,hi] 桶内所有向量与 query 的余弦上界 */
export function bucketBound(q0, lo, hi) {
  const best = q0 >= 0 ? q0 * hi : q0 * lo;
  const crossesZero = lo <= 0 && hi >= 0;
  const minSq = crossesZero ? 0 : Math.min(lo * lo, hi * hi);
  const qRest = Math.sqrt(Math.max(0, 1 - q0 * q0));
  return best + qRest * Math.sqrt(Math.max(0, 1 - minSq));
}

/**
 * 扫描候选桶，返回按 cos 降序的前 k 个 { id, cos }。
 * @param {object} p
 * @param {number} p.dim 向量维度
 * @param {Array<{file:string, records:number, lo?:number, hi?:number}>} [p.buckets] 已做桶级剪枝的候选桶
 * @param {Float32Array|ArrayBuffer} p.query 归一化查询向量
 * @param {number} [p.k]
 * @param {number} [p.minCos]
 * @param {number} [p.excludeId]
 * @returns {{id:number, cos:number}[]}
 */
export function scanBuckets({ dim, buckets = [], query, k = 24, minCos = 0.8, excludeId = 0 }) {
  const q = query instanceof Float32Array ? query : new Float32Array(query);
  if (q.length !== dim) throw new Error(`查询向量维度 ${q.length} 与索引 ${dim} 不一致`);
  const size = recSize(dim);
  const head = dim >> 1;
  let qTailSq = 1;
  for (let j = 0; j < head; j++) qTailSq -= q[j] * q[j];
  const qTail = Math.sqrt(Math.max(0, qTailSq));
  const chunkRecs = Math.max(1, Math.floor(READ_BLOCK / size));
  const buf = Buffer.allocUnsafe(chunkRecs * size);
  const scored = [];
  const LIMIT = Math.max(k * 8, 4096);
  let guard = 0;

  for (const b of buckets) {
    if (!b.records) continue;
    let fd = null;
    try {
      fd = fs.openSync(b.file, 'r');
      for (let slot = 0; slot < b.records; slot += chunkRecs) {
        const n = Math.min(chunkRecs, b.records - slot);
        fs.readSync(fd, buf, 0, n * size, HEADER_BYTES + slot * size);
        for (let i = 0; i < n; i++) {
          const base = i * size;
          const id = buf.readInt32LE(base);
          if (id === 0 || id === excludeId) continue; // 0 = 墓碑
          const scale = buf.readFloatLE(base + 4) / QUANT_MAX;
          const tail = buf.readFloatLE(base + 12);
          let h = 0;
          for (let j = 0; j < head; j++) h += q[j] * buf.readInt16LE(base + REC_META + j * 2) * scale;
          if (h + qTail * tail + EPS < minCos) continue;
          let dot = h;
          for (let j = head; j < dim; j++) dot += q[j] * buf.readInt16LE(base + REC_META + j * 2) * scale;
          if (dot >= minCos) {
            scored.push({ id, cos: dot });
            // 命中远超 k 时就地收敛，minCos 很低时也不让数组膨胀
            if (++guard >= LIMIT) {
              scored.sort((a, b2) => b2.cos - a.cos);
              scored.length = k;
              guard = 0;
            }
          }
        }
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  scored.sort((a, b) => b.cos - a.cos);
  return scored.slice(0, k);
}
