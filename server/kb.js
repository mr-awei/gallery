import { db, getSettings, withTransaction } from './db.js';
import { hammingHex } from './phash.js';
import * as ai from './ai.js';

/**
 * 本地知识库：把「用户删除的不满意图片」沉淀为可执行规则，
 * 用于给图库图片打分、排序降权，以及在采集阶段自动过滤同类图片。
 */

export const RULE_TYPES = {
  source: '来源',
  keyword: '关键词',
  resolution: '分辨率',
  aspect: '宽高比',
  tag: '标签',
  phash: '相似画面',
  ai_term: 'AI 描述词',
};

const REASON_LABELS = {
  blur: '模糊 / 低清',
  lowres: '分辨率太低',
  watermark: '有水印或平台 Logo',
  notHer: '不是目标人物',
  duplicate: '重复画面',
  tinyPerson: '人物画面占比过小',
  faceCovered: '脸被遮挡 / 看不清',
  expression: '表情不好 / 闭眼',
  pose: '动作 / 姿态别扭',
  composition: '构图不好',
  cropped: '截取不全 / 变形',
  background: '背景太乱',
  lighting: '光线差 / 过曝欠曝',
  color: '色调不喜欢',
  noise: '噪点多 / 压缩痕迹重',
  overedited: '修图过度 / 不自然',
  outfit: '穿搭 / 造型不喜欢',
  era: '不是我喜欢的时期',
  notWallpaper: '不适合做壁纸（比例/方向）',
  ad: '广告或宣传图',
  other: '其他',
};

export function reasonLabel(key) {
  return REASON_LABELS[key] || key;
}

/**
 * 规则列表。`dormant` = 这条规则当前**打不中任何图**：
 * ai_term 靠 AI 看图描述做匹配，库里一条 ai_desc 都没有时它永远是死规则。
 * 界面上默认隐藏（并说明原因），否则用户会以为自己配的「水印」规则在生效。
 */
export function listRules() {
  const rows = db.prepare('SELECT * FROM kb_rules ORDER BY enabled DESC, weight DESC, id DESC').all();
  const noAiDesc = !db.prepare('SELECT 1 FROM ai_desc LIMIT 1').get();
  return rows.map((r) => ({ ...r, dormant: r.type === 'ai_term' && noAiDesc }));
}

/**
 * 分页版规则列表：LIMIT/OFFSET 在 SQL 里做，响应体不随规则总数线性增长。
 * 注意 listRules() 不能加分页 —— scoreImage / rescoreAll 拿它当「全部生效规则」用。
 * @returns {{items:object[], total:number, limit:number, offset:number}}
 */
