import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { getThumbDir } from './db.js';
import { designThumbJpeg, isDesignLikePath } from './lib/design-thumb.js';

/**
 * 缩略图按 id 分桶存储：thumbs/<id%256 的两位 hex>/<id>.jpg
 * 单目录百万文件会让 NTFS 枚举/删除性能崩塌（删库 rmSync 递归也是）；
 * 256 桶 × 4k 文件是单层目录的甜点区。
 * 旧库已有平铺文件：读路径先查桶再回退平铺（不迁移，写路径一律分桶，自然过渡）。
 */

export function thumbBucketDir(id) {
  return path.join(getThumbDir(), (Number(id) % 256).toString(16).padStart(2, '0'));
}

export function thumbPathFor(id) {
  return path.join(thumbBucketDir(id), `${id}.jpg`);
}

export function legacyThumbPath(id) {
  return path.join(getThumbDir(), `${id}.jpg`);
}

/** 文件 mtime（毫秒）；取不到返回 0，代表「不知道新鲜度」 */
export function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// 文件系统时间精度 / 同一秒内先写源再写缓存，允许 2 秒误差
const FRESH_SLACK_MS = 2000;

/**
 * 缓存文件是否「不早于它该派生的源文件」。
 *
 * 为什么必须校验：缩略图按 id 命名，而 id 会从头再来 —— 建库时清空过、库用备份恢复过、
 * 导入中断后重来，磁盘上都会留下「上一辈子同一个 id」的缩略图。只判断「文件存不存在」
 * 就会把它当成自己的缓存直接认领：列表里显示别人的图，点开灯箱又是对的（预览图刚生成），
 * 用户看到的就是「缩略图和大图不是一张」。pHash 也是从缩略图算的，认领旧缩略图还会让
 * 查重认错图，连带把好图判成「重复」扔掉。
 *
 * notBeforeMs 缺省时退化为只判断存在（给「只想看有没有」的调用方用）。
 */
export function isCacheFresh(cachePath, notBeforeMs) {
  if (!cachePath) return false;
  let st;
  try {
    st = fs.statSync(cachePath);
  } catch {
    return false;
  }
  if (!st.size) return false;
  if (!notBeforeMs) return true;
  return st.mtimeMs >= notBeforeMs - FRESH_SLACK_MS;
}

/**
 * 该图的缩略图当前实际路径（桶内优先，回退旧平铺；没有 / 明显是旧缓存都返回 ''）。
 * 传了源文件 mtime 就只认不早于它的文件。
 */
export function existingThumbPath(id, notBeforeMs) {
  const bucketed = thumbPathFor(id);
  if (isCacheFresh(bucketed, notBeforeMs)) return bucketed;
  const legacy = legacyThumbPath(id);
  return isCacheFresh(legacy, notBeforeMs) ? legacy : '';
}

export async function ensureThumbDirFor(id) {
  return fsp.mkdir(thumbBucketDir(id), { recursive: true });
}

/* ------------------------------ 预览图（灯箱用） ------------------------------
 * 为什么需要：图库里原图平均 8MB+（棚拍 PNG 能到 20MB），灯箱直接加载原图要下载 +
 * 解码一两秒；缩略图只有 640px，放大又糊。中间这档长边 1920 的 JPEG 通常
 * 300~550KB，解码快一个数量级，正常浏览完全够，放大到 1.4 倍以上时前端再换原图。
 *
 * 为什么是 JPEG 不是 webp：实测同一张 21.8MB / 6000×4000 的相片，
 * webp(2560,q82) 要 550ms，jpeg(1920,q80) 只要 175ms，体积还小一半。
 * 慢的从来不是传输，是编码 —— 灯箱这种「当场生成」的档位必须选编码快的。
 */

const PREVIEW_EDGE = 1920;

export function previewPathFor(id) {
  return path.join(thumbBucketDir(id), `${id}-pv.jpg`);
}

/** 旧版缓存（2560 的 webp）：还能用就继续用，不为了换格式把已有缓存全废掉 */
function legacyPreviewPathFor(id) {
  return path.join(thumbBucketDir(id), `${id}-pv.webp`);
}

/** 已生成的预览图路径（没有 / 早于源文件返回 ''），判定规则同缩略图 */
export function existingPreviewPath(id, notBeforeMs) {
  const p = previewPathFor(id);
  if (isCacheFresh(p, notBeforeMs)) return p;
  const old = legacyPreviewPathFor(id);
  return isCacheFresh(old, notBeforeMs) ? old : '';
}

export async function ensurePreview(id, absPath) {
  const hit = existingPreviewPath(id, mtimeOf(absPath));
  if (hit) return hit;
  try {
    await ensureThumbDirFor(id);
    const target = previewPathFor(id);
    // 先写临时文件再改名：中途被切库/关软件不会留下半张图（半张会一直被当成有效缓存）
    // 后缀必须唯一：后台预取和灯箱前台请求可能同时做同一张（tmp 同名会互相覆盖，
    // 一个 rename 成功后另一个 rename 失败 → 灯箱拿到 404 回退 20MB 原图）
    // 后缀里必须带 `.tmp-`：启动清扫 sweepThumbTemp() 只认这个标记，
    // 以前写成 `xxx.tmp` 的预览图残片永远不会被清理，会一直堆在缩略图桶里。
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    // RAW / PSD 走自带预览：sharp 读不了它们（CR2 里那段还是 14 位无损 JPEG）
    if (isDesignLikePath(absPath)) {
      const t = await designThumbJpeg(absPath, { width: PREVIEW_EDGE, quality: 82 });
      if (!t?.buffer?.length) throw new Error('没有可用的内嵌预览');
      await fsp.writeFile(tmp, t.buffer);
      await fsp.rename(tmp, target);
      return target;
    }
    await sharp(absPath, { failOn: 'none' })
      .rotate() // 按 EXIF 摆正，和浏览器显示原图的方向一致
      .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true, chromaSubsampling: '4:2:0' })
      .toFile(tmp);
    await fsp.rename(tmp, target);
    return target;
  } catch (err) {
    // 并发下另一个任务可能刚好写完（rename 撞车），先看有没有现成的再报失败
    const raced = existingPreviewPath(id, mtimeOf(absPath));
    if (raced) return raced;
    console.error('[preview] 生成预览图失败', id, err.message);
    return null;
  }
}

/** 删除某图所有可能存在的缩略图 + 预览图（桶内 + 旧平铺 + DB 记录的其它路径），全部幂等 */
export async function removeThumbFiles(id, extraPath = '') {
  const candidates = new Set([
    thumbPathFor(id),
    legacyThumbPath(id),
    previewPathFor(id),
    legacyPreviewPathFor(id),
  ]);
  if (extraPath) candidates.add(extraPath);
  await Promise.all(
    [...candidates].map((p) =>
      fsp.rm(p, { force: true }).catch(() => {})
    )
  );
}
