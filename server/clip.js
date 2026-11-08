/**
 * CLIP 深度特征：把每张图编码成 512 维归一化向量，余弦相似度判定「看起来是不是同一张」。
 *
 * 为什么需要它：pHash/dHash 只看低频结构，裁剪、旋转、加滤镜、换画幅都会让哈希面目全非；
 * CLIP 向量对这些变换几乎无感（cos > 0.9 仍是同一张），能补上哈希查重的最大盲区。
 *
 * 模型：CLIP ViT-B/32（约 150MB，首次使用自动下载到 models 缓存目录，之后离线可用）。
 * 权重完整性：加载前与随包可信哈希清单 server/model-pins.json 核对，被替换的权重拒绝加载。
 * 索引：磁盘 int16 量化分桶 + 余弦上界剪枝，扫描在 worker 线程按块读盘，不全表驻留内存。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pipeline, env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { db, getLibraryGeneration, getActiveLibrary } from './db.js';
import { MODEL_CACHE_DIR, DATA_DIR } from './config.js';
import { KNOWN_SHA256 } from './model-fetch.js';
import { openIndex } from './lib/clip-index.js';
import { scanBuckets } from './lib/clip-scan.js';

// 模型缓存放可写目录：打包版代码在只读 asar 内，指向 asar 会导致首次下载必挂
env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;
// 国内直连 huggingface.co 基本不通，默认走 hf-mirror 镜像；需要切换时设环境变量 CLIP_HUB_HOST
env.remoteHost = process.env.CLIP_HUB_HOST || 'https://hf-mirror.com';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const DIM = 512;
export const CLIP_DIM = DIM; // 供聚类等模块预加载缓存

let extractorPromise = null;
let extractorReady = false; // 真正加载完成（extractorPromise 非空 ≠ 可用）
let loadError = '';

/** TUKU_CLIP=off：彻底关掉深度特征（冒烟 / CI 用）。
 *  一是别为了跑接口测试去下 150MB 模型；二是让「入库查重」只走 pHash ——
 *  否则冒烟结果取决于模型此刻有没有加载完，同一份代码在本地和 CI 上结论不同。 */
const CLIP_DISABLED = String(process.env.TUKU_CLIP || '').toLowerCase() === 'off';

let pinnedChecked = false;

/**
 * 随包可信哈希清单核对：CLIP 权重不经过 model-fetch（由 transformers.js 自己下载），
 * 所以加载前单独校验缓存文件。清单里没有的文件（首次下载）跳过；文件存在却与清单
 * 不符时拒绝加载 —— 否则改权重 + 改 sidecar 就能绕过校验，「可信清单」形同虚设。
 * 按 1MB 块读，避免为 90MB 权重再吃一份等量内存。
 */
function verifyPinnedModels() {
  if (pinnedChecked) return;
  for (const [key, expect] of Object.entries(KNOWN_SHA256)) {
    if (!key.startsWith(`${MODEL_ID}/`)) continue;
    const file = path.join(MODEL_CACHE_DIR, key);
    if (!fs.existsSync(file)) continue;
    const hash = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      let n = 0;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    if (hash.digest('hex') !== String(expect).toLowerCase()) {
      throw new Error(`CLIP 模型与随包可信哈希不一致：${key}，请删除 ${file} 后重新下载`);
    }
  }
  pinnedChecked = true;
}

/** 懒加载特征提取器（首次调用触发模型下载） */
function getExtractor() {
  if (CLIP_DISABLED) return Promise.reject(new Error('CLIP 已通过 TUKU_CLIP=off 关闭'));
  try {
    verifyPinnedModels();
  } catch (err) {
    return Promise.reject(err);
  }
  if (!extractorPromise) {
    extractorReady = false;
    extractorPromise = pipeline('image-feature-extraction', MODEL_ID, { dtype: 'q8' })
      .then((p) => {
        extractorReady = true;
        return p;
      })
      .catch((err) => {
        loadError = err?.message || String(err);
        extractorReady = false;
        extractorPromise = null;
        throw err;
      });
  }
  return extractorPromise;
}

/** 模型是否可用：只有真正加载完成才算 ready（旧实现只看 promise 是否存在，
 *  首次下载几百 MB 期间也返回 true，调用方据此认为可用，结果必然超时/失败） */
export function clipReady() {
  return extractorReady;
}

/** 加载状态：ready / loading / error */
export async function clipLoad() {
  try {
    await getExtractor();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: loadError || err?.message || String(err) };
  }
}

