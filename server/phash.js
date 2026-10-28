import sharp from 'sharp';

/**
 * 感知哈希（pHash）
 * 32×32 灰度 → DCT-II → 取左上 8×8 低频 → 以中位数为阈值生成 64bit 指纹
 */

const N = 32;
const LOW = 8;
let COS = null;

function cosTable() {
  if (COS) return COS;
  COS = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let x = 0; x < N; x++) {
      COS[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
  }
  return COS;
}

function dctLowFreq(gray) {
  const cos = cosTable();
  const tmp = new Float64Array(N * N);
  const out = new Float64Array(N * N);
  const a0 = 1 / Math.sqrt(N);
  const a1 = Math.sqrt(2 / N);

  // 行变换
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      const alpha = u === 0 ? a0 : a1;
      let sum = 0;
      const base = u * N;
      for (let x = 0; x < N; x++) sum += gray[y * N + x] * cos[base + x];
      tmp[y * N + u] = alpha * sum;
    }
  }
  // 列变换
  for (let v = 0; v < N; v++) {
    const alpha = v === 0 ? a0 : a1;
    for (let u = 0; u < N; u++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += tmp[y * N + u] * cos[v * N + y];
      out[v * N + u] = alpha * sum;
    }
  }
  return out;
}

/** 32×32 灰度图（长度 1024、单通道）→ pHash */
export function phashFromGrey32(grey) {
  const gray = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) gray[i] = grey[i];

  const dct = dctLowFreq(gray);

  const block = [];
  for (let v = 0; v < LOW; v++) {
    for (let u = 0; u < LOW; u++) block.push(dct[v * N + u]);
  }
  const sorted = block.slice(1).sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  let bits = '';
  for (let i = 0; i < block.length; i++) bits += block[i] > median ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

/** 路径 / Buffer → pHash（缩到 32×32 灰度后走同一套 DCT） */
export async function computePHash(input) {
  const raw = await sharp(input, { failOn: 'none' })
    .resize(N, N, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return phashFromGrey32(raw.data);
}

/**
 * 差异哈希（dHash，64bit）：9×8 灰度图上比较水平相邻像素亮度梯度。
 * 与 pHash 互补——纯色/近黑的图 pHash 会退化（低位信息，容易互相撞哈希），
 * dHash 基于梯度，对这类图仍能有效区分。以图搜图用它做第二重校验。
 */
export async function computeDHash(input) {
  const W = 9;
  const H = 8;
  const raw = await sharp(input, { failOn: 'none' })
    .resize(W, H, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = raw.data;
  const channels = raw.info.channels;
  const at = (x, y) => data[(y * W + x) * channels];

  let bits = '';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits += at(x, y) > at(x + 1, y) ? '1' : '0';
    }
  }
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

/** 哈希里 1 的个数：太少/太多说明哈希几乎没有信息量（纯色图），距离不可信 */
export function hashPopcount(hex) {
  if (!hex) return 0;
  let x = BigInt('0x' + hex);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

export function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}
