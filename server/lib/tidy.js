// 相似图分组（整理）：CLIP 向量流式聚类 + pHash 相似 + 格式重复识别，供整理页使用（从 library.js 拆出）
import path from 'node:path';
import { db, getSettings } from '../db.js';
import { getSharpness } from '../quality.js';
import { hammingHex } from '../phash.js';
import * as clip from '../clip.js';
import { ingest, removeImage, toDTO } from '../library.js';


/**
 * 按感知哈希把「看起来是同一张」的图聚成组，供人工审查合并。
 * 组内按分辨率×评分排序，并给出推荐保留的那张。
 */
/**
 * CLIP 深度特征相似分组（双档，业界通行做法）：
 * - 组内最高余弦 ≥ 0.98 → tier='exact' 完全重复：同一张的转存/压缩版，可放心自动清理
 * - 否则 → tier='series' 系列照：同一场拍摄的多帧（连拍/pose 微调），只聚组折叠，默认不删
 * 组内推荐按「清晰度（拉普拉斯方差）× 分辨率」综合画质排序，最佳帧置顶。
 *
 * 聚类：流式 leader（质心剪枝）。旧实现全对两两比较 + 并查集，O(n²)——十万张 ≈ 5e9 次
 * 点积，主线程直接冻死。现在按 id 倒序逐张处理：先对候选簇的「质心」做前半维上界剪枝
 * （无假阴性），过线再算质心全维粗判，过线才对簇内成员精确判定；命中入簇并更新质心，
 * 未命中自立新簇。近似折衷（整理审查场景可接受，ingest 时的查重仍全量精确）：
 * - 每张图只与「窗口内 + 前 64 个簇」比较——同批导入的照片 id 相邻，窗口基本全覆盖；
 *   跨批次的历史重复主要靠导入查重拦截，这里漏掉的属于长尾。
 * - 簇数上限 2000、乘加预算兜底，超出后停止并 console.warn（结果可能不全）。
 */
const CLIP_GROUP_BUDGET = 1e10; // 乘加预算（≈10s 上限），防止病态分布把主线程拖死
const CLIP_GROUP_MAX_CLUSTERS = 2000;
const CLIP_GROUP_WINDOW = 2000; // 只与最近 WINDOW 个 id 内形成的簇比较
const CLIP_GROUP_TOP_CLUSTERS = 64; // 无论窗口，始终比较的最新簇数（抓跨批次重复）

