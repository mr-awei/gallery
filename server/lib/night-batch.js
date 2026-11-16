// @ts-check
/**
 * AI 夜间批处理：把白天来不及做的索引挪到机器闲置的时段。
 *
 * 为什么要它：导入一结束，用户就滚图库看图了，这时候再全速跑 CLIP/人脸推理，
 * 界面会被拖慢（推理吃满 CPU/GPU、SQLite 写库也被抢）。而这些索引又不是「必须立刻有」：
 * 语义搜索、人物分组晚几个小时出结果完全不影响当天的使用。于是做成「夜间队列」——
 * 时段内、没有导入/采集任务在跑时，串行把缺失的语义特征与人脸索引补上。
 *
 * 几个刻意的选择：
 * - 按库独立存配置（settings 表）：不同资源库的图片量差十倍，时段可以分开设；
 * - 只处理「缺失」的部分（语义缺 embedding、人脸 face_scanned = 0），天然断点续跑，
 *   中途关机/切库/点停止，下次从缺口继续，不会重复算已完成的图；
 * - 串行执行、同一时刻只跑一项：两项并发抢 GPU 只会让两边都变慢；
 * - 模型没下载就跳过并说明原因，绝不半夜偷偷下 200MB 权重（那是白天的显式动作）；
 * - 切库立即中止：跨库写索引等于把数据写错地方。
 */
import { db, getSettings, saveSettings } from '../db.js';
import { createJob, finishJob, hasRunning, jobProgress } from '../jobs.js';
import { NIGHT_TASKS, formatClock, inWindow, parseClock, parseTasks } from './night-window.js';

export { formatClock, inWindow, parseClock } from './night-window.js';

/** 每分钟看一次：比「定死在 02:00:00」更抗休眠，最坏晚一分钟开始 */
const TICK_MS = 60_000;
/** 轮询子任务进度的间隔 */
const POLL_MS = 1_500;
/** 单轮上限 8 小时：防止某个模型卡住时通宵占着显卡 */
const MAX_ROUND_MS = 8 * 3600_000;
/** 启动后先等 3 分钟再判断：避开开库迁移、首屏缩略图排队的高峰 */
const FIRST_TICK_DELAY = 3 * 60_000;

const TASKS = NIGHT_TASKS;
const TASK_TITLE = { semantic: '语义索引', face: '人脸索引' };

/** 由 app.js 注入：判断此刻是否正在导入/采集（lib 层不能反向 import app.js） */
let busyProbe = () => false;
export function registerBusyProbe(fn) {
  if (typeof fn === 'function') busyProbe = fn;
}

let timer = null;
let firstTimer = null;

