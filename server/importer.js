import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LEGACY_DIRS } from './config.js';
import { db, getSettings, getLibraryGeneration, getActiveLibrary, withTransaction } from './db.js';
import { ingest, resyncImageMeta, removePhash } from './library.js';
import * as clip from './clip.js';
import { invalidateQuality } from './quality.js';
import { ingestMedia, isMediaPath, MEDIA_EXTS } from './lib/media.js';
import { bulkImportLocal } from './bulk-import.js';
import { SOURCES } from './crawler.js';
import { shouldSkipDir, isSkippedPath } from './lib/skip-dirs.js';
import { md5File } from './lib/hash.js';
import { liveBus } from './live-bus.js';

// 扫描/监听白名单：图片 + Eagle 式多格式素材（视频/音频/字体/PDF/Office/3D）
// 排除表（thumbs / .tuku / .library …）统一在 lib/skip-dirs.js，别再本地复制一份
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', ...[...MEDIA_EXTS].map((e) => `.${e}`)]);
const DEFAULT_MAX_DEPTH = 4;

/**
 * 来源推断：目录名正好是某个采集源的 key（bing / baidu / weibo…）就沿用该来源，
 * 否则一律按用户自己的本地素材登记。
 * 以前只特判了 `raw`（`folder === 'raw' ? 'bing' : 'local'`）——既漏掉了别的源目录，
 * 也把“父目录恰好叫 raw”的普通素材误标成 bing。
 */
const SOURCE_DIRS = new Set(Object.keys(SOURCES));
function sourceFromDir(dirName) {
  const key = String(dirName || '').toLowerCase();
  return SOURCE_DIRS.has(key) ? key : 'local';
}

/** 遍历深度上限：与 bulk-import 共用设置项 importMaxDepth（默认 4 层） */
function resolveMaxDepth() {
  const v = Number(getSettings().importMaxDepth);
  return Number.isFinite(v) && v > 0 ? Math.min(16, Math.floor(v)) : DEFAULT_MAX_DEPTH;
}

/** 递归扫描壁纸库文件夹下的所有图片 */
export function scanLocalImages(dirs = LEGACY_DIRS, depth = 0, maxDepth = null) {
  const files = [];
  const limit = maxDepth ?? resolveMaxDepth();
  if (depth > limit) return files;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        files.push(...scanLocalImages([full], depth + 1, limit));
        continue;
      }
      if (EXTS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  }
  return files;
}

/**
 * 导入壁纸库文件夹内的图片（不复制原文件，只登记并生成缩略图）
 */
let scanRunning = false;
let scanCancel = false;

/**
 * 中止进行中的本地扫描（切换资源库时调用）。
 * 扫描是跨 await 的长任务：切库后 db / 缩略图目录都会指向新库，继续跑下去
 * 就会把旧库的图写进新库。这里只置标记，真正的拦截至库写入前由 ingest 的
 * 库代数校验完成。
 */
export function cancelLocalImport() {
  if (scanRunning) scanCancel = true;
}

/**
 * 扫描素材目录并入库。走 bulk-import 的流水线：
 * 解码/编码/pHash/主色在 worker 池里并行，主线程只做批量 SQLite 写入。
 */
export async function importLocalImages(options = {}) {
  const settings = getSettings();
  const { dirs = [settings.storageDir || LEGACY_DIRS[0]], keyword = '', onProgress = null } =
    options;
  scanRunning = true;
  scanCancel = false;
  try {
    return await bulkImportLocal({
      dirs,
      keyword,
      onProgress,
      isCancelled: () => scanCancel,
    });
  } finally {
    scanRunning = false;
    scanCancel = false;
  }
}

/** 有限并发执行异步任务（next 指针派发；JS 单线程，各任务对共享计数器的修改天然安全） */
async function mapLimit(list, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      await fn(list[i]);
    }
  });
  await Promise.all(workers);
}

/* ------------------------- 素材文件夹实时监听 ------------------------- */
/* 用户手动往素材文件夹拷图（如同名 jpg/png 副本）时自动登记入库，
 * 避免「磁盘上有、库里没有」导致整理工具配不成对。 */

let watcher = null;
let watchedDir = '';
// file -> 收集该事件时的库代数。防抖回调是延迟执行的，期间可能已切库：
// 旧库的积压事件绝不能写进新库（曾导致 A 库的文件被整批 ingest 进 B 库）
const watchPending = new Map();
let watchTimer = null;

function closeWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    watchedDir = '';
  }
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
}

/** 防抖后处理新增文件（拷贝一批只触发一次入库） */
function scheduleWatchIngest(delayMs = 2000) {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    watchTimer = null;
    if (scanRunning) {
      // 批量扫描进行中：扫描本身会覆盖这些文件；但扫描开始后才拷入的
      // 可能被漏掉，重新排队再等一轮
      scheduleWatchIngest(5000);
      return;
    }
    const nowGen = getLibraryGeneration();
    // 只处理当前库期间收集的文件；上一个库的积压事件整体作废
    const files = [...watchPending]
      .filter((f, gen) => gen === nowGen && fs.existsSync(f))
      .map(([f]) => f);
    for (const f of files) watchPending.delete(f);
    if (!files.length) return;
    const settings = getSettings();
    const root = path.resolve(settings.storageDir || '');
    if (!root) return;
    const knownRows = new Map(
      db.prepare('SELECT id, abs_path FROM images').all().map((r) => [r.abs_path, r.id])
    );
    const generation = nowGen;
    const libName = getActiveLibrary()?.name || '';
    let saved = 0;
    await mapLimit(files, 3, async (f) => {
      if (generation !== getLibraryGeneration()) return;
      // 最后防线：只登记当前素材根目录下的文件（切库时序等任何漏网路径都拦在这里）
      const rel = path.relative(root, f);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return;
      // 已登记的文件被手动替换 / 修改：重新同步元数据（宽高、pHash、特征、缩略图）
      const knownId = knownRows.get(f);
      if (knownId) {
        // 非图片素材没有 sharp 可解元数据，跳过重同步
        if (!isMediaPath(f) && (await resyncImageMeta(knownId))) {
          saved++;
          console.log('[watch] 文件已更新，元数据已同步:', f);
        }
        return;
      }
      const folder = path.basename(path.dirname(f));
      try {
        const res = isMediaPath(f)
          ? await ingestMedia({
              absPath: f,
              source: sourceFromDir(folder),
              keyword: libName,
            })
          : await ingest(
              {
                absPath: f,
                source: sourceFromDir(folder),
                keyword: libName,
                skipPhashDupe: true,
                libGeneration: generation,
              },
              settings
            );
        if (res.ok) {
          saved++;
          console.log('[watch] 新文件已入库:', f);
        }
      } catch (err) {
        console.error('[watch] 入库失败', f, err?.message || err);
      }
    });
    if (saved) {
      console.log(`[watch] 本次自动登记 ${saved} 张`);
      liveBus.emit('library-changed', { added: saved });
    }
  }, delayMs);
}

/** 开始/更新素材文件夹监听（storageDir 变更后重复调用即可换目标） */
export function watchStorageDir() {
  const settings = getSettings();
  const dir = settings.storageDir || '';
  // 关掉监控就把监听摘了（不然回调里还得每次判断，而且句柄一直占着目录）
  if (!dir || settings.watchEnabled === false) {
    closeWatcher();
    return;
  }
  if (watcher && watchedDir === dir) return;
  closeWatcher();
  // 重挂 = 换库/换目录：作废上一个目录积累的变化事件，
  // 否则旧目录的积压会被防抖回调 ingest 进当前库（跨库串图的根源）
  watchPending.clear();
  const gen = getLibraryGeneration();
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      // 开关随时可能被改：回调里再确认一次，避免关掉之后仍有排队事件入库
      if (getSettings().watchEnabled === false) return;
      const full = path.join(dir, filename);
      if (!EXTS.has(path.extname(full).toLowerCase())) return;
      // 跳过回收站 / 缩略图 / 库数据目录（.tuku）/ 资产目录（.library）等内部目录。
      // 这一条尤其关键：库数据默认就在素材文件夹里，监听不过滤的话
      // 每写一张缩略图就触发一轮回扫
      if (isSkippedPath(full)) return;
      watchPending.set(full, gen);
      scheduleWatchIngest();
    });
    watchedDir = dir;
    console.log('[watch] 正在监听素材文件夹:', dir);
  } catch (err) {
    console.error('[watch] 监听失败', err?.message || err);
  }
}

/** 找出图库中已经不在磁盘上的记录（带缩略图路径，清理时要用） */
export function findMissing() {
  const rows = db.prepare('SELECT id, abs_path, size_bytes, thumb FROM images').all();
  return rows.filter((r) => !fs.existsSync(r.abs_path));
}

