import path from 'node:path';
import fs from 'node:fs';
import { globalDb, openLibrary, setActiveLibrary, getActiveLibrary, getSettings, saveSettings } from './db.js';
import { resetPrivacy } from './lib/privacy.js';
import { DATA_DIR } from './config.js';
import { watchStorageDir, cancelLocalImport } from './importer.js';
import { initPhashIndex } from './library.js';
import { clearThumbQueue } from './lib/thumb-queue.js';
import { clearPreviewQueue } from './lib/preview-queue.js';
import { resetVecCache } from './clip.js';
import { applyProxy } from './network.js';

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
 *  库数据默认放在素材文件夹下的隐藏目录 .tuku/lib_xxx/ —— 库跟着素材走
 *  （Eagle 的 xxx.library 同一个思路），整个素材目录拷走就带走了库。
 *  想分开存放就传 libFolder，按其指定位置建。 */
export function createLibrary({ name, rootPath, libFolder }) {
  const libName = String(name || '').trim();
  const root = String(rootPath || '').trim();
  const libDir = String(libFolder || '').trim();
  if (!libName) throw new Error('资源库名称不能为空');
  if (!root && !libDir) throw new Error('请选择素材文件夹');
  // 默认：数据库 / 缩略图落在 <素材文件夹>/.tuku/ 里。
  // 以前建库要用户填「库数据目录」+「素材根目录」两个路径，可这两件事在用户脑子里
  // 就是同一个问题（我的图放哪），只有实现者才需要区分。
  const dataBase = libDir ? path.resolve(libDir) : path.join(path.resolve(root), '.tuku');
  // 库目录用 ASCII 名（node:sqlite 在 Windows 中文路径下有句柄泄漏 bug，中文库目录无法删除）。
  // 显示名 name 仍为中文；目录名 = 库名中的 ASCII 字符 + 时间戳，保证唯一且可整体删除。
  const asciiBase = libName.replace(/[^a-zA-Z0-9_-]/g, '') || 'lib';
  const dirName = `${asciiBase}_${Date.now().toString(36)}`;
  const dir = path.join(dataBase, dirName);
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
    .run(libName, dir, root ? path.resolve(root) : '', thumbDir, now);
  return Number(info.lastInsertRowid);
}

/**
 * 当前库身份（详情面板 / 顶栏用）。
 * 永远返回一个对象：内存里的 activeLibrary 在启动早期、切库瞬间、以及异常路径下都可能
 * 还没就绪，此时回落到注册表，再回落到设置里的素材目录。之前这里返回 null，
 * 前端「所属资源库」就显示成「—」，用户不知道图到底进了哪个库。
 */
export function currentLibraryInfo() {
  const mem = getActiveLibrary();
  const lib =
    mem ||
    globalDb.prepare('SELECT id, name, path, root_path FROM libraries WHERE is_active = 1').get() ||
    globalDb.prepare('SELECT id, name, path, root_path FROM libraries ORDER BY id LIMIT 1').get() ||
    null;
  const settings = getSettings();
  if (lib) {
    return {
      id: String(lib.id),
      name: lib.name || '默认图库',
      // root_path 才是「图片存在哪」；为空时退回素材目录，最后才是库自身目录
      path: lib.root_path || settings.storageDir || lib.path || '',
    };
  }
  // 注册表为空（首次启动迁移中途）也不能显示空：直接按设置里的素材目录兜底
  return { id: '', name: '默认图库', path: settings.storageDir || '' };
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
  // 旧库排队的补图任务必须清掉：它们是按旧库的 id 排的，继续跑会拿这些 id
  // 往新库的 thumbs 目录里写文件（缩略图张冠李戴，且永远清理不掉）
  clearThumbQueue();
  clearPreviewQueue();
  // 内存索引随库重建：pHash 索引 / CLIP 向量缓存若残留上个库的数据，
  // 新库导入会被旧库的哈希/向量误判成重复（ingest 甚至会按旧库 id 删图）
  initPhashIndex();
  resetVecCache();
  // 隐私夹的解锁状态是「按文件夹 id」记的：换库后 id 会撞，必须清空，否则新库里同名 id 白给看
  resetPrivacy();
  // 把当前库的素材根目录同步到 settings.storageDir（importer / library 都读它）
  saveSettings({ storageDir: lib.root_path || '' });
  // 素材文件夹变了，重挂 fs.watch 监听目标
  watchStorageDir();
  // 网络代理也是按库独立的设置：切库后让 Chromium 网络栈应用新库的代理配置
  applyProxy().catch(() => {});
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
    // 库目录默认建在素材文件夹的 .tuku/ 下：库都删完了就把这个空壳也收掉，
    // 别在用户素材目录里留下一个空文件夹（还删不掉，看着像垃圾）
    const parent = path.dirname(libDir);
    if (path.basename(parent).toLowerCase() === '.tuku') {
      try {
        fs.rmdirSync(parent);
      } catch {
        /* 还有别的库在共用，保留 */
      }
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
