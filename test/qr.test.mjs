/**
 * QR 生成器回归：本仓没有 QR 解码库，用一个独立的「反向读取」实现做往返验证。
 * 逆向过程不复用 encodeQr 的中间结果，只共享 ISO 18004 的常量表，
 * 因此能抓出数据摆放顺序、掩码、format bits、RS 交织等绝大多数实现错误。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, getNumRawDataModules, qrSvg } from '../server/lib/qr.js';

const ECC_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const NUM_BLOCKS = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** 独立重建「功能图形」占位图（与生成器摆放数据时的跳过规则对应） */
function functionMap(ver) {
  const size = ver * 4 + 17;
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  const set = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = 1;
  };
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) set(cx + dx, cy + dy);
  }
  for (let i = 0; i < size; i++) {
    set(6, i);
    set(i, 6);
  }
  for (let i = 0; i <= 8; i++) {
    set(8, i);
    set(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8);
    set(8, size - 1 - i);
  }
  set(8, size - 8);
  const pos = alignmentPositions(ver, size);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[j] + dx, pos[i] + dy);
    }
  }
  if (ver >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b);
      set(b, a);
    }
  }
  return fn;
}

function readFormatBits(modules, size) {
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= modules[i][8] << i;
  bits |= modules[7][8] << 6;
  bits |= modules[8][8] << 7;
  bits |= modules[8][7] << 8;
  for (let i = 9; i < 15; i++) bits |= modules[8][14 - i] << i;
  return bits ^ 0x5412;
}

function readCodewords(modules, fn, size, mask) {
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        bits.push(modules[y][x] ^ (MASKS[mask](x, y) ? 1 : 0));
      }
    }
  }
  const out = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
    out.push(v);
  }
  return out;
}

/** 往返：从矩阵解出 byte mode 原文，并与输入逐字相等 */
function decodeText(modules, ver) {
  const size = ver * 4 + 17;
  const fmt = readFormatBits(modules, size);
  const data = fmt >>> 10;
  const rem = fmt & 0x3ff;
  let check = data;
  for (let i = 0; i < 10; i++) check = (check << 1) ^ ((check >>> 9) * 0x537);
  assert.equal(check & 0x3ff, rem, 'format bits 的 BCH 校验不一致');
  assert.equal(data >>> 3, 1, 'ECC level 应为 L');
  const mask = data & 7;

  const cw = readCodewords(modules, functionMap(ver), size, mask);
  assert.equal(cw.length, Math.floor(getNumRawDataModules(ver) / 8));
  const blocks = NUM_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const shortLen = Math.floor(cw.length / blocks);
  const numShort = blocks - (cw.length % blocks);
  const lens = Array.from({ length: blocks }, (_, i) => shortLen - eccLen + (i < numShort ? 0 : 1));
  const dat = lens.map(() => []);
  let p = 0;
  for (let i = 0; i < Math.max(...lens); i++) {
    for (let j = 0; j < blocks; j++) if (i < lens[j]) dat[j][i] = cw[p++];
  }
  const bitOf = (bytes) => {
    const out = [];
    for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >>> i) & 1);
    return out;
  };
  // 编码时原始码字按块顺序切分，多块版本要把各块数据顺序拼回来再解析
  const b = bitOf(dat.flat());
  const read = (n, at) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | b[at + i];
    return v;
  };
  assert.equal(read(4, 0), 4, 'mode 必须是 byte mode');
  const countBits = ver <= 9 ? 8 : 16;
  const len = read(countBits, 4);
  const chars = [];
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | b[4 + countBits + i * 8 + k];
    chars.push(v);
  }
  return Buffer.from(chars).toString('utf8');
}

test('结构：尺寸、三个定位图形、时序图形、dark module', () => {
  const { version, size, modules } = encodeQr('http://192.168.1.7:3001/?token=abc123');
  assert.ok(version >= 1 && version <= 10);
  assert.equal(size, version * 4 + 17);
  assert.equal(modules.length, size);
  const finder = (dx, dy) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(modules[dy + y][dx + x], ring === 2 ? 0 : 1, `定位图形 ${dx},${dy} / ${x},${y}`);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, '横向时序');
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, '纵向时序');
  }
  assert.equal(modules[size - 8][8], 1, 'dark module');
});

test('往返解码：短 URL / 中文 / 跨 version 的长文本都能还原', () => {
  const samples = [
    'http://192.168.1.7:3001/?token=abc123',
    'http://10.0.0.5:42135/?token=Zm9vYmFyYmF6cXV1eA',
    '图库投送',
    'A'.repeat(120),
    'https://example.com/lan?token=' + 'x'.repeat(200),
  ];
  for (const text of samples) {
    const { version, modules } = encodeQr(text);
    assert.equal(decodeText(modules, version), text, `往返失败：${text.slice(0, 30)}… (v${version})`);
  }
});

test('掩码选择是确定的；SVG 含静区且横向黑块已合并', () => {
  const text = 'http://192.168.1.7:3001/?token=abc123';
  const a = encodeQr(text);
  const b = encodeQr(text);
  assert.deepEqual(a.modules, b.modules);
  const svg = qrSvg(text);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes(`viewBox="0 0 ${a.size + 8} ${a.size + 8}"`), '默认 4 模块静区');
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  assert.ok((svg.match(/<rect /g) || []).length < a.size * a.size / 3, '横向连续黑块应合并');
  assert.ok(!svg.includes('<script'), 'SVG 不能夹带脚本');
});

test('空内容与超长内容明确报错', () => {
  assert.throws(() => encodeQr(''), /不能为空/);
  assert.throws(() => qrSvg('x'.repeat(2000)), /内容过长/);
});
