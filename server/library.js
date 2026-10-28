import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import jpegtranPkg from 'jpegtran-bin';
import { db, getSettings, getLibraryGeneration, withTransaction } from './db.js';
import { IMAGE_DIR } from './config.js';
import { linkImageByPath } from './folders.js';
import { computePHash, hammingHex } from './phash.js';
import * as clip from './clip.js';
import { getSharpness, invalidateQuality } from './quality.js';
import { scoreImage } from './kb.js';
import { aiModelOf, isAiModel, runUpscale, isCommunityModel, communityModelOf, cuganInstalled, listCuganModels } from './ai-upscale.js';
import { srModelOf, runSr } from './sr-deep.js';
import { httpFetch } from './http.js';
import { existingThumbPath, ensureThumbDirFor, thumbPathFor, removeThumbFiles } from './thumbs.js';

const jpegtran = typeof jpegtranPkg === 'string' ? jpegtranPkg : jpegtranPkg.default;

export const ALLOWED_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows 下刚写入的文件可能被杀毒软件短暂锁定，删除失败时重试 */
export async function removeFileRetry(p, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rm(p, { force: true });
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (i === attempts - 1) throw err;
      await sleep(120 * (i + 1));
    }
  }
  return false;
}

/** 标记为「已翻译」，避免被二次包装 */
function markFriendly(err) {
  err.friendly = true;
  return err;
}

const OCCUPIED_HINT = '请关闭正在打开这张图的程序（看图软件 / PS / 资源管理器的预览窗格），或临时关闭杀毒软件实时防护后重试。';

/** 把底层文件系统错误翻译成能看懂的中文提示 */
function friendlyFsError(err, target, action) {
  const code = err?.code || '';
  const name = target ? path.basename(target) : '';
  if (code === 'EBUSY' || code === 'UNKNOWN' || code === 'EPERM' || code === 'EACCES') {
    return markFriendly(new Error(`${action}失败：文件「${name}」正被其他程序占用或拒绝访问。${OCCUPIED_HINT}`));
  }
  if (code === 'ENOENT') return markFriendly(new Error(`${action}失败：文件「${name}」已不存在（可能被移动或删除）。`));
  if (code === 'ENOSPC') return markFriendly(new Error(`${action}失败：磁盘空间不足。`));
  if (code === 'EROFS') return markFriendly(new Error(`${action}失败：目标磁盘为只读。`));
  return markFriendly(new Error(`${action}失败：${err?.message || code || '未知错误'}`));
}

/** 读取阶段的失败（sharp / libvips 的报错对用户毫无意义，必须翻译） */
function friendlyReadError(err, target) {
  const name = target ? path.basename(target) : '';
  const m = String(err?.message || '');
  if (err?.code === 'ENOENT' || /no such file|cannot open/i.test(m)) {
    return markFriendly(new Error(`读取失败：文件「${name}」已不存在（可能被移动或删除）。`));
  }
  if (/unsupported image format|unable to open|VipsForeign|Input file|premature end|corrupt/i.test(m)) {
    return markFriendly(new Error(`读取失败：无法打开「${name}」——文件正被其他程序占用，或文件已损坏 / 不是有效图片。${OCCUPIED_HINT}`));
  }
  return markFriendly(new Error(`读取失败：${m}`));
}

