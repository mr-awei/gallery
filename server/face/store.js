// @ts-check
/**
 * 人脸库读写：人物列表/查询、封面、合并、改派、删除、裁切图。
 *
 * 所有写动作在改完库之后都调 rebuildPerson（cluster.js）把质心/计数/封面重算一遍，
 * 顺手同步扫描期的内存缓存 —— 不更新的话，扫描线程仍按旧值比较，界面和库里会是两套数据。
 */
import sharp from 'sharp';
import { db, withTransaction } from '../db.js';
import { coverRank, QUALITY_GATES, SOFT_QUALITY } from '../lib/face-quality.js';
import { DIM, FACE_PX_EXPR } from './constants.js';
import { rebuildPerson, getPersonCache, clearPersonCache } from './cluster.js';

/* --------------------------------- 查询 --------------------------------- */

/** 单张图的人脸（含所属人物名，供灯箱侧栏展示） */
export function facesOfImage(imageId) {
  return db
    .prepare(
      `SELECT f.id, f.person_id, f.x1, f.y1, f.x2, f.y2, f.score, f.quality, f.hidden, p.name
       FROM faces f LEFT JOIN persons p ON p.id = f.person_id
       WHERE f.image_id = ? ORDER BY f.hidden ASC, f.quality DESC, f.score DESC`
    )
    .all(Number(imageId))
    .map((r) => ({
      id: Number(r.id),
      personId: r.person_id == null ? null : Number(r.person_id),
      name: String(r.name || ''),
      box: [Number(r.x1), Number(r.y1), Number(r.x2), Number(r.y2)],
      score: Number(r.score),
      quality: Number(r.quality) || 0,
      hidden: Number(r.hidden) === 1,
      /** 质量偏低：仍然显示、也计入人物，但不会当选封面／不建新人物 */
      soft: (Number(r.quality) || 0) < SOFT_QUALITY,
    }));
}

/**
 * 人物 DTO 的固定字段。列表与「单个」共用一份，避免两处 SELECT 漂移
 * （count 是人脸数，photo_count 是去重照片数：一张合影里同一个人出现两次时两者不等）。
 */
const PERSON_SELECT = `SELECT p.id, p.name, p.count, p.cover_face_id, p.cover_px, COALESCE(f.quality, -1) AS cover_quality,
        f.image_id AS cover_image_id, COALESCE(p.cover_locked, 0) AS cover_locked,
        (SELECT COUNT(DISTINCT fi.image_id) FROM faces fi
          WHERE fi.person_id = p.id AND fi.hidden <> 1) AS photo_count
 FROM persons p LEFT JOIN faces f ON f.id = p.cover_face_id`;

/** @param {any} r */
function mapPerson(r) {
  return {
    id: Number(r.id),
    name: String(r.name || ''),
    count: Number(r.count) || 0,
    photoCount: Number(r.photo_count) || 0,
    coverFaceId: r.cover_face_id == null ? null : Number(r.cover_face_id),
    /** 封面脸在哪张照片上：前端据此在人像照片墙上标出「当前封面」 */
    coverImageId: r.cover_image_id == null ? null : Number(r.cover_image_id),
    /** 用户手动指定过封面：按钮文案要从「设为封面」变成「正在用作封面」 */
    coverLocked: Number(r.cover_locked) === 1,
    coverPx: Number(r.cover_px) || 0,
    coverQuality: Number(r.cover_quality) || 0,
  };
}

/**
 * 人物列表：按人数倒序，带封面脸 id（前端用 /api/face/crop/:faceId 取缩略图）。
 * sharpOnly=true 只返回「封面脸够清晰」的人物：只有一两张糊脸的人物多是误检，
 * 不该占满人物页第一屏；它们仍在库里，切回「全部」就能看到。
 */
