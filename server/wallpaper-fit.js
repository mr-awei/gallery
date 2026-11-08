/**
 * 壁纸适配度：这张图「适不适合做桌面壁纸」的 0-100 评分。
 *
 * - 本地启发式（无 AI 也能用）：分析上下留白（放状态栏/图标的位置是否干净）、
 *   整体亮度、对比度、饱和度、画面复杂度——这些都是壁纸可用性的硬指标。
 * - AI 视觉判定（可选，配了视觉模型才启用）：让模型综合构图、主体位置、观感给出分数与理由。
 * 结果缓存在 wallpaper_fit 表；用户「喜欢 / 不喜欢」会累加 likes/dislikes，用于排序纠偏。
 */
import sharp from 'sharp';
import { db } from './db.js';
import * as ai from './ai.js';

const AI_SCHEMA = `输出严格 JSON（不要输出其他内容）：
{
  "score": 0-100 的整数（作为桌面壁纸的综合适配度），
  "safeArea": "top" | "bottom" | "center"（画面哪里最空、适合放图标或时钟），
  "reason": "30 字以内的理由，说明为什么适合/不适合做壁纸"
}`;

/** 本地启发式：返回 { score, safeArea, reason, brightness } */
export async function computeLocalFit(absPath) {
  const W = 128;
  const { data, info } = await sharp(absPath, { failOn: 'none' })
    .resize(W, null, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const px = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const luma = (x, y) => {
    const [r, g, b] = px(x, y);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };

  // 分区统计：上/中/下三段的亮度与方差（方差低 = 干净，适合放 UI 元素）
  const bandStats = (from, to) => {
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = Math.floor(height * from); y < Math.floor(height * to); y += 1) {
      for (let x = 0; x < width; x += 2) {
        const l = luma(x, y);
        sum += l;
        sumSq += l * l;
        n++;
      }
    }
    const mean = n ? sum / n : 0;
    const variance = n ? Math.max(0, sumSq / n - mean * mean) : 0;
    return { mean, sd: Math.sqrt(variance) };
  };
  const top = bandStats(0, 0.2);
  const bottom = bandStats(0.8, 1);
  const all = bandStats(0, 1);

  // 饱和度（过高刺眼、过低寡淡都不理想）
  let satSum = 0;
  let n = 0;
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const [r, g, b] = px(x, y);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      satSum += max ? (max - min) / max : 0;
      n++;
    }
  }
  const saturation = n ? satSum / n : 0;

  // 复杂度：相邻像素亮度梯度大 = 画面碎，壁纸会显得乱
  let grad = 0;
  let gn = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      grad += Math.abs(luma(x, y) - luma(x + 1, y)) + Math.abs(luma(x, y) - luma(x, y + 1));
      gn++;
    }
  }
  const complexity = gn ? grad / gn : 0;

  // 打分
  let score = 60;
  const cleanest = top.sd <= bottom.sd ? { band: 'top', sd: top.sd } : { band: 'bottom', sd: bottom.sd };
  if (cleanest.sd < 18) score += 14;
  else if (cleanest.sd < 32) score += 7;
  else if (cleanest.sd > 60) score -= 8;
  if (all.mean > 24 && all.mean < 210) score += 8; // 不过曝不过暗
  if (all.sd > 40) score += 6; // 有对比
  if (saturation > 0.15 && saturation < 0.62) score += 6;
  if (complexity > 40) score -= 10;
  else if (complexity < 12) score -= 4; // 过于平（纯色/纯天空）也不耐看
  score = Math.max(0, Math.min(100, Math.round(score)));

  const reason = `留白${cleanest.sd < 18 ? '干净' : '偏杂'}、亮度${Math.round(all.mean)}、对比${Math.round(all.sd)}、饱和${saturation.toFixed(2)}`;
  return { score, safeArea: cleanest.band, reason, brightness: Math.round(all.mean) };
}

export function getFit(imageId) {
  return db.prepare('SELECT * FROM wallpaper_fit WHERE image_id = ?').get(imageId) || null;
}

/** 取（必要时计算）适配度；useAi 为 true 且 AI 可用时用视觉模型判定 */
export async function ensureFit(imageId, { useAi = false } = {}) {
  const cached = getFit(imageId);
  if (cached && (cached.source === 'ai' || !useAi || !ai.aiStatus().ready)) return cached;
  const row = db.prepare('SELECT id, abs_path FROM images WHERE id = ?').get(imageId);
  if (!row) return null;
  let score;
  let safeArea;
  let reason;
  let source = 'local';
  let brightness = null;
  try {
    const local = await computeLocalFit(row.abs_path);
    score = local.score;
    safeArea = local.safeArea;
    reason = local.reason;
    brightness = local.brightness;
  } catch {
    score = 60;
    safeArea = 'center';
    reason = '无法分析画面';
  }
  if (useAi && ai.aiStatus().ready) {
    try {
      const j = await ai.visionJson(
        imageId,
        '你是桌面壁纸审核助手。判断这张图做成电脑桌面壁纸是否合适：考虑构图是否耐看、主体位置是否合适、画面上下是否有可放图标/时钟的留白、观感是否舒适。',
        AI_SCHEMA
      );
      const aiScore = Number(j?.score);
      if (Number.isFinite(aiScore)) {
        score = Math.round(Math.max(0, Math.min(100, aiScore * 0.7 + score * 0.3))); // AI 为主、本地为辅
        safeArea = ['top', 'bottom', 'center'].includes(j?.safeArea) ? j.safeArea : safeArea;
        reason = String(j?.reason || reason).slice(0, 60);
        source = 'ai';
      }
    } catch {
      /* AI 不可用则保留本地结果 */
    }
  }
  db.prepare(
    `INSERT INTO wallpaper_fit(image_id, score, safe_area, reason, source, brightness, likes, dislikes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
     ON CONFLICT(image_id) DO UPDATE SET
       score = excluded.score, safe_area = excluded.safe_area, reason = excluded.reason,
       source = excluded.source, brightness = excluded.brightness`
  ).run(imageId, score, safeArea, reason, source, brightness, new Date().toISOString());
  return getFit(imageId);
}

