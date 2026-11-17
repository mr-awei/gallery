// @ts-check
/**
 * 下载中心「全部下载」：把还没装的模型按顺序装完。
 *
 * 为什么排队而不是并发：每一项都是几十到几百 MB，并发会把带宽、磁盘和 Hub 限流
 * 同时打满；更关键的是人脸 / 语义 / 抠图各模块内部只有一个下载态，并发会互相覆盖
 * 进度，界面就只剩最后一项在动，也分不清失败的是哪一项。
 *
 * 单项失败不中断整批：记下原因继续下一项，最后一次性汇报（用户在这里最想要的是
 * 「能装的都装上」，而不是被第一项网络抖动卡死）。
 */
import { db } from '../db.js';
import { createJob, finishJob, hasRunning, jobProgress } from '../jobs.js';
import { cancelModel, installModel, listModels } from './model-registry.js';

const JOB_KIND = 'models-install-all';
const POLL_MS = 1500;
/** 单项最长等待：40 分钟（几百 MB 在慢网下也要能下完，超时才判失败） */
const ITEM_TIMEOUT_MS = 40 * 60 * 1000;

let state = { canceled: false, currentId: '' };

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @returns {number} 正在跑的批量任务 id，没有则 0 */
function activeJobId() {
  const row = db
    .prepare(`SELECT id FROM jobs WHERE kind = ? AND status = 'running' ORDER BY id DESC LIMIT 1`)
    .get(JOB_KIND);
  return Number(row?.id || 0);
}

export function installAllStatus() {
  const jobId = activeJobId();
  return { running: jobId > 0, jobId };
}

/** 待下载清单：没装、当前也没有在下的 */
export function pendingModels() {
  return listModels().items.filter(
    (m) => !m.installed && m.state !== 'downloading' && m.state !== 'installing'
  );
}

/**
 * 等一项下完。判据只能靠 listModels：
 * installed=true 即成功；连续两次「不在下、也没装好」就当失败（错误由模块自己写在 item.error）。
 * @param {string} id
 */
async function waitItem(id) {
  const deadline = Date.now() + ITEM_TIMEOUT_MS;
  let quiet = 0;
  for (;;) {
    if (state.canceled) return { ok: false, canceled: true, error: '已取消' };
    const item = listModels().items.find((m) => m.id === id);
    if (!item) return { ok: false, error: '清单里找不到这一项' };
    if (item.installed) return { ok: true };
    if (item.state === 'downloading' || item.state === 'installing') quiet = 0;
    else if (++quiet >= 2) return { ok: false, error: item.error || '下载未完成' };
    if (Date.now() > deadline) return { ok: false, error: '下载超时' };
    await sleep(POLL_MS);
  }
}

/** 启动「下载全部」；已有任务在跑就返回它的 id（不重复排队） */
export function startInstallAll() {
  if (hasRunning(JOB_KIND)) return { ok: true, already: true, jobId: activeJobId() };
  const queue = pendingModels();
  if (!queue.length) return { ok: false, error: '所有模型都已装好' };
  state = { canceled: false, currentId: '' };
  const jobId = createJob({ kind: JOB_KIND, title: '下载全部模型', total: queue.length });
  void run(jobId, queue);
  return { ok: true, started: true, jobId, total: queue.length };
}

/** 取消：先拦住队列，再让当前这一项自己停（模块不支持中止就只停队列） */
export function cancelInstallAll() {
  state.canceled = true;
  const id = state.currentId;
  if (id) {
    try {
      cancelModel(id);
    } catch {
      /* 模块没实现中止：队列停住即可，当前这项会自然下完 */
    }
  }
  return { ok: true };
}

/**
 * @param {number} jobId
 * @param {any[]} queue
 */
async function run(jobId, queue) {
  let done = 0;
  /** @type {string[]} */
  const installed = [];
  /** @type {{id:string,name:string,error:string}[]} */
  const failed = [];
  try {
    for (const m of queue) {
      if (state.canceled) break;
      state.currentId = m.id;
      jobProgress(jobId, {
        done,
        total: queue.length,
        progress: Math.round((done / queue.length) * 100),
        message: `正在下载 ${m.name}（${done + 1}/${queue.length}）`,
      });
      /** @type {{ok?:boolean,error?:string}} */
      let r;
      try {
        r = await installModel(m.id);
      } catch (err) {
        r = { ok: false, error: String((err && err.message) || err) };
      }
      if (!r.ok) {
        done++;
        // 「已经安装」不算失败（清单体积刷新有延迟时会出现）
        if (!/已经安装/.test(String(r.error || ''))) failed.push({ id: m.id, name: m.name, error: r.error || '下载未能开始' });
        continue;
      }
      const w = await waitItem(m.id);
      done++;
      if (w.ok) installed.push(m.id);
      else if (!w.canceled) failed.push({ id: m.id, name: m.name, error: w.error || '下载未完成' });
    }
    const canceled = state.canceled;
    const message = canceled
      ? `已取消：完成 ${installed.length}/${queue.length} 项`
      : `完成：新装 ${installed.length} 项${failed.length ? `，${failed.length} 项失败` : ''}`;
    jobProgress(jobId, { done, total: queue.length, progress: 100, message, force: true });
    finishJob(jobId, { status: canceled ? 'canceled' : 'done', result: { installed, failed } });
  } catch (err) {
    finishJob(jobId, { status: 'failed', error: String((err && err.message) || err) });
  } finally {
    state.currentId = '';
  }
}
