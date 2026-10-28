import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_DIRS } from './config.js';
import { db, getSettings, getLibraryGeneration } from './db.js';
import { ingest, resyncImageMeta } from './library.js';
import { bulkImportLocal } from './bulk-import.js';

const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'app',
  'dist',
  'storage',
  'trash',
  'data',
  'thumbs',
  '.codebuddy',
  'system volume information',
  '$recycle.bin',
]);
const MAX_DEPTH = 4;

/** 递归扫描壁纸库文件夹下的所有图片 */
export function scanLocalImages(dirs = LEGACY_DIRS, depth = 0) {
  const files = [];
  if (depth > MAX_DEPTH) return files;
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
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        files.push(...scanLocalImages([full], depth + 1));
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
const watchPending = new Set();
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
    const files = [...watchPending].filter((f) => fs.existsSync(f));
    watchPending.clear();
    if (!files.length) return;
    const settings = getSettings();
    const knownRows = new Map(
      db.prepare('SELECT id, abs_path FROM images').all().map((r) => [r.abs_path, r.id])
    );
    // 监听回调是延迟执行的（防抖 2s）：期间可能已经切了库，
    // 这些文件属于旧库，不能写进新库
    const generation = getLibraryGeneration();
    let saved = 0;
    await mapLimit(files, 3, async (f) => {
      if (generation !== getLibraryGeneration()) return;
      // 已登记的文件被手动替换 / 修改：重新同步元数据（宽高、pHash、特征、缩略图）
      const knownId = knownRows.get(f);
      if (knownId) {
        if (await resyncImageMeta(knownId)) {
          saved++;
          console.log('[watch] 文件已更新，元数据已同步:', f);
        }
        return;
      }
      const folder = path.basename(path.dirname(f));
      try {
        const res = await ingest(
          {
            absPath: f,
            source: folder === 'raw' ? 'bing' : 'local',
            keyword: folder === 'raw' ? '邓紫棋' : '壁纸库',
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
    if (saved) console.log(`[watch] 本次自动登记 ${saved} 张`);
  }, delayMs);
}

/** 开始/更新素材文件夹监听（storageDir 变更后重复调用即可换目标） */
export function watchStorageDir() {
  const dir = getSettings().storageDir || '';
  if (!dir) return;
  if (watcher && watchedDir === dir) return;
  closeWatcher();
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const full = path.join(dir, filename);
      if (!EXTS.has(path.extname(full).toLowerCase())) return;
      // 跳过回收站 / 缩略图等内部目录
      const parts = full.toLowerCase().split(/[\\/]/);
      if (parts.some((p) => SKIP_DIRS.has(p))) return;
      watchPending.add(full);
      scheduleWatchIngest();
    });
    watchedDir = dir;
    console.log('[watch] 正在监听素材文件夹:', dir);
  } catch (err) {
    console.error('[watch] 监听失败', err?.message || err);
  }
}

/** 找出图库中已经不在磁盘上的记录 */
export function findMissing() {
  const rows = db.prepare('SELECT id, abs_path, size_bytes FROM images').all();
  return rows.filter((r) => !fs.existsSync(r.abs_path));
}

export function purgeMissing() {
  const missing = findMissing();
  const del = db.prepare('DELETE FROM images WHERE id = ?');
  for (const row of missing) del.run(row.id);
  return missing.length;
}

/**
 * 尝试找回丢失的图片：用户可能只是移动/更换了保存文件夹。
 * 按文件名在当前保存目录中搜索，文件大小一致或唯一匹配时修复路径。
 */
export function relocateMissing() {
  const missing = findMissing();
  if (!missing.length) return { relocated: 0, remaining: 0 };

  const byName = new Map(); // 文件名(小写) -> [{ absPath, size }]
  for (const file of scanLocalImages([getSettings().storageDir || LEGACY_DIRS[0]])) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
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
    upd.run(match.absPath, row.id);
    usedPaths.add(match.absPath);
    relocated++;
  }
  return { relocated, remaining: findMissing().length };
}