/** 统一把底层异常翻译成可读提示 */
export function translateError(err, target) {
  if (err?.friendly) return err;
  if (err?.code) return friendlyFsError(err, target, '处理文件');
  const m = String(err?.message || '');
  if (/unsupported image format|unable to open|VipsForeign|Input file|premature end|corrupt|magick|sharp/i.test(m)) {
    return friendlyReadError(err, target);
  }
  return err;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 原子写回原文件：先写同目录临时文件，再改名覆盖。
 * 目的：
 *  1. 直接写原文件会先被截断，中途失败（被占用/断电/杀毒拦截）会把原图毁成 0 字节 —— 不可逆；
 *  2. 改名在 Windows 上是原子替换，失败时原图完好无损；
 *  3. 临时文件与改名都对常见的瞬时占用做重试。
 */
export async function writeFileAtomic(target, data, attempts = 5) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.gem-tmp-${process.pid}-${Date.now()}`);
  try {
    for (let i = 0; ; i++) {
      try {
        await fsp.writeFile(tmp, data);
        break;
      } catch (err) {
        if (i >= attempts - 1) throw friendlyFsError(err, target, '写入文件');
        await sleepMs(150 * (i + 1));
      }
    }
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(tmp, target);
        return;
      } catch (err) {
        if (i >= attempts - 1) throw friendlyFsError(err, target, '覆盖原图');
        await sleepMs(150 * (i + 1));
      }
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/** pHash 内存索引：id ↔ 64bit 拆成高低两个 Uint32，汉明距离用 16-bit 查表 popcount。
 *  旧实现 Map<id, hex>，每次比对 BigInt 异或 —— 百万库每张导入图要 100 万次 BigInt
 *  运算（秒级）；typed array + 查表版全程 Number 运算，同规模 ≈ 几十毫秒。 */
const phashIds = [];        // 槽位 → id（0 = 墓碑/空槽）
const phashLo = [];         // 槽位 → 低 32 位
const phashHi = [];         // 槽位 → 高 32 位
const phashSlot = new Map(); // id → 槽位
const phashFree = [];       // 可复用的墓碑槽

const POP16 = (() => {
  const t = new Uint8Array(65536);
  for (let i = 1; i < 65536; i++) t[i] = t[i >> 1] + (i & 1);
  return t;
})();

/** 16 位 hex 的 pHash → [lo, hi]；格式异常返回 null（旧实现会让整个查重抛错） */
function parsePhash64(hex) {
  const h = String(hex || '');
  if (!/^[0-9a-fA-F]{16}$/.test(h)) return null;
  return [parseInt(h.slice(8, 16), 16) >>> 0, parseInt(h.slice(0, 8), 16) >>> 0];
}

function hamming32(a, b) {
  const x = (a ^ b) >>> 0;
  return POP16[x & 0xffff] + POP16[x >>> 16];
}

function addPhash(id, hex) {
  const parts = parsePhash64(hex);
  if (!parts) return;
  const [lo, hi] = parts;
  let slot = phashFree.pop();
  if (slot === undefined) {
    slot = phashIds.length;
    phashIds.push(0);
    phashLo.push(0);
    phashHi.push(0);
  }
  phashIds[slot] = id;
  phashLo[slot] = lo;
  phashHi[slot] = hi;
  phashSlot.set(id, slot);
}

export function clearPhashIndex() {
  phashIds.length = 0;
  phashLo.length = 0;
  phashHi.length = 0;
  phashSlot.clear();
  phashFree.length = 0;
}

export function initPhashIndex() {
  clearPhashIndex();
  const rows = db.prepare('SELECT id, phash FROM images').all();
  for (const r of rows) {
    if (r.phash) addPhash(r.id, r.phash);
  }
  return phashSlot.size;
}

/** 供批量导入在写库后同步内存索引（等价于 ingest 里的 indexPhash） */
export function indexPhash(id, hex) {
  if (id && hex) addPhash(id, hex);
}

export function removePhash(id) {
  const slot = phashSlot.get(id);
  if (slot === undefined) return;
  phashIds[slot] = 0;
  phashSlot.delete(id);
  phashFree.push(slot);
}

export function findDuplicateByPhash(hex, threshold) {
  const target = parsePhash64(hex);
  if (!target) return null;
  const [tLo, tHi] = target;
  for (let i = 0; i < phashIds.length; i++) {
    const id = phashIds[i];
    if (!id) continue;
    let dist = hamming32(phashLo[i], tLo);
    if (dist > threshold) continue;
    dist += hamming32(phashHi[i], tHi);
    if (dist <= threshold) return id;
  }
  return null;
}

function extOf(format) {
  if (format === 'jpeg') return 'jpg';
  if (format === 'jpg') return 'jpg';
  return format || 'jpg';
}

const INVALID_CHARS = /[\\/:*?"<>|\r\n\t]/g;

/** 采集到的图片直接写入用户指定的本地文件夹，并使用可读文件名 */
export function resolveStorageDir(settings = getSettings()) {
  const dir = settings.storageDir || IMAGE_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildFileName({ keyword, source, width, height, format }) {
  const safe = (s) => String(s || '').replace(INVALID_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  // 6 位随机后缀：秒级时间戳 + 相同尺寸仍可能撞名（同一批两张不同图会生成同名文件，
  // 仅扩展名不同，曾被误当成「同名 jpg/png 同一张照片」）
  const suffix = crypto.randomBytes(3).toString('hex');
  const parts = [safe(keyword) || '邓紫棋', source, `${width}x${height}`, stamp, suffix];
  return `${parts.join('_')}.${extOf(format)}`;
}

/** 是否由本应用管理（可随图库一起删除）的文件 */
export function isManagedPath(p, settings = getSettings()) {
  if (!p) return false;
  const dirs = [IMAGE_DIR, settings.storageDir].filter(Boolean);
  return dirs.some((d) => p.startsWith(d));
}

export async function ensureThumb(id, absPath) {
  const target = existingThumbPath(id); // 桶内优先，兼容旧平铺
  if (target) return target;
  try {
    await ensureThumbDirFor(id);
    const target = thumbPathFor(id);
    await sharp(absPath, { failOn: 'none' })
      .rotate()
      .resize({ width: 640, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(target);
    return target;
  } catch (err) {
    console.error('[thumb] 生成缩略图失败', id, err.message);
    return null;
  }
}

/**
 * 物理旋转图片并写回原文件（其他软件打开即为旋转后的效果）
 * 关键：保持原画质——JPEG 走无损变换（仅调整角度，像素零损失），
 *      PNG/WebP 走无损编解码；只有尺寸不满足无损条件的 JPEG 才回退到 quality 100。
 * 同步更新宽高 / 文件大小 / pHash / 缩略图
 */
/** 物理旋转（对外入口）：统一把底层报错翻译成可读提示 */
export async function rotateImage(id, dir = 'cw') {
  const row = getImage(id);
  try {
    return await rotateImageInner(id, dir);
  } catch (err) {
    throw translateError(err, row?.abs_path);
  }
}

async function rotateImageInner(id, dir = 'cw') {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在');

  const angle = dir === 'ccw' ? -90 : 90;
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';

  let data;
  let info;

  if (format === 'jpeg') {
    // 无损旋转：不改像素，只改角度。要求宽高为 MCU 整数倍，否则回退 re-encode
    const tmp = `${row.abs_path}.rotated`;
    try {
      execFileSync(jpegtran, [
        '-rotate',
        String(angle === -90 ? 270 : 90),
        '-copy',
        'comments', // 丢弃 EXIF（含可能的 Orientation），避免部分软件二次旋转
        '-outfile',
        tmp,
        row.abs_path,
      ]);
      const buf = await fsp.readFile(tmp);
      const m = await sharp(buf, { failOn: 'none' }).metadata();
      data = buf;
      info = { width: m.width, height: m.height };
    } catch {
      // 极少数尺寸不满足无损条件的 JPEG：回退到最高质量重编码
      const r = await sharp(row.abs_path, { failOn: 'none' })
        .rotate(angle)
        .jpeg({ quality: 100, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      data = r.data;
      info = r.info;
    } finally {
      await removeFileRetry(tmp);
    }
  } else if (format === 'png') {
    const r = await sharp(row.abs_path, { failOn: 'none' })
      .rotate(angle)
      .png()
      .toBuffer({ resolveWithObject: true });
    data = r.data;
    info = r.info;
  } else if (format === 'webp') {
    const r = await sharp(row.abs_path, { failOn: 'none' })
      .rotate(angle)
      .webp({ lossless: true })
      .toBuffer({ resolveWithObject: true });
    data = r.data;
    info = r.info;
  } else {
    const r = await sharp(row.abs_path, { failOn: 'none' })
      .rotate(angle)
      .jpeg({ quality: 100, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    data = r.data;
    info = r.info;
  }

  await writeFileAtomic(row.abs_path, data);

  const newHash = await computePHash(data).catch(() => '');
  db.prepare('UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ? WHERE id = ?').run(
    info.width,
    info.height,
    data.length,
    newHash,
    id
  );
  if (newHash) indexPhash(id, newHash);
  if (clip.clipReady()) clip.reembed(id, row.abs_path); // 内容已改变，重建深度特征
  invalidateQuality(id); // 清晰度缓存同步失效，下次分组时重算

  // 旧的缩略图已过期，删除后按需重新生成
  await removeThumbFiles(id, row.thumb);

  return toDTO(getImage(id));
}

/* ------------------------------- 画质增强 ------------------------------- */
// 实现已拆到 lib/enhance.js（re-export 保持既有调用方 import 路径不变）
export {
  ENHANCE_MODELS,
  ENHANCE_STANDARDS,
  getStandardResolution,
  countBelowStandard,
  listBelowStandard,
  enhanceImage,
  resyncImageMeta,
  enhanceImageRemote,
  testRemoteService,
} from './lib/enhance.js';
function orientationOf(w, h) {
  if (!w || !h) return 'unknown';
  const ratio = w / h;
  if (ratio > 1.15) return 'landscape';
  if (ratio < 0.87) return 'portrait';
  return 'square';
}

function bucketOf(w, h) {
  const long = Math.max(w || 0, h || 0);
  if (long < 1080) return 'sd';
  if (long < 2048) return 'fhd';
  if (long < 3840) return '2k';
  return '4k';
}

/**
 * 文件名里带着采集时的分辨率（关键词_来源_宽x高_时间.jpg），且增强/旋转不会改名。
 * 因此「当前尺寸 > 文件名里的尺寸」就说明这张图被放大过，可用于展示"增强前 → 后"。
 */
function originalSizeOf(row) {
  const m = path.basename(row.abs_path || '').match(/_(\d+)x(\d+)_/);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!width || !height) return null;
  if (row.width > width * 1.02 || row.height > height * 1.02) return { width, height };
  return null;
}

export function toDTO(row) {
  const tags = row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  // 以文件修改时间作版本号，文件被修改后（如旋转）浏览器缓存自动失效
  let ver = '';
  try {
    ver = `?v=${Math.floor(fs.statSync(row.abs_path).mtimeMs)}`;
  } catch {}
  const orig = originalSizeOf(row);
  return {
    enhanced: !!orig,
    originalWidth: orig ? orig.width : 0,
    originalHeight: orig ? orig.height : 0,
    enhanceScale: orig && orig.width ? Math.round((row.width / orig.width) * 10) / 10 : 0,
    id: row.id,
    title: row.title,
    source: row.source,
    keyword: row.keyword,
    sourceUrl: row.source_url,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    mime: row.mime,
    favorite: row.favorite === 1,
    viewed: !!row.viewed_at,
    viewCount: row.view_count || 0,
    viewedAt: row.viewed_at || '',
    rating: row.rating || 0,
    note: row.note || '',
    dominant: row.dominant || '',
    hue: row.hue ?? '',
    tags,
    createdAt: row.created_at,
    score: row.score ?? 100,
    scoreReason: row.score_reason || '',
    orientation: orientationOf(row.width, row.height),
    bucket: bucketOf(row.width, row.height),
    path: row.abs_path,
    thumbUrl: `/api/images/${row.id}/thumb${ver}`,
    url: `/api/images/${row.id}/file${ver}`,
    downloadUrl: `/api/images/${row.id}/download${ver}`,
  };
}

export function getImage(id) {
  return db.prepare('SELECT * FROM images WHERE id = ?').get(id);
}

export const KEEP_REASONS = {
  ok: 'ok',
  tooSmall: 'lowres',
  tooLight: 'small',
  badFormat: 'format',
  duplicate: 'duplicate',
  failed: 'failed',
  tooLarge: 'oversize',
  aiFilter: 'aiFilter',
  cancelled: 'cancelled',
};

/**
 * 把一张图片纳入图库（含过滤与去重）
 * @param {Object} params
 * @param {string} [params.absPath] 已存在于磁盘的文件（不复制）
 * @param {Buffer} [params.buffer] 内存中的图片数据（会落盘）
 */
export async function ingest(params, settings = getSettings()) {
  const {
    absPath = null,
    buffer = null,
    source = 'local',
    keyword = '',
    sourceUrl = '',
    title = '',
    tags = '',
    copyToStorage = false,
    // 本地导入用：跳过 pHash 查重。磁盘上真实存在的文件都应登记入库（内容相同的不同文件
    // 如同名 jpg/png 对，正是后续去重工具要处理的对象，若在这里拦截反而配不成对）
    skipPhashDupe = false,
    // 任务启动时记下的库代数：跨 await 的长任务（导入）中途若切了库，
    // 这里比对发现代数变了就放弃入库，避免把 A 库的图写进 B 库
    libGeneration = null,
  } = params;

  const minBytes = Number(settings.minFileSize) * 1024;
  const maxBytes = Number(settings.maxFileSize) * 1024 * 1024;
  const minLong = Number(settings.minResolution);
  const threshold = Number(settings.phashThreshold);

  let finalPath = absPath;
  let sizeBytes = 0;
  // 文件指纹：批量导入据此跳过内容未变的文件（增量扫描）
  let fsMtime = 0;

  if (buffer) {
    sizeBytes = buffer.length;
    if (sizeBytes < minBytes) return { ok: false, reason: KEEP_REASONS.tooLight };
    if (sizeBytes > maxBytes) return { ok: false, reason: KEEP_REASONS.tooLarge };
  } else if (absPath) {
    const stat = fs.statSync(absPath);
    sizeBytes = stat.size;
    fsMtime = Math.round(stat.mtimeMs / 1000);
    if (sizeBytes < minBytes) return { ok: false, reason: KEEP_REASONS.tooLight };
    if (sizeBytes > maxBytes) return { ok: false, reason: KEEP_REASONS.tooLarge };
  } else {
    return { ok: false, reason: KEEP_REASONS.failed };
  }

  let meta;
  try {
    const pipeline = sharp(buffer || absPath, { failOn: 'none' });
    meta = await pipeline.metadata();
  } catch {
    return { ok: false, reason: KEEP_REASONS.badFormat };
  }

  const format = (meta.format || '').toLowerCase();
  if (!ALLOWED_FORMATS.has(format)) return { ok: false, reason: KEEP_REASONS.badFormat };

  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) return { ok: false, reason: KEEP_REASONS.badFormat };
  if (Math.max(width, height) < minLong) return { ok: false, reason: KEEP_REASONS.tooSmall };

  // 落盘：采集到的图片直接写入本地保存文件夹
  if (buffer || (copyToStorage && absPath)) {
    const dir = resolveStorageDir(settings);
    const name = buildFileName({ keyword, source, width, height, format });
    let finalPathCandidate = path.join(dir, name);
    if (fs.existsSync(finalPathCandidate)) {
      finalPathCandidate = path.join(dir, name.replace(/(\.\w+)$/, `_${crypto.randomBytes(2).toString('hex')}$1`));
    }
    finalPath = finalPathCandidate;
    if (buffer) await fsp.writeFile(finalPath, buffer);
    else await fsp.copyFile(absPath, finalPath);
  }

  // 切库保护：入库前再确认一次还是当初那个库（此刻 db 可能已经指向新库）。
  // 放在 INSERT 之前 —— 一旦插进去，缩略图也会落进新库的 thumbs 目录，清理成本高得多。
  if (libGeneration != null && libGeneration !== getLibraryGeneration()) {
    return { ok: false, reason: KEEP_REASONS.cancelled };
  }

  // —— 入库：缩略图 / pHash / 主色统一从「缩略图」派生，避免对原图重复解码 ——
  // 旧实现对大图解码 3 次（pHash、缩略图、主色各一次），导入大量相机原图时极慢。
  // 现在每张图只解码一次原图（生成缩略图），pHash 与主色改从 640px 缩略图算，
  // 结果等价（都是缩到 32×32 / 160×160），解码量下降一个数量级。
  const info = db
    .prepare(
      `INSERT INTO images (title, abs_path, thumb, source, keyword, source_url, width, height,
        size_bytes, mime, phash, favorite, tags, created_at, fs_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      title || path.basename(finalPath),
      finalPath,
      null,
      source,
      keyword,
      sourceUrl,
      width,
      height,
      sizeBytes,
      `image/${format === 'jpg' ? 'jpeg' : format}`,
      '',
      tags,
      new Date().toISOString(),
      fsMtime
    );
  const id = Number(info.lastInsertRowid);

  // 缩略图：每张图唯一一次整图解码
  const thumb = await ensureThumb(id, finalPath);

  // pHash 从缩略图派生（若缩略图生成失败则回退到原图，保证查重可用）
  let phash = '';
  try {
    phash = await computePHash(thumb || finalPath);
  } catch (err) {
    console.error('[phash] 计算失败', finalPath, err.message);
  }

  // pHash 查重（采集场景）：命中则撤销本次入库（删记录 + 缩略图 + 已落盘文件）
  if (phash && !skipPhashDupe) {
    const dupId = findDuplicateByPhash(phash, threshold);
    if (dupId) {
      db.prepare('DELETE FROM images WHERE id = ?').run(id);
      if (thumb) await removeFileRetry(thumb).catch(() => {});
      if (buffer || copyToStorage) await removeFileRetry(finalPath);
      return { ok: false, reason: KEEP_REASONS.duplicate, duplicateOf: dupId };
    }
  }

  // CLIP 深度特征查重（第二道防线）：裁剪/旋转/加滤镜的图 pHash 挡不住，向量余弦能识别。
  // 模型未就绪时跳过（首次启动后台加载，加载完成前入库的图由「补算」任务覆盖）。
  if (!skipPhashDupe && clip.clipReady()) {
    try {
      const vec = await clip.embedImage(finalPath);
      const dup = clip.topSimilar(vec, { k: 1, minCos: 0.965 });
      if (dup.length) {
        db.prepare('DELETE FROM images WHERE id = ?').run(id);
        if (thumb) await removeFileRetry(thumb).catch(() => {});
        if (buffer || copyToStorage) await removeFileRetry(finalPath);
        return { ok: false, reason: KEEP_REASONS.duplicate, duplicateOf: dup[0].id, clipCos: +dup[0].cos.toFixed(4) };
      }
    } catch (err) {
      console.error('[clip] 入库查重失败（忽略）', finalPath, err?.message || err);
    }
  }

  // 智能评分：命中知识库负面规则且低于阈值时直接丢弃（此时已占位入库，需撤销记录）
  const { score, reasons } = scoreImage(
    { source, keyword, width, height, tags, phash },
    undefined,
    ''
  );
  if (settings.aiFilterEnabled !== false && score < Number(settings.scoreThreshold)) {
    db.prepare('DELETE FROM images WHERE id = ?').run(id);
    if (thumb) await removeFileRetry(thumb).catch(() => {});
    if (buffer || copyToStorage) await removeFileRetry(finalPath);
    return { ok: false, reason: KEEP_REASONS.aiFilter, score, reasons };
  }

  if (phash) indexPhash(id, phash);
  if (clip.clipReady()) clip.reembed(id, finalPath); // 深度特征入库（异步）

  // 主色与色系从缩略图派生（用于「找同色」与颜色筛选）
  let dominant = null;
  if (thumb) {
    try {
      dominant = await computeDominant(thumb);
    } catch {
      /* 主色提取失败不影响入库 */
    }
  }

  // 一次性回填缩略图 / pHash / 主色 / 评分（减少多次 UPDATE）
  const setCols = ['score = ?', 'score_reason = ?'];
  const setArgs = [score, reasons.join('；')];
  if (thumb) {
    setCols.push('thumb = ?');
    setArgs.push(thumb);
  }
  if (phash) {
    setCols.push('phash = ?');
    setArgs.push(phash);
  }
  if (dominant) {
    setCols.push('dominant = ?', 'hue = ?', 'palette = ?');
    setArgs.push(dominant.dominant, dominant.hue, JSON.stringify(dominant.palette || [dominant.dominant]));
  }
  setArgs.push(id);
  db.prepare(`UPDATE images SET ${setCols.join(', ')} WHERE id = ?`).run(...setArgs);

  // 按磁盘目录归入文件夹树（本地导入的图有目录层级；采集到 root 的归入根）
  try {
    linkImageByPath(id, finalPath, settings.storageDir);
  } catch {
    /* 建树失败不影响入库 */
  }

  return { ok: true, id, image: toDTO(getImage(id)) };
}