export function listPersons({ limit = 200, offset = 0, minCount = 1, q = '', sharpOnly = false } = {}) {
  const needle = String(q || '').trim();
  const conditions = ['count >= ?'];
  /** @type {(string|number)[]} */
  const args = [Math.max(1, minCount)];
  if (needle) {
    conditions.push('(p.name LIKE ? OR CAST(p.id AS TEXT) LIKE ?)');
    args.push(`%${needle}%`, `%${needle}%`);
  }
  if (sharpOnly) {
    // 「有封面」= 存在一张够大够清晰的脸；cover_px 为 0 表示这个人只有糊脸/小脸
    conditions.push('p.cover_px >= ?');
    args.push(QUALITY_GATES.COVER_PX_MIN);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  return db
    .prepare(`${PERSON_SELECT} ${where} ORDER BY p.count DESC, p.id ASC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(2000, Math.max(1, limit)), Math.max(0, offset))
    .map(mapPerson);
}

/**
 * 单个人物。灯箱里点人名要跳到人物页，得先拿到这个人（名字/封面/张数），
 * 没必要为此把 2000 人的列表整页拉下来再 find。
 */
export function getPerson(personId) {
  const row = db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(Number(personId));
  return row ? mapPerson(row) : null;
}

/**
 * 这个人「最清晰最完整」的一张照片：人脸质量分最高，其次人脸像素最大（人占画幅大、
 * 不是合影角落），最后原图面积最大。用这张去全网搜图命中率最高。
 * 一张合格的脸都没有时退回封面脸所在的照片。
 */
export function bestPhotoForPerson(personId) {
  const pid = Number(personId);
  const person = db.prepare('SELECT id, cover_face_id FROM persons WHERE id = ?').get(pid);
  if (!person) throw new Error('人物不存在');
  const row = db
    .prepare(
      `SELECT f.id AS face_id, f.image_id, COALESCE(f.quality, 0) AS quality, ${FACE_PX_EXPR} AS px
       FROM faces f JOIN images i ON i.id = f.image_id
       WHERE f.person_id = ? AND f.hidden <> 1
       ORDER BY COALESCE(f.quality, 0) DESC, px DESC, (COALESCE(i.width, 0) * COALESCE(i.height, 0)) DESC
       LIMIT 1`
    )
    .get(pid);
  if (row) return { faceId: Number(row.face_id), imageId: Number(row.image_id), quality: Number(row.quality) || 0, facePx: Math.round(Number(row.px) || 0) };
  const coverId = person.cover_face_id == null ? null : Number(person.cover_face_id);
  if (!coverId) return null;
  const cover = db.prepare('SELECT id, image_id FROM faces WHERE id = ?').get(coverId);
  if (!cover) return null;
  return { faceId: Number(cover.id), imageId: Number(cover.image_id), quality: 0, facePx: 0 };
}

/** 统计符合当前筛选条件的人物总数（不受 limit 影响，前端据此提示列表被截断） */
export function countPersons({ minCount = 1, q = '', sharpOnly = false } = {}) {
  const needle = String(q || '').trim();
  const conditions = ['count >= ?'];
  /** @type {(string|number)[]} */
  const args = [Math.max(1, minCount)];
  if (needle) {
    conditions.push('(p.name LIKE ? OR CAST(p.id AS TEXT) LIKE ?)');
    args.push(`%${needle}%`, `%${needle}%`);
  }
  if (sharpOnly) {
    conditions.push('p.cover_px >= ?');
    args.push(QUALITY_GATES.COVER_PX_MIN);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM persons p LEFT JOIN faces f ON f.id = p.cover_face_id
       WHERE ${conditions.join(' AND ')}`
    )
    .get(...args);
  return Number(row?.c) || 0;
}

/** 封面不够格的人物数（没封面 / 封面脸太小）：界面据此提示被折叠的部分 */
export function countWeakCoverPersons() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM persons WHERE count >= 1 AND cover_px < ?').get(QUALITY_GATES.COVER_PX_MIN);
  return Number(row?.c) || 0;
}

