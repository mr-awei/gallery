import path from 'node:path';
import fs from 'node:fs';
import { globalDb, openLibrary, setActiveLibrary, getActiveLibrary, saveSettings } from './db.js';
import { DATA_DIR } from './config.js';
import { watchStorageDir, cancelLocalImport } from './importer.js';
import { initPhashIndex } from './library.js';
import { resetVecCache } from './clip.js';

/**
 * 资源库管理：每个库是一个自包含目录（内含 gallery.db / thumbs/）。
 * - 默认库沿用历史 DATA_DIR/gallery.db（迁移时已登记，root = 旧 settings.storageDir）
 * - 新建库在用户指定的目录下建 gallery.db + thumbs/
 * - 切换库 = 换 DB 连接 + 同步 settings.storageDir + 重挂素材目录监听
 */

export function listLibraries() {
  return globalDb
    .prepare(
      'SELECT id, name, path, root_path, thumb_dir, created_at, last_opened, is_active FROM libraries ORDER BY id ASC'
    )
    .all()
    .map((l) => ({ ...l, deletable: path.resolve(l.path) !== path.resolve(DATA_DIR) }));
}

export function getLibrary(id) {
  return globalDb
    .prepare('SELECT id, name, path, root_path, thumb_dir, created_at, last_opened, is_active FROM libraries WHERE id = ?')
    .get(id);
}

/** 新建一个资源库（不切换），返回新库 id。
 *  无论用户选择的是盘符根还是具体目录，都在所选位置下自动创建
 *  与库名同名的子目录作为库目录，避免 gallery.db / thumbs 直接落进所选目录。 */
