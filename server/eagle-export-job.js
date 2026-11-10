// @ts-check
import { createJob, finishJob, hasRunning, jobProgress } from './jobs.js';
import { exportEagleLibrary } from './lib/eagle-export.js';

/**
 * 整库导出 Eagle .library 的后台任务。
 *
 * 之前是同一条 HTTP 请求里同步复制几千张原图：请求几分钟才返回，
 * 前端只能显示「导出中…」，中间没有任何进度，超时后连导出到哪一步都不知道。
 */

const state = { running: false, canceled: false };

/** @param {{destDir?: string, name?: string}} [opts] */
export function startEagleExportJob({ destDir, name } = {}) {
  if (state.running || hasRunning('eagle-export')) throw new Error('已有 Eagle 导出任务在运行');
  const jobId = createJob({
    kind: 'eagle-export',
    title: '导出 Eagle 库',
    payload: { destDir, name },
    total: 0,
  });
  state.running = true;
  state.canceled = false;

  void (async () => {
    try {
      const r = await exportEagleLibrary({
        destDir,
        name,
        isCanceled: () => state.canceled,
        onProgress: (p) =>
          jobProgress(jobId, { done: p.done, total: p.total, message: p.message, progress: p.total ? Math.round((p.done / p.total) * 100) : 0 }),
      });
      // jobProgress 有节流：文件少时最后一条可能是「已导出 1/6」，收尾强制写一次真实总数
      jobProgress(jobId, {
        done: r.exported + r.missing,
        total: r.total,
        progress: 100,
        message: `完成：${r.exported} 个素材`,
        force: true,
      });
      finishJob(jobId, { status: 'done', result: r });
    } catch (err) {
      const e = /** @type {Error & {canceled?: boolean}} */ (err);
      finishJob(jobId, { status: e.canceled ? 'canceled' : 'failed', error: e.message || '导出失败' });
    } finally {
      state.running = false;
      state.canceled = false;
    }
  })();

  return { ok: true, jobId };
}

/** @returns {boolean} 是否真的有一个在跑的任务被标记了取消 */
export function cancelEagleExport() {
  if (!state.running) return false;
  state.canceled = true;
  return true;
}
