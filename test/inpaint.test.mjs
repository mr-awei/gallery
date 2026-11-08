import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseMaskDataUrl, maskFromGrey, inpaintRgba, INPAINT_MAX_EDGE } from '../server/lib/inpaint.js';

test('蒙版 data URL：只收 PNG，拒绝伪造头与其它 MIME', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)]);
  assert.deepEqual(parseMaskDataUrl(`data:image/png;base64,${png.toString('base64')}`), png);
  assert.equal(parseMaskDataUrl('data:image/jpeg;base64,AAAA'), null);
  assert.equal(parseMaskDataUrl(`data:image/png;base64,${Buffer.from('not png!').toString('base64')}`), null);
  assert.equal(parseMaskDataUrl('https://evil/x.png'), null);
  assert.equal(parseMaskDataUrl(''), null);
});

test('灰度蒙版阈值与修复规模上限', () => {
  assert.deepEqual(Array.from(maskFromGrey(Uint8Array.from([0, 10, 40, 255]), 4, 1)), [0, 0, 1, 1]);
  assert.ok(INPAINT_MAX_EDGE >= 600, '工作副本不能小到影响修复质量');
});

test('内容感知扩散：只改孔洞，未擦除像素与 alpha 逐字节不变', () => {
  const W = 9;
  const H = 5;
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const c = x < 4 ? [200, 20, 20] : [20, 20, 200];
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 200;
    }
  }
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) mask[y * W + 4] = 1;
  const out = inpaintRgba(data, W, H, mask, { iterations: 24 });
  assert.equal(out.length, data.length);
  for (let y = 0; y < H; y++) {
    const i = (y * W + 4) * 4;
    assert.ok(out[i] > 20 && out[i + 2] > 20, `第 ${y} 行应由左右两侧扩散出混合色`);
    assert.equal(out[i + 3], 200, 'alpha 不能被改');
  }
  for (let p = 0; p < W * H; p++) {
    if (mask[p]) continue;
    assert.deepEqual(out.subarray(p * 4, p * 4 + 4), data.subarray(p * 4, p * 4 + 4));
  }
  assert.deepEqual(inpaintRgba(data, W, H, new Uint8Array(W * H)), data, '空蒙版必须原样返回');
});

test('真实 PNG 往返：黑色划痕被抹掉，周围颜色不变', async () => {
  const W = 60;
  const H = 40;
  const base = Buffer.alloc(W * H * 3, 235);
  for (let y = 8; y < 32; y++) {
    for (let x = 29; x < 31; x++) {
      const i = (y * W + x) * 3;
      base[i] = 0;
      base[i + 1] = 0;
      base[i + 2] = 0;
    }
  }
  const rgba = await sharp(base, { raw: { width: W, height: H, channels: 3 } })
    .ensureAlpha().raw().toBuffer();
  const mask = new Uint8Array(W * H);
  for (let y = 8; y < 32; y++) {
    for (let x = 29; x < 31; x++) mask[y * W + x] = 1;
  }
  const out = inpaintRgba(rgba, W, H, mask, { iterations: 30 });
  const png = await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => (y * W + x) * 4;
  assert.ok(data[at(30, 20)] > 180, '划痕中心应明显变亮');
  assert.equal(data[at(10, 20)], 235, '未擦除区域保持原色');
});