/** 原地归一化（pooling normalize 选项在该管线不生效，手动做，保证点积即余弦） */
function normalizeInPlace(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Buffer / 路径 → 512 维归一化 Float32Array */
export async function embedImage(input) {
  const extractor = await getExtractor();
  const blob = Buffer.isBuffer(input) ? new Blob([input]) : input;
  const out = await extractor(blob, { pooling: 'cls', normalize: true });
  const data = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  return normalizeInPlace(data);
}

/* ------------------------- 文本塔（自然语言搜图） ------------------------- */
/**
 * 图像塔只做「图 → 512 维」，要让一句话也能查图，必须有文本塔，而且两者要落在
 * 同一个投影空间（CLIP 的 text_projection 与 visual_projection 是对齐训练出来的），
 * 否则余弦相似度就是随机数。
 *
 * 权重和图像塔是同一个仓库，首次使用会额外下 ~85MB（之后离线可用）。
 * 单独懒加载：只用以图搜图的人不必付这份内存。
 */
let textPromise = null;
let textReady = false;
let textError = '';

function getTextEncoder() {
  if (!textPromise) {
    textReady = false;
    textPromise = (async () => {
      verifyPinnedModels(); // 文本塔与图像塔共用仓库权重，同样先过可信哈希清单
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });
      textReady = true;
      return { tokenizer, model };
    })().catch((err) => {
      textError = err?.message || String(err);
      textReady = false;
      textPromise = null; // 允许重试，别把一次失败钉死成永久不可用
      throw err;
    });
  }
  return textPromise;
}

/** 文本塔是否已加载完成（与 clipReady 同一套语义：只有真加载完才算） */
export function textEncoderReady() {
  return textReady;
}

export function textEncoderError() {
  return textError;
}

export async function textEncoderLoad() {
  try {
    await getTextEncoder();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: textError || err?.message || String(err) };
  }
}

/** 一句话 → 512 维归一化向量（调用方须与 embedImage 的结果同空间比较） */
export async function embedText(text) {
  const list = await embedTexts([text]);
  return list[0];
}

/** 批量编码（多条查询做平均融合时用，省一次 tokenizer 往返） */
export async function embedTexts(texts = []) {
  const arr = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '').trim()).filter(Boolean);
  if (!arr.length) throw new Error('查询文本不能为空');
  const { tokenizer, model } = await getTextEncoder();
  const inputs = tokenizer(arr, { padding: true, truncation: true });
  const out = await model(inputs);
  const data = out.text_embeds.data instanceof Float32Array ? out.text_embeds.data : new Float32Array(out.text_embeds.data);
  const dim = out.text_embeds.dims?.[1] || DIM;
  const vecs = [];
  for (let i = 0; i < arr.length; i++) {
    vecs.push(normalizeInPlace(data.slice(i * dim, (i + 1) * dim)));
  }
  return vecs;
}

/** 多条向量平均后再归一化：一句长查询拆成几个短语时，比单句召回更稳 */
export async function embedTextMean(texts) {
  const vecs = await embedTexts(texts);
  if (vecs.length === 1) return vecs[0];
  const acc = new Float32Array(vecs[0].length);
  for (const v of vecs) for (let i = 0; i < v.length; i++) acc[i] += v[i] / vecs.length;
  return normalizeInPlace(acc);
}

export function getEmbedding(imageId) {
  const row = db.prepare('SELECT dim, vec FROM clip_vec WHERE image_id = ?').get(imageId);
  if (!row) return null;
  // 读回时归一化：兼容归一化修复前入库的未归一化向量（点积即余弦）
  return normalizeInPlace(new Float32Array(row.vec.buffer, row.vec.byteOffset, row.dim));
}

/** 重新建模（图片内容被旋转/增强覆盖后调用），失败静默（补算任务会兜底） */
export async function reembed(imageId, input) {
  if (CLIP_DISABLED) return; // 明确关掉了就别每张图刷一条「建模失败」
  try {
    saveEmbedding(imageId, await embedImage(input));
  } catch (err) {
    console.error('[clip] 建模失败', imageId, err?.message || err);
  }
}

export function embeddingCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM clip_vec').get().c;
}

/* -------------------------- 磁盘向量索引 + worker -------------------------- */
/**
 * 旧版 vecStores 把全库 512 维 float32 常驻 HTTP 进程（百万张 ≈ 2GB），
 * 且 topSimilar 在主线程逐条算点积，只能靠 setImmediate 让出事件循环。
 * 现在向量以 int16 量化落在库目录的分桶索引文件里：
 * - 主线程只留 id → { 桶, 槽位 } 的轻量 Map，不含向量本身；
 * - 查询先用桶级余弦上界跳过整桶，再由 worker 线程按块读盘扫描，HTTP 主线程不阻塞；
 * - DB 仍是权威数据源，count 不一致时流式重建，切库按库目录隔离索引。
 */
