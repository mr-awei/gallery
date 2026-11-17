// @ts-check
// 多格式素材支持（对标 Eagle：图片之外还有视频 / GIF / 音频 / 字体 / PDF / Office / 3D）
//
// 这里只做「非图片素材」的判别与入库：
// - 图片仍走 library.ingest（sharp 解元数据 + 缩略图 + pHash + 主色）
// - 其余格式 sharp 处理不了，直接按文件登记，缩略图交给前端用 <video>/<audio>/@font-face 等渲染
//
// 为什么不用 ffmpeg：视频缩略图用 <video preload="metadata"> + 前端抓首帧即可，
// 时长/尺寸由前端读到真实元数据后回写，避免为「抽一帧」引入几百 MB 的外部二进制。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, getSettings } from '../db.js';
import { buildFileName, resolveStorageDir } from '../library.js';
import { uniqueTargetName } from './name-template.js';
import { md5File, md5Buffer } from './hash.js';
import { MEDIA_EXTS, extOf, isJunkFile, isMediaPath, kindOfPath, mimeOfPath } from './media-kind.js';
import { probeMedia } from './media-probe.js';
import { resolveTakenAt } from './taken-at.js';
import { designThumbJpeg } from './design-thumb.js';
import { ensureThumbDirFor, thumbPathFor } from '../thumbs.js';

// 判别逻辑在 media-kind.js（纯函数、可单测）；这里重新导出，保持既有调用方不变
export { MEDIA_EXTS, extOf, isJunkFile, isMediaPath, kindOfPath, mimeOfPath };

/**
 * 非图片素材入库。
 * 与 library.ingest 的差别：不生成缩略图、不算 pHash/主色，宽高留 0（前端渲染时补）。
 */
export async function ingestMedia({
  absPath = null,
  buffer = null,
  source = 'local',
  keyword = '',
  sourceUrl = '',
  title = '',
  tags = '',
  copyToStorage = false,
} = {}) {
  const settings = getSettings();
  const maxBytes = Number(settings.maxFileSize) * 1024 * 1024;
  const nameHint = absPath || title || '';
  const kind = kindOfPath(nameHint);
  if (kind === 'image' || kind === 'other') return { ok: false, reason: 'format' };

  let finalPath = absPath;
  let sizeBytes;
  // 源文件的创建时间：复制进库后目标文件的创建时间会变成复制时刻
  let srcBirthtime = 0;
  if (buffer) sizeBytes = buffer.length;
  else if (absPath) {
    const src = fs.statSync(absPath);
    sizeBytes = src.size;
    srcBirthtime = Math.round(Number(src.birthtimeMs || 0) / 1000);
  } else return { ok: false, reason: 'failed' };

  if (!sizeBytes) return { ok: false, reason: 'small' };
  if (sizeBytes > maxBytes) return { ok: false, reason: 'oversize' };

  if (buffer || (copyToStorage && absPath)) {
    const dir = resolveStorageDir(settings);
    await fsp.mkdir(dir, { recursive: true });
    const ext = extOf(nameHint) || 'bin';
    const base = buildFileName({
      keyword,
      source,
      width: 0,
      height: 0,
      format: ext,
      template: settings.importNameTemplate,
      originalName: title || (absPath ? path.basename(absPath) : ''),
    });
    finalPath = path.join(dir, uniqueTargetName(dir, base));
    if (buffer) await fsp.writeFile(finalPath, buffer);
    else {
      await fsp.copyFile(absPath, finalPath);
      // 还原源文件的修改时间：视频也一样，采集进来的不该显示成导入那天
      try {
        const src = await fsp.stat(absPath);
        await fsp.utimes(finalPath, src.atime, src.mtime);
      } catch {
        /* 还原失败不影响入库 */
      }
    }
  }

  // 文件指纹（秒级 mtime）：DTO 用它拼 ?v= 作为原图/封面的缓存版本号。
  // 非图片素材同样带 7 天强缓存，缺了这个字段，换封面或同名替换后前端永远看不到新图。
  let fsMtime = 0;
  let fsBirthtime = 0;
  try {
    const st = fs.statSync(finalPath);
    fsMtime = Math.round(st.mtimeMs / 1000);
    // 复制分支用源文件的创建时间；buffer 分支写完才有文件，创建时间就是这一刻
    fsBirthtime = !buffer && srcBirthtime ? srcBirthtime : Math.round(Number(st.birthtimeMs || 0) / 1000);
  } catch {
    /* 取不到就留 0，不影响入库 */
  }

  let md5 = '';
  try {
    md5 = buffer ? md5Buffer(buffer) : await md5File(finalPath);
  } catch {
    /* 指纹算不出来不影响入库，后续可补算 */
  }

  // 视频容器头探测：入库时就带上时长/分辨率，卡片不用等用户点开播放才知道
  const meta = kind === 'video' ? probeMedia(finalPath) : { duration: 0, width: 0, height: 0 };

  const info = db
    .prepare(
      `INSERT INTO images (title, abs_path, thumb, source, keyword, source_url, width, height,
        duration, size_bytes, mime, phash, favorite, tags, created_at, taken_at, media_kind, md5, fs_mtime)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title || path.basename(finalPath),
      finalPath,
      source,
      keyword,
      sourceUrl,
      meta.width,
      meta.height,
      meta.duration,
      sizeBytes,
      mimeOfPath(nameHint),
      tags,
      new Date().toISOString(),
      // 非图片素材没有 EXIF：视频用文件修改 / 创建时间（拍摄、导出时间）当时间线口径
      resolveTakenAt({ fsMtime, fsBirthtime }),
      kind,
      md5,
      fsMtime
    );
  const id = Number(info.lastInsertRowid);

  // 设计文件 / RAW：文件自带预览图，抽出来当缩略图 —— 否则卡片只有一个图标，
  // 「像不像素材库」全靠这一眼。提取失败不影响入库，前端会退回到图标占位。
  if (kind === 'design' || kind === 'raw') {
    try {
      const t = await designThumbJpeg(finalPath);
      if (t) {
        await ensureThumbDirFor(id);
        const target = thumbPathFor(id);
        await fsp.writeFile(target, t.buffer);
        db.prepare('UPDATE images SET thumb = ?, width = ?, height = ? WHERE id = ?').run(
          target,
          t.width,
          t.height,
          id
        );
        meta.width = t.width;
        meta.height = t.height;
      }
    } catch (err) {
      console.warn('[ingest] 预览提取失败', path.basename(finalPath), err?.message);
    }
  }

  return { ok: true, id, path: finalPath, kind, meta };
}
