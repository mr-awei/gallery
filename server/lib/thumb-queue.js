import { getLibraryGeneration } from '../db.js';
import * as lib from '../library.js';

/**
 * 缩略图后台补全队列。
 *
 * 为什么需要：库里常有「已登记但没生成缩略图」的图（上次导入被切库/关软件打断，
 * 大库能有上万张）。以前每条 /api/images/:id/thumb 请求都在请求里现场 sharp 解码，
 * 首屏几十张并发直接把 CPU 和 libvips 线程池打满 —— 表现就是切库后三四十秒才出图，
 * 期间点开大图也跟着卡。
 *
 * 现在：请求只查磁盘缓存，缺图立刻 404 交给前端占位，生成丢进这里限速跑。
 * 限并发 2 是刻意的：后台补图是「以后会更好」的工作，不该跟用户正在看的东西抢 CPU。
 */

const MAX_CONCURRENT = 2;
/** 用户正在看的卡片可以插队同步生成，但也要有上限，否则一次一屏又能打满 */
const MAX_SYNC = 3;

const queue = []; // 待生成的 id（FIFO）
const queued = new Set(); // 去重：同一张图只排一次
let running = 0;
let syncRunning = 0;
/** 失败计数与最后一条错误：以前 `.catch(() => '')` 把失败吞成空串，占位图永远不消失也无从排查 */
let failed = 0;
let lastError = '';

function noteFailure(id, err) {
  failed += 1;
  lastError = `#${id} ${err?.message || err}`;
  // 只在前几次与每 50 次打一条：一次坏库可能是所有图都失败，逐条打会把日志刷爆
  if (failed <= 3 || failed % 50 === 0) {
    console.warn(`[thumb] 生成失败（累计 ${failed} 次）：${lastError}`);
  }
}

/** 正在补图的队列长度（诊断用） */
export function thumbQueueStats() {
  return { pending: queue.length, running, syncRunning, failed, lastError };
}

/** 切库时清空：队列里的 id 属于旧库，继续跑会拿旧 id 去新库的 thumbs 目录里生成 */
export function clearThumbQueue() {
  queue.length = 0;
  queued.clear();
}

async function generate(id) {
  // 生成期间可能切了库：id 与 thumbs 目录都会对不上，直接放弃
  const gen = getLibraryGeneration();
  const row = lib.getImage(id);
  if (!row || !row.abs_path) return '';
  if (getLibraryGeneration() !== gen) return '';
  return lib.ensureThumb(id, row.abs_path);
}

function pump() {
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

/** 排进后台队列（幂等：已在队列里的不重复排） */
export function queueThumb(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0 || queued.has(n)) return false;
  queued.add(n);
  queue.push(n);
  pump();
  return true;
}

/**
 * 用户正盯着这张图（卡片可见 / 刚滚动到）：给它一次优先机会。
 * 但同样受并发上限约束 —— 满了就返回 null，让调用方照常 404 + 走后台队列。
 */
export async function trySyncThumb(id) {
  if (syncRunning >= MAX_SYNC) return null;
  syncRunning++;
  try {
    return await generate(id);
  } catch (err) {
    noteFailure(id, err);
    return null;
  } finally {
    syncRunning--;
    pump();
  }
}
