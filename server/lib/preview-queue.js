import { getLibraryGeneration } from '../db.js';
import * as lib from '../library.js';
import { ensurePreview, existingPreviewPath } from '../thumbs.js';

/**
 * 预览图（灯箱大图）后台预取队列。
 *
 * 为什么需要：Eagle 打开大图基本不眨眼，是因为它的预览图入库时就生成好了；
 * 我们的预览图是「第一次打开才现做」，6000×4000 的原图解码 + 缩放要 150~500ms，
 * 加上浏览器解码，用户看到的就是「模糊一两秒」。
 *
 * 现在列表一返回就把这一页的预览图排在后台做掉，用户点开时基本都是磁盘命中（3ms）。
 * 限并发 1 且前台有请求时让路：预取是「以后会更好」的工作，绝不能抢用户正在看的那张。
 */

/**
 * 并发 2：单张 150~500ms，一页 120 张串行要 20~60 秒，用户点到「还没轮到」的图
 * 就是那 1~2 秒模糊的来源。两路并发在 SSD + 多核上不会互相拖慢（libvips 本来
 * 就多线程），整页预取时间直接减半；再高就会和前台请求抢 CPU，得不偿失。
 */
const MAX_CONCURRENT = 2;
/** 队列上限：一页 120 张最多，再多也没意义（用户根本翻不到那么快） */
const MAX_PENDING = 160;

const queue = [];
const queued = new Set();
let running = 0;
/** 前台（用户正点开的那张）正在生成的张数：>0 时后台完全让路 */
let fg = 0;
/** 失败计数与最后一条错误：以前静默吞成空串，灯箱一直是模糊图也查不到原因 */
let failed = 0;
let lastError = '';

function noteFailure(id, err) {
  failed += 1;
  lastError = `#${id} ${err?.message || err}`;
  if (failed <= 3 || failed % 50 === 0) {
    console.warn(`[preview] 生成失败（累计 ${failed} 次）：${lastError}`);
  }
}

export function previewQueueStats() {
  return { pending: queue.length, running, fg, failed, lastError };
}

/** 切库时清空：排队的 id 属于旧库，继续跑只会拿旧 id 去新库目录里写文件 */
export function clearPreviewQueue() {
  queue.length = 0;
  queued.clear();
}

/** 前台开始/结束：路由里正在为某张图现做预览图时调用，后台据此让路 */
export function noteForegroundStart() {
  fg++;
}

export function noteForegroundEnd() {
  fg = Math.max(0, fg - 1);
  if (fg === 0) pump();
}

async function generate(id) {
  const gen = getLibraryGeneration();
  const row = lib.getImage(id);
  if (!row || !row.abs_path) return '';
  if (getLibraryGeneration() !== gen) return '';
  return ensurePreview(id, row.abs_path);
}

function pump() {
  // 前台在跑就等它跑完：noteForegroundEnd 里会再叫一次
  if (fg > 0) return;
  while (running < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    queued.delete(id);
    running++;
    void generate(id)
      .catch((err) => noteFailure(id, err))
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** 排进后台队列（幂等；已有缓存直接跳过） */
export function queuePreview(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (queued.has(n)) return true;
  if (queue.length >= MAX_PENDING) return false;
  // 命中缓存的直接跳过：切库后重新进来，同一页很快又会被排一次
  if (existingPreviewPath(n)) return false;
  queued.add(n);
  queue.push(n);
  pump();
  return true;
}

/** 列表接口回包后调用：把这一页的预览图排进后台 */
export function prefetchPreviews(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  let n = 0;
  for (const id of ids) if (queuePreview(id)) n++;
  return n;
}

/**
 * 前端上报「当前屏幕上真正看得见的那批图」：把它们挪到队首。
 *
 * 为什么需要：一页 120 张按列表顺序预取，用户滚到第 100 张时那一张还要等
 * 99 张 × 200ms ≈ 20 秒 —— 点开必然是现做。按可见性抢先做，用户看哪儿哪儿就绪。
 * 已在跑的（最多 2 张）不动，避免把正在写的任务浪费掉。
 */
export function prioritizePreviews(ids) {
  if (!Array.isArray(ids) || !ids.length) return { moved: 0, added: 0 };
  const want = [];
  for (const raw of ids) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || want.includes(n)) continue;
    if (existingPreviewPath(n)) continue;
    want.push(n);
  }
  if (!want.length) return { moved: 0, added: 0 };
  const wantSet = new Set(want);
  // 队列里已有的提上来，顺序按前端给的可见顺序（左到右、上到下）
  const picked = want.filter((id) => queued.has(id));
  const rest = queue.filter((id) => !wantSet.has(id));
  queue.length = 0;
  queue.push(...picked, ...rest);
  // 还没进队的新 id：插到队首（容量允许时）
  let added = 0;
  for (let i = want.length - 1; i >= 0; i--) {
    const id = want[i];
    if (queued.has(id)) continue;
    if (queue.length >= MAX_PENDING) break;
    queued.add(id);
    queue.unshift(id);
    added++;
  }
  pump();
  return { moved: picked.length, added };
}