export function setFavorite(id, favorite) {
  db.prepare('UPDATE images SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id);
  return toDTO(getImage(id));
}

export function setTags(id, tags) {
  const value = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).join(',') : String(tags || '');
  db.prepare('UPDATE images SET tags = ? WHERE id = ?').run(value, id);
  return toDTO(getImage(id));
}

export function renameTitle(id, title) {
  db.prepare('UPDATE images SET title = ? WHERE id = ?').run(String(title || ''), id);
  return toDTO(getImage(id));
}

/** 标记「已看过」（进入大图预览时调用），供「未看过」筛选使用 */
export function markViewed(id) {
  db.prepare('UPDATE images SET view_count = view_count + 1, viewed_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id
  );
  return toDTO(getImage(id));
}

/** 星级评分（0-5，0 表示未评分） */
export function setRating(id, rating) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  db.prepare('UPDATE images SET rating = ? WHERE id = ?').run(value, id);
  return toDTO(getImage(id));
}

/** 备注 */
export function setNote(id, note) {
  db.prepare('UPDATE images SET note = ? WHERE id = ?').run(String(note || '').slice(0, 1000), id);
  return toDTO(getImage(id));
}

/* ------------------------------- 标签管理 ------------------------------- */
// 实现已拆到 lib/tags.js（此处 re-export 保持既有调用方 import 路径不变）
export { listTags, renameTag, deleteTag, mergeTags } from './lib/tags.js';

