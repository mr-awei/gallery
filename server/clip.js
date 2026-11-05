/**
 * CLIP 深度特征：把每张图编码成 512 维归一化向量，余弦相似度判定「看起来是不是同一张」。
 *
 * 为什么需要它：pHash/dHash 只看低频结构，裁剪、旋转、加滤镜、换画幅都会让哈希面目全非；
 * CLIP 向量对这些变换几乎无感（cos > 0.9 仍是同一张），能补上哈希查重的最大盲区。
 *
 * 模型：CLIP ViT-B/32（约 150MB，首次使用自动下载到 models 缓存目录，之后离线可用）。
 * 索引：全量暴力余弦（778 张 ≈ 每次查询几十毫秒），万张以内无需 ANN。
 */
import fs from 'node:fs';
import { pipeline, env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { db, getLibraryGeneration } from './db.js';
import { MODEL_CACHE_DIR } from './config.js';

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

/** 懒加载特征提取器（首次调用触发模型下载） */
function getExtractor() {
  if (CLIP_DISABLED) return Promise.reject(new Error('CLIP 已通过 TUKU_CLIP=off 关闭'));
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

/* ------------------------------ 向量内存索引 ------------------------------ */
/**
 * 分片增量缓存（替代旧的「全量单块 + 一写全失效」）：
 * - 按维度分组，每片 SHARD_CAP 条连续存储；写/删只动所在分片。
 *   旧实现每 save/delete 一条就把整个缓存扔掉、下次查询全表重读——
 *   批量导入或补算时等于每张图都触发一次全表扫描，百万级直接不可用。
 * - 删除先做墓碑（空槽复用），碎片超阈值就地紧凑化该分片。
 * - 查询两段式：先算前半维点积，用 Cauchy–Schwarz 上界
 *   （cos ≤ headDot + ‖queryTail‖·‖vecTail‖）剪枝，无假阴性；幸存者才算全维。
 *   图库向量普遍彼此 cos ≤ 0.8，典型查询可剪掉大半候选。
 * 内存量级与旧版相同（512 维 × 4B 常驻，百万张 ≈ 2GB），纯 JS 无 ANN 前提的折衷；
 * 进一步省内存需 sqlite-vec / 量化，见 docs。 */
const SHARD_CAP = 4096;
const vecStores = new Map(); // Map<dim, store>

/** 切库后必须调用：缓存里是上一个库的向量，留着会把新库导入误判成重复 */
export function resetVecCache() {
  vecStores.clear();
}

function tailNormOf(data, offset, head, dim) {
  let headSq = 0;
  for (let j = 0; j < head; j++) headSq += data[offset + j] * data[offset + j];
  const v = 1 - headSq;
  return v > 0 ? Math.sqrt(v) : 0;
}

function newShard(dim) {
  return {
    ids: new Int32Array(SHARD_CAP),
    data: new Float32Array(SHARD_CAP * dim),
    tail: new Float32Array(SHARD_CAP),
    count: 0,
    holes: [],
  };
}

function loadStore(dim) {
  const stmt = db.prepare('SELECT image_id, vec FROM clip_vec WHERE dim = ?');
  const store = { dim, shards: [], idIndex: new Map(), total: 0 };
  let shard = null;
  // 用迭代器逐行读：.all() 会先把整表（百万行 × 2KB ≈ 2GB）物化成数组，
  // 再复制进分片，峰值内存直接翻倍。iterate 只保留游标。
  const rows = typeof stmt.iterate === 'function' ? stmt.iterate(dim) : stmt.all(dim);
  for (const r of rows) {
    if (!shard || shard.count >= SHARD_CAP) {
      shard = newShard(dim);
      store.shards.push(shard);
    }
    const slot = shard.count++;
    const normed = normalizeInPlace(new Float32Array(r.vec.buffer, r.vec.byteOffset, dim));
    shard.data.set(normed, slot * dim);
    shard.ids[slot] = r.image_id;
    shard.tail[slot] = tailNormOf(shard.data, slot * dim, dim >> 1, dim);
    store.idIndex.set(r.image_id, { s: store.shards.length - 1, i: slot });
  }
  store.total = store.idIndex.size;
  vecStores.set(dim, store);
  return store;
}

function getStore(dim) {
  return vecStores.get(dim) || loadStore(dim);
}

/** 预加载某维度的全量向量缓存（聚类前调用，避免 cachedVector 逐条回库） */
export function ensureVecCache(dim = DIM) {
  return getStore(dim);
}

/** 分片内墓碑过多时紧凑化（把尾部活体往前挪，更新 idIndex） */
function compactShard(store, si) {
  const shard = store.shards[si];
  const { dim } = store;
  const live = [];
  for (let i = 0; i < shard.count; i++) {
    if (shard.ids[i] !== 0) live.push([shard.ids[i], shard.tail[i], i]);
  }
  const data = new Float32Array(SHARD_CAP * dim);
  const ids = new Int32Array(SHARD_CAP);
  const tail = new Float32Array(SHARD_CAP);
  live.forEach(([id, tn, oldSlot], i) => {
    data.set(shard.data.subarray(oldSlot * dim, oldSlot * dim + dim), i * dim);
    ids[i] = id;
    tail[i] = tn;
    store.idIndex.set(id, { s: si, i });
  });
  store.shards[si] = { ids, data, tail, count: live.length, holes: [] };
}

function removeFromStore(store, imageId) {
  const pos = store.idIndex.get(imageId);
  if (!pos) return;
  const shard = store.shards[pos.s];
  if (shard && shard.ids[pos.i] === imageId) {
    shard.ids[pos.i] = 0;
    shard.holes.push(pos.i);
    if (shard.holes.length > shard.count / 3) compactShard(store, pos.s);
  }
  store.idIndex.delete(imageId);
  store.total--;
}

function insertIntoStore(store, imageId, normed) {
  let shard = store.shards[store.shards.length - 1];
  if (!shard || (shard.count >= SHARD_CAP && !shard.holes.length)) {
    shard = newShard(store.dim);
    store.shards.push(shard);
  }
  let slot;
  if (shard.holes.length) {
    slot = shard.holes.pop();
  } else {
    slot = shard.count++;
  }
  const { dim } = store;
  shard.data.set(normed, slot * dim);
  shard.ids[slot] = imageId;
  shard.tail[slot] = tailNormOf(shard.data, slot * dim, dim >> 1, dim);
  store.idIndex.set(imageId, { s: store.shards.length - 1, i: slot });
  store.total++;
}

export function saveEmbedding(imageId, vec) {
  db.prepare(
    'INSERT INTO clip_vec(image_id, dim, vec, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(image_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec'
  ).run(imageId, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), new Date().toISOString());
  const dim = vec.length;
  const store = getStore(dim);
  const pos = store.idIndex.get(imageId);
  if (pos) {
    const shard = store.shards[pos.s];
    if (shard && shard.ids[pos.i] === imageId) {
      if (store.dim === dim) {
        // 同维度重建模：原地覆盖
        shard.data.set(vec, pos.i * dim);
        shard.tail[pos.i] = tailNormOf(shard.data, pos.i * dim, dim >> 1, dim);
        return;
      }
      removeFromStore(store, imageId); // 跨维度（实际不会发生，防御）
    }
  }
  // 缓存写入用归一化副本，DB 保持调用方原样（读取路径本就归一化）
  insertIntoStore(store, imageId, normalizeInPlace(Float32Array.from(vec)));
}

export function deleteEmbedding(imageId) {
  db.prepare('DELETE FROM clip_vec WHERE image_id = ?').run(imageId);
  // 不知道该向量是哪个维度：逐 store 清（store 数 = 出现过的维度数，通常 1）
  for (const store of vecStores.values()) removeFromStore(store, imageId);
}

/** 缓存中的向量副本（无则 null）。供聚类等场景避免逐 id 回库查询 */
export function cachedVector(imageId) {
  for (const store of vecStores.values()) {
    const pos = store.idIndex.get(imageId);
    if (pos) {
      const shard = store.shards[pos.s];
      if (shard && shard.ids[pos.i] === imageId) {
        return shard.data.slice(pos.i * store.dim, pos.i * store.dim + store.dim);
      }
    }
  }
  return null;
}

/** 全库中与 vec 余弦最高的前 k 个（排除自身），返回 [{ id, cos }] */
export async function topSimilar(vec, { k = 24, minCos = 0.8, excludeId = 0 } = {}) {
  const dim = vec.length;
  const head = dim >> 1;
  const store = getStore(dim);
  const scored = [];
  let qTailSq = 1;
  for (let j = 0; j < head; j++) qTailSq -= vec[j] * vec[j];
  const qTail = qTailSq > 0 ? Math.sqrt(qTailSq) : 0;
  let guard = 0;
  const LIMIT = Math.max(k * 8, 4096);
  let si = 0;
  for (const shard of store.shards) {
    const { ids, data, tail, count } = shard;
    for (let i = 0; i < count; i++) {
      const id = ids[i];
      if (id === 0 || id === excludeId) continue;
      const base = i * dim;
      // 第一段：前半维点积 + 尾范数上界剪枝（上界 < minCos 必然不是近邻）
      let h = 0;
      for (let j = 0; j < head; j++) h += vec[j] * data[base + j];
      if (h + qTail * tail[i] < minCos) continue;
      let dot = h;
      for (let j = head; j < dim; j++) dot += vec[j] * data[base + j];
      if (dot >= minCos) {
        scored.push({ id, cos: dot });
        // 命中远超 k 时就地收敛：排序截断，防止 minCos 很低时数组膨胀
        if (++guard >= LIMIT) {
          scored.sort((a, b) => b.cos - a.cos);
          scored.length = k;
          guard = 0;
        }
      }
    }
    // 每两个分片让出一次事件循环：百万级库一趟扫描是上亿次乘加，
    // 同步跑会把整个 HTTP 服务卡住（期间所有请求都超时）
    if (++si % 2 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  scored.sort((a, b) => b.cos - a.cos);
  return scored.slice(0, k);
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
  const ids = db
    .prepare(
      `SELECT id, abs_path FROM images WHERE id NOT IN (SELECT image_id FROM clip_vec) ORDER BY id`
    )
    .all();
  backfillState.running = true;
  backfillState.done = 0;
  backfillState.total = ids.length;
  backfillState.error = '';
  (async () => {
    try {
      await getExtractor();
      for (const { id, abs_path } of ids) {
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
    } catch (err) {
      backfillState.error = err?.message || String(err);
    } finally {
      backfillState.running = false;
    }
  })();
  return { ok: true, total: ids.length };
}
