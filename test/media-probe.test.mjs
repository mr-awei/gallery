import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeMedia } from '../server/lib/media-probe.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-probe-test-'));

function write(name, buf) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** 拼一个 mp4 box：4 字节大小 + 4 字节类型 + body */
function box(type, body) {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(8 + body.length, 0);
  b.write(type, 4, 'latin1');
  body.copy(b, 8);
  return b;
}

/** 构造只含 ftyp + moov 的最小 mp4，moov 内带 mvhd(时长) 与 trak/tkhd(宽高) */
function buildMp4({ seconds = 5, width = 1920, height = 1080, timescale = 1000 } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'latin1'));

  const mvhdBody = Buffer.alloc(100);
  mvhdBody[0] = 0; // version 0
  mvhdBody.writeUInt32BE(timescale, 12);
  mvhdBody.writeUInt32BE(Math.round(seconds * timescale), 16);
  const mvhd = box('mvhd', mvhdBody);

  const tkhdBody = Buffer.alloc(84);
  tkhdBody[0] = 0; // version 0
  tkhdBody.writeUInt32BE(width * 65536, 76);
  tkhdBody.writeUInt32BE(height * 65536, 80);
  const tkhd = box('tkhd', tkhdBody);

  const moov = box('moov', Buffer.concat([mvhd, box('trak', tkhd)]));
  return Buffer.concat([ftyp, moov]);
}

/** 最小 EBML 元素：ID 用规范字节写，size 用 vint */
function el(idHex, payload) {
  const id = Buffer.from(idHex.replace(/\s/g, ''), 'hex');
  const size = payload.length;
  let len = 1;
  while (size >= Math.pow(2, 7 * len) - 1) len++;
  const sizeBuf = Buffer.alloc(len);
  let v = size;
  for (let i = len - 1; i >= 0; i--) {
    sizeBuf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  sizeBuf[0] |= 0x80 >> (len - 1);
  return Buffer.concat([id, sizeBuf, payload]);
}

function buildWebm({ seconds = 3, width = 1280, height = 720 } = {}) {
  const header = el('1a45dfa3', el('4286', Buffer.from('webm', 'latin1')));
  const scale = el('2ad7b1', Buffer.from([0x0f, 0x42, 0x40])); // 1_000_000 ns
  const dur = Buffer.alloc(4);
  dur.writeFloatBE(seconds * 1000, 0); // Duration 单位 = 毫秒（TimecodeScale/1e6）
  const duration = el('4489', dur);
  const info = el('1549a966', Buffer.concat([scale, duration]));
  const video = el('e0', Buffer.concat([
    el('b0', Buffer.from([width >> 8, width & 0xff])),
    el('ba', Buffer.from([height >> 8, height & 0xff])),
  ]));
  const trackEntry = el('ae', video);
  const tracks = el('1654ae6b', trackEntry);
  const segment = el('18538067', Buffer.concat([info, tracks]));
  return Buffer.concat([header, segment]);
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('mp4：读出时长与分辨率', () => {
  const p = write('a.mp4', buildMp4({ seconds: 5, width: 1920, height: 1080 }));
  const meta = probeMedia(p);
  assert.equal(meta.duration, 5);
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
});

test('mp4：不同时长/尺寸按容器头计算', () => {
  const p = write('b.mp4', buildMp4({ seconds: 12.5, width: 640, height: 360 }));
  const meta = probeMedia(p);
  assert.equal(meta.duration, 12.5);
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 360);
});

test('webm：读出时长与分辨率', () => {
  const p = write('c.webm', buildWebm({ seconds: 3, width: 1280, height: 720 }));
  const meta = probeMedia(p);
  assert.equal(meta.duration, 3);
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 720);
});

test('未知格式返回全 0，不抛异常', () => {
  const p = write('note.mp4', Buffer.from('this is definitely not a video'));
  assert.deepEqual(probeMedia(p), { duration: 0, width: 0, height: 0 });
});

test('文件不存在返回全 0', () => {
  assert.deepEqual(probeMedia(path.join(tmp, 'missing.mp4')), { duration: 0, width: 0, height: 0 });
});

test('空文件返回全 0', () => {
  const p = write('empty.mp4', Buffer.alloc(0));
  assert.deepEqual(probeMedia(p), { duration: 0, width: 0, height: 0 });
});
