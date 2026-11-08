import sharp from 'sharp';
import { db } from './db.js';
import { computePHash, computeDHash, hammingHex, hashPopcount } from './phash.js';
import * as lib from './library.js';
import * as clip from './clip.js';
import * as ai from './ai.js';
import { rgbToOklab, oklabDist, oklabChroma } from './lib/oklab.js';

/* ------------------------------- 颜色工具 ------------------------------- */

function parsePalette(str) {
  const out = [];
  if (!str) return out;
  let arr = null;
  try {
    const v = JSON.parse(str);
    if (Array.isArray(v)) arr = v;
  } catch {
    /* not JSON */
  }
  if (!arr) {
    // 兼容旧格式：纯 hex 字符串或单个 hex
    if (typeof str === 'string' && str.trim()) out.push({ hex: str.trim(), pop: 1 });
    return out;
  }
  for (const x of arr) {
    if (typeof x === 'string') out.push({ hex: x, pop: 1 });
    else if (x && typeof x.h === 'string') out.push({ hex: x.h, pop: typeof x.p === 'number' ? x.p : 0.1 });
  }
  return out;
}

/* 感知均匀颜色空间 OKLab（Björn Ottosson）。相比 CIELAB 更均匀、计算更轻，
 * 现代主色提取库（color-thief v3 / imagecolorpicker）已默认 OKLCH/OKLab 量化与匹配。
 * 这里用 OKLab 欧氏距离衡量“感知色差”——属于感知均匀度量，绝非 RGB 欧氏距离。
 * OKLab 相关换算统一在 ./lib/oklab.js（颜色搜索与查询共用同一实现）。 */

const OKLAB_NEUTRAL_CHROMA = 0.022; // 低于此彩度的颜色视为中性（灰/黑/白）
const MIN_POP = 0.04;       // 命中色至少要占画面 4% 才纳入结果
const MIN_POP_TIGHT = 0.01; // 占比不足 4% 时，需 ≥1% 且颜色几乎完全一致才放行
const TIGHT_DIST = 0.03;    // “几乎完全一致”的 OKLab 距离上限

/**
 * 颜色打分核心（对标 Eagle 调色板搜索 + MPEG-7 DominantColor；颜色搜索与图库精确颜色筛选共用）：
 * 给定目标颜色，返回「主色/调色板与之相近」的图片，并按“相似度 × 颜色占比”排序，
 * 让“画面主色就是该颜色”的图排在最前（精准），同时保留小面积同色作为召回。
 * 距离用 OKLab 感知均匀空间（非 RGB 欧氏），中性色（黑/白/灰）不会蹭进彩色查询。
 * tol 为 UI 滑块 0..160，映射到 OKLab 截止距离 ~0..0.5（≈0 几乎同色，越大越宽松）。
 */
/**
 * 「调色板字符串 → OKLab 颜色」缓存。
 * 颜色筛选每次请求都要把全库 palette JSON 解析一遍再做 RGB→OKLab 转换，
 * 而这些值只在入库/重新分析时变化。按 dominant|palette 串缓存，重复查询基本零解析。
 * 上限 2 万条（约十几 MB），超出按插入顺序淘汰最早的一条。
 */
const paletteLabCache = new Map();
const PALETTE_CACHE_MAX = 20000;

function paletteLabs(dominant, palette) {
  const key = `${dominant || ''}#${palette || ''}`;
  const hit = paletteLabCache.get(key);
  if (hit) return hit;
  const pal = parsePalette(palette);
  const raw = pal.length ? pal : dominant ? [{ hex: dominant, pop: 1 }] : [];
  const out = [];
  for (const c of raw) {
    const lab = rgbToOklab(c.hex);
    if (!lab) continue;
    out.push({ hex: c.hex, pop: c.pop, lab, chroma: oklabChroma(lab) });
  }
  if (paletteLabCache.size >= PALETTE_CACHE_MAX) {
    const first = paletteLabCache.keys().next().value;
    if (first !== undefined) paletteLabCache.delete(first);
  }
  paletteLabCache.set(key, out);
  return out;
}

const COLOR_SCAN_BATCH = 2000;

/**
 * 颜色打分：按 id 游标分批扫表，只保留质量最高的 topK 个命中。
 * 旧实现 `.all()` 把全库 dominant/palette 一次性物化后再对全量排序，
 * 百万级库一次颜色搜索就要几百 MB 常驻；现在常驻内存 = 一批 2000 行 + topK 结果。
 * topK=0 时才保留全部命中（仅供离线分析用，HTTP 路径一律传 limit）。
 */