export function createLibrary({ name, rootPath, libFolder }) {
  const libName = String(name || '').trim();
  const libDir = String(libFolder || '').trim();
  if (!libName) throw new Error('资源库名称不能为空');
  if (!libDir) throw new Error('资源库位置不能为空');
  // 库目录用 ASCII 名（node:sqlite 在 Windows 中文路径下有句柄泄漏 bug，中文库目录无法删除）。
  // 显示名 name 仍为中文；目录名 = 库名中的 ASCII 字符 + 时间戳，保证唯一且可整体删除。
  const asciiBase = libName.replace(/[^a-zA-Z0-9_-]/g, '') || 'lib';
  const dirName = `${asciiBase}_${Date.now().toString(36)}`;
  const dir = path.join(path.resolve(libDir), dirName);
  fs.mkdirSync(dir, { recursive: true });
  const thumbDir = path.join(dir, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  // 打开即建表（幂等）后立即关闭，确保库结构就绪
  openLibrary(path.join(dir, 'gallery.db')).close();
  const now = new Date().toISOString();
  const info = globalDb
    .prepare(
      `INSERT INTO libraries(name, path, root_path, thumb_dir, created_at, is_active)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .run(libName, dir, rootPath || '', thumbDir, now);
  return Number(info.lastInsertRowid);
}

/** Settings 页修改当前库的素材根目录时，同步回库注册表（单一权威） */
export function setActiveRoot(rootPath) {
  const lib = getActiveLibrary();
  if (lib) {
    globalDb.prepare('UPDATE libraries SET root_path = ? WHERE id = ?').run(rootPath || '', lib.id);
  }
}

/** 激活（切换）到指定库 */
export function activateLibrary(id) {
  const lib = getLibrary(id);
  if (!lib) throw new Error('资源库不存在');
  const now = new Date().toISOString();
  globalDb.prepare('UPDATE libraries SET is_active = 0').run();
  globalDb.prepare('UPDATE libraries SET is_active = 1, last_opened = ? WHERE id = ?').run(now, id);
  // 先把上一个库遗留的扫描任务叫停：它是跨 await 的长任务，切库后继续跑会把
  // 旧库的图片写进新库（前端表现为新库里不断冒出别的库的图）
  cancelLocalImport();
  // 切连接 + 更新内存中的激活库元信息
  setActiveLibrary(lib);
  // 内存索引随库重建：pHash 索引 / CLIP 向量缓存若残留上个库的数据，
  // 新库导入会被旧库的哈希/向量误判成重复（ingest 甚至会按旧库 id 删图）
  initPhashIndex();
  resetVecCache();
  // 把当前库的素材根目录同步到 settings.storageDir（importer / library 都读它）
  saveSettings({ storageDir: lib.root_path || '' });
  // 素材文件夹变了，重挂 fs.watch 监听目标
  watchStorageDir();
  return lib;
}

/**
 * 删除资源库：从注册表移除，并删除库目录内的软件自建产物（gallery.db + 缩略图）。
 * 绝不触碰素材根目录（root_path）里的真实图片。默认库（path 即应用数据目录）不可删除。
 */
export function deleteLibrary(id) {
  const lib = getLibrary(id);
  if (!lib) throw new Error('资源库不存在');
  // 默认库的库目录就是应用数据目录（global.db 也在其中），删了会连全局配置一起丢
  if (path.resolve(lib.path) === path.resolve(DATA_DIR)) {
    throw new Error('默认资源库不可删除');
  }
  // 若删的是当前激活库，先切回默认库（关闭其连接，否则活跃连接占用待删文件）
  if (lib.is_active === 1) {
    const def =
      globalDb.prepare('SELECT id FROM libraries WHERE path = ?').get(DATA_DIR) ||
      globalDb.prepare('SELECT id FROM libraries ORDER BY id LIMIT 1').get();
    if (def && def.id !== id) activateLibrary(def.id);
  }
  globalDb.prepare('DELETE FROM libraries WHERE id = ?').run(id);
  // 文件删除放后台异步：thumbs 可能有上千个缩略图，同步 rmSync 会阻塞事件循环
  // 数秒（期间所有 API 无响应、前端统计/列表全部挂起）。接口立即返回，文件慢慢删。
  const libDir = lib.path;
  setTimeout(() => {
    for (const f of ['gallery.db', 'gallery.db-wal', 'gallery.db-shm']) {
      try {
        fs.rmSync(path.join(libDir, f), { force: true });
      } catch (err) {
        console.warn('[删库] 删除库文件失败', f, err?.message || err);
      }
    }
    try {
      fs.rmSync(path.join(libDir, 'thumbs'), { recursive: true, force: true });
    } catch (err) {
      console.warn('[删库] 删除缩略图目录失败', err?.message || err);
    }
    // 尝试删除已清空的库目录（ASCII 目录此时已空；历史中文库若残留文件则失败，无害）
    try {
      fs.rmdirSync(libDir);
    } catch {
      /* 非空则保留 */
    }
  }, 50);
  return { id, activeId: getActiveLibrary()?.id ?? null };
}

/**
 * 标记「当前库有扫描任务在进行 / 已结束」。
 * 进程被强杀（崩溃、断电、用户强关）时任务状态只存在内存里，重启后就丢了 ——
 * 但库里会留下「已登记但还没生成缩略图」的半截记录，以及一整批还没登记的文件。
 * 把标记落到库注册表，重启时才知道要接着扫，而不是无声无息地什么都不做。
 */
export function setImportPending(pending, libId = getActiveLibrary()?.id) {
  // 必须落到「任务启动时那个库」：切库会叫停旧库的扫描，若不指定 id 就会把
  // 新库的标记清掉、旧库的标记留着，下次白跑一次。
  if (!libId) return;
  globalDb.prepare('UPDATE libraries SET import_pending = ? WHERE id = ?').run(pending ? 1 : 0, libId);
}

/** 当前库上次扫描是否没跑完 */
export function isImportPending() {
  const lib = getActiveLibrary();
  if (!lib) return false;
  const row = globalDb.prepare('SELECT import_pending FROM libraries WHERE id = ?').get(lib.id);
  return Number(row?.import_pending) === 1;
}

export { getActiveLibrary };