const indexes = new Map(); // Map<dim, 磁盘索引>

function indexDir(dim) {
  const root = getActiveLibrary()?.path || DATA_DIR;
  return path.join(root, 'clip-index', `d${dim}`);
}

function indexFor(dim) {
  let index = indexes.get(dim);
  if (!index) {
    index = openIndex(indexDir(dim), dim, {
      count: () => Number(db.prepare('SELECT COUNT(*) AS c FROM clip_vec WHERE dim = ?').get(dim)?.c || 0),
      iterate: function* () {
        const stmt = db.prepare('SELECT image_id, dim, vec FROM clip_vec WHERE dim = ?');
        // 迭代器逐行读，不 .all()：重建百万张时不把整表物化进内存
        const rows = typeof stmt.iterate === 'function' ? stmt.iterate(dim) : stmt.all(dim);
        for (const r of rows) {
          yield { id: r.image_id, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, dim) };
        }
      },
    });
    indexes.set(dim, index);
  }
  return index;
}

/** 单个常驻 worker：并发查询排队，避免每个请求都起一个线程 */
let searchWorker = null;
let workerSeq = 0;
const pendingScans = new Map();

function failPending(err) {
  for (const p of pendingScans.values()) p.reject(err);
  pendingScans.clear();
}

function getSearchWorker() {
  if (searchWorker) return searchWorker;
  try {
    const w = new Worker(new URL('./clip-search-worker.js', import.meta.url));
    w.on('message', (msg) => {
      const p = pendingScans.get(msg.seq);
      if (!p) return;
      pendingScans.delete(msg.seq);
      if (msg.ok) p.resolve(msg.hits);
      else p.reject(new Error(msg.error || 'CLIP 扫描 worker 执行失败'));
    });
    w.on('error', (err) => {
      failPending(err);
      w.terminate().catch(() => {});
      searchWorker = null;
    });
    w.on('exit', () => {
      searchWorker = null;
    });
    w.unref?.();
    searchWorker = w;
  } catch (err) {
    searchWorker = null;
    console.warn('[clip] 相似搜索 worker 不可用，回退主线程分块扫描：', err?.message || err);
  }
  return searchWorker;
}

async function runScan(payload) {
  const w = getSearchWorker();
  if (!w) {
    // 打包环境偶发起不了线程：仍走同一份分块磁盘扫描，绝不把向量搬回主线程常驻
    await new Promise((r) => setImmediate(r));
    return scanBuckets(payload);
  }
  const seq = ++workerSeq;
  const copy = Float32Array.from(payload.query);
  return new Promise((resolve, reject) => {
    pendingScans.set(seq, { resolve, reject });
    try {
      w.postMessage({ seq, payload: { ...payload, query: copy.buffer } }, [copy.buffer]);
    } catch (err) {
      pendingScans.delete(seq);
      scanBuckets(payload).then(resolve, reject);
    }
  });
}

/** 切库后必须调用：旧库索引文件里的 id 会和别库撞，留着会误判重复 */
export function resetVecCache() {
  for (const index of indexes.values()) index.close();
  indexes.clear();
  if (searchWorker) {
    searchWorker.terminate().catch(() => {});
    searchWorker = null;
  }
  failPending(new Error('已切换资源库，相似搜索中止'));
}

/** 确保某维度的磁盘索引就绪（聚类前调用，避免 cachedVector 逐条回库） */
export function ensureVecCache(dim = DIM) {
  return indexFor(dim).ensure();
}

export function saveEmbedding(imageId, vec) {
  db.prepare(
    'INSERT INTO clip_vec(image_id, dim, vec, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(image_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec'
  ).run(imageId, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), new Date().toISOString());
  const dim = vec.length;
  try {
    indexFor(dim).upsert(imageId, vec);
  } catch (err) {
    // DB 已写成功，不回滚；标记索引失效，下次查询按 DB 流式重建
    console.warn('[clip] 向量索引写入失败，将在下次查询时重建：', err?.message || err);
    indexes.get(dim)?.invalidate();
  }
}

export function deleteEmbedding(imageId) {
  db.prepare('DELETE FROM clip_vec WHERE image_id = ?').run(imageId);
  // 不知道该向量属于哪个维度：清掉已加载索引里的槽位；
  // 尚未加载的索引下次 ensure 时因 count 变化自动重建，不会留下陈旧向量
  for (const index of indexes.values()) {
    try {
      index.remove(imageId);
    } catch (err) {
      console.warn('[clip] 向量索引删除失败，将在下次查询时重建：', err?.message || err);
      index.invalidate();
    }
  }
}

