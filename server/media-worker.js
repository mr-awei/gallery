import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { phashFromGrey32 } from './phash.js';
import { dominantFromRaw } from './color.js';
import { decodeHeifFile } from './lib/heif.js';

/**
 * 派生资产 worker：一张图只做「一次整图解码」，其余全部由这份像素派生。
 *
 * 旧流水线每张图要：解码原图生成缩略图 → 读缩略图再解码算 pHash → 读缩略图再解码算主色，
 * 而且是跑在 HTTP 主线程上（导入期间所有 API 都被 sharp 的 CPU 占用拖慢，表现为「卡顿」）。
 * 现在解码/编码/量化全部在这里（多核并行），主线程只剩 SQLite 批量写入。
 */

const THUMB_WIDTH = Number(process.env.TUKU_THUMB_WIDTH || 640);
const THUMB_QUALITY = Number(process.env.TUKU_THUMB_QUALITY || 82);

/**
 * 唯一一次整图解码（直接解出「缩略图尺寸」的原始像素）。
 *
 * sharp 解不了的 HEIC 走 WASM 版 libheif：iPhone 照片在目录扫描里也是「普通图片」，
 * 不处理就会被当成格式不支持整批丢掉。
 */
async function decodeOnce(source, file) {
  try {
    const pixels = await sharp(source, { failOn: 'none', sequentialRead: true })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const meta = await sharp(source, { failOn: 'none' }).metadata();
    return {
      data: pixels.data,
      info: pixels.info,
      meta: { width: meta.width || 0, height: meta.height || 0, format: (meta.format || '').toLowerCase() },
    };
  } catch (err) {
    if (!file) throw err;
    const img = await decodeHeifFile(file);
    if (!img) throw err;
    const pixels = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data: pixels.data,
      info: pixels.info,
      meta: { width: img.width, height: img.height, format: 'heif' },
    };
  }
}

parentPort.on('message', async (job) => {
  const { seq, file, buffer, thumbPath } = job;
  // 输入二选一：磁盘路径（本地导入）或内存 buffer（爬虫/浏览器采集下载到的原始字节）
  const source = buffer || file;
  try {
    // 1) 唯一一次整图解码：直接解出「缩略图尺寸」的原始像素
    const { data, info, meta } = await decodeOnce(source, file);

    // 2) 缩略图 JPEG 从这份像素编码（不再二次解码）
    const jpeg = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .jpeg({ quality: THUMB_QUALITY, chromaSubsampling: '4:2:0' })
      .toBuffer();

    // 3) pHash / 主色同样从这份像素派生
    const grey = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .resize(32, 32, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
    const phash = phashFromGrey32(grey);
    const dominant = dominantFromRaw(data, info.channels);

    // 先写临时文件再改名：进程被强杀时不会留下半截 JPEG（半截图在网格里就是
    // 破图 + 一堆 404/解码报错）。缩略图分桶存储，先确保桶目录存在（幂等）。
    await fsp.mkdir(path.dirname(thumbPath), { recursive: true }).catch(() => {});
    const tmp = `${thumbPath}.tmp-${process.pid}-${job.seq}`;
    await fsp.writeFile(tmp, jpeg);
    await fsp.rename(tmp, thumbPath);

    parentPort.postMessage({
      seq,
      ok: true,
      width: meta.width,
      height: meta.height,
      format: meta.format,
      thumb: thumbPath,
      phash,
      dominant,
    });
  } catch (err) {
    parentPort.postMessage({ seq, ok: false, error: String(err?.message || err) });
  }
});