/* ------------------------------- 智能文件夹 ------------------------------- */
// 实现已拆到 lib/smartfolders.js，通用小工具在 lib/utils.js（同样 re-export 保持兼容）
export {
  listSmartFolders,
  getSmartFolder,
  createSmartFolder,
  updateSmartFolder,
  deleteSmartFolder,
  matchSmartFolder,
  previewSmartFolder,
  applySmartFolderTags,
} from './lib/smartfolders.js';

/* ------------------------------- 主色提取 ------------------------------- */
/* 实现已抽到 color.js（worker 线程里也要用：导入时主色/pHash 从缩略图像素派生，
 * 不能在 worker 里 import library.js —— 那会把整个图片库（含 DB 连接）拉进 worker）。 */

import { hueFromPalette, computeDominant, dominantFromRaw } from './color.js';
export { hueFromPalette, computeDominant, dominantFromRaw };



/** 给图片补算主色/调色板（一次处理一批，可重复调用）。
 *  force=true 时重算全部（用于修正已有的旧调色板数据），否则只补算缺失的。 */
export async function backfillDominant(limit = 300, force = false) {
  const rows = db
    .prepare(
      force
        ? 'SELECT id, abs_path FROM images LIMIT ?'
        : "SELECT id, abs_path FROM images WHERE dominant = '' LIMIT ?"
    )
    .all(Math.max(1, Math.min(5000, limit)));
  let done = 0;
  for (const row of rows) {
    try {
      if (!fs.existsSync(row.abs_path)) continue;
      const c = await computeDominant(row.abs_path);
      db.prepare('UPDATE images SET dominant = ?, hue = ?, palette = ? WHERE id = ?').run(
        c.dominant,
        c.hue,
        JSON.stringify(c.palette || [c.dominant]),
        row.id
      );
      done++;
    } catch {
      db.prepare("UPDATE images SET dominant = '#808080', hue = '', palette = '[]' WHERE id = ?").run(row.id);
    }
  }
  const remain = force
    ? 0
    : db.prepare("SELECT COUNT(*) AS c FROM images WHERE dominant = ''").get().c;
  return { done, remain };
}

/* ---------------------------- 相似图分组（整理） ---------------------------- */
// 实现已拆到 lib/tidy.js（re-export 保持既有调用方 import 路径不变）
export {
  listClipSimilarGroups,
  listSimilarGroups,
  listFormatDupes,
  resolveSimilar,
  getTidySkips,
  addTidySkip,
  resetTidySkips,
} from './lib/tidy.js';

/* ------------------------------ 统一列表查询 ------------------------------ */
// 实现已拆到 lib/query.js（re-export 保持既有调用方 import 路径不变）
export {
  markAllViewedByFilter,
  markAllViewed,
  buildImageFilter,
  listImages,
} from './lib/query.js';

/* ------------------------- 删除 / 回收站 / 文件重命名 ------------------------- */
// 实现已拆到 lib/trash.js（re-export 保持既有调用方 import 路径不变）
export {
  removeImage,
  listTrash,
  restoreFromTrash,
  deleteTrashItem,
  emptyTrash,
  renameImage,
  clearLibrary,
} from './lib/trash.js';