/** 磁盘索引中的向量副本（无则 null）。供聚类等场景避免逐 id 回库查询 */
export function cachedVector(imageId) {
  for (const index of indexes.values()) {
    const v = index.get(imageId);
    if (v) return v;
  }
  return null;
}

/** 索引/worker 都不可用时的兜底：按游标逐行读 DB 算余弦，仍不把整表物化进内存 */
function scanFromDb(q, dim, { k, minCos, excludeId }) {
  const hits = [];
  const stmt = db.prepare('SELECT image_id, vec FROM clip_vec WHERE dim = ?');
  const rows = typeof stmt.iterate === 'function' ? stmt.iterate(dim) : stmt.all(dim);
  for (const r of rows) {
    if (r.image_id === excludeId) continue;
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, dim);
    let dot = 0;
    let nb = 0;
    for (let j = 0; j < dim; j++) {
      dot += q[j] * v[j];
      nb += v[j] * v[j];
    }
    const cos = dot / Math.sqrt(nb || 1); // q 已归一化
    if (cos >= minCos) hits.push({ id: r.image_id, cos });
  }
  hits.sort((a, b) => b.cos - a.cos);
  return hits.slice(0, k);
}

/** 全库中与 vec 余弦最高的前 k 个（排除自身），返回 [{ id, cos }] */
export async function topSimilar(vec, { k = 24, minCos = 0.8, excludeId = 0 } = {}) {
  const dim = vec.length;
  const q = normalizeInPlace(Float32Array.from(vec));
  try {
    const buckets = indexFor(dim).plan(q, minCos);
    if (!buckets.length) return [];
    return await runScan({ dim, buckets, query: q, k, minCos, excludeId });
  } catch (err) {
    // 切库会让 db 的 live binding 指向新库：拿旧库的 query 去新库兜底比对只会误判重复
    if (/已切换资源库/.test(String(err?.message || ''))) return [];
    console.warn('[clip] 磁盘索引扫描失败，回退 DB 逐行比对：', err?.message || err);
    return scanFromDb(q, dim, { k, minCos, excludeId });
  }
}

/* ------------------------------- 全库补算 ------------------------------- */

const backfillState = { running: false, done: 0, total: 0, error: '' };

export function backfillStatus() {
  return {
    running: backfillState.running,
    done: backfillState.done,
    total: backfillState.total,
    error: backfillState.error,
    indexed: embeddingCount(),
    model: MODEL_ID,
    loadError,
  };
}

/** 为所有缺失特征的图片补算（异步后台跑，进度见 backfillStatus） */
export async function startBackfill() {
  if (backfillState.running) return { ok: false, message: '补算正在进行中' };
  // 补算是跨 await 的长任务：中途切库后 id 属于旧库，写进新库就是错数据
  const generation = getLibraryGeneration();
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM images WHERE id NOT IN (SELECT image_id FROM clip_vec)')
    .get().c;
  backfillState.running = true;
  backfillState.done = 0;
  backfillState.total = total;
  backfillState.error = '';
  (async () => {
    try {
      await getExtractor();
      // 游标分批：旧版 .all() 一次性把百万个待补算 id 拉进内存，
      // 且补算途中新增/切库都会让这份快照失真；现在每批重新查一次。
      const batch = db.prepare(
        'SELECT id, abs_path FROM images WHERE id < ? AND id NOT IN (SELECT image_id FROM clip_vec) ORDER BY id DESC LIMIT ?'
      );
      let cursor = Number.MAX_SAFE_INTEGER;
      for (;;) {
        const rows = batch.all(cursor, 500);
        if (!rows.length) break;
        cursor = rows[rows.length - 1].id;
        for (const { id, abs_path } of rows) {
          if (generation !== getLibraryGeneration()) {
            backfillState.error = '已切换资源库，补算中止';
            break;
          }
          try {
            if (fs.existsSync(abs_path)) {
              const vec = await embedImage(abs_path);
              saveEmbedding(id, vec);
            }
          } catch (err) {
            console.error('[clip] 建模失败', id, err?.message || err);
          }
          backfillState.done++;
          // 节流：让事件循环转一圈，推理高峰期 HTTP 才不会被饿死。
          // 用 setImmediate 而非 setTimeout(40)：固定 40ms 是给每张图白加 40ms
          // 纯睡眠（百万张 ≈ 11 小时），setImmediate 同样让出主线程但不空等。
          await new Promise((r) => setImmediate(r));
        }
        if (generation !== getLibraryGeneration()) break;
      }
    } catch (err) {
      backfillState.error = err?.message || String(err);
    } finally {
      backfillState.running = false;
    }
  })();
  return { ok: true, total };
}
