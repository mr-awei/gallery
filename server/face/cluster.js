// @ts-check
/**
 * 增量聚类：扫描期在内存里维护「人物 → 质心/计数/封面」，成批刷库。
 *
 * personCache 是**单例**（本模块唯一持有）：扫描、合并、改派、清理都通过
 * getPersonCache() / markPersonDirty() 操作同一份，避免「内存一套、库里一套」；
 * 拆模块时别把这份缓存抄到别的文件里，否则刷库会把另一份的旧值写回去。
 */
import { db, withTransaction } from '../db.js';
import { l2norm, cosine, blendCentroid } from '../lib/face-math.js';
import { coverRank } from '../lib/face-quality.js';
import { DIM, FACE_PX_EXPR, SEED_SCORE, SEED_QUALITY } from './constants.js';
import { getActiveCos } from './state.js';

/** 扫描期的人物缓存：id → { id, count, centroid }，只在内存里更新，成批刷库 */
let personCache = null;
const dirtyPersons = new Set();

/** @returns {Map<number, any>|null} */
export function getPersonCache() {
  return personCache;
}

/** @param {Map<number, any>|null} next */
export function setPersonCache(next) {
  personCache = next;
}

/**
 * 丢掉缓存（扫描结束、重建落库、清空人脸数据后调用）。
 * 只置空引用，不写库：库里已经是新状态，留旧缓存只会把旧值刷回去。
 */
export function clearPersonCache() {
  personCache = null;
}

/** @param {number} personId */
export function markPersonDirty(personId) {
  dirtyPersons.add(personId);
}

export function loadPersonCache() {
  personCache = new Map();
  // 顺带读出封面脸的质量与像素尺寸：扫描中途续跑也要能比较「新脸是否比旧封面更清晰」
  for (const row of db
    .prepare(
      `SELECT p.id, p.count, p.centroid, p.cover_face_id, COALESCE(f.quality, -1) AS cover_quality, p.cover_px,
              COALESCE(p.cover_locked, 0) AS cover_locked
       FROM persons p LEFT JOIN faces f ON f.id = p.cover_face_id`
    )
    .all()) {
    const c = row.centroid
      ? new Float32Array(/** @type {Buffer} */ (row.centroid).buffer, /** @type {Buffer} */ (row.centroid).byteOffset, DIM)
      : null;
    personCache.set(Number(row.id), {
      id: Number(row.id),
      count: Number(row.count) || 0,
      centroid: c ? Float32Array.from(c) : null,
      coverFaceId: row.cover_face_id == null ? null : Number(row.cover_face_id),
      coverScore: Number(row.cover_quality) >= 0 ? coverRank({ quality: Number(row.cover_quality), facePx: Number(row.cover_px) || 0 }) : null,
      coverQuality: Number(row.cover_quality) || -1,
      coverPx: Number(row.cover_px) || 0,
      /** 用户手动锁定的封面：扫描/清理/重建都不许自动换掉 */
      coverLocked: Number(row.cover_locked) === 1,
      /** 这个人已经收录了哪些照片 —— 同图排他要靠它判断 */
      images: new Set(),
    });
  }
  for (const row of db.prepare('SELECT person_id, image_id FROM faces WHERE person_id IS NOT NULL AND hidden <> 1').all()) {
    const p = personCache.get(Number(row.person_id));
    if (p) p.images.add(Number(row.image_id));
  }
  dirtyPersons.clear();
  return personCache;
}

export function flushPersons() {
  if (!personCache || !dirtyPersons.size) return;
  withTransaction(() => {
    const up = db.prepare(
      'UPDATE persons SET count = ?, centroid = ?, cover_face_id = COALESCE(?, cover_face_id), cover_px = ? WHERE id = ?'
    );
    for (const id of dirtyPersons) {
      const p = personCache.get(id);
      if (!p) continue;
      up.run(
        p.count,
        p.centroid ? Buffer.from(p.centroid.buffer, p.centroid.byteOffset, p.centroid.byteLength) : null,
        p.coverFaceId ?? null,
        p.coverPx ?? 0,
        id
      );
    }
  });
  dirtyPersons.clear();
}

/**
 * 找最像的人：返回 {person, sim} 或 null（质心数量在个人图库里通常只有几百，线性扫足够且精确）。
 * 跳过「这张照片里已经有他的脸」的人：同一张合影里出现 2~4 张同一个人的脸，只可能是误分。
 * @param {Float32Array} vec
 * @param {number} imageId
 */
function bestPerson(vec, imageId) {
  let best = null;
  let bestSim = -2;
  for (const p of personCache.values()) {
    if (!p.centroid) continue;
    if (imageId && p.images.has(imageId)) continue;
    const s = cosine(p.centroid, vec);
    if (s > bestSim) {
      bestSim = s;
      best = p;
    }
  }
  if (best && bestSim >= getActiveCos()) return { person: best, sim: bestSim };
  return null;
}

