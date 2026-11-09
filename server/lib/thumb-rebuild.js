// @ts-check
/**
 * 后台补缩略图（按库里的记录，不扫文件系统）。
 *
 * 为什么需要：从旧库合并进来、或者上一次导入被打断的库，会有成千上万行 thumb 为空。
 * 光靠「用户滚到哪补到哪」的在线队列，一屏几十张排队要十几秒，卡片等不到就显示异常，
 * 用户看到的就是「图片加载不出来」。这里一次性按批补完，进度写进任务表。
 */
import { db, getLibraryGeneration } from '../db.js';
import { ensureThumb } from '../library.js';
import { createJob, finishJob, jobProgress } from '../jobs.js';
import { mapLimit } from './utils.js';

const BATCH = 120;
const CONCURRENCY = 3;
/** 补不出来的（文件确实不在、格式没预览）在本次任务里跳过，避免死循环重试 */
const attempted = new Set();

let running = false;
let stopFlag = false;
let stats = { done: 0, failed: 0, total: 0, jobId: 0 };

const MISSING_SQL =
  "SELECT id, abs_path FROM images WHERE COALESCE(thumb, '') = '' AND media_kind IN ('image', 'gif', 'raw', 'design')";

export function thumbMissingCount() {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS c FROM (${MISSING_SQL})`).get()?.c || 0);
  } catch {
    return 0;
  }
}

export function thumbRebuildStatus() {
  return { ...stats, running, remaining: running ? Math.max(0, stats.total - stats.done - stats.failed) : thumbMissingCount() };
}

/** 切库时叫停：id 与 thumbs 目录都换人了，继续补会写错库 */
export function stopThumbRebuild() {
  if (running) stopFlag = true;
}

/**
 * 开始补图（同一时刻只跑一个）。
 * @param {{onProgress?:(s:object)=>void, minBatch?:boolean}} opts
 */
export function startThumbRebuild({ onProgress = null } = {}) {
  if (running) return { started: false, reason: 'running', ...thumbRebuildStatus() };
  const total = thumbMissingCount();
  if (!total) return { started: false, reason: 'nothing', total: 0 };

  running = true;
  stopFlag = false;
  attempted.clear();
  const gen = getLibraryGeneration();
  const jobId = createJob({ kind: 'thumb-rebuild', title: '重建缺失缩略图', total });
  stats = { done: 0, failed: 0, total, jobId };

  void (async () => {
    try {
      // 游标必须往前推进，不能每轮都重新取「最新 120 行再在内存里 filter attempted」：
      // 一批补不出来的图（文件确实不在）thumb 仍为空，会永久占住 id DESC 的窗口，
      // 下一轮过滤后为空 → break，库里其余缺图的记录再也补不到，任务还报 done。
      let cursor = Number.MAX_SAFE_INTEGER;
      for (;;) {
        if (stopFlag || getLibraryGeneration() !== gen) break;
        const raw = db.prepare(`${MISSING_SQL} AND id < ? ORDER BY id DESC LIMIT ?`).all(cursor, BATCH);
        if (!raw.length) break;
        cursor = raw[raw.length - 1].id;
        const rows = raw.filter((r) => !attempted.has(r.id));
        if (!rows.length) continue;
        await mapLimit(rows, CONCURRENCY, async (r) => {
          if (stopFlag || getLibraryGeneration() !== gen) return;
          attempted.add(r.id);
          let ok;
          try {
            ok = Boolean(await ensureThumb(r.id, r.abs_path));
          } catch {
            ok = false;
          }
          if (ok) stats.done++;
          else stats.failed++;
        });
        jobProgress(jobId, {
          done: stats.done,
          failed: stats.failed,
          total,
          progress: Math.round(((stats.done + stats.failed) / total) * 100),
          message: `已补 ${stats.done} 张${stats.failed ? `，失败 ${stats.failed} 张` : ''}`,
        });
        onProgress?.({ ...stats, running: true });
      }
      const cancelled = stopFlag || getLibraryGeneration() !== gen;
      finishJob(jobId, {
        status: cancelled ? 'canceled' : stats.done ? 'done' : 'failed',
        result: { done: stats.done, failed: stats.failed },
        error: cancelled ? '已切换资源库' : '',
      });
      onProgress?.({ ...stats, running: false, finished: true, cancelled });
    } catch (err) {
      finishJob(jobId, { status: 'failed', error: err?.message || String(err) });
      onProgress?.({ ...stats, running: false, error: String(err?.message || err) });
    } finally {
      running = false;
      stopFlag = false;
    }
  })();

  return { started: true, total, jobId };
}
