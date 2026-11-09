import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { designThumbJpeg, largestJpeg, orientedSize } from '../server/lib/design-thumb.js';
import { kindOfPath } from '../server/lib/media-kind.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-design-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 造一张真实 JPEG（sharp 编码，保证是合法图像） */
async function jpegFixture(w = 1200, h = 800, color = '#3b82f6') {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}

test('设计文件与 RAW 各自归类，不再落进 other', () => {
  assert.equal(kindOfPath('a.psd'), 'design');
  assert.equal(kindOfPath('b.ai'), 'design');
  assert.equal(kindOfPath('c.sketch'), 'design');
  assert.equal(kindOfPath('DSC_0001.NEF'), 'raw');
  assert.equal(kindOfPath('IMG_0001.cr3'), 'raw');
  // 图片仍然走 image，别被新加的 design 抢走
  assert.equal(kindOfPath('a.jpg'), 'image');
});

test('largestJpeg：从 RAW 那样的二进制里挑出最大的内嵌 JPEG', async () => {
  const small = await jpegFixture(200, 150);
  const big = await jpegFixture(1600, 1200);
  // 模拟 RAW：TIFF 头 + 小预览 + 传感器数据 + 大预览
  const buf = Buffer.concat([Buffer.alloc(4096, 0x11), small, Buffer.alloc(8192, 0x22), big, Buffer.alloc(1024, 0x33)]);
  const found = largestJpeg(buf);
  assert.ok(found, '应能找到内嵌 JPEG');
  assert.equal(found.length, big.length, '取最大的那段，不是第一个');
});

test('largestJpeg：只有图标级碎片时返回 null（避免生成糊图）', () => {
  const tiny = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0), Buffer.from([0xff, 0xd9])]);
  assert.equal(largestJpeg(tiny), null);
});

test('designThumbJpeg：Sketch（zip）取 previews/preview.png', async () => {
  const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#16a34a' } }).png().toBuffer();
  const zip = new JSZip();
  zip.file('previews/preview.png', png);
  zip.file('document.json', '{}');
  const file = path.join(tmp, 'demo.sketch');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));

  const r = await designThumbJpeg(file);
  assert.ok(r, '应抽出缩略图');
  assert.ok(r.buffer.length > 0);
  assert.equal(r.width, 900);
  assert.equal(r.height, 600);
  const meta = await sharp(r.buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.ok(meta.width <= 640, '缩略图长边不超过 640');
});

test('designThumbJpeg：RAW 无专用解析时靠内嵌 JPEG 兜底', async () => {
  const big = await jpegFixture(1400, 1000);
  const file = path.join(tmp, 'shot.nef');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(2048, 0x55), big]));

  const r = await designThumbJpeg(file);
  assert.ok(r);
  assert.equal(r.width, 1400);
  assert.equal(r.height, 1000);
});

test('designThumbJpeg：AI 文件里嵌了位图也能出缩略图', async () => {
  const jpg = await jpegFixture(1000, 700);
  const file = path.join(tmp, 'poster.ai');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('%PDF-1.6\n', 'latin1'), jpg, Buffer.from('\n%%EOF', 'latin1')]));

  const r = await designThumbJpeg(file);
  assert.ok(r, 'AI 应回退到内嵌位图');
  assert.equal(r.width, 1000);
});

/** 造一个无图层的最小 PSD：raw 或 RLE 压缩，RGB 8bit */
function makePsd({ w, h, rle = false, rgb = [34, 153, 204] }) {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'latin1');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12);
  header.writeUInt32BE(h, 14);
  header.writeUInt32BE(w, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24);
  const sections = Buffer.alloc(12); // 三个长度字段都为 0
  const planes = [];
  for (let c = 0; c < 3; c++) planes.push(Buffer.alloc(w * h, rgb[c]));
  if (!rle) {
    const comp = Buffer.alloc(2, 0);
    return Buffer.concat([header, sections, comp, ...planes]);
  }
  // 每行一个 literal run：首字节 w-1（w<=128 时合法），后跟该行全部字节
  const row = Buffer.alloc(1 + w);
  row[0] = w - 1;
  const encoded = [];
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      row.fill(rgb[c], 1);
      encoded.push(Buffer.from(row));
    }
  }
  const table = Buffer.alloc(3 * h * 2);
  let off = 0;
  let total = 0;
  for (let i = 0; i < 3 * h; i++) {
    table.writeUInt16BE(1 + w, off);
    off += 2;
    total += 1 + w;
  }
  const comp = Buffer.alloc(2);
  comp.writeUInt16BE(1, 0);
  return Buffer.concat([header, sections, comp, table, ...encoded]);
}

test('designThumbJpeg：PSD 走自研合成图解码（raw 压缩）', async () => {
  const file = path.join(tmp, 'flat.psd');
  fs.writeFileSync(file, makePsd({ w: 160, h: 120 }));
  const r = await designThumbJpeg(file);
  assert.ok(r, 'PSD 应能解出合成图');
  assert.equal(r.width, 160);
  assert.equal(r.height, 120);
});

test('designThumbJpeg：PSD 的 RLE 压缩也能解', async () => {
  const file = path.join(tmp, 'rle.psd');
  fs.writeFileSync(file, makePsd({ w: 100, h: 40, rle: true, rgb: [200, 40, 90] }));
  const r = await designThumbJpeg(file);
  assert.ok(r, 'RLE PSD 应能解出合成图');
  assert.equal(r.width, 100);
  assert.equal(r.height, 40);
  // 解出来的颜色要对（否则 RLE 行长/字节序错了也能「成功」）
  const { data } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
  assert.ok(Math.abs(data[0] - 200) < 12, `R 通道应接近 200，实际 ${data[0]}`);
});

test('orientedSize：5~8 表示画面转了 90°，宽高必须互换', () => {
  assert.deepEqual(orientedSize(5472, 3648, 1), { width: 5472, height: 3648 });
  assert.deepEqual(orientedSize(5472, 3648, 3), { width: 5472, height: 3648 });
  for (const o of [5, 6, 7, 8]) {
    assert.deepEqual(orientedSize(5472, 3648, o), { width: 3648, height: 5472 }, `orientation ${o}`);
  }
});

test('designThumbJpeg：竖拍 RAW（内嵌预览带 orientation=6）要摆正并互换宽高', async () => {
  // 相机竖拍的典型数据：像素是横的 1400×1000，靠 EXIF 说「要顺时针转 90°」
  const landscape = await sharp({ create: { width: 1400, height: 1000, channels: 3, background: '#f59e0b' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const file = path.join(tmp, 'portrait.nef');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(2048, 0x55), landscape]));

  const r = await designThumbJpeg(file);
  assert.ok(r, '应抽出缩略图');
  assert.equal(r.width, 1000, '宽高要按屏幕方向给出');
  assert.equal(r.height, 1400);
  const meta = await sharp(r.buffer).metadata();
  assert.equal(meta.width, 640, '缩略图缩到 640 宽');
  assert.ok(meta.height > meta.width, `缩略图像素本身也要摆正（以前是躺倒的 640×457），实际 ${meta.width}×${meta.height}`);
});

test('designThumbJpeg：什么都抽不出来时返回 null，不抛错', async () => {
  const file = path.join(tmp, 'empty.psd');
  fs.writeFileSync(file, Buffer.alloc(4096, 0));
  assert.equal(await designThumbJpeg(file), null);
});
