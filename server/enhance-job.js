import { enhanceImage, getImage } from './library.js';
import { getLibraryGeneration } from './db.js';

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
  failed: 0,
  model: '',
  standard: '',
  currentId: null,
  currentTitle: '',
  currentProgress: 0,
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
    failed: state.failed,
    model: state.model,
    standard: state.standard,
    currentId: state.currentId,
    currentTitle: state.currentTitle,
    currentProgress: state.currentProgress,
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
    failed: 0,
    model,
    standard,
    currentId: null,
    currentTitle: '',
    currentProgress: 0,
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
  for (const id of ids) {
    if (state.cancelled) break;
    if (generation !== getLibraryGeneration()) {
      state.lastError = '已切换资源库，增强任务已中止';
      break;
    }
    state.currentId = id;
    state.currentProgress = 0;
    try {
      const row = getImage(id);
      state.currentTitle = row?.title || `图片 ${id}`;
    } catch {
      state.currentTitle = `图片 ${id}`;
    }
    try {
      await enhanceImage(id, model, {
        standard,
        onProgress: (p) => {
          if (state.currentId === id) state.currentProgress = p;
        },
      });
      state.done++;
      state.results.push({ id, ok: true });
    } catch (err) {
      state.failed++;
      state.lastError = String((err && err.message) || err);
      state.results.push({ id, ok: false, error: state.lastError });
    }
    state.currentProgress = 0;
  }
  state.running = false;
  state.currentId = null;
  state.currentTitle = '';
  state.finishedAt = new Date().toISOString();
}

export function cancelJob() {
  if (state.running) state.cancelled = true;
  return jobStatus();
}
