// @ts-check
/**
 * 本地零样本打标：不配置任何 AI 供应商、断网也能给素材打上大类标签。
 *
 * 原理：CLIP 的图像塔与文本塔落在同一投影空间，把「一张猫的照片」这类短语编码成
 * 向量，与图片向量算余弦 —— 谁高就是谁。这是零样本分类，不是「AI 猜你想什么」：
 * 只会从下面这份固定清单里选，选不中的（余弦太低）宁可不打标，也不硬塞一个错的。
 *
 * 与外部 AI 的关系：外部 AI 仍能给出更细的描述（场景、风格、物体关系），
 * 但它是可选的；这条路径保证「没配 key / 断网」时自动标签不是不可用。
 */
import * as clip from '../clip.js';
import { db } from '../db.js';
import * as lib from '../library.js';

/**
 * 标签清单：tag 是落到库里中文名，prompt 是给文本塔的英文短语。
 * 英文短语比中文命中率明显高（CLIP 训练集以英文为主），但用户看到的仍是中文标签。
 */
export const LOCAL_TAGS = [
  { tag: '人像', prompt: 'a portrait photo of a person' },
  { tag: '多人合影', prompt: 'a group photo of many people' },
  { tag: '自拍', prompt: 'a selfie taken with a phone' },
  { tag: '猫', prompt: 'a photo of a cat' },
  { tag: '狗', prompt: 'a photo of a dog' },
  { tag: '鸟', prompt: 'a photo of a bird' },
  { tag: '野生动物', prompt: 'a photo of a wild animal in nature' },
  { tag: '风景', prompt: 'a landscape photo of scenery' },
  { tag: '海景', prompt: 'a photo of the ocean and beach' },
  { tag: '山景', prompt: 'a photo of mountains' },
  { tag: '天空', prompt: 'a photo of the sky and clouds' },
  { tag: '夜景', prompt: 'a night photo of a city with lights' },
  { tag: '日落', prompt: 'a sunset or sunrise photo' },
  { tag: '雪景', prompt: 'a photo of snow in winter' },
  { tag: '森林', prompt: 'a photo of a forest with trees' },
  { tag: '花', prompt: 'a close up photo of flowers' },
  { tag: '植物', prompt: 'a photo of a plant or leaves' },
  { tag: '食物', prompt: 'a photo of food on a plate' },
  { tag: '咖啡', prompt: 'a photo of a cup of coffee' },
  { tag: '饮品', prompt: 'a photo of a drink in a glass' },
  { tag: '建筑', prompt: 'a photo of a building or architecture' },
  { tag: '室内', prompt: 'an indoor photo of a room' },
  { tag: '街道', prompt: 'a photo of a city street' },
  { tag: '交通工具', prompt: 'a photo of a car or vehicle' },
  { tag: '飞机', prompt: 'a photo of an airplane' },
  { tag: '火车', prompt: 'a photo of a train' },
  { tag: '船', prompt: 'a photo of a boat on water' },
  { tag: '家具', prompt: 'a photo of furniture in a room' },
  { tag: '服装', prompt: 'a photo of clothes or fashion' },
  { tag: '鞋子', prompt: 'a photo of shoes' },
  { tag: '包', prompt: 'a photo of a bag or handbag' },
  { tag: '首饰', prompt: 'a photo of jewelry' },
  { tag: '化妆品', prompt: 'a photo of cosmetics or skincare products' },
  { tag: '电子产品', prompt: 'a photo of an electronic device' },
  { tag: '手机', prompt: 'a photo of a smartphone' },
  { tag: '电脑', prompt: 'a photo of a laptop or computer' },
  { tag: '截图', prompt: 'a screenshot of a computer or phone interface' },
  { tag: '文字', prompt: 'an image containing a lot of text' },
  { tag: '图表', prompt: 'a chart or infographic with data' },
  { tag: '文档', prompt: 'a scanned document or paper page' },
  { tag: '海报', prompt: 'a poster or flyer design' },
  { tag: '标志', prompt: 'a logo on a plain background' },
  { tag: '插画', prompt: 'an illustration or digital drawing' },
  { tag: '动漫', prompt: 'an anime style illustration' },
  { tag: '游戏', prompt: 'a video game screenshot' },
  { tag: '3D 渲染', prompt: 'a 3d render of an object' },
  { tag: '白底图', prompt: 'a product photo on a pure white background' },
  { tag: '产品图', prompt: 'a commercial product photography shot' },
  { tag: '室内设计', prompt: 'an interior design photo of a decorated room' },
  { tag: '婚礼', prompt: 'a wedding photo' },
  { tag: '运动', prompt: 'a sports action photo' },
  { tag: '音乐', prompt: 'a photo of a musical instrument' },
  { tag: '书', prompt: 'a photo of a book' },
  { tag: '玩具', prompt: 'a photo of a toy' },
  { tag: '纹理', prompt: 'a close up texture or pattern' },
  { tag: '抽象', prompt: 'an abstract colorful composition' },
];

