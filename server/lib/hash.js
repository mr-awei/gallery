// 内容指纹（MD5）：完全重复检测用，与 pHash（相似）互补。
// 单独成文件是为了让 library.js 与 lib/media.js 都能引用，避免两者互相 import 成环。
import fs from 'node:fs';
import crypto from 'node:crypto';

/** 流式计算文件 MD5（大视频不会整块进内存） */
export async function md5File(file) {
  const hash = crypto.createHash('md5');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

export function md5Buffer(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}
