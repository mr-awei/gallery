/**
 * 对比两种图像编码：pipeline(image-feature-extraction) vs CLIPVisionModelWithProjection。
 * 如果两者 cos ≈ 1，说明 pipeline 已走 visual_projection，问题在文本侧；
 * 如果差很远，说明现网向量是未投影的 CLS 特征，和文本塔不在一个空间。
 */
import { env, pipeline, RawImage, AutoProcessor, CLIPVisionModelWithProjection } from '@huggingface/transformers';
import { MODEL_CACHE_DIR } from '../../server/config.js';
import { DatabaseSync } from 'node:sqlite';

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;
env.remoteHost = process.env.CLIP_HUB_HOST || 'https://hf-mirror.com';
const MODEL_ID = 'Xenova/clip-vit-base-patch32';

const db = new DatabaseSync('E:/邓紫棋/lib_mvs2ij40/gallery.db', { readOnly: true });
const row = db.prepare("SELECT abs_path FROM images WHERE media_kind='image' AND phash<>'' ORDER BY id LIMIT 1").get();

const norm = (v) => {
  const a = Float32Array.from(v);
  let n = 0;
  for (const x of a) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < a.length; i++) a[i] /= n;
  return a;
};
const cos = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};

const pipe = await pipeline('image-feature-extraction', MODEL_ID, { dtype: 'q8' });
const image = await RawImage.read(row.abs_path);
const outA = await pipe(image, { pooling: 'cls', normalize: true });
const vA = norm(outA.data);

const processor = await AutoProcessor.from_pretrained(MODEL_ID);
const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });
const inputs = await processor(image);
const outB = await vision(inputs);
const vB = norm(outB.image_embeds.data);

console.log('pipeline dims', outA.dims, 'vision_proj dims', outB.image_embeds.dims);
console.log('cos(pipeline, vision_proj) =', cos(vA, vB).toFixed(4));
