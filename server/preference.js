/**
 * 本地偏好模型（个性化推荐）——完全离线，不上传任何数据。
 *
 * 思路：把你过去的行为当标签学一个「你会不会喜欢这类图」的线性模型（逻辑回归 + SGD）。
 * - 正样本：收藏、壁纸点「喜欢」、反复查看、4 星以上
 * - 负样本：壁纸点「不喜欢」、删除时选了原因、1 星
 * 标签只用用户行为。**不要**把规则分（score）当标签：那是模型的输入特征之一，
 * 拿来当标签只会让模型复现规则公式，学不到个人偏好。
 * 特征只用**画面属性**（来源、分辨率档、方向、色系、亮度、清晰度、AI 描述里的问题词），
 * 不用「是谁」这类身份特征——避免变成「只推某一个人」的信息茧房。
 *
 * 训练结果写回 images.pref（0-100），供「推荐排序」与壁纸挑选使用。
 */
import { db, getSettings, saveSettings } from './db.js';

/** AI 描述里的问题词 → 特征（与 kb 的原因体系一致） */
const TERMS = ['模糊', '噪点', '闭眼', '表情', '动作', '扭曲', '水印', 'Logo', '过曝', '光线', '构图', '背景', '修图', '低清'];
/** 亮度分档（来自 wallpaper_fit.brightness） */
const BRIGHT_BUCKETS = [60, 110, 160, 210];
/** 清晰度分档（来自 image_quality.sharpness） */
const SHARP_BUCKETS = [80, 250, 700];

const MAX_KEYWORDS = 16;

function bucketOf(v, edges) {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return i;
  return edges.length;
}

/** 构建特征字典（训练时按库内数据生成，保证稳定） */
function buildFeatures() {
  const sources = db
    .prepare("SELECT source AS k, COUNT(*) c FROM images WHERE source <> '' GROUP BY source ORDER BY c DESC LIMIT 8")
    .all()
    .map((r) => r.k);
  const keywords = db
    .prepare("SELECT keyword AS k, COUNT(*) c FROM images WHERE keyword <> '' GROUP BY keyword ORDER BY c DESC LIMIT ?")
    .all(MAX_KEYWORDS)
    .map((r) => r.k);
  const names = [];
  for (const s of sources) names.push(`src:${s}`);
  for (const k of keywords) names.push(`kw:${k}`);
  names.push('bucket:sd', 'bucket:fhd', 'bucket:2k', 'bucket:4k');
  names.push('orient:portrait', 'orient:landscape', 'orient:square');
  for (let i = 0; i < 13; i++) names.push(`hue:${i}`);
  names.push('hue:gray');
  names.push('bright:0', 'bright:1', 'bright:2', 'bright:3', 'bright:4');
  names.push('sharp:0', 'sharp:1', 'sharp:2', 'sharp:3');
  for (const t of TERMS) names.push(`term:${t}`);
  return { names, sources, keywords };
}

function orientationOf(w, h) {
  if (!w || !h) return 'orient:square';
  const r = w / h;
  if (r < 0.85) return 'orient:portrait';
  if (r > 1.18) return 'orient:landscape';
  return 'orient:square';
}

