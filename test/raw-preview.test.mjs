import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  bufferReader,
  locatePreviewSegments,
  readEmbeddedPreviews,
  tiffPreviewSegments,
} from '../server/lib/raw-preview.js';
import { designThumbJpeg, isDesignLikePath } from '../server/lib/design-thumb.js';
import { kindOfPath } from '../server/lib/media-kind.js';
import { decodeHeifBuffer, decodeHeifFile } from '../server/lib/heif.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-raw-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function jpegFixture(w = 1200, h = 800, color = '#2563eb') {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}

/** 手工拼一个 TIFF：IFD0 里放宽高 + 预览指针，预览 JPEG 追加在目录后面 */
function buildTiff({ jpeg, width = 1200, height = 800, viaSubIfd = false, viaStrip = false }) {
  const HEADER = 8;
  const n0 = viaSubIfd ? 1 : viaStrip ? 6 : 4;
  const ifd0Size = 2 + n0 * 12 + 4;
  const ifd0 = HEADER;
  const subIfd = ifd0 + ifd0Size + 8;
  const subIfdSize = 2 + 4 * 12 + 4;
  const jpegAt = viaSubIfd ? subIfd + subIfdSize + 8 : ifd0 + ifd0Size + 8;

  const buf = Buffer.alloc(jpegAt + jpeg.length);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifd0, 4);

  const entry = (base, i, tag, type, count, value) => {
    const at = base + 2 + i * 12;
    buf.writeUInt16LE(tag, at);
    buf.writeUInt16LE(type, at + 2);
    buf.writeUInt32LE(count, at + 4);
    buf.writeUInt32LE(value, at + 8);
  };

  if (viaSubIfd) {
    buf.writeUInt16LE(1, ifd0);
    entry(ifd0, 0, 0x014a, 4, 1, subIfd); // SubIFDs
    buf.writeUInt32LE(0, ifd0 + 2 + 12);

    buf.writeUInt16LE(4, subIfd);
    entry(subIfd, 0, 0x0100, 4, 1, width);
    entry(subIfd, 1, 0x0101, 4, 1, height);
    entry(subIfd, 2, 0x0201, 4, 1, jpegAt); // JPEGInterchangeFormat
    entry(subIfd, 3, 0x0202, 4, 1, jpeg.length);
    buf.writeUInt32LE(0, subIfd + 2 + 4 * 12);
  } else if (viaStrip) {
    buf.writeUInt16LE(6, ifd0);
    entry(ifd0, 0, 0x0100, 4, 1, width);
    entry(ifd0, 1, 0x0101, 4, 1, height);
    entry(ifd0, 2, 0x0102, 3, 1, 8); // BitsPerSample
    entry(ifd0, 3, 0x0103, 3, 1, 7); // Compression = JPEG
    entry(ifd0, 4, 0x0111, 4, 1, jpegAt); // StripOffsets
    entry(ifd0, 5, 0x0117, 4, 1, jpeg.length); // StripByteCounts
    buf.writeUInt32LE(0, ifd0 + 2 + 6 * 12);
  } else {
    buf.writeUInt16LE(4, ifd0);
    entry(ifd0, 0, 0x0100, 4, 1, width);
    entry(ifd0, 1, 0x0101, 4, 1, height);
    entry(ifd0, 2, 0x0201, 4, 1, jpegAt);
    entry(ifd0, 3, 0x0202, 4, 1, jpeg.length);
    buf.writeUInt32LE(0, ifd0 + 2 + 4 * 12);
  }
  jpeg.copy(buf, jpegAt);
  return buf;
}

/** ISO-BMFF 盒子 */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

const CRX_UUID = Buffer.from('85c0b687820f11e08111f4ce462b6a48', 'hex');

test('TIFF：从 IFD0 的 JPEGInterchangeFormat 精确取到预览段', async () => {
  const jpeg = await jpegFixture();
  const buf = buildTiff({ jpeg });
  const segs = tiffPreviewSegments(bufferReader(buf).read, buf.length);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'jpeg');
  assert.equal(segs[0].length, jpeg.length);
});

test('TIFF：预览挂在 SubIFD 上也能找到（NEF/ARW 的常见布局）', async () => {
  const jpeg = await jpegFixture(1600, 1000);
  const buf = buildTiff({ jpeg, viaSubIfd: true });
  const segs = tiffPreviewSegments(bufferReader(buf).read, buf.length);
  assert.ok(segs.length >= 1);
  assert.equal(segs[0].length, jpeg.length);
});

