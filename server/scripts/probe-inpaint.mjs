// 临时探路：验证「遮罩区 RGB 置零」是否为该导出的正确输入约定
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR } from '../config.js';
import { db } from '../db.js';

const MODEL = path.join(DATA_DIR, 'ai', 'inpaint', 'lama_fp16.onnx');
const ort = await import('onnxruntime-node');
const session = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'] });

const row = db.prepare("SELECT abs_path FROM images WHERE abs_path LIKE '%.jpg' ORDER BY id DESC LIMIT 1").get();
const meta = await sharp(row.abs_path).metadata();
const W = 512;
const H = Math.round((meta.height / meta.width) * 512);
const imgRaw = await sharp(row.abs_path).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer();
const x0 = Math.round(W / 2 - 60), y0 = Math.round(H / 2 - 60), side = 120;
const maskBuf = Buffer.alloc(W * H);
for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) maskBuf[y * W + x] = 255;

const build = (zeroOut) => {
  const n = W * H;
  const data = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) {
    const hole = maskBuf[i] > 127;
    const k = zeroOut && hole ? 0 : 1;
    data[i] = (imgRaw[i * 3] / 255) * k;
    data[n + i] = (imgRaw[i * 3 + 1] / 255) * k;
    data[2 * n + i] = (imgRaw[i * 3 + 2] / 255) * k;
    data[3 * n + i] = hole ? 1 : 0;
  }
  return data;
};

const mean = (b, w, px, py, s) => {
  let r = 0, g = 0, bl = 0, c = 0;
  for (let y = py; y < py + s; y++) for (let x = px; x < px + s; x++) {
    const i = (y * w + x) * 3; r += b[i]; g += b[i + 1]; bl += b[i + 2]; c++;
  }
  return [r / c, g / c, bl / c].map((v) => Math.round(v));
};

for (const zeroOut of [false, true]) {
  const data = build(zeroOut);
  const t = Date.now();
  const out = await session.run({ input: new ort.Tensor('float32', data, [1, 4, H, W]) });
  const o = out.output;
  const ow = o.dims[3], oh = o.dims[2];
  const buf = Buffer.alloc(ow * oh * 3);
  for (let i = 0; i < ow * oh; i++) {
    for (let c = 0; c < 3; c++) buf[i * 3 + c] = Math.max(0, Math.min(255, Math.round(o.data[c * ow * oh + i] * 255)));
  }
  const sx = Math.round((x0 / W) * ow), sy = Math.round((y0 / H) * oh), ss = Math.round((side / W) * ow);
  const inside = mean(buf, ow, sx + 10, sy + 10, ss - 20);
  const ring = mean(buf, ow, Math.max(0, sx - 30), Math.max(0, sy - 30), Math.min(ow - 1, ss + 60));
  const d = Math.round(Math.hypot(inside[0] - ring[0], inside[1] - ring[1], inside[2] - ring[2]));
  console.log(`遮罩区RGB置零=${zeroOut}: ${Date.now() - t}ms 区内=${inside.join(',')} 周边=${ring.join(',')} 色差=${d}`);
  if (zeroOut) await sharp(buf, { raw: { width: ow, height: oh, channels: 3 } }).png().toFile(path.join(import.meta.dirname, 'inpaint-real2.png'));
}
