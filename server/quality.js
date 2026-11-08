/**
 * 图片画质：清晰度（拉普拉斯方差）。
 * 组内排序用——同一系列里自动把对焦最实的那张排前面（业界通用做法，
 * 参考 Google Photos 连拍选最佳帧）。
 * 结果缓存到 image_quality 表；图片被旋转 / 增强覆盖后需失效重算。
 */
import sharp from 'sharp';
import { db } from './db.js';

const SIZE = 256; // 缩到 256px 算拉普拉斯，单张几毫秒，且抗噪

/** 读取（带缓存）一张图的清晰度；读取失败返回 0 */
export async function getSharpness(imageId, absPath) {
  const cached = db.prepare('SELECT sharpness FROM image_quality WHERE image_id = ?').get(imageId);
  if (cached) return cached.sharpness;
  try {
    const { data, info } = await sharp(absPath, { failOn: 'none' })
      .greyscale()
      .resize(SIZE, SIZE, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        // 拉普拉斯核 [0,1,0;1,-4,1;0,1,0]，响应方差越大越清晰
        const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }
    const mean = sum / count;
    const variance = sumSq / count - mean * mean;
    db.prepare(
      'INSERT INTO image_quality(image_id, sharpness, created_at) VALUES (?, ?, ?) ON CONFLICT(image_id) DO NOTHING'
    ).run(imageId, variance, new Date().toISOString());
    return variance;
  } catch {
    return 0;
  }
}

/** 缓存失效（图片内容被覆盖后调用） */
export function invalidateQuality(imageId) {
  db.prepare('DELETE FROM image_quality WHERE image_id = ?').run(imageId);
}
