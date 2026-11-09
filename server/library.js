import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import jpegtranPkg from 'jpegtran-bin';
import { db, getSettings, getLibraryGeneration } from './db.js';
import { IMAGE_DIR } from './config.js';
import { renderNameTemplate, uniqueTargetName } from './lib/name-template.js';
import { linkImageByPath } from './folders.js';
import { computePHash } from './phash.js';
import { designThumbJpeg, isDesignLikePath } from './lib/design-thumb.js';
import { computeSubjectPHash } from './lib/subject.js';
import * as clip from './clip.js';
import { invalidateQuality } from './quality.js';
import { scoreImage } from './kb.js';
import { existingThumbPath, ensureThumbDirFor, thumbPathFor, removeThumbFiles, mtimeOf } from './thumbs.js';
import { md5File, md5Buffer } from './lib/hash.js';
import { pushEditBackup } from './lib/undo.js';
// 注意：本文件里已有一个按「格式名」取扩展名的 extOf()，这里按路径取扩展名要换名
import { extOf as extOfPath, isHeifExt } from './lib/media-kind.js';
import { decodeHeifBuffer, decodeHeifFile } from './lib/heif.js';

const jpegtran = typeof jpegtranPkg === 'string' ? jpegtranPkg : jpegtranPkg.default;

/**
 * 允许入库的位图格式（sharp 自带解码能力范围内的全部）。
 *
 * 以前只有 jpeg/png/webp：拖一张 GIF、AVIF、TIFF 进来会被判「格式不支持」，
 * 而 Eagle 同样一张图能收 —— 用户视角就是「你们支持得太少」。
 * bmp / ico / heic 没有内建解码器，列进来只会变成假承诺，不放。
 * 注意 sharp 对 AVIF 报的 format 是 heif（见 imageTypeOf），所以 heif 必须在此。
 */
export const ALLOWED_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp', 'gif', 'heif', 'tiff', 'tif']);

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

/**
 * 回滚 / 去重失败时清掉已生成的缩略图或落盘副本。
 * 清理失败不能掩盖真正的失败原因（duplicate / aiFilter），但也不能一声不吭：
 * 以前这些点全是 `.catch(() => {})`，磁盘越用越大时完全对不上账。
 * @returns {Promise<boolean>} 是否删干净
 */
export async function cleanupQuietly(p, label = '文件') {
  if (!p) return true;
  try {
    await removeFileRetry(p);
    return true;
  } catch (err) {
    console.warn(`[cleanup] ${label}删除失败：`, p, err?.message || err);
    return false;
  }
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
  const tmp = path.join(dir, `.tuku-tmp-${process.pid}-${Date.now()}`);
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

/**
 * 分桶索引（多索引哈希）：64 位拆成 4 个 16 位块，每块一张 value → 槽位 表。
 * 汉明距离 ≤ t 时，四块里至少有一块的距离 ≤ ⌊t/4⌋（容斥：四块都 > t/4 则总和 > t），
 * 所以查询只需枚举那一档的 key（t=6 时每块 137 个），不必再扫全库。
 * 以前每导入一张都要跟内存里所有 pHash 逐个比，十万张就是 O(n²)。
 */
const PHASH_CHUNKS = 4;
const phashBuckets = Array.from({ length: PHASH_CHUNKS }, () => new Map());

function chunkOf(lo, hi, c) {
  if (c === 0) return lo & 0xffff;
  if (c === 1) return lo >>> 16;
  if (c === 2) return hi & 0xffff;
  return hi >>> 16;
}

function bucketAdd(slot, lo, hi) {
  for (let c = 0; c < PHASH_CHUNKS; c++) {
    const key = chunkOf(lo, hi, c);
    const map = phashBuckets[c];
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(slot);
  }
}

function bucketRemove(slot, lo, hi) {
  for (let c = 0; c < PHASH_CHUNKS; c++) {
    const key = chunkOf(lo, hi, c);
    const map = phashBuckets[c];
    const list = map.get(key);
    if (!list) continue;
    const i = list.indexOf(slot);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) map.delete(key);
  }
}