export function scoreByColor(hex, tol = 48, topK = 0) {
  const t = rgbToOklab(hex);
  if (!t) throw new Error('无效的颜色值，请用 #rrggbb');
  const tChroma = oklabChroma(t);
  const targetNeutral = tChroma < OKLAB_NEUTRAL_CHROMA || t.L < 0.02 || t.L > 0.98;
  const cutoff = Math.max(0.001, (Math.max(0, Math.min(160, tol)) / 160) * 0.5);
  const SCALE = 0.12; // 距离对质量的衰减尺度：越小越强调“颜色要近”
  const cap = Math.max(0, Number(topK) || 0);
  // SQL 粗筛 box：以目标 OKLab 为中心、半宽 = cutoff + 余量。半宽 ≥ cutoff 保证「精确球面 ⊂ box」，
  // 主色命中的图绝不会被误删；余量覆盖画面内调色板相对主色的离散，避免把那些低质量召回丢掉。
  // 未回填 / 空主色（dominant_l IS NULL）的行仍全量兜底，保证正确性。
  const boxW = cutoff + 0.18;
  const box = [t.L - boxW, t.L + boxW, t.a - boxW, t.a + boxW, t.b - boxW, t.b + boxW];
  const stmt = db.prepare(
    `SELECT id, dominant, palette FROM images
     WHERE (dominant <> '' OR palette <> '')
       AND (dominant_l BETWEEN ? AND ? AND dominant_a BETWEEN ? AND ? AND dominant_b BETWEEN ? AND ? OR dominant_l IS NULL)
       AND id < ? ORDER BY id DESC LIMIT ?`
  );

  const scored = [];
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = stmt.all(box[0], box[1], box[2], box[3], box[4], box[5], cursor, COLOR_SCAN_BATCH);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const r of rows) {
      const colors = paletteLabs(r.dominant, r.palette);
      let best = null;
      for (const c of colors) {
        const { lab, chroma } = c;
        if (targetNeutral) {
          // 查询是黑/白/灰：只与同样中性的颜色匹配，并以其占比加权
          if (chroma >= OKLAB_NEUTRAL_CHROMA && lab.L >= 0.02 && lab.L <= 0.98) continue;
        } else {
          // 彩色查询：跳过中性色候选，避免灰图蹭进彩色结果
          if (chroma < OKLAB_NEUTRAL_CHROMA || lab.L < 0.02 || lab.L > 0.98) continue;
        }
        const d = oklabDist(t, lab);
        if (d > cutoff) continue;
        // 精度门槛：该颜色必须在画面里占到一定比例才算“有这种颜色”，
        // 否则 0.03% 的红色噪点会把整张图拽进红色结果（召回变噪音）。
        // 占比不足时，只有颜色几乎完全一致（d ≤ TIGHT_DIST）且至少 ~1% 存在感才放行。
        if (c.pop < MIN_POP && !(c.pop >= MIN_POP_TIGHT && d <= TIGHT_DIST)) continue;
        const pop = Math.max(0.01, c.pop);
        // 质量 = 颜色占比 × 距离衰减：主色图优先，但远处小色块也保留为召回
        const quality = pop * Math.exp(-d / SCALE);
        if (!best || quality > best.quality) best = { quality, d, hex: c.hex, pop };
      }
      if (best) scored.push({ id: r.id, ...best });
    }
    if (cap) {
      scored.sort((a, b) => b.quality - a.quality);
      if (scored.length > cap) scored.length = cap;
    }
  }
  scored.sort((a, b) => b.quality - a.quality);
  return cap ? scored.slice(0, cap) : scored;
}

