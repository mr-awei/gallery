/**
 * 手工造一个「无图层、raw 压缩、RGB」的最小 PSD，验证 @webtoon/psd 的合成图路径是否可用。
 * 仓库里没有 PSD 样本，这条路径只能靠构造文件来测。
 * 用法：node scripts/manual/test-psd.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { designThumbJpeg } from '../../server/lib/design-thumb.js';

function makePsd(w, h) {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'latin1');
  header.writeUInt16BE(1, 4); // version
  header.writeUInt16BE(3, 12); // channels
  header.writeUInt32BE(h, 14);
  header.writeUInt32BE(w, 18);
  header.writeUInt16BE(8, 22); // depth
  header.writeUInt16BE(3, 24); // color mode: RGB
  // color mode data / image resources / layer & mask info 三段长度都为 0
  const sections = Buffer.alloc(12);
  const compression = Buffer.alloc(2); // 0 = raw
  const r = Buffer.alloc(w * h, 0x22);
  const g = Buffer.alloc(w * h, 0x99);
  const b = Buffer.alloc(w * h, 0xcc);
  return Buffer.concat([header, sections, compression, r, g, b]);
}

const w = 160;
const h = 120;
const file = path.join(os.tmpdir(), 'gemvault-min.psd');
fs.writeFileSync(file, makePsd(w, h));
console.log('psd bytes', fs.statSync(file).size);

const r = await designThumbJpeg(file);
if (!r) {
  console.log('FAILED：抽不出缩略图');
  process.exit(1);
}
console.log('OK', r.width, 'x', r.height, 'jpeg bytes', r.buffer.length);
