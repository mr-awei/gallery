// @ts-check
/**
 * 存量人脸的「质量重算 / 重选封面」后台任务。
 *
 * 老库里的人脸没有质量分，封面又是「第一张脸 / 最高检测分」选的，糊脸当门面。
 * 这个任务不跑模型、不删人脸：按同一套质量门槛回填分数、标记排除，再按质量重选封面。
 * hidden=1 只是「不显示 / 不聚类」，用户在灯箱里手动归到某个人即可找回（hidden=2）。
 */
import { db } from '../db.js';
import { createJob, finishJob, jobProgress } from '../jobs.js';
import { loadWork, qualityFromWork } from './detect.js';
import { rebuildPerson } from './cluster.js';
import { faceStatus } from './status.js';
import { cleanState, scanState } from './state.js';

export function startQualityCleanup() {
  if (cleanState.running || scanState.running) return { ok: true, busy: true, ...faceStatus() };
  Object.assign(cleanState, {
    running: true,
    cancelled: false,
    done: 0,
    total: 0,
    hidden: 0,
    reasons: { 模糊: 0, 人脸过小: 0, 几乎没有纹理: 0, 过曝: 0, 欠曝: 0, '非正面/疑似后脑勺': 0 },
    message: '准备重算人脸质量…',
    error: '',
  });
  runQualityCleanup().catch((err) => {
    console.warn('[face] 质量清理失败：', err?.message || err, err?.cause?.code || '');
    cleanState.error = String(err?.message || err);
    cleanState.running = false;
  });
  return { ok: true, started: true, ...faceStatus() };
}

export function cancelQualityCleanup() {
  if (!cleanState.running) return false;
  cleanState.cancelled = true;
  cleanState.message = '正在取消…';
  return true;
}

async function runQualityCleanup() {
  const jobId = createJob({ kind: 'face-quality', title: '清理模糊人脸并重选封面', payload: {} });
  try {
    const total = Number(db.prepare('SELECT COUNT(*) AS c FROM faces').get()?.c) || 0;
    cleanState.total = total;
    jobProgress(jobId, { total, progress: 0, message: total ? '开始检查人脸清晰度…' : '没有已检出的人脸', force: true });

    const pickBatch = db.prepare(
      `SELECT f.id, f.image_id, f.x1, f.y1, f.x2, f.y2, f.score, f.frontal, f.hidden, i.abs_path
       FROM faces f JOIN images i ON i.id = f.image_id
       WHERE f.id > ? ORDER BY f.id LIMIT 100`
    );
    const update = db.prepare('UPDATE faces SET quality = ?, hidden = ? WHERE id = ?');
    let lastId = 0;
    let failed = 0;
    // 解码是瓶颈（5D4 原图 resize 到 1600 约 300ms/张，串行只有 2~3 张脸/秒），
    // 按图片分组后并发跑：sharp 内部走 libuv 线程池，4 路足够喂满且不抢爆内存。
    const CONCURRENCY = 4;

    /** 一张图里的一批脸：解码一次，逐脸评分写库 */
    const scoreImageGroup = async (group) => {
      let work;
      try {
        work = await loadWork(group[0].abs_path);
      } catch (err) {
        // 单个文件缺失/损坏不该让整次清理停摆，质量留 -1，界面会如实显示「未评估」
        console.warn('[face] 质量评估跳过图片', group[0].image_id, err?.message || err);
        failed += group.length;
        cleanState.done += group.length;
        return;
      }
      for (const row of group) {
        try {
          const box = [Number(row.x1), Number(row.y1), Number(row.x2), Number(row.y2)];
          const q = qualityFromWork(work, box, {
            score: Number(row.score),
            frontal: Number(row.frontal) >= 0 ? Number(row.frontal) : 1,
          });
          // hidden=2 是用户手动保留，清理不能覆盖用户决定；
          // 只有硬门槛不通过（真糊 / 太小 / 无纹理 / 后脑勺）才隐藏，
          // 「不够清晰」只影响封面与聚类，不把整张照片从人物相册里拿走。
          const hidden = Number(row.hidden) === 2 ? 2 : q.keep ? 0 : 1;
          update.run(q.quality, hidden, Number(row.id));
          if (hidden === 1) {
            cleanState.hidden++;
            // 统计「为什么排除」，主原因计一次，避免同一张脸把多个计数器都抬高
            const why = q.reasons[0] || '清晰度不足';
            cleanState.reasons[why] = (cleanState.reasons[why] || 0) + 1;
          }
          cleanState.done++;
        } catch (err) {
          console.warn('[face] 质量评估跳过', row.id, err?.message || err);
          failed++;
          cleanState.done++;
        }
      }
    };

    for (;;) {
      const rows = pickBatch.all(lastId);
      if (!rows.length) break;
      lastId = Number(rows[rows.length - 1].id);
      if (cleanState.cancelled) break;
      // 同一张图的多张脸共用一次解码（工作图 1600px，和扫描期同量纲）
      /** @type {Map<number, typeof rows>} */
      const groups = new Map();
      for (const row of rows) {
        const key = Number(row.image_id);
        const list = groups.get(key);
        if (list) list.push(row);
        else groups.set(key, [row]);
      }
      const queue = [...groups.values()];
      const lanes = Math.max(1, Math.min(CONCURRENCY, queue.length));
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          for (;;) {
            if (cleanState.cancelled) return;
            const group = queue.shift();
            if (!group) return;
            await scoreImageGroup(group);
          }
        })
      );
      cleanState.message = `已检查 ${cleanState.done}/${total} 张脸，排除 ${cleanState.hidden} 张`;
      jobProgress(jobId, {
        done: cleanState.done,
        total,
        progress: total ? Math.round((cleanState.done / total) * 100) : 100,
        message: cleanState.message,
      });
      await new Promise((r) => setImmediate(r));
      if (cleanState.cancelled) break;
    }

    // 按新质量重算每个人物：质心、人数、封面都只吃可见的脸
    const ids = db.prepare('SELECT id FROM persons').all().map((r) => Number(r.id));
    for (const id of ids) rebuildPerson(id);
    const persons = ids.length;
    // 让用户看得见「排除了多少、为什么排除」，而不是只给一个数字
    const why = Object.entries(cleanState.reasons)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(' / ');
    const detail = why ? `（${why}）` : '';
    cleanState.message = cleanState.cancelled
      ? `已取消：检查 ${cleanState.done} 张脸，排除 ${cleanState.hidden} 张${detail}`
      : `完成：检查 ${total} 张脸、排除 ${cleanState.hidden} 张${detail}，重选 ${persons} 个人的封面`;
    finishJob(jobId, {
      status: cleanState.cancelled ? 'canceled' : 'done',
      result: { faces: total, hidden: cleanState.hidden, reasons: { ...cleanState.reasons }, persons, failed },
    });
  } catch (err) {
    finishJob(jobId, { status: 'failed', error: String(err?.message || err).slice(0, 300) });
    cleanState.error = String(err?.message || err);
    throw err;
  } finally {
    cleanState.running = false;
    cleanState.cancelled = false;
  }
}