export function listRulesPaged({ limit = 100, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  const total = Number(db.prepare('SELECT COUNT(*) AS c FROM kb_rules').get()?.c || 0);
  const rows = db
    .prepare('SELECT * FROM kb_rules ORDER BY enabled DESC, weight DESC, id DESC LIMIT ? OFFSET ?')
    .all(lim, off);
  const noAiDesc = !db.prepare('SELECT 1 FROM ai_desc LIMIT 1').get();
  return {
    items: rows.map((r) => ({ ...r, dormant: r.type === 'ai_term' && noAiDesc })),
    total,
    limit: lim,
    offset: off,
  };
}

export function upsertRule({ type, value, label, weight = 12, origin = 'user' }) {
  if (!type || !value) return null;
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM kb_rules WHERE type = ? AND value = ?').get(type, value);
  if (existing) {
    const hits = existing.hits + 1;
    const nextWeight = Math.min(45, Math.max(existing.weight, weight) + 2);
    db.prepare('UPDATE kb_rules SET hits = ?, weight = ?, updated_at = ?, label = ? WHERE id = ?').run(
      hits,
      nextWeight,
      now,
      label || existing.label,
      existing.id
    );
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO kb_rules(type, value, label, weight, hits, origin, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)`
    )
    .run(type, String(value), label || '', weight, origin, now, now);
  return Number(info.lastInsertRowid);
}

export function setRule(id, patch) {
  const fields = [];
  const values = [];
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.weight !== undefined) {
    fields.push('weight = ?');
    values.push(Math.max(0, Math.min(45, Number(patch.weight) || 0)));
  }
  if (patch.label !== undefined) {
    fields.push('label = ?');
    values.push(String(patch.label));
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE kb_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteRule(id) {
  db.prepare('DELETE FROM kb_rules WHERE id = ?').run(id);
}

/* --------------------------------- 反馈 ---------------------------------- */

/**
 * @param {boolean} [skipStatsRules] 为真时不生成「来源 / 关键词」这类连坐规则。
 *   壁纸「不喜欢」走这里：只按推断出的具体原因（噪点/光线/闭眼/动作…）建规则，
 *   不能因为一张图不喜欢就给整个来源或关键词降分。
 */
export function addFeedback({ imageId, reasons = [], note = '', aiAnalysis = '', skipStatsRules = false }) {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(imageId);
  const snapshot = row
    ? {
        width: row.width,
        height: row.height,
        source: row.source,
        keyword: row.keyword,
        tags: row.tags,
        phash: row.phash,
        path: row.abs_path,
        title: row.title,
        aspect: row.height ? +(row.width / row.height).toFixed(3) : 0,
        longEdge: Math.max(row.width || 0, row.height || 0),
      }
    : {};

  // 写反馈 + 规则沉淀放进一个事务：否则十几次独立小写入各自 fsync，删除会拖慢数秒。
  // 全库重打分不再塞在事务里（百万级要十几秒，把写入锁持那么久），改为提交后合并触发。
  const feedbackId = withTransaction(() => {
    const info = db
      .prepare(
        'INSERT INTO feedback(image_id, created_at, reasons, note, ai_analysis, snapshot) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        imageId,
        new Date().toISOString(),
        (reasons || []).join(','),
        String(note || ''),
        String(aiAnalysis || ''),
        JSON.stringify(snapshot)
      );
    if (row) deriveRules(row, reasons || []);
    if (!skipStatsRules) reinforceByStats(); // 跳过「来源/关键词」连坐规则
    return Number(info.lastInsertRowid);
  });
  requestRescore();
  return feedbackId;
}

/** 从一次明确的不满意原因中推导出规则 */
function deriveRules(row, reasons) {
  const longEdge = Math.max(row.width || 0, row.height || 0);
  for (const key of reasons) {
    switch (key) {
      case 'blur':
      case 'lowres':
        upsertRule({
          type: 'resolution',
          value: String(Math.min(Math.max(longEdge, 800), 2600)),
          label: `分辨率低于 ${Math.min(Math.max(longEdge, 800), 2600)}px 的画面偏糊`,
          weight: 14,
        });
        break;
      case 'watermark':
        upsertRule({ type: 'ai_term', value: '水印', label: '含水印或平台 Logo', weight: 22 });
        upsertRule({ type: 'ai_term', value: 'Logo', label: '含水印或平台 Logo', weight: 18 });
        break;
      case 'notHer':
        upsertRule({ type: 'ai_term', value: '非本人', label: '疑似不是目标人物', weight: 30 });
        break;
      case 'duplicate':
        if (row.phash) {
          upsertRule({ type: 'phash', value: row.phash, label: '与已删除的重复画面相似', weight: 25 });
        }
        break;
      case 'composition':
        upsertRule({ type: 'ai_term', value: '构图', label: '构图不佳', weight: 12 });
        break;
      case 'tinyPerson':
        upsertRule({ type: 'ai_term', value: '人物过小', label: '人物画面占比过小', weight: 15 });
        break;
      case 'faceCovered':
        upsertRule({ type: 'ai_term', value: '遮挡', label: '脸被遮挡或看不清', weight: 20 });
        break;
      case 'expression':
        upsertRule({ type: 'ai_term', value: '表情', label: '表情不佳或闭眼', weight: 14 });
        upsertRule({ type: 'ai_term', value: '闭眼', label: '闭眼画面', weight: 20 });
        break;
      case 'pose':
        upsertRule({ type: 'ai_term', value: '动作', label: '动作姿态不佳', weight: 12 });
        break;
      case 'background':
        upsertRule({ type: 'ai_term', value: '背景', label: '背景杂乱', weight: 12 });
        break;
      case 'lighting':
        upsertRule({ type: 'ai_term', value: '过曝', label: '过曝或欠曝', weight: 14 });
        upsertRule({ type: 'ai_term', value: '光线', label: '光线不佳', weight: 12 });
        break;
      case 'noise':
        upsertRule({ type: 'ai_term', value: '噪点', label: '噪点或压缩痕迹重', weight: 14 });
        break;
      case 'overedited':
        upsertRule({ type: 'ai_term', value: '修图', label: '修图过度不自然', weight: 14 });
        break;
      case 'outfit':
        upsertRule({ type: 'ai_term', value: '穿搭', label: '穿搭造型不受喜欢', weight: 10 });
        break;
      case 'color':
        upsertRule({ type: 'ai_term', value: '色调', label: '色调不受喜欢', weight: 10 });
        break;
      case 'cropped':
      case 'ad':
        upsertRule({ type: 'ai_term', value: '变形', label: '截取不全或变形', weight: 12, origin: 'user' });
        break;
      default:
        break;
    }
  }
}

/** 同一来源 / 关键词被反复差评时，自动形成更强的规则（越用越准） */
function reinforceByStats() {
  const rows = db.prepare('SELECT snapshot FROM feedback').all();
  const sourceCount = new Map();
  const keywordCount = new Map();
  for (const r of rows) {
    try {
      const s = JSON.parse(r.snapshot || '{}');
      if (s.source) sourceCount.set(s.source, (sourceCount.get(s.source) || 0) + 1);
      if (s.keyword) keywordCount.set(s.keyword, (keywordCount.get(s.keyword) || 0) + 1);
    } catch {
      /* ignore */
    }
  }
  for (const [source, count] of sourceCount) {
    if (count >= 3) {
      upsertRule({
        type: 'source',
        value: source,
        label: `来源「${source}」被差评 ${count} 次`,
        weight: Math.min(35, 8 + count * 2),
      });
    }
  }
  for (const [keyword, count] of keywordCount) {
    if (count >= 3) {
      upsertRule({
        type: 'keyword',
        value: keyword,
        label: `关键词「${keyword}」被差评 ${count} 次`,
        weight: Math.min(35, 8 + count * 2),
      });
    }
  }
}

export function listFeedback(limit = 100) {
  return db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
    id: r.id,
    imageId: r.image_id,
    createdAt: r.created_at,
    reasons: r.reasons ? r.reasons.split(',').filter(Boolean) : [],
    note: r.note,
    aiAnalysis: r.ai_analysis,
    snapshot: (() => {
      try {
        return JSON.parse(r.snapshot || '{}');
      } catch {
        return {};
      }
    })(),
  }));
}

export function deleteFeedback(id) {
  db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
}

/* --------------------------------- 打分 ---------------------------------- */

export function matchRule(image, rule, aiText = '') {
  switch (rule.type) {
    case 'source':
      return image.source === rule.value;
    case 'keyword': {
      const kw = image.keyword || '';
      const v = rule.value || '';
      return !!kw && !!v && (kw === v || kw.includes(v) || v.includes(kw));
    }
    case 'resolution':
      return Math.max(image.width || 0, image.height || 0) < Number(rule.value || 0);
    case 'aspect': {
      const [min, max] = String(rule.value).split(':').map(Number);
      if (!image.height || Number.isNaN(min) || Number.isNaN(max)) return false;
      const a = image.width / image.height;
      return a >= min && a <= max;
    }
    case 'tag': {
      const tags = String(image.tags || '')
        .split(',')
        .map((t) => t.trim());
      return tags.includes(rule.value);
    }
    case 'phash':
      return !!image.phash && hammingHex(image.phash, rule.value) <= 10;
    case 'ai_term':
      return !!aiText && aiText.includes(rule.value);
    default:
      return false;
  }
}

export function scoreImage(image, rules = listRules(), aiText = '') {
  let score = 100;
  const hits = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (matchRule(image, rule, aiText)) {
      score -= rule.weight;
      hits.push(rule.label || `${RULE_TYPES[rule.type] || rule.type}:${rule.value}`);
    }
  }
  return { score: Math.max(0, Math.min(100, score)), reasons: hits };
}

let rescoreTimer = null;
let rescoreRunning = false;
let rescorePending = false;

/**
 * 合并触发全库重打分。
 *
 * 旧实现每次反馈/规则增删都同步跑一遍全表读 + 逐行 UPDATE（百万级要十几秒），
 * 连写 10 条反馈就是 10 遍全表写。这里合并成一次，且同一时刻只跑一遍
 * （跑的过程中又有请求 → 标记 pending，结束后补跑一次）。
 */
export function requestRescore(delay = 2000) {
  if (rescoreTimer) clearTimeout(rescoreTimer);
  rescoreTimer = setTimeout(() => {
    rescoreTimer = null;
    if (rescoreRunning) {
      rescorePending = true;
      return;
    }
    rescoreRunning = true;
    try {
      rescoreAll();
    } catch (err) {
      console.error('[kb] 重打分失败：', err?.message || err);
    } finally {
      rescoreRunning = false;
      if (rescorePending) {
        rescorePending = false;
        requestRescore(200);
      }
    }
  }, delay);
  // 别让定时器把进程吊住（Node 22+ 支持 unref）
  rescoreTimer.unref?.();
  return rescoreTimer;
}

const RESCORE_BATCH = 1000;

export function rescoreAll() {
  const rules = listRules().filter((r) => r.enabled);
  const threshold = getSettings().scoreThreshold; // 移出循环：getSettings 每次全量读表+JSON解析，放循环里曾导致全库重打分耗时 11 秒
  // 旧实现把 `SELECT * FROM images` 与整张 ai_desc 全量物化，再包一个跨百万行的事务。
  // 现在按 id 游标分批，AI 描述随批 LEFT JOIN，每批独立事务：常驻内存与 WAL 都不再随库线性增长。
  const batch = db.prepare(
    `SELECT i.id, i.source, i.keyword, i.width, i.height, i.tags, i.phash,
            i.score, i.score_reason,
            COALESCE(d.description, '') || ' ' || COALESCE(d.issues, '') AS ai_text
       FROM images i
       LEFT JOIN ai_desc d ON d.image_id = i.id
      WHERE i.id < ? ORDER BY i.id DESC LIMIT ?`
  );
  const update = db.prepare('UPDATE images SET score = ?, score_reason = ? WHERE id = ?');
  let low = 0;
  let written = 0;
  let updated = 0;
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = batch.all(cursor, RESCORE_BATCH);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    updated += rows.length;
    withTransaction(() => {
      for (const row of rows) {
        const { score, reasons } = scoreImage(row, rules, row.ai_text || '');
        if (score < threshold) low++;
        const reason = reasons.join('；');
        // 分数没变就不写：以前每次反馈/改规则都把全库每一行 UPDATE 一遍
        if (row.score !== score || String(row.score_reason || '') !== reason) {
          update.run(score, reason, row.id);
          written++;
        }
      }
    });
  }
  return { updated, written, low };
}

/* -------------------------------- AI 归纳 -------------------------------- */

const SUMMARIZE_PROMPT = `你是一个图片库的知识库分析师。给你两部分输入：
1) 用户删除图片时留下的「不满意反馈」（含图片元数据与原因）；
2) 当前知识库里的全部规则。

你的任务是输出一份【整理后的完整规则集】，要求：
- 合并重复与冗余：同一关键词/来源的多个相近规则（如「人物 演唱会」被差评 25 次和 21 次两条）合并为一条，label 概括总差评次数，weight 取较高值；
- 删除无效规则：乱码（如 value 为 "????"）、无意义或互相矛盾的条目；
- 去掉被更通用规则覆盖的条目（如多条细分关键词可归并为少数几条核心关键词）；
- 再结合反馈归纳确实需要的新规则；
- 保持精炼：上限 12 条，宁缺毋滥。

输出严格 JSON：
{"rules":[{"type":"...","value":"...","label":"中文说明","weight":5-30}],"summary":"50 字以内说明做了哪些合并与清理"}
可选 type：
- source：某来源整体质量差，value ∈ bing/baidu/sogou/wallhaven/local
- keyword：某关键词采集质量差，value 为关键词原文
- resolution：分辨率阈值，value 为长边像素数字（低于它容易不满意）
- aspect：宽高比区间，value 形如 "0.4:0.8"（竖图约 0.4-0.8，横图约 1.2-2.5，方图约 0.9-1.1）
- tag：含某标签不喜欢，value 为标签
- ai_term：AI 看图描述中出现该词说明有问题，value 如 水印 / 模糊 / Logo / 非本人 / 构图
enabled 不用输出，系统沿用现有开关状态。不要臆造反馈中未出现的来源或关键词。`;

export async function summarizeWithAI() {
  const feedback = listFeedback(60);
  if (!feedback.length) throw new Error('还没有反馈记录，先删除几张不满意的图片吧');
  if (!ai.aiStatus().ready) throw new Error('AI 未配置');
  const existing = listRules();
  const payload = {
    feedback: feedback.map((f) => ({
      reasons: f.reasons,
      note: f.note,
      ai: f.aiAnalysis,
      meta: {
        source: f.snapshot.source,
        keyword: f.snapshot.keyword,
        size: `${f.snapshot.width}x${f.snapshot.height}`,
        aspect: f.snapshot.aspect,
        path: f.snapshot.path,
      },
    })),
    currentRules: existing.map((r) => ({
      type: r.type,
      value: r.value,
      label: r.label,
      weight: r.weight,
      hits: r.hits,
    })),
  };
  const result = await ai.chatJson(
    [
      { role: 'system', content: SUMMARIZE_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    { timeout: 90000 }
  );
  const finalRules = (Array.isArray(result?.rules) ? result.rules : [])
    .filter((r) => r?.type && r?.value !== undefined && r.value !== '' && RULE_TYPES[r.type])
    .slice(0, 12);
  if (!finalRules.length) throw new Error('AI 未返回有效规则，现有规则保持不变');

  // 整体替换为 AI 整理后的规则集；沿用同名规则的开关状态与命中次数
  const oldBy = new Map(existing.map((r) => [`${r.type}:${r.value}`, r]));
  // 与其它写路径统一用 withTransaction（SAVEPOINT），避免与外层事务嵌套时抛
  // "cannot start a transaction within a transaction" 或把外层一起回滚
  withTransaction(() => {
    db.exec('DELETE FROM kb_rules');
    const ins = db.prepare(
      `INSERT INTO kb_rules(type, value, label, weight, hits, origin, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ai', ?, ?, ?)`
    );
    const now = new Date().toISOString();
    for (const r of finalRules) {
      const old = oldBy.get(`${r.type}:${String(r.value)}`);
      ins.run(
        r.type,
        String(r.value),
        r.label || `${RULE_TYPES[r.type]}：${r.value}`,
        Math.max(5, Math.min(30, Number(r.weight) || 12)),
        old?.hits || 0,
        old ? old.enabled : 1,
        old?.created_at || now,
        now
      );
    }
  });
  const stats = rescoreAll();
  return {
    ok: true,
    before: existing.length,
    after: finalRules.length,
    summary: result?.summary || '',
    stats,
  };
}

