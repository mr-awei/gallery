/**
 * CLIP 向量的磁盘索引（分桶 + int16 量化 + id→槽位轻量索引）。
 *
 * 旧实现把全库 512 维 float32 常驻在 HTTP 进程（百万张 ≈ 2GB），且查询在主线程
 * 逐条算点积，只能靠 setImmediate 让出事件循环。现在：
 * - 向量以 int16 量化后落在库目录的桶文件里，查询按 64KB 分块读，内存恒定；
 * - 按第 0 维分 16 桶 + 球面余弦上界做索引剪枝，整个桶可以一次跳过；
 * - 主线程只留 id → { 桶, 槽位 } 的轻量 Map（百万条约几十 MB，且不含向量本身）。
 *
 * DB 仍是权威数据源：任何写都同步更新索引；启动时用 COUNT 核对，
 * 不一致（崩溃在写一半 / 外部改库 / 切库）就流式重建，不会拿陈旧向量误判重复。
 * 本模块不 import db.js，重建所需的数据由调用方以回调注入，便于独立单测。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MAGIC,
  HEADER_BYTES,
  REC_META,
  QUANT_MAX,
  BUCKETS,
  EPS,
  READ_BLOCK,
  recSize,
  bucketOf,
  bucketBound,
} from './clip-scan.js';

/** 归一化副本：DB 里可能还存着旧版本未归一化的向量，索引一律用单位向量 */
function normalizedCopy(vec) {
  const v = Float32Array.from(vec);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** 写一条完整记录；返回桶号与精确 v0（供桶范围维护） */
export function encodeRecord(buf, offset, id, vec, dim) {
  const v = normalizedCopy(vec);
  let scale = 0;
  for (let j = 0; j < dim; j++) scale = Math.max(scale, Math.abs(v[j]));
  scale = scale || 1;
  const head = dim >> 1;
  let tailSq = 0;
  for (let j = head; j < dim; j++) tailSq += v[j] * v[j];
  buf.writeInt32LE(id, offset);
  buf.writeFloatLE(scale, offset + 4);
  buf.writeFloatLE(v[0], offset + 8);
  buf.writeFloatLE(Math.sqrt(tailSq), offset + 12);
  const f = QUANT_MAX / scale;
  for (let j = 0; j < dim; j++) {
    const q = Math.max(-QUANT_MAX, Math.min(QUANT_MAX, Math.round(v[j] * f)));
    buf.writeInt16LE(q, offset + REC_META + j * 2);
  }
  return { v0: v[0], bucket: bucketOf(v[0]) };
}

/** 读一条记录并反量化（cachedVector 用，误差 < 1e-4） */
export function decodeRecord(buf, offset, dim) {
  const id = buf.readInt32LE(offset);
  const scale = buf.readFloatLE(offset + 4) / QUANT_MAX;
  const v0 = buf.readFloatLE(offset + 8);
  const tail = buf.readFloatLE(offset + 12);
  const vec = new Float32Array(dim);
  for (let j = 0; j < dim; j++) vec[j] = buf.readInt16LE(offset + REC_META + j * 2) * scale;
  return { id, vec, v0, tail };
}

/**
 * @param {string} dir 索引目录（按库 + 维度隔离）
 * @param {number} dim 向量维度
 * @param {{count?:()=>number, iterate?:()=>Iterable<{id:number,vec:Float32Array}>}} [src] 权威数据源回调
 */
export function openIndex(dir, dim, src = {}) {
  const { count = () => 0, iterate = function* () {} } = src;
  const size = recSize(dim);
  const files = Array.from({ length: BUCKETS }, (_, b) => path.join(dir, `b${b}.bin`));
  const fds = new Array(BUCKETS).fill(null);
  let ready = false;
  let invalid = false;
  let total = 0;
  let idIndex = new Map();
  let buckets = freshBuckets();

  function freshBuckets() {
    return Array.from({ length: BUCKETS }, (_, b) => ({ file: files[b], records: 0, alive: 0, lo: 1, hi: -1 }));
  }

  function closeFds() {
    for (let b = 0; b < BUCKETS; b++) {
      if (fds[b] !== null) {
        try {
          fs.closeSync(fds[b]);
        } catch {
          /* 已关闭 */
        }
        fds[b] = null;
      }
    }
  }

  function fdFor(b) {
    if (fds[b] === null) fds[b] = fs.openSync(files[b], 'r+');
    return fds[b];
  }

  function writeHeader(fd) {
    const h = Buffer.alloc(HEADER_BYTES);
    h.write(MAGIC, 0, 'ascii');
    h.writeUInt32LE(dim, 8);
    h.writeUInt32LE(0, 12);
    fs.writeSync(fd, h, 0, HEADER_BYTES, 0);
  }

  /** 扫描已有桶文件构建轻量 id 索引；返回文件是否完整可用 */
  function scanExisting() {
    idIndex = new Map();
    buckets = freshBuckets();
    total = 0;
    const chunkRecs = Math.max(1, Math.floor(READ_BLOCK / size));
    const buf = Buffer.allocUnsafe(chunkRecs * size);
    for (let b = 0; b < BUCKETS; b++) {
      const file = files[b];
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        return false;
      }
      if (st.size < HEADER_BYTES || (st.size - HEADER_BYTES) % size !== 0) return false;
      const records = (st.size - HEADER_BYTES) / size;
      buckets[b].records = records;
      let fd = null;
      try {
        fd = fs.openSync(file, 'r');
        const h = Buffer.alloc(HEADER_BYTES);
        fs.readSync(fd, h, 0, HEADER_BYTES, 0);
        if (h.toString('ascii', 0, 8) !== MAGIC || h.readUInt32LE(8) !== dim) return false;
        for (let slot = 0; slot < records; slot += chunkRecs) {
          const n = Math.min(chunkRecs, records - slot);
          fs.readSync(fd, buf, 0, n * size, HEADER_BYTES + slot * size);
          for (let i = 0; i < n; i++) {
            const off = i * size;
            const id = buf.readInt32LE(off);
            if (id === 0) continue;
            const v0 = buf.readFloatLE(off + 8);
            const at = slot + i;
            idIndex.set(id, { b, slot: at });
            buckets[b].lo = Math.min(buckets[b].lo, v0);
            buckets[b].hi = Math.max(buckets[b].hi, v0);
          }
        }
        buckets[b].alive = Number(idIndex.size) - total;
        total = idIndex.size;
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
    }
    return true;
  }

  /** 从权威数据源流式重建（不 .all()，任何时刻只有一批 Buffer 在内存） */
  function rebuild() {
    closeFds();
    fs.mkdirSync(dir, { recursive: true });
    idIndex = new Map();
    buckets = freshBuckets();
    total = 0;
    const out = files.map((f) => fs.openSync(f, 'w'));
    const pending = Array.from({ length: BUCKETS }, () => []);
    const flush = (b) => {
      const items = pending[b];
      if (!items.length) return;
      const chunk = Buffer.concat(items.map((it) => it.buf));
      fs.writeSync(out[b], chunk, 0, chunk.length, HEADER_BYTES + buckets[b].records * size);
      for (const it of items) {
        const slot = buckets[b].records++;
        idIndex.set(it.id, { b, slot });
        buckets[b].lo = Math.min(buckets[b].lo, it.v0);
        buckets[b].hi = Math.max(buckets[b].hi, it.v0);
        buckets[b].alive++;
        total++;
      }
      items.length = 0;
    };
    try {
      for (const fd of out) writeHeader(fd);
      for (const { id, vec } of iterate()) {
        if (!vec || vec.length !== dim) continue;
        const rec = Buffer.alloc(size);
        const { v0, bucket } = encodeRecord(rec, 0, id, vec, dim);
        pending[bucket].push({ id, buf: rec, v0 });
        if (pending[bucket].length >= 128) flush(bucket);
      }
      for (let b = 0; b < BUCKETS; b++) flush(b);
    } finally {
      for (const fd of out) {
        try {
          fs.closeSync(fd);
        } catch {
          /* 已关闭 */
        }
      }
    }
  }

  function ensure() {
    if (ready && !invalid) return api;
    fs.mkdirSync(dir, { recursive: true });
    const ok = invalid ? false : scanExisting();
    const dbCount = Number(count()) || 0;
    if (!ok || total !== dbCount) rebuild();
    ready = true;
    invalid = false;
    return api;
  }

  function writeAt(b, slot, buf) {
    fs.writeSync(fdFor(b), buf, 0, size, HEADER_BYTES + slot * size);
  }

  function tombstone(b, slot) {
    const zero = Buffer.alloc(4);
    fs.writeSync(fdFor(b), zero, 0, 4, HEADER_BYTES + slot * size);
  }

  function upsert(id, vec) {
    ensure();
    const rec = Buffer.alloc(size);
    const { v0, bucket } = encodeRecord(rec, 0, id, vec, dim);
    const pos = idIndex.get(id);
    if (pos) {
      if (pos.b === bucket) {
        writeAt(pos.b, pos.slot, rec); // 同桶重建模：原地覆盖
        buckets[pos.b].lo = Math.min(buckets[pos.b].lo, v0);
        buckets[pos.b].hi = Math.max(buckets[pos.b].hi, v0);
        return;
      }
      tombstone(pos.b, pos.slot); // 换桶：旧槽留墓碑
      buckets[pos.b].alive--;
      total--;
      idIndex.delete(id);
    }
    const slot = buckets[bucket].records;
    writeAt(bucket, slot, rec);
    buckets[bucket].records = slot + 1;
    buckets[bucket].alive++;
    buckets[bucket].lo = Math.min(buckets[bucket].lo, v0);
    buckets[bucket].hi = Math.max(buckets[bucket].hi, v0);
    idIndex.set(id, { b: bucket, slot });
    total++;
  }

  function remove(id) {
    ensure();
    const pos = idIndex.get(id);
    if (!pos) return;
    tombstone(pos.b, pos.slot);
    idIndex.delete(id);
    buckets[pos.b].alive--;
    total--;
  }

  function get(id) {
    ensure();
    const pos = idIndex.get(id);
    if (!pos) return null;
    const buf = Buffer.alloc(size);
    fs.readSync(fdFor(pos.b), buf, 0, size, HEADER_BYTES + pos.slot * size);
    const rec = decodeRecord(buf, 0, dim);
    return rec.id === id ? rec.vec : null;
  }

  /** 桶级上界剪枝：返回需要交给扫描器的桶（主线程不碰向量数据） */
  function plan(query, minCos = 0.8) {
    ensure();
    const q0 = Number(query[0]) || 0;
    const out = [];
    for (let b = 0; b < BUCKETS; b++) {
      const m = buckets[b];
      if (!m.records || m.alive <= 0) continue;
      const lo = m.hi < m.lo ? -1 : m.lo;
      const hi = m.hi < m.lo ? 1 : m.hi;
      if (bucketBound(q0, lo, hi) + EPS < minCos) continue;
      out.push({ file: m.file, records: m.records, lo, hi });
    }
    return out;
  }

  const api = {
    ensure,
    upsert,
    remove,
    get,
    plan,
    invalidate() {
      ready = false;
      invalid = true;
      closeFds();
    },
    close: closeFds,
    stats: () => ({ dir, dim, total, buckets: buckets.map((b) => ({ records: b.records, alive: b.alive, lo: b.lo, hi: b.hi })) }),
  };
  return api;
}
