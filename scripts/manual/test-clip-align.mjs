/**
 * 手动验证：图像塔与文本塔是否在同一投影空间。
 * 判据：与画面相符的描述 cos 明显高于无关描述（一般 0.25+ vs 0.15 以下）。
 * 若所有文本 cos 都挤在一起，说明图像侧没走 visual_projection，语义搜图不可用。
 * 用法：node scripts/manual/test-clip-align.mjs
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { embedImage, embedText } from '../../server/clip.js';

const db = new DatabaseSync('E:/邓紫棋/lib_mvs2ij40/gallery.db', { readOnly: true });
const rows = db
  .prepare("SELECT id, title, abs_path FROM images WHERE media_kind='image' AND phash<>'' ORDER BY id LIMIT 3")
  .all();

const texts = [
  '一只猫',
  '白色背景的商品图片',
  '夜晚的星空',
  '一张人物照片',
  'a photo of a cat',
  'a product photo on white background',
  'night sky with stars',
  'a portrait of a person',
  'text screenshot',
];
const tvecs = [];
for (const t of texts) tvecs.push(await embedText(t));

for (const r of rows) {
  const v = await embedImage(fs.readFileSync(r.abs_path));
  const parts = texts.map((t, i) => {
    let dot = 0;
    for (let j = 0; j < v.length; j++) dot += v[j] * tvecs[i][j];
    return `${t}=${dot.toFixed(3)}`;
  });
  console.log(`#${r.id} ${r.title}\n  ${parts.join('  ')}`);
}
