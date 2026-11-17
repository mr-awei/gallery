/**
 * CLIP 基准（独立进程）。
 *
 * 为什么单独一个进程：`server/clip.js` 在 import 那一刻就把 TUKU_CLIP 开关与配置路径固化了，
 * 塞进 bench 主进程会和它自己的 sqlite 连接、临时库清理互相干扰。这里只负责：
 *   --mode vectors：给前 N 个素材写入合成向量，量「磁盘索引扫描」的耗时（不加载模型）
 *   --mode text   ：加载文本塔，量单次 embedText 的耗时（需要本机已有权重）
 * 结果以一行 JSON 打到 stdout，父进程负责套门槛。
 */
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? '' : String(argv[i + 1] || '');
};
const opt = (name, dflt) => {
  const n = Number(arg(name));
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const app = arg('app');
const mode = arg('mode') || 'vectors';
if (!app) {
  console.error('[bench-clip] 缺少 --app 参数');
  process.exit(2);
}
process.env.TUKU_USER_DATA = app;
process.env.TUKU_DATA_DIR = path.join(app, 'data');
// 向量检索不需要模型；只有 text 模式才让 CLIP 保持开启
if (mode === 'vectors') process.env.TUKU_CLIP = 'off';

const VECTORS = opt('vectors', 20000);
const SAMPLES = opt('samples', 15);
const DIM = 512;

function emit(obj) {
  console.log(`[bench-clip] ${JSON.stringify(obj)}`);
}

const clip = await import('../server/clip.js');
const { db } = await import('../server/db.js');

/** 确定性的伪随机单位向量：同一 seed 每次跑都得到同一批数据 */
function makeVec(seed) {
  let s = (seed * 2654435761) >>> 0;
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = s / 4294967296 - 0.5;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

try {
  if (mode === 'vectors') {
    const ids = db
      .prepare('SELECT id FROM images ORDER BY id LIMIT ?')
      .all(VECTORS)
      .map((r) => r.id);
    if (!ids.length) {
      emit({ ok: false, mode, error: '库里没有素材，无法写入向量' });
      process.exit(0);
    }
    const t0 = performance.now();
    for (const id of ids) clip.saveEmbedding(id, makeVec(id));
    const seedMs = performance.now() - t0;

    // 扫描 worker 在 clip.js 里是 unref 的（服务进程有 HTTP 句柄兜底）。这里是短命进程，
    // 不挂一个计时器的话事件循环会先空掉，Promise 永远不落地
    const keepAlive = setInterval(() => {}, 1000);

    // minCos=0 是刻意的最坏情况：不做余弦剪枝，全库扫一遍，得到耗时的上界
    const q = makeVec(1);
    await clip.topSimilar(q, { k: 24, minCos: 0 });

    const samples = [];
    let hits = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const t = performance.now();
      const r = await clip.topSimilar(q, { k: 24, minCos: 0 });
      samples.push(performance.now() - t);
      hits = r.length;
    }
    clearInterval(keepAlive);
    emit({ ok: true, mode, vectors: ids.length, dim: DIM, seedMs, samples, hits });
    process.exit(0);
  }

  if (mode === 'text') {
    const loadT0 = performance.now();
    await clip.textEncoderLoad();
    const loadMs = performance.now() - loadT0;
    // 每次换一句话：避免任何一层缓存（tokenizer / 图优化）把重复查询测成常数
    const queryAt = (i) => `第 ${i} 张：一只猫躺在草地上`;
    await clip.embedText(queryAt(0)); // 首次含一次性初始化，不计入样本
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = performance.now();
      await clip.embedText(queryAt(i + 1));
      samples.push(performance.now() - t);
    }
    emit({ ok: true, mode, loadMs, samples });
    process.exit(0);
  }

  emit({ ok: false, mode, error: `未知 mode：${mode}` });
  process.exit(0);
} catch (err) {
  emit({ ok: false, mode, error: String(err?.message || err).slice(0, 300) });
  process.exit(0);
}
