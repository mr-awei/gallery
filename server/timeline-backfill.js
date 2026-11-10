// @ts-check
/**
 * 时间线「按 EXIF 重建拍摄时间」后台任务。
 *
 * 为什么需要独立任务：升级前入库的图只有 created_at（入库时间），
 * 拿它当拍摄时间会让时间线整个错位（2019 拍的照片排到 2026）。
 * 全库逐张读 EXIF 是分钟级操作，不能塞进 HTTP 请求；这里按 id 游标分页，
 * 中断后重跑从「仍与 created_at 相同」的行继续，可取消、有进度。
 */
import sharp from 'sharp';
import { db } from './db.js';
import { parseExif } from './lib/exif.js';
import { exifStamp } from './lib/taken-at.js';
import { mapLimit } from './lib/utils.js';
import { createJob, finishJob, hasRunning, jobProgress } from './jobs.js';

let state = { jobId: 0, canceled: false };

/** 还有多少张图的拍摄时间仍是「入库时间兜底」（界面据此提示要不要重建） */
export function pendingCount() {
  try {
    const r = db
      .prepare("SELECT COUNT(*) AS n FROM images WHERE media_kind = 'image' AND taken_at = substr(replace(created_at, 'Z', ''), 1, 19)")
      .get();
    return Number(r?.n || 0);
  } catch {
    return 0;
  }
}

/**
 * 启动重建任务。已有一个在跑时直接返回它的 id。
 * @param {{limit?:number}} [o]
 */
export function startTimelineBackfill(o = {}) {
  if (hasRunning('timeline-backfill')) {
    const running = db.prepare("SELECT id FROM jobs WHERE kind = 'timeline-backfill' AND status = 'running' ORDER BY id DESC LIMIT 1").get();
    return { ok: true, jobId: Number(running?.id || 0), already: true };
  }
  const total = Number(
    db.prepare("SELECT COUNT(*) AS n FROM images WHERE media_kind = 'image'").get()?.n || 0
  );
  const jobId = createJob({ kind: 'timeline-backfill', title: '按 EXIF 重建拍摄时间', total });
  state = { jobId, canceled: false };
  run(jobId, total).catch((e) => finishJob(jobId, { status: 'failed', error: e?.message || String(e) }));
  return { ok: true, jobId };
}

export function cancelTimelineBackfill() {
  state.canceled = true;
  return { ok: true };
}

async function run(jobId, total) {
  let cursor = 0;
  let scanned = 0;
  let fixed = 0;
  const batchSize = 200;
  const upd = db.prepare('UPDATE images SET taken_at = ? WHERE id = ?');
  for (;;) {
    if (state.canceled) {
      jobProgress(jobId, { done: scanned, message: `已取消（修正 ${fixed} 张）`, force: true });
      return finishJob(jobId, { status: 'canceled', result: { scanned, fixed } });
    }
    const rows = db
      .prepare("SELECT id, abs_path FROM images WHERE media_kind = 'image' AND id > ? ORDER BY id LIMIT ?")
      .all(cursor, batchSize);
    if (!rows.length) break;
    await mapLimit(rows, 4, async (row) => {
      cursor = Math.max(cursor, Number(row.id));
      scanned++;
      try {
        const meta = await sharp(row.abs_path).metadata();
        const stamp = exifStamp(parseExif(meta.exif).takenAt);
        // 没有 EXIF 时间就保留原值：不要用 mtime 覆盖已经算好的值
        if (stamp) {
          upd.run(stamp, Number(row.id));
          fixed++;
        }
      } catch {
        /* 单张读不动（RAW/损坏）不影响整批 */
      }
    });
    jobProgress(jobId, {
      done: scanned,
      total,
      progress: total ? Math.min(99, Math.round((scanned / total) * 100)) : 0,
      message: `已扫描 ${scanned} 张，修正 ${fixed} 张`,
    });
  }
  jobProgress(jobId, { done: scanned, progress: 100, message: `完成：修正 ${fixed} 张的拍摄时间`, force: true });
  finishJob(jobId, { status: 'done', result: { scanned, fixed } });
}
