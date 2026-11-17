// @ts-check
/**
 * 人物重建（全局）：用库里已有的特征重新聚类，不解码图片（所以是秒级）。
 *
 * 为什么需要它：增量聚类一旦被一批伪造特征带跑，质心就再也回不来了 ——
 * 真实库里出现过 562 张脸的「人物」，成员全是不同人的后脑勺/耳朵。
 * 全量重建可以一次性把这些簇整体判死（簇健康度），并按新规则重选封面。
 * 也正因为不重新检测，「后脑勺」只能靠检测分与质量分筛，不能靠姿态。
 */
import { db, withTransaction } from '../db.js';
import { createJob, finishJob, jobProgress } from '../jobs.js';
import { cosine, blendCentroid } from '../lib/face-math.js';
import { coverRank, QUALITY_GATES, SOFT_QUALITY } from '../lib/face-quality.js';
import { clearPersonCache } from './cluster.js';
import {
  DIM,
  FACE_PX_EXPR,
  SEED_SCORE,
  SEED_QUALITY,
  JOIN_COS,
  HEALTH_MIN_SCORE,
  HEALTH_MIN_COUNT,
} from './constants.js';
import { rebuildState, scanState, cleanState } from './state.js';

export function personRebuildStatus() {
  return { ...rebuildState };
}

export function cancelPersonRebuild() {
  if (rebuildState.running) rebuildState.cancelled = true;
}

/** @param {Buffer|Uint8Array} buf */
function f32(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, DIM);
}