/** 颜色搜索：打分后取前 limit 个，回填完整 DTO 与命中信息 */
export function searchByColor(hex, tol = 48, limit = 120) {
  const scored = scoreByColor(hex, tol, limit);
  const ids = scored.slice(0, limit).map((s) => s.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const map = new Map(
    db.prepare(`SELECT * FROM images WHERE id IN (${placeholders})`).all(...ids).map((r) => [r.id, r])
  );
  const scoreMap = new Map(scored.map((s) => [s.id, s]));
  return ids
    .map((id) => {
      const row = map.get(id);
      if (!row) return null;
      const dto = lib.toDTO(row);
      const sc = scoreMap.get(id);
      dto.matchHex = sc?.hex;
      dto.dist = sc ? Math.round(sc.d * 1000) / 1000 : undefined;
      return dto;
    })
    .filter(Boolean);
}

/* ------------------------------- 以图搜图（视觉搜索） ------------------------------- */

/**
 * 以图搜图：计算上传图的 pHash，找出感知哈希最接近的图（近邻 = 同一张/相似构图）。
 * maxHamming 越大越宽松（0=完全相同，10 左右=高度相似）。
 *
 * 误匹配治理（参考 PhotoPrism / image-match 的本地做法）：
 * 1. 纯色、近黑的图 pHash 会退化（几乎全 0 或全 1），彼此汉明距离很近却毫不相干——
 *    查询图或候选图哈希信息量过低时，只接受「几乎完全相同」的距离；
 * 2. 对 pHash 粗筛出的候选，重读文件再算一次 dHash（梯度哈希）做第二重校验，
 *    两个哈希都接近才算命中，避免暗色图撞 pHash 带出的无关结果。
 */
export async function searchByImageBuffer(buffer, { limit = 24, maxHamming = 10 } = {}) {
  // CLIP 深度特征优先：对裁剪/旋转/加滤镜的同类图远比哈希鲁棒（模型未就绪时自动退回哈希方案）
  // 返回值必须带上真实引擎：两种模式的可信度差一个量级，前端不能都写成「高度相似」
  if (clip.clipReady()) {
    try {
      const vec = await clip.embedImage(buffer);
      const hits = await clip.topSimilar(vec, { k: limit, minCos: 0.82 });
      if (hits.length) {
        const byId = new Map(hits.map((h) => [h.id, h.cos]));
        const rows = db
          .prepare(`SELECT * FROM images WHERE id IN (${hits.map(() => '?').join(',')})`)
          .all(...hits.map((h) => h.id));
        const sorted = rows.sort((a, b) => byId.get(b.id) - byId.get(a.id));
        return {
          engine: 'clip',
          items: sorted.map((r) => ({ ...lib.toDTO(r), cos: +byId.get(r.id).toFixed(4) })),
        };
      }
    } catch (err) {
      console.error('[clip] 以图搜图失败，退回哈希方案', err?.message || err);
    }
  }

  const phash = await computePHash(buffer);
  if (!phash) throw new Error('无法读取图片');
  const dhash = await computeDHash(buffer);
  // 查询图信息量过低（纯色/纯黑屏截图等）时，pHash 距离不可信
  const weakQuery = hashPopcount(phash) <= 6 || hashPopcount(phash) >= 58;

  // 走内存分桶索引取候选，不再把全表（含大文本列）读进内存逐个比
  const near = lib.findSimilarByPhash(phash, maxHamming, Math.max(240, limit * 8));
  const scored = [];
  if (near.length) {
    const byId = new Map();
    for (let i = 0; i < near.length; i += 400) {
      const ids = near.slice(i, i + 400).map((n) => n.id);
      const rows = db
        .prepare(`SELECT * FROM images WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids);
      for (const r of rows) byId.set(r.id, r);
    }
    for (const n of near) {
      const r = byId.get(n.id);
      if (!r) continue;
      // 候选图自身哈希退化，且不是几乎完全相同 → 大概率是暗色图撞哈希，直接丢弃
      if (!weakQuery && (hashPopcount(r.phash) <= 6 || hashPopcount(r.phash) >= 58) && n.dist > 2) continue;
      scored.push({ row: r, dist: n.dist });
    }
    scored.sort((a, b) => a.dist - b.dist);
  }

  // 第二重校验：只对头部候选重算 dHash（读原图，本地库里几十张的开销可以接受）
  const dhashLimit = Math.max(12, maxHamming + 2);
  const verified = [];
  const candidates = scored.slice(0, Math.max(limit, 24));
  for (const c of candidates) {
    if (dhash && !weakQuery) {
      try {
        const dh = await computeDHash(c.row.thumb || c.row.abs_path);
        if (dh && hammingHex(dhash, dh) > dhashLimit) continue; // pHash 近但 dHash 远 → 无关图
      } catch {
        /* 文件读不到就不拦（缩略图会显示文件缺失） */
      }
    }
    verified.push(c);
  }

  return {
    engine: 'phash',
    items: verified.slice(0, limit).map((s) => ({ ...lib.toDTO(s.row), hamming: s.dist })),
  };
}

export async function searchByImageDataUrl(dataUrl, opts = {}) {
  const m = String(dataUrl || '').match(/^data:image\/[a-zA-Z+]+;base64,(.+)$/);
  if (!m) throw new Error('需要 base64 图片（data:image/...;base64,...）');
  const buffer = Buffer.from(m[1], 'base64');
  return searchByImageBuffer(buffer, opts);
}

export async function searchByImagePath(filePath, opts = {}) {
  const buffer = await sharp(filePath, { failOn: 'none' }).toBuffer();
  return searchByImageBuffer(buffer, opts);
}

/* ------------------------------- 自然语言搜图（本地 CLIP） ------------------------------- */

/**
 * 本地语义检索：一句话 → CLIP 文本塔 512 维 → 与已建索引的图像向量比余弦。
 *
 * 和下面的 aiSearch 是两回事，别混：
 *  - 这里是真的跨模态召回，能搜「暖色调的日落海边」这种库里的标签根本没写过的描述；
 *  - aiSearch 是 LLM 抽词 + LIKE，标题/标签/描述里没有那个词就搜不到。
 *
 * 模型没就绪、文本塔加载失败、或者库里一张向量都没有时，退回 aiSearch，
 * 并把 degraded/reason 如实带出去（前端不能把关键词结果标成语义搜索）。
 */
export async function semanticSearch(query, { limit = 60, minCos = 0.18 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], engine: 'keyword', degraded: false, reason: '查询为空', keywords: [] };

  let reason;
  // 文本塔是独立懒加载的：首次要下 ~85MB（已缓存约 10 秒）。绝不能把请求挂在那里等，
  // 先把加载点着，给 4 秒窗口；没就绪就回 loading，前端隔几秒自动重试。
  if (!clip.textEncoderReady()) {
    const loading = clip.textEncoderLoad();
    loading.catch(() => {});
    await Promise.race([
      loading.then(() => true).catch(() => true),
      new Promise((r) => setTimeout(() => r(false), 4000)),
    ]);
  }

  if (clip.textEncoderReady()) {
    try {
      const vec = await clip.embedText(q);
      const hits = await clip.topSimilar(vec, { k: limit, minCos });
      const indexed = clip.embeddingCount();
      const total = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
      if (hits.length) {
        const byId = new Map(hits.map((h) => [h.id, h.cos]));
        const rows = db
          .prepare(`SELECT * FROM images WHERE id IN (${hits.map(() => '?').join(',')})`)
          .all(...hits.map((h) => h.id));
        const sorted = rows.sort((a, b) => byId.get(b.id) - byId.get(a.id));
        return {
          engine: 'clip',
          items: sorted.map((r) => ({ ...lib.toDTO(r), cos: +byId.get(r.id).toFixed(4) })),
          keywords: [],
          degraded: false,
          reason: '',
          covered: { indexed, total },
        };
      }
      // 模型可用但没命中：**不要**退回关键词。语义模式下用户描述的画面本来就可能
      // 一个字都不在标题/标签里，退回 LIKE 只会给一堆看似相关的噪音。
      return {
        engine: 'clip',
        items: [],
        keywords: [],
        degraded: false,
        reason: '',
        covered: { indexed, total },
      };
    } catch (err) {
      reason = `语义检索失败：${String(err?.message || err).slice(0, 160)}`;
    }
  } else {
    // 4 秒还没好：没报错就是还在下载/加载 —— 回「加载中」，后台继续，前端几秒后自动重试
    const loadError = clip.textEncoderError();
    if (!loadError) {
      return {
        items: [],
        engine: 'loading',
        keywords: [],
        degraded: false,
        reason: '文本模型首次加载中（约 85MB），几秒后自动重试',
      };
    }
    reason = `文本模型加载失败：${String(loadError).slice(0, 160)}`;
  }

  // 降级：LLM 抽词 / 关键词。engine 保持 keyword，degraded 明确为 true
  const fallback = await aiSearch(q, { limit });
  return { ...fallback, degraded: true, reason: reason || fallback.reason };
}

/* ------------------------------- AI 语义 / 视觉搜索 ------------------------------- */

/**
 * AI 语义搜索：把自然语言交给 LLM，转成「结构化过滤条件 + 关键词」，再在本地库检索。
 * 复用现有 OpenAI 兼容 AI（无需 embedding）。
 *
 * 注意：这里**没有** embedding/向量召回，本质是「LLM 抽词 + LIKE」。所以必须把
 * engine/degraded 一起返回：未配置 AI 或解析失败时结果只是整句关键词匹配，
 * 页面上不能再标成「AI 语义搜索」。
 */
export async function aiSearch(query, { limit = 60 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], engine: 'keyword', degraded: false, reason: '', keywords: [] };

  const configured = ai.aiStatus().ready;
  let filters = {};
  let keywords = [];
  let reason = '';

  if (configured) {
    try {
      const parsed = await ai.chatJson(
        [
          {
            role: 'system',
            content:
              '你是图库检索助手。用户用自然语言描述想要的图片，请输出严格 JSON：' +
              '{"filters":{"favorite":"yes"|"no"|null,"minRating":0,"orientation":"landscape"|"portrait"|"square"|null,' +
              '"source":null,"minWidth":0,"minScore":0,"tagsInclude":[]},"keywords":["用于匹配画面内容/场景/人物的词，如 山、演唱会、舞台、微笑、红色"]}。' +
              '只输出 JSON，不要解释。',
          },
          { role: 'user', content: q },
        ],
        { temperature: 0.1, timeout: 8000 }
      );
      filters = parsed?.filters || {};
      keywords = Array.isArray(parsed?.keywords) ? parsed.keywords.filter(Boolean) : [];
      if (!keywords.length) reason = 'AI 没有抽出可用关键词';
    } catch (err) {
      reason = String(err?.message || err).slice(0, 200);
    }
  } else {
    reason = '未配置 AI，直接按关键词匹配';
  }

  const engine = keywords.length && !reason ? 'llm' : 'keyword';
  // 只有「配了 AI 却没解析成功」才算降级；本来就没配属于正常的关键词模式
  const degraded = configured && engine !== 'llm';
  // 没有可用关键词时，用整句做关键词
  if (!keywords.length) keywords = [q];

  return { items: runStructuredSearch(filters, keywords, limit), engine, degraded, reason, keywords, filters };
}

/** 结构化条件 + 关键词混合检索（本地 SQL，零额外依赖） */
export function runStructuredSearch(filters = {}, keywords = [], limit = 60) {
  const where = [];
  const params = [];

  const fav = filters?.favorite;
  if (fav === 'yes') where.push('favorite = 1');
  else if (fav === 'no') where.push('favorite = 0');

  if (filters?.minRating > 0) {
    where.push('rating >= ?');
    params.push(Number(filters.minRating));
  }
  if (filters?.minScore > 0) {
    where.push('score >= ?');
    params.push(Number(filters.minScore));
  }
  if (filters?.minWidth > 0) {
    where.push('MAX(width, height) >= ?');
    params.push(Number(filters.minWidth));
  }
  const ori = filters?.orientation;
  if (ori === 'landscape') where.push('width > height * 1.15');
  else if (ori === 'portrait') where.push('height > width * 1.15');
  else if (ori === 'square') where.push('ABS(width - height) <= width * 0.15');

  const src = filters?.source;
  if (typeof src === 'string' && src) {
    where.push('source = ?');
    params.push(src);
  }

  const inc = Array.isArray(filters?.tagsInclude) ? filters.tagsInclude.filter(Boolean) : [];
  for (const t of inc) {
    // 标签倒排表（item_tags，触发器自动同步）：主键索引精确命中，替代此前的
    // (','||tags||',') LIKE '%,tag,%' 全表扫描；语义一致（完整标签匹配）
    where.push('id IN (SELECT image_id FROM item_tags WHERE tag = ?)');
    params.push(String(t).trim());
  }

  // 关键词：匹配标题 / 标签 / 采集词 / 备注 / AI 看图描述
  const kwList = (keywords || []).map((k) => String(k).trim()).filter(Boolean);
  if (kwList.length) {
    const like = kwList
      .map(() => '(title LIKE ? OR tags LIKE ? OR keyword LIKE ? OR note LIKE ? OR id IN (SELECT image_id FROM ai_desc WHERE description LIKE ?))')
      .join(' AND ');
    for (const k of kwList) {
      const p = `%${k}%`;
      params.push(p, p, p, p, p);
    }
    where.push(`(${like})`);
  }

  const sql = `SELECT * FROM images ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY score DESC, created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  return rows.map(lib.toDTO);
}