/**
 * 把一张脸归到某个人（必要时新建），返回 person_id；不该进人物时返回 null。
 *
 * 三条规定（扫描与重建共用同一套，否则两条路径迟早分叉）：
 * 1. 同图排他：这个人已经在这张照片里出现过了 → 不再收（宁可不收也不串人）；
 * 2. 高置信种子：只有检测分/质量足够高的脸才有资格新建人物，低分伪脸只能「加入」；
 * 3. 质心用代价均摊的方式更新（blendCentroid），避免大簇被后来的错脸慢慢带跑。
 *
 * @param {Float32Array} vec
 * @param {{imageId:number, score:number, quality:number}} meta
 */
export function assignPerson(vec, { imageId, score, quality }) {
  const hit = bestPerson(vec, imageId);
  if (hit) {
    const p = hit.person;
    p.centroid = blendCentroid(p.centroid, p.count, vec);
    p.count += 1;
    p.images.add(imageId);
    dirtyPersons.add(p.id);
    return p.id;
  }
  if (score < SEED_SCORE || quality < SEED_QUALITY) return null;
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO persons (name, count, centroid, cover_px, created_at) VALUES (?, 1, ?, 0, ?)').run(
    '',
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    now
  );
  const id = Number(r.lastInsertRowid);
  personCache.set(id, {
    id,
    count: 1,
    centroid: Float32Array.from(vec),
    coverFaceId: null,
    coverScore: null,
    coverQuality: -1,
    coverPx: 0,
    images: new Set([imageId]),
  });
  return id;
}

/**
 * 从库里重算某人的质心、计数与封面（合并/移脸/清理后调用）。
 *
 * 封面不是「质量分最高的脸」：一张 29px 的脸也能拿到 0.53 分，放大到 150px 卡片上就是
 * 一块白糊。所以封面必须同时满足「原图短边 ≥ COVER_PX_MIN」与质量/检测分门槛，
 * 排序分再用尺寸做惩罚（coverRank）；一条都不满足就不给封面（cover_face_id = NULL），
 * 前端把它折叠进「封面不清晰」。
 */
export function rebuildPerson(personId) {
  // hidden=1 是低质量自动排除的脸：不进质心、不进计数、不进封面
  const rows = db
    .prepare(
      `SELECT f.id, f.image_id, f.vec, f.score, f.quality, ${FACE_PX_EXPR} AS px
       FROM faces f JOIN images i ON i.id = f.image_id
       WHERE f.person_id = ? AND f.hidden <> 1`
    )
    .all(personId);
  if (!rows.length) {
    // 保留人物行（名字可能有用），但计数清零后界面自然过滤掉
    db.prepare('UPDATE persons SET count = 0, centroid = NULL, cover_face_id = NULL, cover_px = 0 WHERE id = ?').run(personId);
    personCache?.delete(personId);
    return { count: 0, removed: false };
  }
  const acc = new Float32Array(DIM);
  for (const r of rows) {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM);
    for (let i = 0; i < DIM; i++) acc[i] += v[i];
  }
  const centroid = l2norm(acc);
  const pickCover = (list) => {
    let best = null;
    for (const r of list) {
      const rank = coverRank({ quality: Number(r.quality), facePx: Number(r.px) || 0, score: Number(r.score) });
      if (rank == null) continue;
      if (!best || rank > best.rank) best = { id: Number(r.id), rank, px: Number(r.px), quality: Number(r.quality) };
    }
    return best;
  };
  const cover = pickCover(rows);
  // 用户手动锁定过封面就尊重它：只要那张脸还在这个人名下、没被排除，就原样保留。
  // 锁定的脸一旦被删/被移走（合并、单脸改派），才回落到自动挑选并解锁。
  const locked = db.prepare('SELECT cover_face_id, cover_locked FROM persons WHERE id = ?').get(personId);
  const lockedFace = Number(locked?.cover_locked) === 1 ? Number(locked?.cover_face_id) || null : null;
  const keep = lockedFace ? rows.find((r) => Number(r.id) === lockedFace) : null;
  const finalCover = keep
    ? { id: lockedFace, rank: coverRank({ quality: Number(keep.quality), facePx: Number(keep.px) || 0, score: Number(keep.score) }), px: Number(keep.px) || 0, quality: Number(keep.quality) }
    : cover;
  db.prepare('UPDATE persons SET count = ?, centroid = ?, cover_face_id = ?, cover_px = ?, cover_locked = ? WHERE id = ?').run(
    rows.length,
    Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength),
    finalCover ? finalCover.id : null,
    finalCover ? finalCover.px : 0,
    keep ? 1 : 0,
    personId
  );
  if (personCache?.has(personId)) {
    // 保留封面与质量：丢掉的话，后续扫描会误以为「这个人还没有封面」再抢一次
    personCache.set(personId, {
      id: personId,
      count: rows.length,
      centroid,
      coverFaceId: finalCover ? finalCover.id : null,
      coverScore: finalCover ? finalCover.rank : null,
      coverQuality: finalCover ? finalCover.quality : -1,
      coverPx: finalCover ? finalCover.px : 0,
      coverLocked: !!keep,
      images: new Set(rows.map((r) => Number(r.image_id)).filter((v) => v)),
    });
  }
  return { count: rows.length, removed: false };
}
