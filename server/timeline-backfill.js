// @ts-check
/**
 * 时间线「重建拍摄时间」后台任务。
 *
 * 为什么需要独立任务：升级前的版本只给老库写了 created_at（入库时间），
 * 拿它当拍摄时间会让时间线整个错位（2019 拍的照片排到 2026）。库里的 fs_mtime
 * 只覆盖得到「导入时 stat 过」的行，还有一批（早期版本入库、复制进库、文件被外部替换）
 * 只能重新看一次文件。全库逐张读 EXIF + stat 是分钟级操作，不能塞进 HTTP 请求；
 * 这里按 id 游标分页，中断后重跑可继续，可取消、有进度。
 *
 * 口径与导入完全一致（见 lib/taken-at.js）：
 *   EXIF 时间 → 文件修改时间 / 创建时间取较早者 → 都没有就保持原样（绝不写入库时间）。
 */
import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { db } from './db.js';
import { parseExif } from './lib/exif.js';
import { exifStamp, fileStamp } from './lib/taken-at.js';
import { countPending } from './lib/timeline-repair.js';
import { mapLimit } from './lib/utils.js';
import { createJob, finishJob, hasRunning, jobProgress } from './jobs.js';

let state = { jobId: 0, canceled: false };

/** 还有多少张的拍摄时间仍是「入库时间兜底」或空着（界面据此提示要不要重建） */
export function pendingCount() {
  return countPending(db);
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
    db.prepare('SELECT COUNT(*) AS n FROM images').get()?.n || 0
  );
  const jobId = createJob({ kind: 'timeline-backfill', title: '重建拍摄时间', total });
  state = { jobId, canceled: false };
  run(jobId, total).catch((e) => finishJob(jobId, { status: 'failed', error: e?.message || String(e) }));
  return { ok: true, jobId };
}

export function cancelTimelineBackfill() {
  state.canceled = true;
  return { ok: true };
}

/**
 * 单张素材的最佳已知时间：EXIF 优先，其次文件修改 / 创建时间。
 * @param {{abs_path:string, media_kind?:string}} row
 * @returns {Promise<{stamp: string, mtime: number}>} mtime 只有 stat 成功时才有值（补文件指纹用）
 */
async function bestStamp(row) {
  if (row.media_kind === 'image') {
    try {
      const meta = await sharp(row.abs_path).metadata();
      const exif = exifStamp(parseExif(meta.exif).takenAt);
      if (exif) return { stamp: exif, mtime: 0 };
    } catch {
      /* RAW / 损坏 / 已移走：读不到 EXIF 就往下走文件时间 */
    }
  }
  try {
    const st = await fsp.stat(row.abs_path);
    const mtime = Math.round(st.mtimeMs / 1000);
    return {
      stamp: fileStamp({ fsMtime: mtime, fsBirthtime: Math.round(Number(st.birthtimeMs || 0) / 1000) }),
      mtime,
    };
  } catch {
    return { stamp: '', mtime: 0 };
  }
}

async function run(jobId, total) {
  let cursor = 0;
  let scanned = 0;
  let fixed = 0;
  const batchSize = 200;
  const upd = db.prepare('UPDATE images SET taken_at = ? WHERE id = ?');
  const updWithMtime = db.prepare('UPDATE images SET taken_at = ?, fs_mtime = ? WHERE id = ?');
  for (;;) {
    if (state.canceled) {
      jobProgress(jobId, { done: scanned, message: `已取消（修正 ${fixed} 张）`, force: true });
      return finishJob(jobId, { status: 'canceled', result: { scanned, fixed } });
    }
    const rows = db
      .prepare('SELECT id, abs_path, taken_at, media_kind, fs_mtime FROM images WHERE id > ? ORDER BY id LIMIT ?')
      .all(cursor, batchSize);
    if (!rows.length) break;
    await mapLimit(rows, 4, async (row) => {
      cursor = Math.max(cursor, Number(row.id));
      scanned++;
      const { stamp, mtime } = await bestStamp(row);
      // 算不出来就保留原值：拿不准的情况下不动已有数据
      if (!stamp || stamp === row.taken_at) return;
      if (Number(row.fs_mtime || 0) > 0 || !mtime) {
        upd.run(stamp, Number(row.id));
      } else {
        // 顺手补上文件指纹（老行可能一直是 0，缺它就没有 ?v= 缓存版本号）
        updWithMtime.run(stamp, mtime, Number(row.id));
      }
      fixed++;
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