export async function startPersonRebuild() {
  if (rebuildState.running) throw new Error('人物重建正在进行中');
  if (scanState.running) throw new Error('扫描正在进行，等它结束再重建（扫描本身也在建组）');
  if (cleanState.running) throw new Error('请先等「清理模糊人脸」结束');
  Object.assign(rebuildState, { running: true, cancelled: false, done: 0, total: 0, message: '准备中…', error: '' });
  const jobId = createJob({ kind: 'face-rebuild', title: '重建人物分组', payload: {} });
  try {
    const rows = db
      .prepare(
        `SELECT f.id, f.image_id, f.score, f.quality, f.person_id, f.vec, ${FACE_PX_EXPR} AS px
         FROM faces f JOIN images i ON i.id = f.image_id WHERE f.hidden <> 1`
      )
      .all();
    // 只有过得了聚类门槛的脸才参与：检测分低的脸（后脑勺/耳朵）特征彼此瞎相似，
    // 放进来就是给别人「加料」；它们仍留在照片上，只是不归人物。
    const eligible = rows
      .filter((r) => Number(r.score) >= QUALITY_GATES.SCORE_CLUSTER && Number(r.quality) >= SOFT_QUALITY)
      .sort((a, b) => Number(b.score) * Number(b.quality) - Number(a.score) * Number(a.quality));
    rebuildState.total = eligible.length;
    jobProgress(jobId, { total: eligible.length, progress: 0, message: '开始重建人物分组…', force: true });

    /**
     * @type {{count:number, centroid:Float32Array, images:Set<number>, scoreSum:number,
     *         qualitySum:number, best:any, oldVotes:Map<number,number>, faces:number[]}[]}
     */
    const clusters = [];
    let dropped = 0;
    for (let i = 0; i < eligible.length; i++) {
      if (rebuildState.cancelled) break;
      const r = eligible[i];
      const v = f32(r.vec);
      const imageId = Number(r.image_id);
      let bestIdx = -1;
      let bestSim = -2;
      for (let c = 0; c < clusters.length; c++) {
        const cl = clusters[c];
        if (cl.images.has(imageId)) continue;
        const s = cosine(cl.centroid, v);
        if (s > bestSim) {
          bestSim = s;
          bestIdx = c;
        }
      }
      const joinable = bestIdx >= 0 && bestSim >= JOIN_COS;
      if (joinable) {
        const cl = clusters[bestIdx];
        cl.centroid = blendCentroid(cl.centroid, cl.count, v);
        cl.count++;
        cl.images.add(imageId);
        cl.scoreSum += Number(r.score);
        cl.qualitySum += Number(r.quality);
        cl.faces.push(Number(r.id));
        if (Number(r.person_id)) cl.oldVotes.set(Number(r.person_id), (cl.oldVotes.get(Number(r.person_id)) || 0) + 1);
        const rank = coverRank({ quality: Number(r.quality), facePx: Number(r.px) || 0, score: Number(r.score) });
        if (rank != null && (!cl.best || rank > cl.best.rank)) {
          cl.best = { id: Number(r.id), rank, px: Number(r.px) || 0 };
        }
      } else if (Number(r.score) >= SEED_SCORE && Number(r.quality) >= SEED_QUALITY) {
        const rank = coverRank({ quality: Number(r.quality), facePx: Number(r.px) || 0, score: Number(r.score) });
        clusters.push({
          count: 1,
          centroid: Float32Array.from(v),
          images: new Set([imageId]),
          scoreSum: Number(r.score),
          qualitySum: Number(r.quality),
          best: rank != null ? { id: Number(r.id), rank, px: Number(r.px) || 0 } : null,
          oldVotes: new Map(Number(r.person_id) ? [[Number(r.person_id), 1]] : []),
          faces: [Number(r.id)],
        });
      } else {
        // 既不能加入任何人，又不够格当种子 —— 不归属任何人物
        dropped++;
      }
      rebuildState.done = i + 1;
      if ((i + 1) % 400 === 0) {
        rebuildState.message = `已分配 ${rebuildState.done}/${eligible.length} 张脸`;
        jobProgress(jobId, {
          done: rebuildState.done,
          total: eligible.length,
          progress: Math.round((rebuildState.done / eligible.length) * 100),
          message: rebuildState.message,
        });
        await new Promise((res) => setImmediate(res));
        if (rebuildState.cancelled) break;
      }
    }

    // 簇健康度：一整簇脸的平均检测分都很低 = 这批「脸」本身就不成立（后脑勺、耳朵、
    // 帽子、半张脸），把它们拆开毫无意义 —— 只能整簇作废。
    let dissolved = 0;
    const kept = [];
    for (const cl of clusters) {
      const avg = cl.scoreSum / cl.count;
      if (cl.count >= HEALTH_MIN_COUNT && avg < HEALTH_MIN_SCORE) {
        dissolved++;
        dropped += cl.count;
        continue;
      }
      kept.push(cl);
    }

    // 落库：先摘掉所有归属，再按新簇写回；旧人物的名字按「多数票」迁到新簇上
    const namedOld = new Map(
      db
        .prepare("SELECT id, name FROM persons WHERE name <> ''")
        .all()
        .map((r) => [Number(r.id), String(r.name)])
    );
    const usedNames = new Set();
    // 用户手动选过的封面要跨重建保留：重建会给人物重新发 id，只能靠「封面脸所在的照片」
    // 认亲 —— 新簇里还包含那张照片，就说明还是同一个人，沿用那张脸当门面并继续锁定。
    const lockedByOld = new Map(
      db
        .prepare(
          `SELECT p.id, f.image_id FROM persons p JOIN faces f ON f.id = p.cover_face_id
           WHERE COALESCE(p.cover_locked, 0) = 1`
        )
        .all()
        .map((r) => [Number(r.id), Number(r.image_id)])
    );
    const faceMeta = new Map(rows.map((r) => [Number(r.id), { imageId: Number(r.image_id), px: Number(r.px) || 0 }]));
    withTransaction(() => {
      db.prepare('UPDATE faces SET person_id = NULL WHERE person_id IS NOT NULL').run();
      db.prepare('UPDATE persons SET count = 0, centroid = NULL, cover_face_id = NULL, cover_px = 0, cover_locked = 0').run();
      const insert = db.prepare(
        'INSERT INTO persons (name, count, centroid, cover_face_id, cover_px, cover_locked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const setFace = db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
      const now = new Date().toISOString();
      for (const cl of kept) {
        let name = '';
        let nameFrom = 0;
        let votes = 0;
        for (const [oldId, n] of cl.oldVotes) {
          if (n > votes && namedOld.has(oldId) && !usedNames.has(oldId)) {
            votes = n;
            nameFrom = oldId;
          }
        }
        if (nameFrom) {
          name = namedOld.get(nameFrom) || '';
          if (name) usedNames.add(nameFrom);
        }
        // 手动封面优先：名字来源的那个旧人物锁过封面，且新簇里还有那张照片，就沿用它
        let coverId = cl.best ? cl.best.id : null;
        let coverPx = cl.best ? cl.best.px : 0;
        let coverLocked = 0;
        const lockedImage = nameFrom ? lockedByOld.get(nameFrom) : null;
        if (lockedImage != null) {
          const fid = cl.faces.find((f) => faceMeta.get(f)?.imageId === lockedImage);
          if (fid) {
            coverId = fid;
            coverPx = faceMeta.get(fid)?.px || 0;
            coverLocked = 1;
          }
        }
        const id = Number(
          insert.run(
            name,
            cl.count,
            Buffer.from(cl.centroid.buffer, cl.centroid.byteOffset, cl.centroid.byteLength),
            coverId,
            coverPx,
            coverLocked,
            now
          ).lastInsertRowid
        );
        for (const faceId of cl.faces) setFace.run(id, faceId);
      }
      // 没被认领的旧人物：无名且空 → 删；有名字的留着（名字是用户资产）
      db.prepare("DELETE FROM persons WHERE count = 0 AND name = ''").run();
    });
    clearPersonCache();

    const personsLeft = Number(db.prepare('SELECT COUNT(*) AS n FROM persons WHERE count > 0').get().n) || 0;
    rebuildState.message = rebuildState.cancelled
      ? `已取消：已分配 ${rebuildState.done} 张脸`
      : `重建完成：${eligible.length} 张脸 → ${personsLeft} 个人物` +
        (dissolved ? `，解散 ${dissolved} 个不可信簇（${dropped} 张脸不再归属任何人）` : '') +
        `，封面已按清晰度与尺寸重选`;
    finishJob(jobId, {
      status: rebuildState.cancelled ? 'canceled' : 'done',
      result: { faces: eligible.length, persons: personsLeft, clusters: kept.length, dissolved, dropped },
    });
    return { persons: personsLeft, clusters: kept.length, dissolved, dropped };
  } catch (err) {
    finishJob(jobId, { status: 'failed', error: String(err?.message || err).slice(0, 300) });
    rebuildState.error = String(err?.message || err);
    throw err;
  } finally {
    rebuildState.running = false;
    rebuildState.cancelled = false;
  }
}
