import { adjustImage, cropImage, normalizeAdjust } from './lib/edit.js';
import { watermarkImage } from './lib/watermark.js';
import { getImage } from './library.js';
import { getLibraryGeneration } from './db.js';
import { createJob, finishJob, jobProgress } from './jobs.js';

/**
 * 批量编辑后台任务（一次只跑一个）。
 * 每张都要重编码 + 重算 pHash/主体哈希 + CLIP 重嵌入（数百毫秒），
 * 上百张就是分钟级，必须异步执行 + 轮询进度，否则同步 HTTP 请求会超时。
 */

const state = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  failed: 0,
  op: '', // crop | adjust | watermark
  label: '',
  currentId: null,
  currentTitle: '',
  startedAt: null,
  finishedAt: null,
  lastError: '',
  results: [],
};

export function editJobStatus() {
  return {
    running: state.running,
    cancelled: state.cancelled,
    total: state.total,
    done: state.done,
    failed: state.failed,
    op: state.op,
    label: state.label,
    currentId: state.currentId,
    currentTitle: state.currentTitle,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    lastError: state.lastError,
    failures: state.results.filter((r) => !r.ok).slice(0, 20),
  };
}

/**
 * 启动批量编辑。op='crop' 时 params={ratio, rect?}；op='adjust' 时 params=调色参数。
 */
export function startEditJob(ids, op, params = {}) {
  if (state.running) throw new Error('已有批量编辑任务正在进行');
  if (!ids.length) throw new Error('没有选中的图片');
  if (op !== 'crop' && op !== 'adjust' && op !== 'watermark') throw new Error('未知的编辑类型');
  const list = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!list.length) throw new Error('没有选中的图片');
  // 保存方式：'copy' 时目录可以留空 —— persistEdit 会把副本写到各自原图旁边
  if (op === 'watermark') {
    // 批量也要在启动前拦住「什么都没选」：否则会变成 N 条一模一样的失败记录
    const hasStyle = params.style && params.style !== 'none';
    const hasFrame = params.frame && params.frame !== 'none';
    if (!hasStyle && !hasFrame) throw new Error('请先选择一个水印样式或相框样式');
    const hasFields = Array.isArray(params.fields) && params.fields.length > 0;
    if (hasStyle && !hasFields && !params.logo) throw new Error('一项信息都没选：请至少勾选一个要显示的拍摄信息，或打开「品牌 logo」');
  }
  const saveMode = params.saveMode === 'copy' ? 'copy' : 'overwrite';
  // 逐张框选：裁切台允许每张图单独框，rects = { imageId: {x,y,w,h} }（归一化）
  const rects =
    op === 'crop' && params.rects && typeof params.rects === 'object' && !Array.isArray(params.rects)
      ? params.rects
      : null;
  const label =
    (op === 'crop'
      ? `裁切 ${rects ? '逐张框选' : params.ratio && params.ratio !== 'free' ? params.ratio : '自由框'}`
      : op === 'watermark'
        ? `${params.frame && params.frame !== 'none' ? '相框' : ''}${params.style && params.style !== 'none' ? '水印' : ''} 合成`
        : 'Camera Raw 调色') + (saveMode === 'copy' ? '（另存副本）' : '');
  Object.assign(state, {
    running: true,
    cancelled: false,
    total: list.length,
    done: 0,
    failed: 0,
    op,
    label,
    currentId: null,
    currentTitle: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: '',
    results: [],
  });
  // 保存方式字段要透传（normalizeAdjust 只保留调色参数，会把它丢掉）
  const saveOpts = { saveMode, targetDir: String(params.targetDir || '').trim(), addToLibrary: !!params.addToLibrary };
  const normalized =
    op === 'adjust'
      ? { ...normalizeAdjust(params), ...saveOpts }
      : op === 'watermark'
        ? { ...params, ...saveOpts }
        : {
          ratio: params.ratio,
          rect: params.rect,
          rects,
          // 裁切台可指定输出像素（宽/高）；0 表示保持裁切后的自然尺寸
          outWidth: Number(params.outWidth) || 0,
          outHeight: Number(params.outHeight) || 0,
          ...saveOpts,
        };
  run(list, op, normalized);
  return editJobStatus();
}

async function run(ids, op, params) {
  // 任务里的 id 属于启动时的那个库：中途切库后 id 在新库指向别的图，写错库不可逆，直接中止
  const generation = getLibraryGeneration();
  // 落表：批量编辑是不可逆写回原图的操作，历史里必须留一条（含参数，可据此重试）
  const jobId = createJob({
    kind: 'edit',
    title: `${state.label} ${ids.length} 张`,
    payload: { ids, op, params },
    total: ids.length,
  });
  for (const id of ids) {
    if (state.cancelled) break;
    if (generation !== getLibraryGeneration()) {
      state.lastError = '已切换资源库，批量编辑已中止';
      break;
    }
    state.currentId = id;
    try {
      const row = getImage(id);
      state.currentTitle = row?.title || `图片 ${id}`;
    } catch {
      state.currentTitle = `图片 ${id}`;
    }
    try {
      if (op === 'crop') {
        // 逐张框选时用该图自己的框；没有则退回统一的 ratio 居中
        const per = params.rects ? params.rects[id] || params.rects[String(id)] || null : null;
        await cropImage(id, per ? { ...params, ratio: 'free', rect: per } : params);
      } else if (op === 'watermark') {
        await watermarkImage(id, params);
      } else {
        await adjustImage(id, params);
      }
      state.done++;
    } catch (err) {
      state.failed++;
      state.lastError = String((err && err.message) || err);
      // 只留失败明细（成功的不需要回传，避免上千张时无限增长）
      if (state.results.length < 50) state.results.push({ id, ok: false, error: state.lastError });
    }
    jobProgress(jobId, {
      done: state.done,
      total: state.total,
      failed: state.failed,
      progress: Math.round(((state.done + state.failed) / Math.max(1, ids.length)) * 100),
      message: state.currentTitle ? `处理中：${state.currentTitle}` : '',
    });
  }
  state.running = false;
  state.currentId = null;
  state.currentTitle = '';
  state.finishedAt = new Date().toISOString();
  finishJob(jobId, {
    status: state.cancelled ? 'canceled' : state.failed > 0 && state.done === 0 ? 'failed' : 'done',
    error: state.lastError,
    result: { done: state.done, failed: state.failed },
  });
}

export function cancelEditJob() {
  if (state.running) state.cancelled = true;
  return editJobStatus();
}