/** 枚举 16 位空间里与 v 距离 ≤ r 的所有 key（r 只会是 0/1/2，穷举位移组合即可） */
function keysWithin16(v, r) {
  const out = [v];
  if (r <= 0) return out;
  for (let i = 0; i < 16; i++) out.push(v ^ (1 << i));
  if (r >= 2) {
    for (let i = 0; i < 16; i++) {
      for (let j = i + 1; j < 16; j++) out.push(v ^ (1 << i) ^ (1 << j));
    }
  }
  return out;
}

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
  // 同一 id 重新派生/批量回填时先摘掉旧槽：否则旧哈希会永远留在分桶里，
  // 查重与以图搜图会命中「幽灵图」（指向已改动的同一行，距离却是旧值）
  if (phashSlot.has(id)) removePhash(id);
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
  bucketAdd(slot, lo, hi);
}

export function clearPhashIndex() {
  phashIds.length = 0;
  phashLo.length = 0;
  phashHi.length = 0;
  phashSlot.clear();
  phashFree.length = 0;
  for (const map of phashBuckets) map.clear();
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
  bucketRemove(slot, phashLo[slot], phashHi[slot]);
  phashIds[slot] = 0;
  phashLo[slot] = 0;
  phashHi[slot] = 0;
  phashSlot.delete(id);
  phashFree.push(slot);
}

/**
 * 取与给定 pHash 相近的若干条（以图搜图用）。
 * 以前是 "SELECT * FROM images WHERE phash <> ''" 全表进内存再逐个算距离，
 * 库到十万级单次请求就要几百毫秒到几秒；这里复用同一套分桶索引。
 * @returns {{id:number, dist:number}[]} 按距离升序
 */
export function findSimilarByPhash(hex, threshold, limit = 200) {
  const target = parsePhash64(hex);
  if (!target) return [];
  const [tLo, tHi] = target;
  const t = Math.max(0, Math.min(64, Number(threshold) || 0));
  const perChunk = Math.floor(t / 4);
  const max = Math.max(1, Math.min(5000, Number(limit) || 200));
  const seen = new Set();
  const out = [];
  for (let c = 0; c < PHASH_CHUNKS; c++) {
    const map = phashBuckets[c];
    if (!map.size) continue;
    for (const key of keysWithin16(chunkOf(tLo, tHi, c), perChunk)) {
      const list = map.get(key);
      if (!list) continue;
      for (const slot of list) {
        if (seen.has(slot)) continue;
        seen.add(slot);
        const id = phashIds[slot];
        if (!id) continue;
        let dist = hamming32(phashLo[slot], tLo);
        if (dist > t) continue;
        dist += hamming32(phashHi[slot], tHi);
        if (dist <= t) out.push({ id, dist });
      }
    }
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, max);
}

export function findDuplicateByPhash(hex, threshold) {
  const target = parsePhash64(hex);
  if (!target) return null;
  const [tLo, tHi] = target;
  const t = Math.max(0, Math.min(64, Number(threshold) || 0));
  // 四块里必有一块距离 ≤ ⌊t/4⌋，按这个半径去查桶
  const perChunk = Math.floor(t / 4);
  const seen = new Set();
  for (let c = 0; c < PHASH_CHUNKS; c++) {
    const map = phashBuckets[c];
    if (!map.size) continue;
    for (const key of keysWithin16(chunkOf(tLo, tHi, c), perChunk)) {
      const list = map.get(key);
      if (!list) continue;
      for (const slot of list) {
        if (seen.has(slot)) continue;
        seen.add(slot);
        const id = phashIds[slot];
        if (!id) continue;
        let dist = hamming32(phashLo[slot], tLo);
        if (dist > t) continue;
        dist += hamming32(phashHi[slot], tHi);
        if (dist <= t) return id;
      }
    }
  }
  return null;
}

function extOf(format) {
  if (format === 'jpeg') return 'jpg';
  if (format === 'jpg') return 'jpg';
  return format || 'jpg';
}

