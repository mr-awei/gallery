// 资源库的「出口」：备份（可恢复的完整快照）、元数据导出（JSON / CSV）、
// 恢复备份、从 Eagle .library 迁移进来。
//
// 为什么是「备份到文件夹」而不是 zip：百万级图库的 thumbs 可能有几 GB，
// 打成 zip 要么爆内存（jszip）要么长时间占 CPU；拷贝文件夹可以边拷边报进度，
// 用户也能直接把这个文件夹丢进网盘。想压缩自己右键压缩即可。
import fs from 'node:fs';
import path from 'node:path';
import { assertWritableDir } from './safe-path.js';
import * as lib from '../library.js';
import { DatabaseSync } from 'node:sqlite';
import { db, getSettings, globalDb } from '../db.js';
import { createLibrary, getActiveLibrary, getLibrary } from '../libraries.js';
import { addImagesToFolder, createVirtualFolder } from '../folders.js';

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* 忽略读不到的 */
        }
      }
    }
  };
  walk(dir);
  return total;
}

function counts() {
  const one = (sql) => Number(db.prepare(sql).get()?.n || 0);
  return {
    images: one('SELECT COUNT(*) AS n FROM images'),
    folders: one('SELECT COUNT(*) AS n FROM folders'),
    tags: one('SELECT COUNT(DISTINCT tag) AS n FROM item_tags'),
    playlists: one('SELECT COUNT(*) AS n FROM playlists'),
    actions: one('SELECT COUNT(*) AS n FROM actions'),
    ocr: one('SELECT COUNT(*) AS n FROM image_ocr'),
  };
}

function collectMeta() {
  const folders = db
    .prepare('SELECT id, name, parent_id, anchor_path, sort_order FROM folders ORDER BY sort_order, id')
    .all();
  // 注意：images 表没有 deleted_at（删除是移到 trash 表，行本身就没删），也没有 page_url；
  // 文件夹归属在 image_folders 关联表里。按真实 schema 查，别照直觉猜列名。
  const images = db
    .prepare(
      `SELECT i.id, i.abs_path, i.title, i.keyword, i.note, i.rating, i.width, i.height, i.size_bytes,
              i.source, i.source_url, i.created_at, i.tags,
              (SELECT group_concat(folder_id, ',') FROM image_folders f WHERE f.image_id = i.id) AS folderIds,
              (SELECT o.text FROM image_ocr o WHERE o.image_id = i.id) AS ocr
         FROM images i
        ORDER BY i.id`
    )
    .all();
  const tags = db
    .prepare('SELECT tag, COUNT(*) AS n FROM item_tags GROUP BY tag ORDER BY n DESC')
    .all();
  return { folders, images, tags };
}

/** 备份当前资源库到目标文件夹下的一个新目录，返回清单 */
export function backupLibrary({ targetDir, includeThumbs = true } = {}) {
  const dir = assertWritableDir(targetDir, '备份位置');
  if (!dir) throw new Error('请先选择备份位置');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const active = getActiveLibrary();
  const name = String(active?.name || '图库').replace(/[\\/:*?"<>|]/g, '_');
  const outDir = path.join(dir, `${name}-backup-${stamp()}`);
  fs.mkdirSync(outDir, { recursive: true });

  // VACUUM INTO 会写出一个已经 checkpoint 过的干净库文件，比直接拷 .db 安全
  const dbOut = path.join(outDir, 'gallery.db');
  const escaped = dbOut.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);

  const meta = collectMeta();
  const payload = {
    schema: 1,
    app: 'TuKu',
    exportedAt: new Date().toISOString(),
    name: active?.name || '图库',
    rootPath: active?.root_path || '',
    counts: { images: meta.images.length, folders: meta.folders.length, tags: meta.tags.length },
    settings: {
      // 只带「可复原的展示偏好」，绝不导出 Cookie / API Key / 代理账号
      storageDir: getSettings().storageDir || '',
    },
    folders: meta.folders,
    tags: meta.tags,
    images: meta.images,
  };
  fs.writeFileSync(path.join(outDir, 'library.json'), JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'README.txt'),
    [
      '图库资源库备份',
      '',
      `导出时间：${payload.exportedAt}`,
      `素材数量：${payload.counts.images}`,
      '',
      '内容说明：',
      '  gallery.db    图库数据库（文件夹/标签/注释/评分/OCR/动作等全部元数据）',
      '  library.json  可读的元数据清单（图片绝对路径、标签、文件夹归属）',
      '  thumbs/       缩略图（可删，软件会按需重建）',
      '',
      '恢复方式：设置 → 数据与维护 → 从备份恢复，选择这个文件夹。',
      '原图不包含在备份里：原图一直在你自己的素材文件夹中。',
    ].join('\r\n'),
    'utf8'
  );

  let thumbs = 0;
  if (includeThumbs && active?.thumb_dir && fs.existsSync(active.thumb_dir)) {
    const dest = path.join(outDir, 'thumbs');
    fs.mkdirSync(dest, { recursive: true });
    // 缩略图是分桶目录（thumbs/ab/cd/...），整体递归复制
    fs.cpSync(active.thumb_dir, dest, { recursive: true });
    thumbs = dirSize(dest);
  }

  const size = dirSize(outDir);
  return {
    ok: true,
    dir: outDir,
    bytes: size,
    thumbsBytes: thumbs,
    counts: payload.counts,
    note: '原图不在备份里（它们一直在你的素材文件夹），备份包含全部元数据与缩略图',
  };
}