/** 单张图的特征向量（0/1） */
function vectorOf(row, descText, brightness, sharpness, feats) {
  const x = new Float64Array(feats.names.length);
  const set = (name) => {
    const i = feats.names.indexOf(name);
    if (i >= 0) x[i] = 1;
  };
  if (row.source) set(`src:${row.source}`);
  if (row.keyword) set(`kw:${row.keyword}`);
  const long = Math.max(row.width || 0, row.height || 0);
  if (long < 1280) set('bucket:sd');
  else if (long < 1920) set('bucket:fhd');
  else if (long < 2560) set('bucket:2k');
  else set('bucket:4k');
  set(orientationOf(row.width, row.height));
  const hue = String(row.hue || '').split(',')[0];
  if (hue === '' || hue === 'gray') set('hue:gray');
  else set(`hue:${Number(hue) || 0}`);
  if (typeof brightness === 'number') set(`bright:${bucketOf(brightness, BRIGHT_BUCKETS)}`);
  if (typeof sharpness === 'number') set(`sharp:${bucketOf(sharpness, SHARP_BUCKETS)}`);
  for (const t of TERMS) if (descText.includes(t)) set(`term:${t}`);
  return x;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/** 收集样本：[{x, y}] */
function collectSamples(feats) {
  const rows = db.prepare('SELECT * FROM images').all();
  const descMap = new Map(db.prepare('SELECT image_id, description, issues FROM ai_desc').all().map((r) => [r.image_id, `${r.description || ''} ${r.issues || ''}`]));
  const fitMap = new Map(db.prepare('SELECT image_id, brightness, likes, dislikes FROM wallpaper_fit').all().map((r) => [r.image_id, r]));
  const sharpMap = new Map(db.prepare('SELECT image_id, sharpness FROM image_quality').all().map((r) => [r.image_id, r.sharpness]));
  const feedback = db.prepare('SELECT image_id, COUNT(*) c FROM feedback GROUP BY image_id').all();
  const fbMap = new Map(feedback.map((r) => [r.image_id, r.c]));

  const samples = [];
  for (const row of rows) {
    const f = fitMap.get(row.id);
    const rating = Number(row.rating) || 0;
    // 标签只取**用户行为**：收藏 / 壁纸点喜欢 / 反复查看 / 高星；负样本是点不喜欢、写过删除原因、低星。
    // 以前把「知识库规则分 < 60」也算负样本——那等于让模型去拟合规则分的形状，
    // 训练出来的「偏好」和用户实际偏好没关系，只是把打分公式学了一遍。
    const y =
      row.favorite === 1 || (f && f.likes > 0) || (row.view_count || 0) >= 3 || rating >= 4
        ? 1
        : (f && f.dislikes > 0) || (fbMap.get(row.id) || 0) > 0 || rating === 1
          ? -1
          : 0;
    if (y === 0) continue; // 没有明确行为信号的图不参与训练
    const descText = descMap.get(row.id) || '';
    samples.push({
      x: vectorOf(row, descText, f?.brightness, sharpMap.get(row.id), feats),
      y: y > 0 ? 1 : 0,
    });
  }
  return samples;
}

function trainSgd(samples, dim) {
  const w = new Float64Array(dim);
  let b = 0;
  const LR = 0.15;
  const EPOCHS = 220;
  const L2 = 0.002;
  for (let e = 0; e < EPOCHS; e++) {
    for (const s of samples) {
      let z = b;
      for (let i = 0; i < dim; i++) z += w[i] * s.x[i];
      const p = sigmoid(z);
      const err = p - s.y;
      for (let i = 0; i < dim; i++) w[i] -= LR * (err * s.x[i] + L2 * w[i]);
      b -= LR * err;
    }
  }
  return { w: Array.from(w), b };
}

/** 训练并把打分写回 images.pref */
export function trainPreference() {
  const feats = buildFeatures();
  const samples = collectSamples(feats);
  const pos = samples.filter((s) => s.y === 1).length;
  const neg = samples.length - pos;
  if (samples.length < 8 || pos === 0 || neg === 0) {
    return { ok: false, samples: samples.length, pos, neg, message: '样本不足（需要同时有「喜欢」和「不喜欢/删除」信号，至少 8 条）' };
  }
  const model = trainSgd(samples, feats.names.length);
  const wArr = Float64Array.from(model.w);

  // 给全库打分写回
  const rows = db.prepare('SELECT * FROM images').all();
  const descMap = new Map(db.prepare('SELECT image_id, description, issues FROM ai_desc').all().map((r) => [r.image_id, `${r.description || ''} ${r.issues || ''}`]));
  const fitMap = new Map(db.prepare('SELECT image_id, brightness FROM wallpaper_fit').all().map((r) => [r.image_id, r.brightness]));
  const sharpMap = new Map(db.prepare('SELECT image_id, sharpness FROM image_quality').all().map((r) => [r.image_id, r.sharpness]));
  const upd = db.prepare('UPDATE images SET pref = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const x = vectorOf(row, descMap.get(row.id) || '', fitMap.get(row.id), sharpMap.get(row.id), feats);
      let z = model.b;
      for (let i = 0; i < x.length; i++) z += wArr[i] * x[i];
      upd.run(Math.round(sigmoid(z) * 100), row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  saveSettings({
    prefModel: {
      trainedAt: new Date().toISOString(),
      samples: samples.length,
      pos,
      neg,
      features: feats.names,
      w: model.w,
      b: model.b,
      // 前几个权重最大的特征，便于在界面上解释「模型学到了什么」
      top: feats.names
        .map((n, i) => ({ feature: n, w: +model.w[i].toFixed(3) }))
        .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
        .slice(0, 8),
    },
  });
  return { ok: true, samples: samples.length, pos, neg, updated: rows.length, top: getSettings().prefModel?.top || [] };
}

export function prefStatus() {
  const m = getSettings().prefModel || null;
  return {
    trained: !!m?.trainedAt,
    trainedAt: m?.trainedAt || null,
    samples: m?.samples || 0,
    pos: m?.pos || 0,
    neg: m?.neg || 0,
    featureCount: m?.features?.length || 0,
    top: m?.top || [],
  };
}

/** 单张图的偏好分（0-100，未训练时返回 50） */
export function prefScore(imageId) {
  const row = db.prepare('SELECT pref FROM images WHERE id = ?').get(imageId);
  return row ? Number(row.pref) || 50 : 50;
}
