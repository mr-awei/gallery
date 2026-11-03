import { enhanceImage, getImage } from './library.js';
import { getLibraryGeneration } from './db.js';
import { createJob, finishJob, jobProgress } from './jobs.js';

/**
 * 画质增强后台任务（一次只跑一个）。
 * AI 超分单张可能数秒到数十秒，批量必须异步执行 + 轮询进度，
 * 否则同步 HTTP 请求会超时。
 */

const state = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  model: '',
  standard: '',
  currentId: null,
  currentTitle: '',
  currentProgress: 0,
  /** 当前这张图的进度是否「说不清」（如 Swin2SR 推理阶段拿不到中间进度） */
  currentIndeterminate: false,
  startedAt: null,
  finishedAt: null,
  lastError: '',
  results: [],
};

export function jobStatus() {
  return {
    running: state.running,
    cancelled: state.cancelled,
    total: state.total,
    done: state.done,
    skipped: state.skipped,
    failed: state.failed,
    model: state.model,
    standard: state.standard,
    currentId: state.currentId,
    currentTitle: state.currentTitle,
    currentProgress: state.currentProgress,
    currentIndeterminate: state.currentIndeterminate,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    lastError: state.lastError,
    failures: state.results.filter((r) => !r.ok).slice(0, 20),
  };
}

export function startJob(ids, model, standard) {
  if (state.running) throw new Error('已有增强任务正在进行');
  if (!ids.length) throw new Error('没有需要增强的图片');
  Object.assign(state, {
    running: true,
    cancelled: false,
    total: ids.length,
    done: 0,
    skipped: 0,
    failed: 0,
    model,
    standard,
    currentId: null,
    currentTitle: '',
    currentProgress: 0,
    currentIndeterminate: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: '',
    results: [],
  });
  run(ids, model, standard);
  return jobStatus();
}

async function run(ids, model, standard) {
  // 任务里的 id 属于启动时的那个库：中途切库后这些 id 在新库里指向别的图，
  // 继续跑会把增强结果写错库，直接中止
  const generation = getLibraryGeneration();
  // 落表：进程重启/崩溃后还能在「任务历史」里看到这批跑过什么、失败在哪
  const jobId = createJob({
    kind: 'enhance',
    title: `画质增强 ${ids.length} 张（${model}）`,
    payload: { ids, model, standard },
    total: ids.length,
  });
  // 中途切库 = 这批 id 在新库里指向别图，必须中止；单独记下来，任务表里标 interrupted 而不是 done
  let interrupted = false;
  for (const id of ids) {
    if (state.cancelled) break;
    if (generation !== getLibraryGeneration()) {
      state.lastError = '已切换资源库，增强任务已中止';
      interrupted = true;
      break;
    }
    state.currentId = id;
    state.currentProgress = 0;
    state.currentIndeterminate = false;
    try {
      const row = getImage(id);
      state.currentTitle = row?.title || `图片 ${id}`;
    } catch {
      state.currentTitle = `图片 ${id}`;
    }
    try {
      const result = await enhanceImage(id, model, {
        standard,
        onProgress: (p, info) => {
          if (state.currentId !== id) return;
          state.currentProgress = p;
          state.currentIndeterminate = !!info?.indeterminate;
        },
      });
      // 已达标（底层 noop）：不算「增强成功」，单独计数，否则完成提示与画面都不符
      if (result && result.noop) {
        state.skipped++;
        state.results.push({ id, ok: true, noop: true });
      } else {
        state.done++;
        state.results.push({ id, ok: true });
      }
    } catch (err) {
      state.failed++;
      state.lastError = String((err && err.message) || err);
      state.results.push({ id, ok: false, error: state.lastError });
    }
    state.currentProgress = 0;
    state.currentIndeterminate = false;
    jobProgress(jobId, {
      done: state.done,
      total: state.total,
      failed: state.failed,
      progress: Math.round(((state.done + state.skipped + state.failed) / Math.max(1, ids.length)) * 100),
      message: state.currentTitle ? `处理中：${state.currentTitle}` : '',
    });
  }
  state.running = false;
  state.currentId = null;
  state.currentTitle = '';
  state.currentProgress = 0;
  state.currentIndeterminate = false;
  state.finishedAt = new Date().toISOString();
  finishJob(jobId, {
    status: state.cancelled ? 'canceled' : interrupted ? 'interrupted' : state.failed > 0 && state.done === 0 ? 'failed' : 'done',
    error: state.lastError,
    result: { done: state.done, skipped: state.skipped, failed: state.failed },
  });
}

export function cancelJob() {
  if (state.running) state.cancelled = true;
  return jobStatus();
}