export async function suggestions() {
  const rules = listRules().filter((r) => r.enabled);
  const stats = feedbackStats();
  if (!ai.aiStatus().ready) throw new Error('AI 未配置');
  const text = await ai.chat(
    [
      {
        role: 'system',
        content:
          '你是本图库的采集顾问。根据知识库规则与统计，给出下一步采集建议：推荐关键词、应避开的来源/参数、以及筛选阈值。用中文分条列出，控制在 200 字内。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          rules: rules.map((r) => ({ type: r.type, value: r.value, label: r.label, hits: r.hits, weight: r.weight })),
          stats,
        }),
      },
    ],
    { timeout: 60000 }
  );
  return { ok: true, text: String(text) };
}

export function feedbackStats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM feedback').get().c;
  const rules = db.prepare('SELECT COUNT(*) AS c FROM kb_rules').get().c;
  const enabledRules = db.prepare('SELECT COUNT(*) AS c FROM kb_rules WHERE enabled = 1').get().c;
  const low = db.prepare('SELECT COUNT(*) AS c FROM images WHERE score < ?').get(getSettings().scoreThreshold).c;
  const avg = db.prepare('SELECT AVG(score) AS a FROM images').get().a || 0;
  const byReason = new Map();
  for (const row of db.prepare('SELECT reasons FROM feedback').all()) {
    for (const r of (row.reasons || '').split(',')) {
      if (r) byReason.set(r, (byReason.get(r) || 0) + 1);
    }
  }
  return {
    feedbackCount: total,
    ruleCount: rules,
    enabledRuleCount: enabledRules,
    lowScoreCount: low,
    avgScore: Math.round(avg),
    byReason: [...byReason.entries()].map(([key, count]) => ({ key, label: reasonLabel(key), count })),
  };
}