export function backupPreview() {
  const active = getActiveLibrary();
  const meta = counts();
  return {
    ok: true,
    library: { id: active?.id, name: active?.name, rootPath: active?.root_path || '', dbPath: active?.path || '' },
    counts: meta,
    thumbsBytes: active?.thumb_dir && fs.existsSync(active.thumb_dir) ? dirSize(active.thumb_dir) : 0,
    storageDir: getSettings().storageDir || '',
  };
}

export function exportMetadataJson() {
  const meta = collectMeta();
  return {
    schema: 1,
    app: 'TuKu',
    exportedAt: new Date().toISOString(),
    library: { name: getActiveLibrary()?.name, rootPath: getActiveLibrary()?.root_path || '' },
    ...meta,
  };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportMetadataCsv() {
  const { images } = collectMeta();
  const head = ['id', '标题', '标签', '宽', '高', '字节', '评分', '来源', '原始地址', '创建时间', '备注', '文件夹ID', '图内文字', '文件路径'];
  const lines = [head.join(',')];
  for (const r of images) {
    lines.push(
      [
        r.id,
        r.title,
        r.tags || '',
        r.width,
        r.height,
        r.size_bytes,
        r.rating,
        r.source,
        r.source_url,
        r.created_at,
        r.note,
        r.folderIds || '',
        r.ocr || '',
        r.abs_path,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  // Excel 打开 UTF-8 CSV 需要 BOM，否则中文全是乱码
  return '\ufeff' + lines.join('\r\n');
}

/** 备份格式版本：改结构时递增；恢复时拒绝「比当前应用更新」的备份 */
const BACKUP_SCHEMA = 1;

/**
 * 只读打开备份里的 gallery.db 做完整性检查。
 * 必须在覆盖任何现有数据**之前**做：坏包一旦写进去，得到的是一个打不开、
 * 又已经在库列表里登记好的半成品库。
 */
function assertBackupDbUsable(file) {
  let conn = null;
  try {
    conn = new DatabaseSync(file, { readOnly: true });
    const check = conn.prepare('PRAGMA integrity_check').get() || {};
    const value = String(Object.values(check)[0] ?? '').toLowerCase();
    if (value !== 'ok') throw new Error(`备份数据库损坏（${value || '未知原因'}）`);
    const images = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'images'")
      .get();
    if (!images) throw new Error('备份里没有 images 表，不像是图库数据库');
  } catch (err) {
    if (/损坏|images 表/.test(String(err?.message))) throw err;
    throw new Error(`备份数据库无法打开：${err?.message || err}`, { cause: err });
  } finally {
    try {
      conn?.close();
    } catch {
      /* 只读连接关不掉不影响结论 */
    }
  }
}

/**
 * 从备份目录恢复成一个「新资源库」（不动当前库）。
 * 素材根目录变了的话，按备份里记录的 rootPath 做前缀重映射。
 *
 * 三道保护：
 * 1. 恢复到新库之前校验版本号与 PRAGMA integrity_check；
 * 2. 任何一步失败都回滚（删注册表行 + 删目录），不留半成品；
 * 3. 路径重映射放在事务里，失败整体回滚。
 */
export function restoreLibrary({ sourceDir, name, rootPath } = {}) {
  const src = String(sourceDir || '').trim();
  if (!src || !fs.existsSync(src)) throw new Error('备份文件夹不存在');
  const dbFile = path.join(src, 'gallery.db');
  const metaFile = path.join(src, 'library.json');
  if (!fs.existsSync(dbFile)) throw new Error('这个文件夹里没有 gallery.db，不像是图库备份');

  let meta = {};
  if (fs.existsSync(metaFile)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      throw new Error('library.json 已损坏，无法确认备份来源与版本');
    }
  }
  const schema = Number(meta.schema || 0);
  if (schema > BACKUP_SCHEMA) {
    throw new Error(`这个备份来自更新的版本（格式 ${schema}），请先升级应用再恢复`);
  }
  assertBackupDbUsable(dbFile);

  const root = assertWritableDir(String(rootPath || meta.rootPath || '').trim(), '素材文件夹');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const libName = String(name || meta.name || '恢复的图库').trim();
  const id = createLibrary({ name: libName, rootPath: root });
  const created = getLibrary(id);

  try {
    const targetDb = path.join(created.path, 'gallery.db');
    // createLibrary 只是建了空库并关了连接，这里用备份覆盖它
    fs.copyFileSync(dbFile, targetDb);
    for (const f of ['gallery.db-wal', 'gallery.db-shm']) {
      fs.rmSync(path.join(created.path, f), { force: true });
    }

    let thumbs = 0;
    const thumbsSrc = path.join(src, 'thumbs');
    if (fs.existsSync(thumbsSrc)) {
      fs.cpSync(thumbsSrc, created.thumb_dir, { recursive: true });
      thumbs = dirSize(created.thumb_dir);
    }

    // 素材根目录换过（换机器/换盘符）时，把库里的绝对路径前缀整体重映射，
    // 否则恢复出来的库每张图都指向旧机器上的路径。
    const oldRoot = String(meta.rootPath || '').trim();
    let remapped = 0;
    let missing = 0;
    if (oldRoot && path.resolve(oldRoot) !== path.resolve(root)) {
      const conn = new DatabaseSync(targetDb);
      try {
        const rows = conn.prepare('SELECT id, abs_path FROM images').all();
        const upd = conn.prepare('UPDATE images SET abs_path = ? WHERE id = ?');
        conn.exec('BEGIN');
        try {
          for (const r of rows) {
            const p = String(r.abs_path || '');
            if (!p) continue;
            // 必须按「路径段」判断前缀：裸 startsWith 会把 D:\素材备份\x.jpg 误判成
            // D:\素材 之下，拼成 新根\备份\x.jpg 这种不存在的路径（恢复后大面积为空）。
            // path.relative 同时处理分隔符与 Windows 大小写。
            const rel = path.relative(path.resolve(oldRoot), path.resolve(p));
            if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
            const next = path.join(root, rel);
            upd.run(next, r.id);
            remapped += 1;
            if (!fs.existsSync(next)) missing += 1;
          }
          conn.exec('COMMIT');
        } catch (err) {
          try {
            conn.exec('ROLLBACK');
          } catch {
            /* 事务可能已经结束 */
          }
          throw err;
        }
      } finally {
        conn.close();
      }
    }

    return {
      ok: true,
      id,
      name: libName,
      rootPath: root,
      dbPath: targetDb,
      thumbsBytes: thumbs,
      counts: meta.counts || null,
      remapped,
      missing,
      schema,
      note: '已作为新资源库登记；切换过去即可使用。原图需位于素材文件夹中',
    };
  } catch (err) {
    // 回滚：注册表行与目录一起清掉，避免留下「打不开也删不掉」的库
    try {
      globalDb.prepare('DELETE FROM libraries WHERE id = ?').run(id);
      fs.rmSync(created.path, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error('[restore] 回滚半成品库失败', id, cleanupErr?.message || cleanupErr);
    }
    throw err;
  }
}

/** 读 JSON 文件，坏了就返回兜底值（Eagle 的 metadata 偶尔会写一半） */
function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Eagle 的文件夹树在 .library/metadata.json 的 folders 里，可能是嵌套 children，
 * 也可能是扁平 parent_id。两种都展开成 id → { name, parentId }。
 */
function collectEagleFolders(rootMeta) {
  const map = new Map();
  const walk = (arr, parentId = null) => {
    if (!Array.isArray(arr)) return;
    for (const f of arr) {
      if (!f || !f.id || f.id === '' || f.id === undefined || f.id === null) continue;
      const id = String(f.id);
      const pid = f.parent_id ?? f.parentId ?? parentId;
      map.set(id, { name: String(f.name || '未命名'), parentId: pid == null ? null : String(pid) });
      if (Array.isArray(f.children)) walk(f.children, id);
      if (Array.isArray(f.folders)) walk(f.folders, id);
    }
  };
  walk(rootMeta?.folders);
  return map;
}

/** Eagle 文件夹 id → 从根到叶的名称数组（带环保护，坏数据不会死循环） */
function eagleFolderNames(map, id) {
  const names = [];
  const seen = new Set();
  let cur = id == null ? '' : String(id);
  while (cur && map.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const f = map.get(cur);
    names.unshift(f.name);
    cur = f.parentId == null ? '' : String(f.parentId);
  }
  return names;
}

/**
 * 从 Eagle .library 完整迁移：素材本体、文件夹树、标签、评分、备注、来源地址、创建时间。
 *
 * Eagle 的存储：`images/<id>.info/` 里放原图 + metadata.json（name/tags/folders/
 * annotation/url/star/btime/isDeleted…），库级 `metadata.json` 里放 folders 树。
 * 迁移策略：
 * - 原图复制到本库素材文件夹（扁平，同名自动加后缀），文件名保持 Eagle 原样
 * - 文件夹按 Eagle 的层级建成本库的虚拟文件夹，并建立「图 ↔ 夹」多对多关联
 * - 用 images.eagle_id 记录来源素材 id，重复点「开始迁移」只会补漏，不会产生副本
 * - 每轮默认最多处理 limit 个（默认 1000，够快也不会让 HTTP 请求挂太久），
 *   返回值里的 remaining 表示还有多少没迁，前端提示再点一次继续
 */
export async function importEagleLibrary({ srcDir, name, rootPath, limit } = {}) {
  const src = String(srcDir || '').trim();
  if (!src || !fs.existsSync(src)) throw new Error('Eagle 资源库目录不存在');
  const imagesDir = path.join(src, 'images');
  if (!fs.existsSync(imagesDir)) throw new Error('这个目录下没有 images/，不是 Eagle 资源库（.library）');
  const root = String(rootPath || getSettings().storageDir || '').trim();
  if (!root) throw new Error('请先设置素材文件夹');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const allInfos = fs
    .readdirSync(imagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('.info'))
    .map((d) => path.join(imagesDir, d.name));
  if (!allInfos.length) throw new Error('images/ 里没有 *.info 目录，可能不是 Eagle 4 资源库');

  const rootMeta = readJsonSafe(path.join(src, 'metadata.json'), {});
  const eagleFolders = collectEagleFolders(rootMeta);
  const perRun = Math.max(1, Number(limit) || 1000);
  const infos = allInfos.slice(0, perRun);

  const result = {
    ok: true,
    total: allInfos.length,
    processed: 0,
    imported: 0,
    skipped: 0,
    existing: 0,
    failed: 0,
    folders: 0,
    remaining: Math.max(0, allInfos.length - infos.length),
    items: [],
    errors: [],
  };
  const mediaExt = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|svg|mp4|mov|webm|mkv|mp3|wav|flac|pdf|psd|ai|sketch|fig|ttf|otf|woff2?|glb|gltf|obj|fbx|stl|zip|epub)$/i;

  // 路径 → 本库 folder id 缓存：同一个夹下的成百上千张只查一次
  const folderCache = new Map();
  const ensureFolderPath = (names) => {
    let parentId = null;
    let key = '';
    for (const nm of names) {
      key += `/${nm}`;
      if (folderCache.has(key)) {
        parentId = folderCache.get(key);
        continue;
      }
      const row = db
        .prepare('SELECT id FROM folders WHERE name = ? AND IFNULL(parent_id, 0) = ?')
        .get(nm, parentId ?? 0);
      const id = row ? Number(row.id) : createVirtualFolder(nm, parentId);
      if (!row) result.folders += 1;
      folderCache.set(key, id);
      parentId = id;
    }
    return parentId;
  };

  const existsStmt = db.prepare("SELECT id FROM images WHERE eagle_id = ? AND eagle_id <> '' LIMIT 1");
  const patchStmt = db.prepare('UPDATE images SET eagle_id = ?, rating = ?, created_at = ? WHERE id = ?');

  for (const dir of infos) {
    result.processed += 1;
    const eagleId = path.basename(dir).replace(/\.info$/i, '');
    const meta = readJsonSafe(path.join(dir, 'metadata.json'), {});
    // Eagle 的回收站素材（isDeleted）不迁，避免把已删的东西又搬回来
    if (meta.isDeleted || meta.deletedTime) {
      result.skipped += 1;
      continue;
    }
    if (existsStmt.get(eagleId)) {
      result.existing += 1;
      continue;
    }
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => mediaExt.test(f) && !f.startsWith('.'));
    } catch {
      result.failed += 1;
      result.errors.push(`${eagleId}: 读不到素材目录`);
      continue;
    }
    if (!files.length) {
      result.skipped += 1;
      continue;
    }
    // 选体积最大的那个：Eagle 的 .info 里可能同时有缩略图与原图
    let pick = files[0];
    let maxSize = -1;
    for (const f of files) {
      try {
        const s = fs.statSync(path.join(dir, f)).size;
        if (s > maxSize) {
          maxSize = s;
          pick = f;
        }
      } catch {
        /* 读不到就跳过 */
      }
    }
    const srcFile = path.join(dir, pick);
    let finalDest = path.join(root, path.basename(pick));
    if (fs.existsSync(finalDest)) {
      const base = path.parse(pick).name;
      const ext = path.extname(pick);
      let n = 2;
      while (fs.existsSync(path.join(root, `${base}-${n}${ext}`)) && n < 9999) n += 1;
      finalDest = path.join(root, `${base}-${n}${ext}`);
    }
    try {
      fs.copyFileSync(srcFile, finalDest);
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${pick}: ${err.message}`);
      continue;
    }
    const tags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean).map(String) : [];
    const r = await lib
      .ingest({
        absPath: finalDest,
        source: 'eagle',
        title: meta.name || path.parse(pick).name,
        tags: tags.join(','),
        sourceUrl: meta.url || '',
        // 迁库不是采集：Eagle 里的相似图/重复图都要原样保留下来
        skipPhashDupe: true,
      })
      .catch((err) => ({ ok: false, reason: err.message }));
    if (!r?.ok) {
      result.failed += 1;
      if (r?.reason) result.errors.push(`${pick}: ${r.reason}`);
      continue;
    }
    result.imported += 1;

    // 评分 / 创建时间 / 来源 id：ingest 没有这些入口，入库后补一次
    const rating = Math.max(0, Math.min(5, Math.round(Number(meta.star) || 0)));
    let createdAt = new Date().toISOString();
    const bt = Number(meta.btime || meta.creationTime || 0);
    if (Number.isFinite(bt) && bt > 0) {
      // Eagle 存的是毫秒时间戳；个别版本是秒
      const d = new Date(bt > 1e12 ? bt : bt > 1e9 ? bt * 1000 : bt);
      if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
    } else if (typeof meta.createdAt === 'string' && !Number.isNaN(Date.parse(meta.createdAt))) {
      createdAt = new Date(meta.createdAt).toISOString();
    }
    try {
      patchStmt.run(eagleId, rating, createdAt, r.id);
    } catch {
      /* 补字段失败不影响素材可用 */
    }
    // ingest 不接备注；Eagle 的 annotation 单独写进去
    if (meta.annotation) {
      try {
        lib.setNote(r.id, meta.annotation);
      } catch {
        /* 备注写失败不影响导入 */
      }
    }
    // 文件夹：Eagle 的 folders 是 id 数组，按库级树还原成层级
    const folderIds = Array.isArray(meta.folders) ? meta.folders : meta.folderId ? [meta.folderId] : [];
    for (const fid of folderIds) {
      const names = eagleFolderNames(eagleFolders, fid);
      if (!names.length) continue;
      try {
        const appFolderId = ensureFolderPath(names);
        if (appFolderId != null) addImagesToFolder(appFolderId, [r.id]);
      } catch {
        /* 单个文件夹建失败不影响素材 */
      }
    }
    if (result.items.length < 50) result.items.push({ id: r.id, title: meta.name || pick, folder: folderIds.length > 0 });
  }
  result.errors = result.errors.slice(0, 20);
  return result;
}
