// @ts-check
/**
 * 全库人脸扫描任务：逐图检测 → 聚类归人 → 写 faces / persons。
 *
 * 进度落 jobs 表（kind='face-scan'），可取消、可重试、崩了能看出停在哪；
 * 每张图之间 setImmediate 让出事件循环，避免扫库时把 HTTP 接口卡死。
 */
import { db, withTransaction } from '../db.js';
import { createJob, finishJob, jobProgress } from '../jobs.js';
import { coverRank } from '../lib/face-quality.js';
import { analyzeImage } from './detect.js';
import { assignPerson, flushPersons, loadPersonCache, getPersonCache, markPersonDirty, setPersonCache } from './cluster.js';
import { faceStatus } from './status.js';
import { modelsReady } from './model.js';
import { DET_THRESH, MATCH_COS } from './constants.js';
import { scanState, setActiveCos } from './state.js';

export function cancelFaceScan() {
  if (!scanState.running) return false;
  scanState.cancelled = true;
  return true;
}

/**
 * 开始全库人脸扫描。
 * force=true 时清空已有人脸重扫（改了阈值/换了模型后用）。
 */
export function startFaceScan({ limit = 0, force = false, minCos = 0 } = {}) {
  if (scanState.running) return { ok: false, message: '人脸扫描正在进行中' };
  if (!modelsReady()) return { ok: false, message: '人脸模型未下载，请先到「设置 → 人脸识别」下载（约 191MB）' };
  scanState.running = true;
  scanState.cancelled = false;
  // 阈值只接受 0.25~0.7：低于 0.25 会把整库并成一个人，高于 0.7 等于只认同一张照片
  const cos = Number(minCos) ? Math.max(0.25, Math.min(0.7, Number(minCos))) : MATCH_COS;
  runScan({ limit: Number(limit) || 0, force: !!force, minCos: cos }).catch((err) => {
    console.warn('[face] 扫描失败：', err?.message || err);
  });
  return { ok: true, started: true, ...faceStatus() };
}

async function runScan({ limit, force, minCos }) {
  const jobId = createJob({ kind: 'face-scan', title: '人脸扫描与聚类', payload: { limit, force, minCos } });
  scanState.jobId = jobId;
  setActiveCos(minCos);
  let done = 0;
  let failed = 0;
  let faceTotal = 0;
  try {
    if (force) {
      withTransaction(() => {
        db.exec('DELETE FROM faces');
        db.exec('DELETE FROM persons');
        db.exec('UPDATE images SET face_scanned = 0');
      });
    }
    loadPersonCache();
    const pending = Number(db.prepare('SELECT COUNT(*) AS c FROM images WHERE face_scanned = 0').get()?.c) || 0;
    const total = limit > 0 ? Math.min(limit, pending) : pending;
    jobProgress(jobId, { total, progress: 0, message: total ? '开始扫描…' : '没有待扫描的素材', force: true });
    if (!total) {
      finishJob(jobId, { status: 'done', result: { done: 0, faces: 0, failed: 0 } });
      return;
    }

    const pickBatch = db.prepare('SELECT id, abs_path FROM images WHERE face_scanned = 0 ORDER BY id LIMIT ?');
    const markScanned = db.prepare('UPDATE images SET face_scanned = 1 WHERE id = ?');
    const insertFace = db.prepare(
      `INSERT INTO faces (image_id, person_id, x1, y1, x2, y2, score, det, vec, quality, frontal, hidden, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (;;) {
      if (scanState.cancelled) break;
      if (limit > 0 && done + failed >= limit) break;
      const batch = pickBatch.all(Math.min(50, limit > 0 ? limit - done - failed : 50));
      if (!batch.length) break;

      for (const row of batch) {
        if (scanState.cancelled) break;
        try {
          const { faces } = await analyzeImage(row.abs_path);
          // 质量硬门槛（模糊 / 太小 / 无纹理 / 疑似后脑勺）直接排除，连库都不进
          const usable = faces.filter((f) => f.keep);
          if (usable.length) {
            // 特征先算完再一次事务写入：单张图的多张脸不该出现「写了一半」的中间态
            withTransaction(() => {
              const now = new Date().toISOString();
              for (const f of usable) {
                // 分层门槛只决定「能不能聚类/当封面」，不决定「显示不显示」：
                // 模糊的脸本来就没进库（上面按 keep 过滤过），而只是不够清晰的脸
                // 仍然留着（灯箱可见、可手动收录），否则人物相册会被掏空一片。
                const personId = f.cluster
                  ? assignPerson(f.vec, { imageId: Number(row.id), score: f.score, quality: f.quality })
                  : null;
                const ins = insertFace.run(
                  row.id,
                  personId,
                  f.box[0],
                  f.box[1],
                  f.box[2],
                  f.box[3],
                  f.score,
                  DET_THRESH,
                  Buffer.from(f.vec.buffer, f.vec.byteOffset, f.vec.byteLength),
                  f.quality,
                  f.frontalKnown ? f.frontal : -1,
                  0,
                  now
                );
                // 封面取舍同时看清晰度与尺寸（coverRank）：只有 29px 的脸质量分不低，
                // 但它放大到卡片上就是一块白糊，绝不能当门面
                if (f.cluster) {
                  const p = getPersonCache()?.get(personId);
                  const rank = coverRank({ quality: f.quality, facePx: f.facePx, score: f.score });
                  // coverLocked：用户手动选过封面，扫描只加照片不许换门面
                  if (p && !p.coverLocked && rank != null && (p.coverScore == null || rank > p.coverScore)) {
                    p.coverFaceId = Number(ins.lastInsertRowid);
                    p.coverQuality = f.quality;
                    p.coverPx = f.facePx;
                    p.coverScore = rank;
                    markPersonDirty(personId);
                  }
                }
              }
            });
            faceTotal += usable.length;
          }
          markScanned.run(row.id);
          done++;
        } catch (err) {
          // 单张图坏了（损坏文件/超长边）不该让整次扫描停摆，标记已扫并计数上报
          console.warn('[face] 跳过', row.id, err?.message || err);
          markScanned.run(row.id);
          failed++;
        }
        const processed = done + failed;
        jobProgress(jobId, {
          done: processed,
          total,
          progress: Math.round((processed / total) * 100),
          failed,
          message: `已扫描 ${processed}/${total}，检出人脸 ${faceTotal} 张`,
        });
        // 让出事件循环：否则几百张连跑时整个 HTTP 服务像卡死
        await new Promise((r) => setImmediate(r));
      }
      flushPersons(); // 每批刷一次质心，进程被杀也只丢最后几十张图的聚类增量
    }

    flushPersons();
    const cancelled = scanState.cancelled;
    const cache = getPersonCache();
    finishJob(jobId, {
      status: cancelled ? 'canceled' : 'done',
      result: { done, failed, faces: faceTotal, persons: cache ? cache.size : 0 },
    });
  } catch (err) {
    flushPersons();
    finishJob(jobId, { status: 'failed', error: String(err?.message || err).slice(0, 300) });
    throw err;
  } finally {
    scanState.running = false;
    scanState.jobId = 0;
    scanState.cancelled = false;
    setPersonCache(null);
  }
}