/** 某人的所有图（按人脸质量排，同一张图多张脸只出一次；低质量脸不混进来） */
export function personImages(personId, { limit = 500, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT f.image_id, MAX(f.score) AS score, MAX(f.quality) AS quality, MIN(f.id) AS face_id
       FROM faces f WHERE f.person_id = ? AND f.hidden <> 1
       GROUP BY f.image_id ORDER BY quality DESC, score DESC, f.image_id DESC LIMIT ? OFFSET ?`
    )
    .all(Number(personId), Math.min(2000, Math.max(1, limit)), Math.max(0, offset))
    .map((r) => ({ imageId: Number(r.image_id), faceId: Number(r.face_id), score: Number(r.score) }));
}

/* -------------------------------- 编辑动作 -------------------------------- */

export function renamePerson(personId, name) {
  const clean = String(name || '').trim().slice(0, 60);
  const r = db.prepare('UPDATE persons SET name = ? WHERE id = ?').run(clean, Number(personId));
  if (!r.changes) throw new Error('人物不存在');
  return { ok: true, id: Number(personId), name: clean };
}

/**
 * 手动指定人物封面：用户在某张照片上点「设为封面」。
 *
 * 封面存的是**脸**的 id（/api/face/crop/:faceId 直接出裁切图），所以要先在这张照片里
 * 找到属于这个人的脸 —— 合影里可能有这个人两张脸，取质量最高的那张。
 * 选定后打上 cover_locked，后续扫描 / 清理 / 重建都不会再自动换掉，
 * 否则用户会看到「刚设的封面过一会儿自己变了」。
 */
export function setPersonCover(personId, imageId) {
  const pid = Number(personId);
  const iid = Number(imageId);
  if (!pid || !iid) throw new Error('需要人物与照片');
  const person = db.prepare('SELECT id FROM persons WHERE id = ?').get(pid);
  if (!person) throw new Error('人物不存在');
  const face = db
    .prepare(
      `SELECT f.id, ${FACE_PX_EXPR} AS px, f.quality, f.score
       FROM faces f JOIN images i ON i.id = f.image_id
       WHERE f.person_id = ? AND f.image_id = ? AND f.hidden <> 1
       ORDER BY f.quality DESC, f.score DESC LIMIT 1`
    )
    .get(pid, iid);
  if (!face) throw new Error('这张照片里没有这个人的人脸记录');
  const px = Number(face.px) || 0;
  db.prepare('UPDATE persons SET cover_face_id = ?, cover_px = ?, cover_locked = 1 WHERE id = ?').run(
    Number(face.id),
    px,
    pid
  );
  // 缓存同步：不更新的话，扫描线程仍按旧封面比较，重启前界面和库里会是两套数据
  const cached = getPersonCache()?.get(pid);
  if (cached) {
    cached.coverFaceId = Number(face.id);
    cached.coverPx = px;
    cached.coverQuality = Number(face.quality) || -1;
    cached.coverScore = coverRank({ quality: Number(face.quality), facePx: px, score: Number(face.score) });
    cached.coverLocked = true;
  }
  return { ok: true, id: pid, coverFaceId: Number(face.id), coverImageId: iid, coverPx: px, coverLocked: true };
}

/** 合并：把 fromId 的人脸全部改挂到 toId，然后按实际人脸重算 toId 的质心 */
export function mergePersons(fromId, toId) {
  const from = Number(fromId);
  const to = Number(toId);
  if (!from || !to || from === to) throw new Error('合并需要两个不同的人物');
  const exists = db.prepare('SELECT id FROM persons WHERE id = ?').get(to);
  if (!exists) throw new Error('目标人物不存在');
  let moved = 0;
  withTransaction(() => {
    const r = db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(to, from);
    moved = Number(r.changes) || 0;
    // 名字保留目标；源人物被合并后名字若无意义就一并清掉行
    db.prepare('DELETE FROM persons WHERE id = ?').run(from);
    getPersonCache()?.delete(from);
  });
  rebuildPerson(to);
  return { ok: true, moved };
}

/** 把一张脸移到指定人物（personId=null 则单独成新人物） */
export function reassignFace(faceId, personId) {
  const face = db.prepare('SELECT id, image_id, person_id, vec, score FROM faces WHERE id = ?').get(Number(faceId));
  if (!face) throw new Error('人脸记录不存在');
  const oldPerson = face.person_id == null ? null : Number(face.person_id);
  let target = personId == null ? null : Number(personId);
  withTransaction(() => {
    if (target == null) {
      const vec = new Float32Array(face.vec.buffer, face.vec.byteOffset, DIM);
      const r = db
        .prepare('INSERT INTO persons (name, count, centroid, cover_face_id, created_at) VALUES (?, 1, ?, ?, ?)')
        .run('', Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), Number(face.id), new Date().toISOString());
      target = Number(r.lastInsertRowid);
    }
    // 用户主动把低质量脸归到某个人 = 手动保留：清理任务不能再自动把它排除掉
    db.prepare('UPDATE faces SET person_id = ?, hidden = CASE WHEN hidden = 1 THEN 2 ELSE hidden END WHERE id = ?').run(
      target,
      Number(face.id)
    );
  });
  if (oldPerson) rebuildPerson(oldPerson);
  rebuildPerson(target);
  return { ok: true, personId: target };
}

/**
 * 手动保留 / 重新排除一张脸。
 * 灯箱里看到被自动排除的低质量脸，用户点「仍要收录」→ hidden=false（记为 2，清理任务不再覆盖）；
 * 点「排除」→ hidden=true（1）。两者都不删记录，随时可反悔。
 */
export function setFaceHidden(faceId, hidden) {
  const id = Number(faceId);
  const face = db.prepare('SELECT id, person_id FROM faces WHERE id = ?').get(id);
  if (!face) throw new Error('人脸记录不存在');
  db.prepare('UPDATE faces SET hidden = ? WHERE id = ?').run(hidden ? 1 : 2, id);
  const personId = face.person_id == null ? null : Number(face.person_id);
  if (personId) rebuildPerson(personId);
  return { ok: true, id, hidden: !!hidden };
}

/** 不是人脸 / 不想收录：删掉这条记录（并修正所属人物） */
export function deleteFace(faceId) {
  const face = db.prepare('SELECT id, person_id FROM faces WHERE id = ?').get(Number(faceId));
  if (!face) throw new Error('人脸记录不存在');
  const personId = face.person_id == null ? null : Number(face.person_id);
  db.prepare('DELETE FROM faces WHERE id = ?').run(Number(face.id));
  if (personId) rebuildPerson(personId);
  return { ok: true };
}

/** 删除整个「人物」：他名下的所有人脸记录一并清掉，图片本身不动 */
export function deletePerson(personId) {
  const id = Number(personId);
  let removedFaces = 0;
  withTransaction(() => {
    const r = db.prepare('DELETE FROM faces WHERE person_id = ?').run(id);
    removedFaces = Number(r.changes) || 0;
    db.prepare('DELETE FROM persons WHERE id = ?').run(id);
  });
  getPersonCache()?.delete(id);
  return { ok: true, removedFaces };
}

/** 清空全部人脸数据（保留图片），用于换模型或彻底重来 */
export function resetFaces() {
  withTransaction(() => {
    db.exec('DELETE FROM faces');
    db.exec('DELETE FROM persons');
    db.exec('UPDATE images SET face_scanned = 0');
  });
  clearPersonCache();
  return { ok: true };
}

/** 人脸裁切图（百分比框 → 当前原图尺寸），带 25% 外扩以便看清五官 */
export async function faceCrop(faceId, size = 192) {
  const row = db
    .prepare('SELECT f.x1, f.y1, f.x2, f.y2, i.abs_path FROM faces f JOIN images i ON i.id = f.image_id WHERE f.id = ?')
    .get(Number(faceId));
  if (!row) throw new Error('人脸记录不存在');
  const px = Math.max(32, Math.min(512, Number(size) || 192));
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const swap = Number(meta.orientation) >= 5;
  const W = swap ? Number(meta.height) : Number(meta.width);
  const H = swap ? Number(meta.width) : Number(meta.height);
  if (!W || !H) throw new Error('无法读取图片尺寸');

  const padX = (row.x2 - row.x1) * 0.25;
  const padY = (row.y2 - row.y1) * 0.25;
  const l = Math.max(0, Math.round((row.x1 - padX) * W));
  const t = Math.max(0, Math.round((row.y1 - padY) * H));
  const r = Math.min(W, Math.round((row.x2 + padX) * W));
  const b = Math.min(H, Math.round((row.y2 + padY) * H));
  const width = Math.max(1, r - l);
  const height = Math.max(1, b - t);
  return sharp(row.abs_path, { failOn: 'none' })
    .rotate()
    .extract({ left: l, top: t, width, height })
    .resize(px, px, { fit: 'cover' })
    .jpeg({ quality: 86 })
    .toBuffer();
}