/**
 * sharp 报的是「容器格式」：AVIF 和 HEIC 都报 heif，只能按 compression 区分（av1 = AVIF）。
 * 扩展名/MIME 必须按真实格式写，否则存成 xxx.heif 在资源管理器里打不开、前端也显示不出后缀。
 */
function imageTypeOf(meta) {
  const raw = String(meta?.format || '').toLowerCase();
  if (raw === 'heif') {
    return meta?.compression === 'av1'
      ? { format: 'avif', ext: 'avif', mime: 'image/avif' }
      : { format: 'heic', ext: 'heic', mime: 'image/heic' };
  }
  if (raw === 'tiff' || raw === 'tif') return { format: 'tiff', ext: 'tif', mime: 'image/tiff' };
  if (raw === 'jpeg' || raw === 'jpg') return { format: 'jpeg', ext: 'jpg', mime: 'image/jpeg' };
  return { format: raw, ext: raw, mime: raw ? `image/${raw}` : '' };
}

const INVALID_CHARS = /[\\/:*?"<>|\r\n\t]/g;

/** 采集到的图片直接写入用户指定的本地文件夹，并使用可读文件名 */
export function resolveStorageDir(settings = getSettings()) {
  const dir = settings.storageDir || IMAGE_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 单张采集 / 拖拽 / 投送没有「批次序号」，用一个进程内自增序号喂给 {index}
let nameSeq = 0;
const nextNameIndex = () => ++nameSeq;

/**
 * @param {{keyword?:string, source?:string, width?:number, height?:number, format?:string, ext?:string, template?:string, index?:number, originalName?:string}} opts
 */
export function buildFileName({
  keyword,
  source,
  width,
  height,
  format,
  ext,
  template = '',
  index = 0,
  originalName = '',
}) {
  // ext 优先：avif/heic 在 sharp 里都叫 heif，只有 imageTypeOf 知道该写哪个后缀
  if (String(template || '').trim()) {
    return renderNameTemplate(String(template), {
      keyword,
      source,
      width,
      height,
      originalName,
      ext: ext || extOf(format),
      index: index || nextNameIndex(),
    });
  }
  const safe = (s) => String(s || '').replace(INVALID_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  // 6 位随机后缀：秒级时间戳 + 相同尺寸仍可能撞名（同一批两张不同图会生成同名文件，
  // 仅扩展名不同，曾被误当成「同名 jpg/png 同一张照片」）
  const suffix = crypto.randomBytes(3).toString('hex');
  const parts = [safe(keyword) || '壁纸', source, `${width}x${height}`, stamp, suffix];
  return `${parts.join('_')}.${ext || extOf(format)}`;
}

/** 是否由本应用管理（可随图库一起删除）的文件 */
export function isManagedPath(p, settings = getSettings()) {
  if (!p) return false;
  const target = path.resolve(String(p));
  const dirs = [IMAGE_DIR, settings?.storageDir].filter(Boolean).map((d) => path.resolve(d));
  // 必须按「路径段」判断，不能裸 startsWith：
  // C:\images2\a.jpg 会被 C:\images 前缀命中，导致删除/清库时动到用户自己的素材目录。
  // rel 为空表示就是目录本身；以 .. 开头或仍是绝对路径（跨盘）都说明在外层。
  return dirs.some((root) => {
    const rel = path.relative(root, target);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/**
 * 生成（或复用）缩略图。
 *
 * force：新入库的行专用 —— 全新的 id 不可能有合法缓存，磁盘上同名的东西一定是
 * 「上一辈子这个 id」留下的，先清干净再画，否则列表里会显示别人的图。
 * 不传 force 时用「缓存不早于源文件」来判断能否复用：源图被旋转/裁切/替换后
 * mtime 变新，旧的缩略图和预览图也会自动作废。
 */
export async function ensureThumb(id, absPath, { force = false } = {}) {
  if (force) {
    await removeThumbFiles(id); // 连灯箱预览图一起清：它同样按 id 命名
  } else {
    const hit = existingThumbPath(id, mtimeOf(absPath)); // 桶内优先，兼容旧平铺
    if (hit) return hit;
  }
  const gen = getLibraryGeneration();
  try {
    await ensureThumbDirFor(id);
    const target = thumbPathFor(id);
    // RAW（CR2/NEF/ARW/DNG…）与 PSD/PSB 交给设计文件提取器：它们自带的预览图
    // 比 sharp 直接解码更靠谱，也避免 CR2 里那段 14 位无损 JPEG 报错
    const design = isDesignLikePath(absPath) ? await designThumbJpeg(absPath, { width: 640 }) : null;
    if (design?.buffer?.length) {
      await fsp.writeFile(target, design.buffer);
      if (getLibraryGeneration() === gen) {
        try {
          db.prepare('UPDATE images SET thumb = ?, width = ?, height = ? WHERE id = ?').run(
            target,
            design.width || 0,
            design.height || 0,
            id
          );
        } catch {
          /* 行可能已删除 */
        }
      }
      return target;
    }
    await sharp(absPath, { failOn: 'none' })
      .rotate()
      .resize({ width: 640, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(target);
    // 写回 DB：批量导入的「这张已处理过」判断看的是 thumb 字段，
    // 懒补全（浏览时现补）不写回的话，下次扫描会把这些图再派生一遍
    if (getLibraryGeneration() === gen) {
      try {
        db.prepare('UPDATE images SET thumb = ? WHERE id = ?').run(target, id);
      } catch {
        /* 行可能已被删除，忽略 */
      }
    }
    return target;
  } catch (err) {
    // sharp 解不了的（RAW 变体、少见的 PSD/PSB、AI/EPS）：再给一次「抽内嵌预览」的机会
    try {
      const design = await designThumbJpeg(absPath, { width: 640 });
      if (design?.buffer?.length) {
        await ensureThumbDirFor(id);
        const target = thumbPathFor(id);
        await fsp.writeFile(target, design.buffer);
        if (getLibraryGeneration() === gen) {
          db.prepare('UPDATE images SET thumb = ?, width = ?, height = ? WHERE id = ?').run(
            target,
            design.width || 0,
            design.height || 0,
            id
          );
        }
        return target;
      }
    } catch {
      /* 兜底也失败：走下面的报错 */
    }
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

  pushEditBackup(row, 'rotate');
  await writeFileAtomic(row.abs_path, data);

  const newHash = await computePHash(data).catch(() => '');
  // 同 persistEdit：旋转也要换缓存版本号，否则（尤其 180°/方形图）尺寸没变，
  // 浏览器继续拿 7 天强缓存里的旧图，看起来像「转了个寂寞」。
  let fsMtime = Number(row.fs_mtime || 0) + 1;
  try {
    fsMtime = Math.max(Math.round(fs.statSync(row.abs_path).mtimeMs / 1000), fsMtime);
  } catch {
    /* 保留递增兜底值 */
  }
  db.prepare(
    'UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ?, fs_mtime = ? WHERE id = ?'
  ).run(info.width, info.height, data.length, newHash, fsMtime, id);
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

/** 解析主色板列：损坏的 JSON 不应该让整张卡片 500 */
function parsePalette(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .map((c) => (typeof c === 'string' ? { h: c, p: 0 } : c && typeof c.h === 'string' ? { h: c.h, p: Number(c.p) || 0 } : null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function toDTO(row) {
  const tags = row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  // 缓存版本号：用导入时落库的文件指纹 fs_mtime，不再逐行 statSync ——
  // 万级库每个列表请求做 N 次同步 IO 会拖慢接口并阻塞事件循环。
  // 文件被修改（旋转/替换）时由 resyncImageMeta 更新 fs_mtime 保持缓存失效能力。
  const mtime = Number(row.fs_mtime) || 0;
  // 封面版本单独拼在缩略图 URL 上：换封面只重写 thumbs/<id>.jpg，原文件没动，
  // 不带上它就永远是 7 天前那张封面
  const coverVer = Number(row.cover_ver) || 0;
  const ver = mtime ? `?v=${mtime}` : '';
  // 老库 fs_mtime 可能是 0，这里始终带版本（0-0）——只要后续有增量就一定能失效缓存
  const thumbVer = `?v=${mtime}-${coverVer}`;
  // 预览图同样带版本：带版本才能给长缓存（灯箱重复打开直接命中浏览器缓存，
  // 不再每次发条件请求），增强/旋转写回原图后 mtime 变化自动失效
  const previewVer = `?v=${mtime}`;
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
    /** 素材类型：image / gif / video / audio / font / pdf / office / model（Eagle 式多格式） */
    mediaKind: row.media_kind || 'image',
    /** 音视频时长（秒）；0 = 尚未探明 */
    duration: Number(row.duration) || 0,
    /** 自定义封面帧（秒），视频/GIF 缩略图取自该时间点 */
    coverTs: Number(row.cover_ts) || 0,
    /** 视频首尾裁剪区间（秒），0 = 未设置 */
    trimStart: Number(row.trim_start) || 0,
    trimEnd: Number(row.trim_end) || 0,
    md5: row.md5 || '',
    /** 堆叠：0 = 未堆叠；否则是组主 id（组主自己的 stackId = 自己的 id） */
    stackId: Number(row.stack_id) || 0,
    /** 使用统计：复制 / 导出次数 + 最近一次使用时间 */
    copyCount: Number(row.copy_count) || 0,
    exportCount: Number(row.export_count) || 0,
    lastUsedAt: row.last_used_at || '',
    favorite: row.favorite === 1,
    viewed: !!row.viewed_at,
    viewCount: row.view_count || 0,
    viewedAt: row.viewed_at || '',
    rating: row.rating || 0,
    note: row.note || '',
    dominant: row.dominant || '',
    /** 主色板（导入时算好落库）：[{h:'#rrggbb', p:占比}]，供「导出调色板」直接使用 */
    palette: parsePalette(row.palette),
    hue: row.hue ?? '',
    tags,
    createdAt: row.created_at,
    score: row.score ?? 100,
    scoreReason: row.score_reason || '',
    orientation: orientationOf(row.width, row.height),
    bucket: bucketOf(row.width, row.height),
    path: row.abs_path,
    thumbUrl: `/api/images/${row.id}/thumb${thumbVer}`,
    /** 灯箱预览图（长边 1920 JPEG）：带文件版本号，可安全长缓存 */
    previewUrl: `/api/images/${row.id}/preview${previewVer}`,
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
 * @param {string} [params.source] 来源标记
 * @param {string} [params.keyword] 采集关键词
 * @param {string} [params.sourceUrl] 原始网页地址
 * @param {string} [params.title] 标题
 * @param {string} [params.tags] 逗号分隔标签
 * @param {boolean} [params.copyToStorage] 是否复制到素材目录
 * @param {boolean} [params.skipPhashDupe] 跳过 pHash 查重
 * @param {number|null} [params.libGeneration] 启动任务时的库代数（防跨库串图）
 * @param {boolean} [params.skipQuality] 用户主动采集时跳过质量门槛
 * @returns {Promise<{ok:boolean, id?:number, image?:any, reason?:string, format?:string, duplicateOf?:number, clipCos?:number, score?:number, reasons?:string[]}>}
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
    // 用户主动采集（拖拽 / 右键「采集这张图片」）用：不过 minFileSize / minResolution 门槛。
    // 「小于 30KB」「短边不到 800」是给爬虫批量抓图定的,拿来拦用户自己挑的图就是拦错人：
    // AI 生成站常常只把 512/768 的预览图放进 <img>，Eagle 照收，我们却判 lowres 丢掉了。
    skipQuality = false,
  } = params;

  const minBytes = Number(settings.minFileSize) * 1024;
  const maxBytes = Number(settings.maxFileSize) * 1024 * 1024;
  const minLong = Number(settings.minResolution);
  const threshold = Number(settings.phashThreshold);

  let finalPath = absPath;
  let sizeBytes;
  // 文件指纹：批量导入据此跳过内容未变的文件（增量扫描）
  let fsMtime = 0;

  if (buffer) {
    sizeBytes = buffer.length;
    if (!skipQuality && sizeBytes < minBytes) return { ok: false, reason: KEEP_REASONS.tooLight };
    if (sizeBytes > maxBytes) return { ok: false, reason: KEEP_REASONS.tooLarge };
  } else if (absPath) {
    // 异步 stat：批量导入时几千个文件的同步 stat 会按住事件循环
    const stat = await fsp.stat(absPath);
    sizeBytes = stat.size;
    fsMtime = Math.round(stat.mtimeMs / 1000);
    if (!skipQuality && sizeBytes < minBytes) return { ok: false, reason: KEEP_REASONS.tooLight };
    if (sizeBytes > maxBytes) return { ok: false, reason: KEEP_REASONS.tooLarge };
  } else {
    return { ok: false, reason: KEEP_REASONS.failed };
  }

  let meta;
  try {
    const pipeline = sharp(buffer || absPath, { failOn: 'none' });
    meta = await pipeline.metadata();
  } catch {
    // HEIC / HEIF：sharp 的 libvips 没编 HEVC 解码器，但它确实是 iPhone 拍的照片，
    // 不属于「格式不支持」。用 WASM 版 libheif 读宽高后照常入库，
    // 缩略图仍由 design-thumb 那条路（同一个解码器）生成。
    const maybeHeif = buffer ? true : isHeifExt(extOfPath(absPath));
    const img = maybeHeif
      ? await (buffer ? decodeHeifBuffer(buffer) : decodeHeifFile(absPath)).catch(() => null)
      : null;
    if (!img) return { ok: false, reason: KEEP_REASONS.badFormat };
    meta = { format: 'heif', compression: 'hevc', width: img.width, height: img.height };
  }

  const format = (meta.format || '').toLowerCase();
  // 失败时把实际格式带回去：插件端才能说清「不支持的是 avif 还是 heic」，
  // 而不是一句没头没尾的「目标不是可用的图片」
  if (!ALLOWED_FORMATS.has(format)) {
    return { ok: false, reason: KEEP_REASONS.badFormat, format: format || 'unknown' };
  }
  const type = imageTypeOf(meta);

  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) return { ok: false, reason: KEEP_REASONS.badFormat, format };
  if (!skipQuality && Math.max(width, height) < minLong) {
    return { ok: false, reason: KEEP_REASONS.tooSmall, format };
  }

  // 落盘：采集到的图片直接写入本地保存文件夹
  if (buffer || (copyToStorage && absPath)) {
    const dir = resolveStorageDir(settings);
    const name = buildFileName({
      keyword,
      source,
      width,
      height,
      format,
      ext: type.ext,
      template: settings.importNameTemplate,
      originalName: title || (absPath ? path.basename(absPath) : ''),
    });
    // 模板里没有 {index}/{random} 时多张会同名：统一用 -1 / -2 追加，绝不互相覆盖
    finalPath = path.join(dir, uniqueTargetName(dir, name));
    if (buffer) await fsp.writeFile(finalPath, buffer);
    else await fsp.copyFile(absPath, finalPath);
    // 写盘/复制后必须重取文件指纹：buffer 路径原本没有 fs_mtime，导致「上传进来的图」
    // 在 DTO 里永远没有 ?v= 版本号。原图/缩略图响应带 7 天强缓存，没有版本号就意味着
    // 后续裁切/调色/旋转完，浏览器会一直拿旧图。
    try {
      fsMtime = Math.round((await fsp.stat(finalPath)).mtimeMs / 1000);
    } catch {
      /* 取不到就沿用上面 absPath 分支的值（buffer 分支则为 0） */
    }
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
  // 内容指纹：完全重复检测用。刚写完/刚解码过的文件基本都在系统缓存里，代价远小于一次 sharp 解码。
  let md5 = '';
  try {
    md5 = buffer ? md5Buffer(buffer) : await md5File(finalPath);
  } catch {
    /* 指纹失败不影响入库 */
  }

  // OR IGNORE：abs_path 上有唯一索引，watch 与 rescan 并发时后到的那条直接放弃，
  // 不会因为约束冲突把整批导入打成「本批失败」
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO images (title, abs_path, thumb, source, keyword, source_url, width, height,
        size_bytes, mime, phash, favorite, tags, created_at, fs_mtime, md5, media_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
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
      // mime 按真实格式写：heif 容器要区分 AVIF / HEIC，tiff 不能写成 image/tiff 之外的花样
      type.mime || 'application/octet-stream',
      '',
      tags,
      new Date().toISOString(),
      fsMtime,
      md5,
      'image'
    );
  const id = Number(info.lastInsertRowid);
  if (!info.changes) {
    // 同一路径已被另一个流程写进去了（并发导入）：原路径的文件绝不能删；
    // 但如果是我们刚复制出来的副本，就没人认领了，清掉免得留孤儿
    if (finalPath !== absPath) await cleanupQuietly(finalPath, '重复路径副本');
    return { ok: false, reason: KEEP_REASONS.duplicate };
  }

  // 缩略图：每张图唯一一次整图解码。
  // force：这个 id 是刚插进去的，磁盘上若有同名缩略图/预览图，只可能是旧库残留，
  // 不先清掉就会被下面这次复用 → 列表显示别人的图、pHash 也按别人的图算。
  const thumb = await ensureThumb(id, finalPath, { force: true });

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
      if (thumb) await cleanupQuietly(thumb, '缩略图');
      if (buffer || copyToStorage) await cleanupQuietly(finalPath, '回滚素材副本');
      return { ok: false, reason: KEEP_REASONS.duplicate, duplicateOf: dupId };
    }
  }

  // CLIP 深度特征查重（第二道防线）：裁剪/旋转/加滤镜的图 pHash 挡不住，向量余弦能识别。
  // 模型未就绪时跳过（首次启动后台加载，加载完成前入库的图由「补算」任务覆盖）。
  /** 向量查重失败时如实记下来：调用方与前端要能说「本次只按 pHash 查重」，而不是假装查过 */
  let clipCheckError = '';
  if (!skipPhashDupe && clip.clipReady()) {
    try {
      const vec = await clip.embedImage(finalPath);
      const dup = await clip.topSimilar(vec, { k: 1, minCos: 0.965 });
      if (dup.length) {
        db.prepare('DELETE FROM images WHERE id = ?').run(id);
        if (thumb) await cleanupQuietly(thumb, '缩略图');
        if (buffer || copyToStorage) await cleanupQuietly(finalPath, '回滚素材副本');
        return { ok: false, reason: KEEP_REASONS.duplicate, duplicateOf: dup[0].id, clipCos: +dup[0].cos.toFixed(4) };
      }
    } catch (err) {
      clipCheckError = String(err?.message || err);
      console.error('[clip] 入库查重失败，本次仅按 pHash 查重：', finalPath, clipCheckError);
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
    if (thumb) await cleanupQuietly(thumb, '缩略图');
    if (buffer || copyToStorage) await cleanupQuietly(finalPath, '回滚素材副本');
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

  return { ok: true, id, image: toDTO(getImage(id)), clipCheckFailed: !!clipCheckError, clipCheckError };
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

/**
 * 自定义缩略图：视频/GIF 的封面帧、手动换封面都走这里。
 * 统一转成 jpg 落到 id 分桶目录，和 sharp 生成的缩略图同路径，前端 <img> 无需区分来源。
 */
export async function setCustomThumb(id, buf, _fmt = 'png') {
  const row = db.prepare('SELECT id FROM images WHERE id = ?').get(id);
  if (!row) throw new Error('图片不存在');
  await ensureThumbDirFor(id);
  const target = thumbPathFor(id);
  await sharp(buf).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toFile(target);
  // cover_ver 自增 = 缩略图 URL 换版本（原文件没动，fs_mtime 变不了）
  db.prepare('UPDATE images SET thumb = ?, cover_ver = cover_ver + 1 WHERE id = ?').run(target, id);
  return target;
}

/**
 * 恢复默认缩略图（Eagle 的「Reset cover」）：
 * 删掉自定义封面帧；图片 / GIF 顺手按原图重建一张，其它素材置空让前端回落到图标卡。
 */
export async function resetThumb(id) {
  const row = db.prepare('SELECT id, abs_path, media_kind FROM images WHERE id = ?').get(id);
  if (!row) throw new Error('图片不存在');
  await removeThumbFiles(id);
  db.prepare('UPDATE images SET thumb = ?, cover_ts = 0, cover_ver = cover_ver + 1 WHERE id = ?').run('', id);
  const kind = row.media_kind || 'image';
  if ((kind === 'image' || kind === 'gif') && row.abs_path) {
    try {
      const p = await ensureThumb(id, row.abs_path);
      db.prepare('UPDATE images SET thumb = ? WHERE id = ?').run(p || '', id);
    } catch {
      /* 原图缺失或解码失败：留空，卡片走占位/缺失态 */
    }
  }
  return toDTO(getImage(id));
}

export function renameTitle(id, title) {
  db.prepare('UPDATE images SET title = ? WHERE id = ?').run(String(title || ''), id);
  return toDTO(getImage(id));
}

/** 标记「已看过」（进入大图预览时调用），供「未看过」筛选使用 */
export function markViewed(id) {
  const now = new Date().toISOString();
  // 单调写入：快速切图时两个请求可能乱序到达，或在同毫秒里与批量标记交错，
  // 旧请求不能用更早的时间把已更新的 viewed_at 覆盖回去；view_count 仍然照实累加。
  db.prepare(
    `UPDATE images SET view_count = view_count + 1,
       viewed_at = CASE WHEN viewed_at < ? THEN ? ELSE viewed_at END
     WHERE id = ?`
  ).run(now, now, id);
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
export {
  listTags,
  listTagsRich,
  listTagsPaged,
  listTagGroups,
  setTagMeta,
  setTagParent,
  reorderTags,
  renameTagGroup,
  clearTagGroup,
  removeTagMeta,
  renameTag,
  deleteTag,
  mergeTags,
} from './lib/tags.js';

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
  /** 文件不在了的行：写占位色后计入 skipped，否则它们会永久占住缺失窗口 */
  let skipped = 0;
  for (const row of rows) {
    try {
      if (!fs.existsSync(row.abs_path)) {
        // 以前这里直接 continue：这些行 dominant 仍为空，下一批还是它们，
        // 后面的图永远补不出主色，接口却返回 ok:true。
        db.prepare("UPDATE images SET dominant = '#808080', hue = '', palette = '[]' WHERE id = ?").run(row.id);
        skipped++;
        continue;
      }
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
      skipped++;
    }
  }
  const remain = force
    ? 0
    : db.prepare("SELECT COUNT(*) AS c FROM images WHERE dominant = ''").get().c;
  return { done, skipped, remain };
}

/** 补算主体哈希（白底抠图+主体包围盒归一化后的 pHash），一次一批可重复调用。
 *  为什么存在：全图 pHash 被白底背景主导，不同商品也判相似——见 lib/subject.js 头注。
 *  从缩略图算（与全图 pHash 同源，整图内容一致；6000×4000 原图解码太慢）。
 *  抠不出主体（非白底/纯色图）写入 'SKIP' 占位，避免每次补算都重试同一批失败图。 */
export async function backfillSubjectHash(limit = 300) {
  const rows = db
    .prepare("SELECT id, thumb, abs_path FROM images WHERE obj_phash = '' LIMIT ?")
    .all(Math.max(1, Math.min(5000, limit)));
  let done = 0;
  for (const row of rows) {
    const src = row.thumb && fs.existsSync(row.thumb) ? row.thumb : row.abs_path;
    let obj = 'SKIP';
    try {
      if (fs.existsSync(src)) obj = (await computeSubjectPHash(src)) || 'SKIP';
    } catch {
      obj = 'SKIP';
    }
    db.prepare('UPDATE images SET obj_phash = ? WHERE id = ?').run(obj, row.id);
    if (obj !== 'SKIP') done++;
  }
  const remain = db.prepare("SELECT COUNT(*) AS c FROM images WHERE obj_phash = ''").get().c;
  return { done, remain, skipped: rows.length - done };
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
  listImageIds,
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