test('TIFF：JPEG 压缩的条带预览按 StripOffsets 取（DNG 常见）', async () => {
  const jpeg = await jpegFixture(1400, 900);
  const buf = buildTiff({ jpeg, viaStrip: true });
  const segs = tiffPreviewSegments(bufferReader(buf).read, buf.length);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'jpeg');
  assert.ok(segs[0].strips?.length);
});

test('TIFF：12/14 位单通道的「无损 JPEG 原始数据」不会被当成预览', async () => {
  const jpeg = await jpegFixture(1400, 900);
  const buf = buildTiff({ jpeg, viaStrip: true });
  // 把 BitsPerSample 改成 14、SamplesPerPixel 加上单通道：应被判定为传感器数据
  const reader = bufferReader(buf);
  const segs = tiffPreviewSegments(reader.read, buf.length);
  assert.equal(segs.length, 1, '先确认基准可解析');
  // 直接构造一个 14bit 的 TIFF
  const raw = buildTiff({ jpeg, viaStrip: true });
  raw.writeUInt16LE(14, 8 + 2 + 2 * 12 + 8); // 0x0102 的 value 字段
  // IFD0 目录里再加一个 SamplesPerPixel=1 的标签不方便，这里只验证 bits 会被筛掉
  assert.equal(tiffPreviewSegments(bufferReader(raw).read, raw.length).length, 0);
});

test('RAF：头部 84/88 字节给出 JPEG 偏移与长度', async () => {
  const jpeg = await jpegFixture(1500, 1000);
  const head = Buffer.alloc(104);
  head.write('FUJIFILMCCD-RAW ', 0, 'latin1');
  head.writeUInt32BE(104, 84);
  head.writeUInt32BE(jpeg.length, 88);
  const buf = Buffer.concat([head, jpeg]);
  const segs = locatePreviewSegments(bufferReader(buf), 'raf');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].offset, 104);
  assert.equal(segs[0].length, jpeg.length);
});

test('CR3：PRVW 盒子嵌在 uuid/moov 里也能定位，并跳过盒内前缀', async () => {
  const jpeg = await jpegFixture(1620, 1080);
  const prvw = box('PRVW', Buffer.concat([Buffer.alloc(4), jpeg]));
  const buf = Buffer.concat([
    box('ftyp', Buffer.from('crx  \0\0\0\0crx ', 'latin1')),
    box('moov', box('uuid', Buffer.concat([CRX_UUID, prvw]))),
  ]);
  const segs = locatePreviewSegments(bufferReader(buf), 'cr3');
  assert.equal(segs.length, 1);

  const file = path.join(tmp, 'cr3-sample.cr3');
  fs.writeFileSync(file, buf);
  const read = await readEmbeddedPreviews(file, 'cr3');
  assert.equal(read.jpeg.length, 1);
  assert.equal(read.jpeg[0][0], 0xff);
  assert.equal(read.jpeg[0][1], 0xd8);
  assert.equal(read.jpeg[0].length, jpeg.length);
});

test('designThumbJpeg：.dng 走容器解析直接出图', async () => {
  const jpeg = await jpegFixture(1200, 800);
  const file = path.join(tmp, 'shot.dng');
  fs.writeFileSync(file, buildTiff({ jpeg, viaSubIfd: true }));
  const r = await designThumbJpeg(file);
  assert.ok(r, '应能从 TIFF 目录里抽到预览');
  assert.equal(r.width, 1200);
  assert.equal(r.height, 800);
});

test('HEIC：非 HEIF 数据返回 null，不抛错', async () => {
  assert.equal(await decodeHeifBuffer(Buffer.from('definitely not heic')), null);
  assert.equal(await decodeHeifFile(path.join(tmp, 'nope.heic')), null);
});

test('HEIC 走「抽预览」通道：sharp 解不了，但仍按图片归类', () => {
  assert.equal(isDesignLikePath('IMG_0001.heic'), true);
  assert.equal(isDesignLikePath('IMG_0001.hif'), true);
  assert.equal(kindOfPath('IMG_0001.heic'), 'image');
});

test('新的相机扩展名都归类为 raw，HEIC 仍是 image', () => {
  for (const ext of ['x3f', 'crw', 'iiq', 'mos', 'mef', 'dcr', 'k25', 'erf', 'rwl', 'gpr', 'fff', 'ori', 'srw']) {
    assert.equal(kindOfPath(`a.${ext}`), 'raw', `${ext} 应归为 raw`);
  }
  assert.equal(kindOfPath('IMG_0001.HEIC'), 'image');
  assert.equal(kindOfPath('IMG_0001.hif'), 'image');
});
