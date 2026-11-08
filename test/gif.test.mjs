import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { bytesToDataUrl, encodeGif, GIF_PALETTE } from '../web/src/lib/gif.ts';
import { frameDelayMs, planFrameTimes } from '../web/src/lib/clip-plan.ts';

function solid(w, h, rgb, delayMs = 100) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return { width: w, height: h, data, delayMs };
}

test('GIF89a 头、全局颜色表与小端尺寸', () => {
  assert.equal(GIF_PALETTE.length, 256 * 3);
  const bytes = encodeGif([solid(16, 12, [255, 0, 0])]);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  assert.equal(bytes[6] | (bytes[7] << 8), 16);
  assert.equal(bytes[8] | (bytes[9] << 8), 12);
  assert.equal(bytes[10], 0xf7, '必须声明 256 项全局颜色表');
  assert.equal(bytes[bytes.length - 1], 0x3b, 'Trailer');
});

test('多帧动画能被真实解码器读回（页数/尺寸/像素）', async () => {
  const bytes = encodeGif([
    solid(24, 16, [255, 0, 0], 80),
    solid(24, 16, [0, 0, 255], 120),
    solid(24, 16, [0, 255, 0], 200),
  ]);
  const meta = await sharp(bytes, { animated: true }).metadata();
  assert.equal(meta.format, 'gif');
  assert.equal(meta.width, 24);
  // sharp 对多页 GIF 的 metadata().height 返回「所有页纵向展开」的高度，单页高度在 pageHeight
  assert.equal(meta.pageHeight ?? meta.height / meta.pages, 16);
  assert.equal(meta.pages, 3);
  assert.deepEqual(meta.delay.slice(0, 3), [80, 120, 200], '延时以毫秒写进 GCE');

  const first = await sharp(bytes, { page: 0 }).ensureAlpha().raw().toBuffer();
  assert.ok(first[0] > 240 && first[1] < 12, `第 1 帧应为红色，实际 ${first[0]},${first[1]}`);
  const second = await sharp(bytes, { page: 1 }).ensureAlpha().raw().toBuffer();
  assert.ok(second[2] > 240 && second[0] < 12, `第 2 帧应为蓝色，实际 ${second[0]},${second[2]}`);
});

test('帧尺寸不一致 / 数据不完整 / 空帧都要明确报错', () => {
  assert.throws(() => encodeGif([]), /没有可导出的帧/);
  assert.throws(() => encodeGif([solid(8, 8, [0, 0, 0]), solid(9, 8, [0, 0, 0])]), /尺寸必须一致/);
  const bad = solid(8, 8, [0, 0, 0]);
  bad.data = new Uint8ClampedArray(4);
  assert.throws(() => encodeGif([bad]), /像素数据不完整/);
});

test('data URL 可还原为同样字节', () => {
  const bytes = encodeGif([solid(4, 4, [10, 20, 30])]);
  const url = bytesToDataUrl(bytes);
  assert.ok(url.startsWith('data:image/gif;base64,'));
  assert.deepEqual(Buffer.from(url.split(',')[1], 'base64'), Buffer.from(bytes));
});

test('抽帧时间点：等距、上限抽稀、首尾不丢', () => {
  const a = planFrameTimes(0, 2, 10);
  assert.equal(a.length, 20);
  assert.equal(a[0], 0);
  assert.ok(Math.abs(a[a.length - 1] - 1.9) < 1e-6);
  const b = planFrameTimes(0, 100, 10, 120);
  assert.equal(b.length, 120, '超出帧数上限时抽稀而不是丢弃尾部');
  assert.equal(b[0], 0);
  assert.ok(b[b.length - 1] < 100);
  assert.deepEqual(planFrameTimes(5, 5, 10), [5]);
  assert.equal(planFrameTimes(-3, -1, 10)[0], 0, '负数被夹到 0');
  assert.equal(frameDelayMs(b, 100), Math.round(100000 / 120));
});