const state = {
  running: false,
  task: '',
  jobId: 0,
  done: 0,
  total: 0,
  startedAt: '',
  lastAt: '',
  lastSummary: '',
  lastError: '',
  skipped: '',
  stopRequested: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前配置（前端、调度器共用同一份口径） */
export function nightBatchConfig() {
  const s = getSettings();
  return {
    enabled: !!s.nightBatch,
    start: parseClock(s.nightBatchStart, 120),
    end: parseClock(s.nightBatchEnd, 360),
    startText: formatClock(parseClock(s.nightBatchStart, 120)),
    endText: formatClock(parseClock(s.nightBatchEnd, 360)),
    tasks: parseTasks(s.nightBatchTasks),
    lastAt: String(s.nightBatchLastAt || ''),
    lastSummary: String(s.nightBatchLastSummary || ''),
  };
}

/** 保存配置：白名单字段，不信任前端塞进来的任意键 */
export function saveNightBatchConfig(patch) {
  const next = {};
  if (patch?.enabled !== undefined) next.nightBatch = !!patch.enabled;
  if (patch?.start !== undefined) {
    const v = typeof patch.start === 'number' ? patch.start : parseClock(patch.start, 120);
    next.nightBatchStart = formatClock(v);
  }
  if (patch?.end !== undefined) {
    const v = typeof patch.end === 'number' ? patch.end : parseClock(patch.end, 360);
    next.nightBatchEnd = formatClock(v);
  }
  if (patch?.tasks !== undefined) {
    const list = Array.isArray(patch.tasks) ? patch.tasks : parseTasks(patch.tasks);
    next.nightBatchTasks = list.filter((t) => TASKS.includes(/** @type {any} */ (t))).join(',') || 'semantic,face';
  }
  saveSettings(next);
  return nightBatchConfig();
}

/**
 * 待处理数量：只数缺口，不数总量（索引已建好的库这里会是 0）
 * @param {string[]} [tasks]
 */
export function nightBatchPending(tasks = [...TASKS]) {
  const out = { semantic: 0, face: 0, total: 0 };
  try {
    if (tasks.includes('semantic')) {
      out.semantic =
        Number(
          db.prepare('SELECT COUNT(*) AS c FROM images WHERE id NOT IN (SELECT image_id FROM clip_vec)').get()?.c
        ) || 0;
    }
    if (tasks.includes('face')) {
      out.face = Number(db.prepare('SELECT COUNT(*) AS c FROM images WHERE face_scanned = 0').get()?.c) || 0;
    }
  } catch {
    // 老库迁移未完成时状态接口不该 500：按 0 报，用户看到「暂无待处理」
  }
  out.total = out.semantic + out.face;
  return out;
}

/** 状态：配置 + 时段判断 + 待办 + 当前进度，前端轮询这一个接口就够 */
export function nightBatchStatus() {
  const cfg = nightBatchConfig();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return {
    ...cfg,
    nowMin,
    inWindow: inWindow(nowMin, cfg.start, cfg.end),
    pending: nightBatchPending(cfg.tasks),
    running: state.running,
    task: state.task,
    jobId: state.jobId,
    done: state.done,
    total: state.total,
    startedAt: state.startedAt,
    lastAt: state.lastAt || cfg.lastAt,
    lastSummary: state.lastSummary || cfg.lastSummary,
    lastError: state.lastError,
    skipped: state.running ? '' : nightBatchSkipReason(),
    stopRequested: state.stopRequested,
  };
}

/** 模型是否就绪（没下载就跳过，不在半夜下载权重） */
async function taskBlocked(task) {
  if (task === 'semantic') {
    const clip = await import('../clip.js');
    if (!clip.clipDownloaded()) return '语义模型未下载';
    if (!clip.clipReady()) return '语义模型还没加载完';
    return '';
  }
  if (task === 'face') {
    const face = await import('../face.js');
    const st = face.faceStatus();
    if (!st.downloaded) return '人脸模型未下载';
    if (st.downloading) return '人脸模型正在下载';
    return '';
  }
  return '';
}

/**
 * 跑语义补算直到结束/停止/超时。
 * @returns {Promise<{done:number, error:string, cancelled:boolean}>}
 */
async function runSemantic(jobId, base, total, roundStart) {
  const clip = await import('../clip.js');
  const before = clip.backfillStatus();
  if (before.running) return { done: 0, error: '语义补算已经在跑', cancelled: false };
  const r = await clip.startBackfill();
  if (!r.ok) return { done: 0, error: r.message || '启动失败', cancelled: false };
  state.task = 'semantic';
  for (;;) {
    const s = clip.backfillStatus();
    state.done = base + s.done;
    state.total = total;
    jobProgress(jobId, {
      done: base + s.done,
      total,
      message: `语义索引 ${s.done}/${s.total}`,
      force: true,
    });
    if (!s.running) return { done: s.done, error: s.error || '', cancelled: !!s.cancelled };
    if (state.stopRequested || Date.now() - roundStart > MAX_ROUND_MS) clip.cancelBackfill();
    await sleep(POLL_MS);
  }
}

/** 跑人脸扫描直到结束/停止/超时（进度用「待扫数量下降」推算） */
async function runFace(jobId, base, total, roundStart) {
  const face = await import('../face.js');
  const st0 = face.faceStatus();
  if (st0.scanning) return { done: 0, error: '人脸扫描已经在跑', cancelled: false };
  const pending0 = Number(st0.pending) || 0;
  const r = face.startFaceScan({});
  if (r?.ok === false) return { done: 0, error: r.message || '启动失败', cancelled: false };
  state.task = 'face';
  for (;;) {
    const s = face.faceStatus();
    const done = Math.max(0, pending0 - (Number(s.pending) || 0));
    state.done = base + done;
    state.total = total;
    jobProgress(jobId, {
      done: base + done,
      total,
      message: `人脸索引 ${done}/${pending0}`,
      force: true,
    });
    if (!s.scanning) return { done, error: '', cancelled: state.stopRequested };
    if (state.stopRequested || Date.now() - roundStart > MAX_ROUND_MS) face.cancelFaceScan();
    await sleep(POLL_MS);
  }
}

/**
 * 立即跑一轮（设置页「现在跑一次」也走这里）。
 * @param {{reason?: 'schedule' | 'manual'}} [opts]
 */
export async function runNightBatch({ reason = 'manual' } = {}) {
  if (state.running) return { ok: false, message: '夜间批处理正在运行' };
  const cfg = nightBatchConfig();
  const tasks = cfg.tasks.filter((t) => TASKS.includes(/** @type {any} */ (t)));
  const pending = nightBatchPending(tasks);
  if (!pending.total) return { ok: false, message: '没有需要补算的图片' };

  const total = pending.semantic + pending.face;
  const startedAt = new Date().toISOString();
  const jobId = createJob({
    kind: 'night-batch',
    title: reason === 'manual' ? 'AI 夜间批处理（手动）' : 'AI 夜间批处理',
    total,
    payload: { tasks, reason },
  });

  state.running = true;
  state.task = '';
  state.jobId = jobId;
  state.done = 0;
  state.total = total;
  state.startedAt = startedAt;
  state.lastError = '';
  state.skipped = '';
  state.stopRequested = false;

  const parts = [];
  let base = 0;
  let cancelled = false;
  const roundStart = Date.now();
  try {
    for (const task of tasks) {
      if (state.stopRequested) {
        cancelled = true;
        break;
      }
      const blocked = await taskBlocked(task);
      if (blocked) {
        parts.push(`${TASK_TITLE[task]}跳过（${blocked}）`);
        continue;
      }
      const r =
        task === 'semantic'
          ? await runSemantic(jobId, base, total, roundStart)
          : await runFace(jobId, base, total, roundStart);
      base += r.done;
      if (r.error) parts.push(`${TASK_TITLE[task]} ${r.done} 张（${r.error}）`);
      else parts.push(`${TASK_TITLE[task]} ${r.done} 张`);
      if (r.cancelled || state.stopRequested) {
        cancelled = true;
        break;
      }
    }
    const summary = parts.length ? parts.join(' · ') : '没有可处理的任务';
    const at = new Date().toISOString();
    state.lastAt = at;
    state.lastSummary = summary;
    saveSettings({ nightBatchLastAt: at, nightBatchLastSummary: summary });
    finishJob(jobId, { status: cancelled ? 'canceled' : 'done', result: { summary, cancelled } });
    return { ok: true, cancelled, summary };
  } catch (err) {
    const msg = err?.message || String(err);
    state.lastError = msg;
    finishJob(jobId, { status: 'failed', error: msg });
    return { ok: false, error: msg };
  } finally {
    state.running = false;
    state.task = '';
    state.jobId = 0;
    state.stopRequested = false;
  }
}

/** 请求停止：当前项收尾后不再开始下一项（已写入的索引保留） */
export function stopNightBatch() {
  if (!state.running) return { ok: false, message: '没有在跑的夜间任务' };
  state.stopRequested = true;
  const task = state.task;
  void (async () => {
    try {
      if (task === 'semantic') (await import('../clip.js')).cancelBackfill();
      else if (task === 'face') (await import('../face.js')).cancelFaceScan();
    } catch (err) {
      state.lastError = err?.message || String(err);
    }
  })();
  return { ok: true, message: '已请求停止，正在收尾当前这一张' };
}

/** 调度判断：能不能开跑（返回不能跑的原因，空串 = 可以）。同步实现，状态接口也要用 */
export function nightBatchSkipReason() {
  const cfg = nightBatchConfig();
  if (!cfg.enabled) return '未开启';
  const now = new Date();
  if (!inWindow(now.getHours() * 60 + now.getMinutes(), cfg.start, cfg.end)) return '不在设定的时段内';
  try {
    if (busyProbe()) return '正在导入或采集';
  } catch {
    /* 探测器抛错不该让调度停摆 */
  }
  for (const kind of ['import', 'crawl', 'model-install']) {
    if (hasRunning(kind)) return '有导入/采集/模型下载在进行';
  }
  const pending = nightBatchPending(cfg.tasks);
  if (!pending.total) return '没有待补算的图片';
  return '';
}

async function tick() {
  if (state.running) return;
  const reason = nightBatchSkipReason();
  state.skipped = reason;
  if (reason) return;
  await runNightBatch({ reason: 'schedule' });
}

/** 服务启动时调用（幂等） */
export function startNightBatchSchedule() {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
  firstTimer = setTimeout(() => {
    void tick();
  }, FIRST_TICK_DELAY);
  firstTimer.unref?.();
}

export function stopNightBatchSchedule() {
  if (timer) clearInterval(timer);
  if (firstTimer) clearTimeout(firstTimer);
  timer = null;
  firstTimer = null;
}