/** 文本向量缓存：60 条短语只编码一次，之后每张图都是一次点积 */
let labelVecs = null;

async function ensureLabelVecs() {
  if (labelVecs) return labelVecs;
  labelVecs = await clip.embedTexts(LOCAL_TAGS.map((l) => l.prompt));
  return labelVecs;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * 猜一张图的标签。
 * @param {number} imageId
 * @param {{top?:number, minCos?:number}} [opts]
 * @returns {Promise<{tags:string[], scores:{tag:string, cos:number}[]}>}
 */
export async function guessTags(imageId, { top = 3, minCos = 0.24 } = {}) {
  const id = Number(imageId) || 0;
  const row = db.prepare('SELECT id, abs_path FROM images WHERE id = ?').get(id);
  if (!row) throw new Error('图片不存在');
  let vec = clip.getEmbedding(id);
  if (!vec) {
    vec = await clip.embedImage(row.abs_path);
    clip.saveEmbedding(id, vec);
  }
  const vecs = await ensureLabelVecs();
  const scores = LOCAL_TAGS.map((l, i) => ({ tag: l.tag, cos: dot(vec, vecs[i]) })).sort((a, b) => b.cos - a.cos);
  // 阈值卡在「至少有把握」的位置：低于阈值宁可不打标，也别往库里塞错的
  const picked = scores.filter((s) => s.cos >= minCos).slice(0, Math.max(1, Math.min(6, top)));
  return { tags: picked.map((p) => p.tag), scores: scores.slice(0, 5) };
}

/**
 * 批量给最近素材打本地标签。
 * 已有标签不重复加；dryRun 只回报「会打什么」，方便先看准确率。
 * @param {{limit?:number, top?:number, minCos?:number, dryRun?:boolean}} [opts]
 */
export async function tagBatch({ limit = 20, top = 3, minCos = 0.24, dryRun = true } = {}) {
  if (!clip.clipReady() && !clip.textEncoderReady()) {
    return { ok: false, error: 'CLIP 模型未就绪：先在设置里下载语义模型（之后离线可用）', done: 0, added: 0, remain: 0 };
  }
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  // 优先处理还没打标签的：打过的再跑一遍只是重复劳动
  const rows = db
    .prepare(
      `SELECT id, tags FROM images
        WHERE (tags = '' OR tags IS NULL) AND abs_path <> ''
        ORDER BY id DESC LIMIT ?`
    )
    .all(n);
  let added = 0;
  const samples = [];
  for (const row of rows) {
    const { tags } = await guessTags(row.id, { top, minCos });
    if (!tags.length) continue;
    samples.push({ id: row.id, tags });
    if (dryRun) continue;
    const cur = String(row.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const merged = [...new Set([...cur, ...tags])];
    if (merged.length === cur.length) continue;
    lib.setTags(row.id, merged);
    added++;
  }
  const remain = Number(
    db.prepare("SELECT COUNT(*) AS n FROM images WHERE (tags = '' OR tags IS NULL) AND abs_path <> ''").get()?.n || 0
  );
  return { ok: true, done: rows.length, added, remain, samples: samples.slice(0, 10), dryRun };
}
