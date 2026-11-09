// @ts-check
/**
 * 纯底图抠图：把「单一颜色背景」的图变成透明背景 PNG。
 *
 * 为什么单独做一个（除了 AI 抠图）：库里大量商品图是白底/灰底/纯色底棚拍，
 * 这类图的背景是**数学上可判定的**——不需要 4.5MB 的人像分割模型，
 * 也不需要等模型下载；用 U-2-Net 抠保温桶只会得到一片空白。
 *
 * 算法（纯像素，零模型）：
 * 1. 从四条边采样求背景中位色 —— 任意纯色都行（白、灰、蓝、绿幕），不写死白色；
 * 2. 容差自适应：取边缘像素与背景色差的 90 分位，背景有轻微渐变/暗角也能吃掉；
 * 3. **从边缘做连通域漫水**，而不是「所有接近背景色的像素都算背景」：
 *    后者会把主体内部的白色高光、镜面反射打出洞来（保温桶、白鞋、瓷器全中招）；
 * 4. alpha 做一次 3×3 均值去掉锯齿，再放大回原分辨率与 RGB 合成。
 *
 * 与 lib/subject.js 的区别：那边只要包围盒（给 pHash 用，512px 中间图就够），
 * 这边要全分辨率的 alpha 通道。
 */
import sharp from 'sharp';

/** 计算 alpha 的中间图长边：再大对抠图精度没帮助，只会拖慢漫水 */
const SCAN_MAX = 2048;
/** 容差下限/上限（0~255 的通道差） */
const TOL_MIN = 14;
const TOL_MAX = 84;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 3×3 均值（边界夹边），给 alpha 去锯齿 */
function blur3(src, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < H - 1 ? y + 1 : H - 1;
    for (let x = 0; x < W; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < W - 1 ? x + 1 : W - 1;
      let acc = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * W;
        for (let xx = x0; xx <= x1; xx++) acc += src[row + xx];
      }
      out[y * W + x] = acc / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return out;
}

/** 从四边采样：背景中位色 + 背景色差分布（90 分位） */
function backgroundStats(data, W, H) {
  const at = (i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
  const picks = [];
  const stepX = Math.max(1, Math.floor(W / 64));
  const stepY = Math.max(1, Math.floor(H / 64));
  for (let x = 0; x < W; x += stepX) {
    picks.push(x);
    picks.push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y += stepY) {
    picks.push(y * W);
    picks.push(y * W + (W - 1));
  }
  const cols = [0, 1, 2].map((k) => picks.map((i) => at(i)[k]).sort((a, b) => a - b));
  const bg = cols.map((c) => c[c.length >> 1] || 0);

  const dists = picks
    .map((i) => {
      const p = at(i);
      return Math.max(Math.abs(p[0] - bg[0]), Math.abs(p[1] - bg[1]), Math.abs(p[2] - bg[2]));
    })
    .sort((a, b) => a - b);
  const p90 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.9))] || 0;
  return { bg, spread: p90, tol: clamp(p90 * 1.9, TOL_MIN, TOL_MAX) };
}

/**
 * 纯底图抠图。
 * @param {string} inputPath
 * @returns {Promise<{buffer: Buffer, width: number, height: number, coverage: number, warning: string, bg: number[]}>}
 */
export async function removeFlatBackground(inputPath) {
  const meta = await sharp(inputPath, { failOn: 'none' }).metadata();
  const OW = meta.width || 0;
  const OH = meta.height || 0;
  if (!OW || !OH) throw new Error('无法读取图片尺寸');

  // 1. 中间图（含 EXIF 旋转，与后续合成用的原图方向一致）
  const mid = await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .resize(SCAN_MAX, SCAN_MAX, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = mid.info.width;
  const H = mid.info.height;
  const data = mid.data;
  if (!W || !H) throw new Error('无法读取图片尺寸');

  const { bg, spread, tol } = backgroundStats(data, W, H);

  // 2. 从四条边漫水：只吃掉「与边界连通」且颜色接近背景的像素
  const n = W * H;
  const isBg = new Uint8Array(n);
  const queue = new Uint32Array(n);
  let head = 0;
  let tail = 0;

  const near = (i) => {
    const p = i * 3;
    return (
      Math.abs(data[p] - bg[0]) <= tol &&
      Math.abs(data[p + 1] - bg[1]) <= tol &&
      Math.abs(data[p + 2] - bg[2]) <= tol
    );
  };
  const push = (i) => {
    if (isBg[i]) return;
    if (!near(i)) return;
    isBg[i] = 1;
    queue[tail++] = i;
  };

  for (let x = 0; x < W; x++) {
    push(x);
    push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    push(y * W);
    push(y * W + W - 1);
  }

  let covered = 0;
  while (head < tail) {
    const i = queue[head++];
    covered++;
    const x = i % W;
    const y = (i - x) / W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }

  // 3. alpha：背景 0、前景 255，再做一次 3×3 均值去锯齿
  const alphaSrc = new Float32Array(n);
  for (let i = 0; i < n; i++) alphaSrc[i] = isBg[i] ? 0 : 255;
  const alphaSoft = blur3(alphaSrc, W, H);

  const coverage = 1 - covered / n;

  // 4. 放大回原分辨率，与原始 RGB 合成 RGBA PNG
  //    注意 toColourspace('b-w')：sharp 会把单通道 raw 当灰度图，resize 后若不加这句
  //    会输出 3 通道，字节索引全错位（alpha 会变成 RGB 交错里的某个分量）
  const alphaU8 = Uint8Array.from(alphaSoft, (v) => clamp(Math.round(v), 0, 255));
  const alphaFull = await sharp(Buffer.from(alphaU8.buffer, alphaU8.byteOffset, alphaU8.byteLength), {
    raw: { width: W, height: H, channels: 1 },
  })
    .resize(OW, OH, { kernel: 'lanczos3' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();

  const base = await sharp(inputPath, { failOn: 'none' }).rotate().removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(OW * OH * 4);
  for (let i = 0; i < OW * OH; i++) {
    rgba[i * 4] = base[i * 3];
    rgba[i * 4 + 1] = base[i * 3 + 1];
    rgba[i * 4 + 2] = base[i * 3 + 2];
    rgba[i * 4 + 3] = alphaFull[i];
  }
  const buffer = await sharp(rgba, { raw: { width: OW, height: OH, channels: 4 } }).png().toBuffer();

  let warning = '';
  if (coverage < 0.01) warning = '几乎没抠出主体（背景可能不是纯色，或主体与背景颜色太接近）';
  else if (coverage > 0.985) warning = '背景没被抠掉（这张图可能不是纯色底，或主体颜色与背景太接近）';
  else if (spread > 30) warning = '背景不太均匀（有渐变或阴影），边缘可能留下残影，建议改用 AI 抠图';

  return {
    buffer,
    width: OW,
    height: OH,
    coverage: +coverage.toFixed(4),
    bg,
    warning,
  };
}