/** 用户反馈：喜欢 / 不喜欢（不喜欢会同时沉淀到知识库规则） */
export function recordFeedback(imageId, like) {
  const cur = getFit(imageId);
  if (!cur) return null;
  const likes = (cur.likes || 0) + (like ? 1 : 0);
  const dislikes = (cur.dislikes || 0) + (like ? 0 : 1);
  db.prepare('UPDATE wallpaper_fit SET likes = ?, dislikes = ? WHERE image_id = ?').run(likes, dislikes, imageId);
  return getFit(imageId);
}

/* ------------------------- 归因：这张为什么不适合当壁纸 ------------------------- */
/* 不做「来源/关键词」连坐：只从画面本身找具体原因（暗、糊、噪点、闭眼、动作变形…），
 * 再把这些原因交给知识库生成针对性规则（ai_term 类），与画面里是谁完全无关。 */

/** 关键词 → 原因 的对照表（按 ai_desc.issues / description 里出现的词匹配） */
const ISSUE_TO_REASON = [
  [/闭眼|眨眼|眼睛|表情|狰狞|神态/, 'expression'],
  [/动作|姿态|扭曲|变形|肢体|手势/, 'pose'],
  [/模糊|虚焦|脱焦|低清|分辨率低|马赛克/, 'blur'],
  [/噪点|压缩|涂抹|锯齿|伪影/, 'noise'],
  [/过曝|欠曝|曝光|太暗|昏暗|光线|逆光|死黑/, 'lighting'],
  [/水印|logo|台标|字幕|文字|,/i, 'watermark'],
  [/构图|歪|截取|裁切|倾斜/, 'composition'],
  [/背景|杂乱|路人|杂物/, 'background'],
  [/不是|非本人|不像|错人|他人/, 'notHer'],
  [/修图|磨皮|过度|不自然/, 'overedited'],
];

/** 从已有数据推断原因；证据不足且 AI 可用时，让视觉模型再看一眼 */
export async function inferDislikeReasons(imageId) {
  const reasons = new Set();
  const row = db.prepare('SELECT id, width, height, abs_path FROM images WHERE id = ?').get(imageId);
  const desc = db.prepare('SELECT description, issues, quality FROM ai_desc WHERE image_id = ?').get(imageId);
  const f = getFit(imageId) || (row ? await ensureFit(imageId, { useAi: false }).catch(() => null) : null);
  const q = db.prepare('SELECT sharpness FROM image_quality WHERE image_id = ?').get(imageId);

  const text = `${desc?.description || ''} ${desc?.issues || ''}`;
  for (const [re, reason] of ISSUE_TO_REASON) if (re.test(text)) reasons.add(reason);

  // 壁纸专属指标：亮度极端 / 画面过碎 / 留白不够
  if (f) {
    if (typeof f.brightness === 'number') {
      if (f.brightness < 55) reasons.add('lighting');
      else if (f.brightness > 205) reasons.add('lighting');
    }
    if (f.score < 45) reasons.add('composition');
  }
  // 清晰度显著偏低 → 模糊 / 噪点
  if (q && q.sharpness < 60) reasons.add('blur');

  // 证据不足：交给视觉模型按固定选项归因（更准）
  if (reasons.size === 0 && ai.aiStatus().ready && row) {
    try {
      const j = await ai.visionJson(
        imageId,
        '这张图被用户选作桌面壁纸后很快换掉了。请判断它最主要的问题是什么（最多 2 个），只能从给定选项中选择。',
        `选项：blur 模糊低清 / noise 噪点压缩痕迹 / lighting 过曝欠曝光线差 / expression 闭眼或表情不好 / pose 动作姿态扭曲 / composition 构图不好 / background 背景杂乱 / overedited 修图过度 / notHer 不是预期人物 / other 其他
输出严格 JSON：{"reasons":["blur","noise"],"why":"20 字以内说明"}`
      );
      for (const r of Array.isArray(j?.reasons) ? j.reasons : []) {
        if (typeof r === 'string' && r !== 'other') reasons.add(r);
      }
      if (!reasons.size) reasons.add('other');
    } catch {
      reasons.add('other');
    }
  }
  if (!reasons.size) reasons.add('other');
  return [...reasons];
}

/** 批量补算缺失的适配度（后台扫描，返回处理数量） */
export async function scanFits(limit = 200, useAi = false) {
  const rows = db
    .prepare(
      `SELECT i.id FROM images i
       LEFT JOIN wallpaper_fit f ON f.image_id = i.id
       WHERE f.image_id IS NULL
       ORDER BY i.id DESC LIMIT ?`
    )
    .all(limit);
  let done = 0;
  for (const r of rows) {
    try {
      await ensureFit(r.id, { useAi });
      done++;
    } catch {
      /* 单张失败不影响整体 */
    }
  }
  return { done, remain: db.prepare('SELECT COUNT(*) AS c FROM images WHERE id NOT IN (SELECT image_id FROM wallpaper_fit)').get().c };
}