export async function listClipSimilarGroups(minCos = 0.92, maxGroups = 80) {
  const EXACT_COS = 0.98;
  const dim = clip.CLIP_DIM;
  const head = dim >> 1;
  clip.ensureVecCache(dim);
  const rows = db
    .prepare(
      `SELECT i.id, i.width, i.height, i.abs_path FROM images i JOIN clip_vec c ON c.image_id = i.id ORDER BY i.id DESC`
    )
    .all();

  const tailOf = (v) => {
    let s = 1;
    for (let j = 0; j < head; j++) s -= v[j] * v[j];
    return s > 0 ? Math.sqrt(s) : 0;
  };

  const clusters = []; // 按形成序（最新在前）：{ members, sum, centroid, tail, maxEdge }
  let cost = 0;
  let truncated = false;
  let processed = 0;
  for (const row of rows) {
    if (++processed % 256 === 0) await new Promise((r) => setImmediate(r)); // 让 HTTP 喘气
    if (cost > CLIP_GROUP_BUDGET) {
      truncated = true;
      break;
    }
    const vec = clip.cachedVector(row.id);
    if (!vec) continue;
    const qTail = tailOf(vec);
    let best = null;
    let bestCos = 0;
    const limit = Math.min(clusters.length, CLIP_GROUP_TOP_CLUSTERS + CLIP_GROUP_MAX_CLUSTERS);
    for (let ci = 0; ci < limit; ci++) {
      const c = clusters[ci];
      // 窗口外的簇不再扫（同批导入 id 相邻；前 TOP 个最新簇除外）
      if (ci >= CLIP_GROUP_TOP_CLUSTERS && c.members[0].row.id < row.id - CLIP_GROUP_WINDOW) break;
      // 1) 质心前半维点积：cos 全维 ≤ headDot + ‖qTail‖·‖cTail‖（Cauchy–Schwarz 上界）
      let h = 0;
      for (let j = 0; j < head; j++) h += vec[j] * c.centroid[j];
      cost += head;
      if (h + qTail * c.tail < minCos) continue;
      // 2) 质心全维粗判
      let cd = h;
      for (let j = head; j < dim; j++) cd += vec[j] * c.centroid[j];
      cost += dim - head;
      if (cd < minCos) continue;
      // 3) 簇内成员精确判定（成员可能比质心更像；超大簇只查前 200 个成员）
      const members = c.members;
      const m = Math.min(members.length, 200);
      for (let mi = 0; mi < m; mi++) {
        const mv = members[mi].vec;
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += vec[j] * mv[j];
        cost += dim;
        if (dot > bestCos) {
          bestCos = dot;
          best = c;
        }
      }
    }
    if (best && bestCos >= minCos) {
      best.members.push({ row, vec });
      const sum = best.sum;
      for (let j = 0; j < dim; j++) sum[j] += vec[j];
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += sum[j] * sum[j];
      norm = Math.sqrt(norm) || 1;
      const centroid = best.centroid;
      for (let j = 0; j < dim; j++) centroid[j] = sum[j] / norm;
      best.tail = tailOf(centroid);
      if (bestCos > best.maxEdge) best.maxEdge = bestCos;
    } else if (clusters.length < CLIP_GROUP_MAX_CLUSTERS) {
      const sum = Float32Array.from(vec);
      clusters.push({ members: [{ row, vec }], sum, centroid: Float32Array.from(vec), tail: tailOf(vec), maxEdge: 0 });
    }
  }
  if (truncated) console.warn('[clip] 相似分组扫描超出预算，结果可能不全（图库过大或簇过多）');

  const rankOf = (c) => (c.maxEdge >= EXACT_COS ? 1 : 0); // exact 档优先
  const formed = clusters
    .filter((c) => c.members.length >= 2)
    .sort((a, b) => rankOf(b) - rankOf(a) || b.maxEdge - a.maxEdge)
    .slice(0, Math.max(1, Math.min(500, maxGroups)));

  // 只为入选簇回表取全行（分片 IN，避免超大占位符列表）
  const rowMap = new Map();
  const allIds = [];
  for (const c of formed) for (const m of c.members) allIds.push(m.row.id);
  for (let i = 0; i < allIds.length; i += 500) {
    const chunk = allIds.slice(i, i + 500);
    for (const r of db
      .prepare(`SELECT * FROM images WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk)) {
      rowMap.set(r.id, r);
    }
  }

  const groups = [];
  for (const c of formed) {
    const list = c.members;
    const maxCos = c.maxEdge;
    const tier = maxCos >= EXACT_COS ? 'exact' : 'series';
    // 组内画质：清晰度（相对组内最高）65% + 分辨率（相对组内最高）35%
    const sharpness = [];
    let maxSharp = 0;
    for (const v of list) {
      const s = await getSharpness(v.row.id, v.row.abs_path);
      sharpness.push(s);
      if (s > maxSharp) maxSharp = s;
    }
    const maxPixels = Math.max(...list.map((v) => v.row.width * v.row.height));
    const scored = list.map((v, i) => {
      const relSharp = maxSharp > 0 ? sharpness[i] / maxSharp : 0;
      const relRes = (v.row.width * v.row.height) / maxPixels;
      return { ...toDTO(rowMap.get(v.row.id) || v.row), quality: Math.round((0.65 * relSharp + 0.35 * relRes) * 100) };
    });
    scored.sort((a, b) => b.quality - a.quality || b.width * b.height - a.width * a.height);
    groups.push({
      key: `c${scored[0].id}`,
      recommendId: scored[0].id,
      count: list.length,
      tier,
      maxCos: +maxCos.toFixed(4),
      items: scored,
    });
  }
  return groups;
}

/**
 * 按感知哈希把「看起来是同一张」的图聚成组，供人工审查合并。
 * 组内按分辨率×评分排序，并给出推荐保留的那张。
 */
export function listSimilarGroups(threshold = 10, maxGroups = 60, scanLimit = 4000) {
  const rows = db
    .prepare("SELECT * FROM images WHERE phash != '' ORDER BY id DESC LIMIT ?")
    .all(Math.max(50, Math.min(20000, scanLimit)));
  const used = new Set();
  const groups = [];
  for (let i = 0; i < rows.length; i++) {
    if (used.has(rows[i].id)) continue;
    const group = [rows[i]];
    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(rows[j].id)) continue;
      if (hammingHex(rows[i].phash, rows[j].phash) <= threshold) {
        used.add(rows[j].id);
        group.push(rows[j]);
      }
    }
    if (group.length > 1) {
      used.add(rows[i].id);
      const weight = (r) => r.width * r.height * Math.max(1, (r.score ?? 100) / 50);
      const best = [...group].sort((a, b) => weight(b) - weight(a))[0];
      groups.push({
        key: `g${best.id}`,
        recommendId: best.id,
        count: group.length,
        items: group
          .map(toDTO)
          .sort((a, b) => b.width * b.height - a.width * a.height),
      });
      if (groups.length >= maxGroups) break;
    }
  }
  return groups;
}

/**
 * 同名跨格式去重：同一目录下主文件名相同、扩展名不同（如 5.jpg 与 5.png）视为同一张照片。
 * 推荐保留更清晰的 PNG（用户策略）；都没有 PNG 时保留分辨率更大的那张。
 */
export function listFormatDupes() {
  const FORMAT_RANK = { '.png': 3, '.webp': 2, '.jpeg': 1, '.jpg': 1, '.bmp': 1 };
  // 内容一致性阈值：同名不等于同图（旧版采集器曾因「秒级时间戳 + 相同尺寸」撞名，
  // 把两张不同的图存成同名 png/jpg）。同一张照片换格式后 pHash 距离通常 ≤ 6，
  // 不同照片一般 > 20，取 max(10, phashThreshold) 兼容较重的 JPEG 压缩。
  const contentThreshold = Math.max(10, Number(getSettings().phashThreshold) || 10);
  const sameContent = (a, b) => {
    if (a.phash && b.phash) return hammingHex(a.phash, b.phash) <= contentThreshold;
    // 缺 pHash 时退化为尺寸比对（比纯文件名可靠）
    return (a.width || 0) === (b.width || 0) && (a.height || 0) === (b.height || 0);
  };
  const rows = db.prepare('SELECT * FROM images').all();
  const buckets = new Map();
  for (const r of rows) {
    const p = r.abs_path || '';
    const ext = path.extname(p).toLowerCase();
    const stem = path.basename(p, ext);
    if (!stem) continue;
    const key = `${path.dirname(p).toLowerCase()}::${stem.toLowerCase()}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const groups = [];
  for (const list of buckets.values()) {
    const exts = new Set(list.map((r) => path.extname(r.abs_path || '').toLowerCase()));
    if (list.length < 2 || exts.size < 2) continue;
    const rank = (r) =>
      (FORMAT_RANK[path.extname(r.abs_path || '').toLowerCase()] || 0) * 1e12 +
      (r.width || 0) * (r.height || 0);
    const sorted = [...list].sort((a, b) => rank(b) - rank(a));
    // 只保留与画质最高那张内容一致的照片，撞名但内容不同的不组成一组
    const base = sorted[0];
    const same = sorted.filter((r) => r.id === base.id || sameContent(base, r));
    if (same.length < 2 || new Set(same.map((r) => path.extname(r.abs_path || '').toLowerCase())).size < 2) continue;
    groups.push({
      key: `f${same[0].id}`,
      recommendId: same[0].id,
      count: same.length,
      items: same.map(toDTO),
    });
  }
  return groups.sort((a, b) => b.items[0].id - a.items[0].id);
}

/** 相似图审查结果落地：保留 keepId，其余按删除策略处理（默认进应用内回收站，可恢复） */
export async function resolveSimilar(keepId, removeIds) {
  const keep = Number(keepId) || 0;
  const list = (Array.isArray(removeIds) ? removeIds : []).map(Number).filter((id) => id && id !== keep);
  let removed = 0;
  const failures = [];
  for (const id of list) {
    const res = await removeImage(id);
    if (res?.ok) removed++;
    else failures.push({ id, error: res?.error || '删除失败' });
  }
  return { removed, failures };
}

/** 列出「这组不处理」已跳过的组标识（组推荐保留项的 id） */
export function getTidySkips() {
  return db.prepare('SELECT recommend_id FROM tidy_skip').all().map((r) => r.recommend_id);
}

/** 标记某相似组「不处理」，刷新/重扫后依旧隐藏 */
export function addTidySkip(recommendId) {
  db.prepare('INSERT OR IGNORE INTO tidy_skip(recommend_id) VALUES (?)').run(Number(recommendId));
  return getTidySkips();
}

/** 清空所有「不处理」标记，让被跳过的组重新出现 */
export function resetTidySkips() {
  db.prepare('DELETE FROM tidy_skip').run();
  return getTidySkips();
}