/**
 * 异步版缺失检查：并发 access 逐行探测，不阻塞事件循环。
 * 同步版在全表上逐行 existsSync，万级库会把事件循环卡住数秒
 * （Windows + 杀软 hook 放大更明显），期间所有 API 排队 —— 表现为打开软件后卡很久。
 */
export async function findMissingAsync(concurrency = 64) {
  const rows = db.prepare('SELECT id, abs_path FROM images').all();
  const missing = [];
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        await fsp.access(row.abs_path);
      } catch {
        missing.push(row);
      }
    }
  }
  const n = Math.min(concurrency, rows.length);
  await Promise.all(Array.from({ length: n }, worker));
  return { count: missing.length, ids: missing.map((m) => m.id) };
}

/* /api/library/missing 是前端首屏必拉接口：结果缓存（并发请求共享同一 promise），
 * 导入完成 / 清理 / 重定位后主动失效，60s 兜底过期。 */
let missingCache = null;
let missingAt = 0;
export function invalidateMissingCache() {
  missingCache = null;
  missingAt = 0;
}
export function getMissingCached(maxAgeMs = 60_000) {
  if (!missingCache || Date.now() - missingAt > maxAgeMs) {
    missingAt = Date.now();
    missingCache = findMissingAsync().catch(() => ({ count: 0, ids: [] }));
  }
  return missingCache;
}

/**
 * 清理「磁盘上已不存在」的记录。
 *
 * 不能只 DELETE 行：缩略图会变成孤儿文件，更严重的是内存里的 pHash 索引还留着
 * 已删除的 id —— 后续查重会拿这些幽灵 id 与新图比较，把刚导入的同一张图判成
 * 「重复」并连文件一起删掉。所以删除行之后必须同步摘索引、删缩略图。
 */
export function purgeMissing() {
  const missing = findMissing();
  if (!missing.length) {
    invalidateMissingCache();
    return 0;
  }
  const del = db.prepare('DELETE FROM images WHERE id = ?');
  withTransaction(() => {
    for (const row of missing) del.run(row.id);
  });
  for (const row of missing) {
    if (row.thumb) {
      try {
        fs.rmSync(row.thumb, { force: true });
      } catch {
        /* 缩略图删不掉不影响记录已清理 */
      }
    }
    removePhash(row.id);
    clip.deleteEmbedding(row.id);
    invalidateQuality(row.id);
  }
  invalidateMissingCache();
  return missing.length;
}

/**
 * 尝试找回丢失的图片：用户可能只是移动/更换了保存文件夹。
 * 按文件名在当前保存目录中搜索，文件大小一致或唯一匹配时修复路径。
 */
export async function relocateMissing() {
  const missing = findMissing();
  if (!missing.length) return { relocated: 0, remaining: 0 };

  const byName = new Map(); // 文件名(小写) -> [{ absPath, size }]
  for (const file of scanLocalImages([getSettings().storageDir || LEGACY_DIRS[0]])) {
    let size = 0;
    // 异步 stat：大目录里几千个文件用 statSync 会把事件循环按住
    try {
      size = (await fsp.stat(file)).size;
    } catch {}
    const key = path.basename(file).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ absPath: file, size });
  }
  // 已被其他记录占用的路径不能指过去，否则会出现两条记录指向同一文件
  const usedPaths = new Set(
    db.prepare('SELECT abs_path FROM images').all().map((r) => r.abs_path)
  );

  const upd = db.prepare('UPDATE images SET abs_path = ? WHERE id = ?');
  let relocated = 0;
  for (const row of missing) {
    const candidates = (byName.get(path.basename(row.abs_path).toLowerCase()) || []).filter(
      (c) => !usedPaths.has(c.absPath)
    );
    if (!candidates.length) continue;
    const match =
      candidates.find((c) => c.size && c.size === row.size_bytes) ||
      (candidates.length === 1 ? candidates[0] : null);
    if (!match) continue;
    // 内容校验：同名同大小的文件仍可能是两张完全不同的图（IMG_0001.jpg 这类批量命名）。
    // 以前唯一候选就直接改路径，库里会出现「张冠李戴」——宁可留着待人工确认。
    if (row.md5) {
      const actual = await md5File(match.absPath).catch(() => '');
      if (actual && actual !== row.md5) continue;
    }
    upd.run(match.absPath, row.id);
    usedPaths.add(match.absPath);
    relocated++;
  }
  invalidateMissingCache();
  return { relocated, remaining: findMissing().length };
}
