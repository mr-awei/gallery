/**
 * 零依赖 QR Code 生成器（byte mode / ECC L / version 1~10）。
 *
 * 手机扫码投送只需要编码一条 http://192.168.x.x:port/?token=... 的短 URL，
 * 为此引入 qrcode 之类的整包依赖并不划算。这里按 ISO/IEC 18004 实现最小可用路径：
 * 位缓冲 → RS 纠错 → 分块交织 → 功能图形 → 数据摆放 → 掩码选择。
 * 算法结构参考 Nayuki 的 QR Code generator（公共领域），只保留 byte mode + ECC L。
 *
 * 输出是 0/1 矩阵，由 qrSvg 渲染成可直接 <img> 的 SVG（横向连续黑块合并成一个 rect）。
 */

/** 每版本每个块的纠错码字数（ECC L），index = version */
const ECC_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
/** 纠错块数量（ECC L），index = version */
const NUM_BLOCKS = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const MAX_VERSION = 10;
const ECL_FORMAT_BITS = 1; // ECC L 的格式位

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

/** 原始数据模块数（含余位），决定总码字数 */
export function getNumRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver) {
  return Math.floor(getNumRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

function makeBitBuffer() {
  const bytes = [];
  let len = 0;
  return {
    get length() {
      return len;
    },
    append(val, n) {
      for (let i = n - 1; i >= 0; i--) {
        const idx = len >>> 3;
        if (idx >= bytes.length) bytes.push(0);
        bytes[idx] |= ((val >>> i) & 1) << (7 - (len & 7));
        len++;
      }
    },
    bytes: () => bytes,
  };
}

/** 把文本按 byte mode 编码成（含纠错码字、已交织）的码字序列 */
function encodeCodewords(text, ver) {
  const data = Buffer.from(String(text), 'utf8');
  const capacity = numDataCodewords(ver) * 8;
  const countBits = ver <= 9 ? 8 : 16;
  if (data.length >= 1 << countBits) throw new Error('内容过长，超出 QR byte mode 计数范围');
  const bb = makeBitBuffer();
  bb.append(0x4, 4); // byte mode
  bb.append(data.length, countBits);
  for (const b of data) bb.append(b, 8);
  bb.append(0, Math.min(4, capacity - bb.length)); // terminator
  bb.append(0, (8 - (bb.length % 8)) % 8); // 补齐到字节
  for (let pad = 0xec; bb.length < capacity; pad ^= 0xec ^ 0x11) bb.append(pad, 8);
  const all = Uint8Array.from(bb.bytes());

  const blocks = NUM_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const shortBlockLen = Math.floor(rawCodewords / blocks);
  const numShortBlocks = blocks - (rawCodewords % blocks);
  const divisor = rsDivisor(eccLen);
  const chunks = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const datLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const dat = all.slice(k, k + datLen);
    k += datLen;
    chunks.push({ dat, ecc: rsRemainder(dat, divisor) });
  }
  const result = new Uint8Array(rawCodewords);
  let p = 0;
  const maxDat = Math.max(...chunks.map((c) => c.dat.length));
  for (let i = 0; i < maxDat; i++) {
    for (const c of chunks) if (i < c.dat.length) result[p++] = c.dat[i];
  }
  for (let i = 0; i < eccLen; i++) for (const c of chunks) result[p++] = c.ecc[i];
  if (p !== rawCodewords) throw new Error('QR 码字交织长度不一致');
  return result;
}

function chooseVersion(text) {
  const dataLen = Buffer.byteLength(String(text), 'utf8');
  for (let ver = 1; ver <= MAX_VERSION; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    const need = 4 + countBits + dataLen * 8;
    if (need <= numDataCodewords(ver) * 8) return ver;
  }
  throw new Error(`内容过长（${dataLen} 字节），超出 QR version ${MAX_VERSION} 容量`);
}

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

/**
 * 生成 QR 矩阵。返回 { version, size, modules }，modules[y][x] 为 0/1（不含静区）。
 */
export function encodeQr(text) {
  const value = String(text ?? '');
  if (!value) throw new Error('二维码内容不能为空');
  const ver = chooseVersion(value);
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));
  const codewords = encodeCodewords(value, ver);

  const setFn = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark ? 1 : 0;
    isFunction[y][x] = 1;
  };

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  // 时序图形先画、定位图形后画：后者覆盖前者才是 ISO 18004 的顺序，
  // 反过来会把定位图形第 6 列/行改掉，扫码器直接认不出定位点。
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  const pos = alignmentPositions(ver);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFn(pos[j] + dx, pos[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  const drawFormat = (mask) => {
    const data = (ECL_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
    setFn(8, 7, getBit(bits, 6));
    setFn(8, 8, getBit(bits, 7));
    setFn(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
    setFn(8, size - 8, true); // dark module
  };

  const placeData = (mask) => {
    const fn = MASKS[mask];
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (isFunction[y][x] || i >= codewords.length * 8) continue;
          const bit = getBit(codewords[i >>> 3], 7 - (i & 7)) ? 1 : 0;
          modules[y][x] = bit ^ (fn(x, y) ? 1 : 0);
          i++;
        }
      }
    }
    // version 2~6 有 0~7 个「余位」，它们不属于任何码字，保持 0 即可
    if (i !== codewords.length * 8) throw new Error('QR 数据位摆放不完整');
  };

  // 掩码惩罚：连续同色游程 / 2×2 同色块 / 黑白比例，取分最小的掩码（任意掩码都可解码，这只影响易扫程度）
  const penalty = () => {
    let score = 0;
    const runs = (get) => {
      for (let line = 0; line < size; line++) {
        let run = 1;
        for (let i = 1; i <= size; i++) {
          const same = i < size && get(line, i) === get(line, i - 1);
          if (same) run++;
          else {
            if (run >= 5) score += 3 + (run - 5);
            run = 1;
          }
        }
      }
    };
    runs((y, x) => modules[y][x]);
    runs((x, y) => modules[y][x]);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const v = modules[y][x];
        if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += modules[y][x];
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  };

  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    placeData(mask);
    drawFormat(mask);
    const s = penalty();
    if (s < bestScore) {
      bestScore = s;
      best = mask;
    }
  }
  if (best !== 7) {
    placeData(best);
    drawFormat(best);
  }
  return { version: ver, size, modules };
}

/** 渲染成 SVG（含 4 模块静区）；横向连续黑块合并，避免上万个小 rect */
export function qrSvg(text, options = {}) {
  const { size, modules } = encodeQr(text);
  const quiet = Number.isFinite(options.quiet) ? Math.max(0, Math.floor(options.quiet)) : 4;
  const dim = size + quiet * 2;
  const rects = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!modules[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && modules[y][x + run]) run++;
      rects.push(`<rect x="${x + quiet}" y="${y + quiet}" width="${run}" height="1"/>`);
      x += run;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * 6}" height="${dim * 6}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="投送二维码">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/><g fill="#000000">${rects.join('')}</g></svg>`
  );
}
