import sharp from 'sharp';

/**
 * 图像焦点检测（自动构图）：给一个目标比例，算出「最该保留的那块」。
 *
 * 用途：批量裁切台的「自动检测图像焦点」——上百张图不可能逐张手拖，
 * 先按显著度把框放到主体上，再让用户微调。
 *
 * 算法（纯像素，零模型、零额外依赖，单张 10~30ms）：
 * 1. 缩到 256px 中间图，取 RGB；
 * 2. 算三条与「图里有什么」无关的通用线索（人像、风景、商品、截图、动漫都吃）：
 *    - 局部对比度：梯度图做 7×7 均值，得到「整片有细节的区域」而不是一条条细线；
 *      再按 95 分位归一化，避免高反差图把可用区间吃满
 *    - 颜色稀有度：RGB 各取 3bit 量化后统计频率，越少见的颜色越显著。
 *      这是「主体 vs 背景」的主判据：白底商品、蓝天前的建筑、草地上的红衣服
 *      都靠它区分。3bit 是为了让天空/虚化背景这类渐变并进同一格，
 *      否则「每个色号都少见」会让整片背景都变显著
 *    - 饱和度（弱）、中心先验（弱）、边缘轻微抑制
 * 3. 肤色只是**加分项不是主判据**：仅当全图肤色像素占比落在合理区间
 *    （真的像有人）时才启用，权重也比通用线索低一档 —— 没有人脸的图
 *    完全不吃这一项，不会被「有没有脸」绑架。
 * 4. 积分图 + 滑窗：在目标比例的最大可用窗口里枚举位置，取权重和最大者；
 *    与最高分相差 1.5% 以内的多个候选里，再取最靠近权重质心的那个，
 *    避免「亮角落」把框吸到边缘。
 *
 * 全部输出归一化坐标（0..1），与 /api/images/:id/crop 的 rect 同构。
 */

const SCAN = 256; // 中间图最长边：够分辨主体轮廓，又保证毫秒级
const CENTER_SIGMA = 0.42; // 中心先验的高斯宽度（归一化半径）
const EDGE_FADE = 0.1; // 边缘 10% 内的轻微抑制宽度

// 线索权重：局部对比度与颜色稀有度是主判据，肤色的份额刻意压到 ~15%
const W_CONTRAST = 1.0;
const W_RARITY = 0.85;
const W_SAT = 0.2;
const W_CENTER = 0.12;
const W_SKIN = 0.3;
// 肤色只在「像是有人的占比」区间内启用：太小是误检，太大是暖色场景（沙漠/木地板）
const SKIN_MIN = 0.004;
const SKIN_MAX = 0.8;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 可分离 box blur（边界夹边复制），O(W*H)，r 为半径 */
function boxBlur(src, W, H, r) {
  const win = 2 * r + 1;
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + clampI(k, 0, W - 1)];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = acc / win;
      acc -= src[row + clampI(x - r, 0, W - 1)];
      acc += src[row + clampI(x + r + 1, 0, W - 1)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[clampI(k, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / win;
      acc -= tmp[clampI(y - r, 0, H - 1) * W + x];
      acc += tmp[clampI(y + r + 1, 0, H - 1) * W + x];
    }
  }
  return out;
}

/** 取 0..1 分位值（隔点采样 + 排序，65k 像素约 2ms）；全 0 或空时返回 0 */
function percentile(src, p) {
  const step = src.length > 30000 ? 3 : 1;
  const s = [];
  for (let i = 0; i < src.length; i += step) s.push(src[i]);
  if (!s.length) return 0;
  s.sort((a, b) => a - b);
  return s[clampI(Math.floor(s.length * p), 0, s.length - 1)] || 0;
}

/** 解析 '2:3' / '2/3' / '0.75' → [w, h]；无法解析返回 null */
export function parseRatioSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return [clamp(w, 0.05, 20), clamp(h, 0.05, 20)];
    return null;
  }
  const v = Number(s);
  if (Number.isFinite(v) && v > 0) {
    const w = clamp(v, 0.05, 20);
    return [w, 1];
  }
  return null;
}

/**
 * 在 256px 中间图上求显著度权重图（Float32Array），并顺带算出加权质心。
 * 返回 null 表示尺寸异常。
 */
function saliencyWeights(data, W, H, ch) {
  if (!W || !H) return null;
  const n = W * H;
  const grey = new Float32Array(n);
  const sat = new Float32Array(n);
  const skin = new Uint8Array(n);
  const hist = new Uint32Array(512); // 3bit/通道 → 512 格
  let skinCount = 0;

  for (let i = 0, p = 0; i < n; i++, p += ch) {
    const r = data[p];
    const g = ch > 1 ? data[p + 1] : r;
    const b = ch > 2 ? data[p + 2] : r;
    grey[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sat[i] = mx > 0 ? (mx - mn) / mx : 0;
    hist[((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)]++;
    // 肤色：暖色 + 红通道占优（对黄/棕肤色也成立，白炽灯偏黄不误判为纯白）
    if (r > 60 && r > g * 1.05 && r > b * 1.12 && g > b * 0.75 && r - g > 8) {
      skin[i] = 1;
      skinCount++;
    }
  }

  // 1) 梯度 → 7×7 局部对比度：整片有结构/纹理的区域才显著，孤立的一条高反差线不会抢走框
  const grad = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    const yPrev = y > 0 ? y - 1 : 0;
    const yNext = y < H - 1 ? y + 1 : H - 1;
    for (let x = 0; x < W; x++) {
      const xPrev = x > 0 ? x - 1 : 0;
      const xNext = x < W - 1 ? x + 1 : W - 1;
      const gx = grey[y * W + xNext] - grey[y * W + xPrev];
      const gy = grey[yNext * W + x] - grey[yPrev * W + x];
      grad[y * W + x] = Math.min(1, Math.hypot(gx, gy) / 90);
    }
  }
  const contrast = boxBlur(grad, W, H, 3);
  const contrastP = percentile(contrast, 0.95) || 1;

  // 2) 颜色稀有度：全图同一色（纯色底/天空）→0，主体色 →1。再做一次小半径平滑，免得出麻点
  let maxHist = 0;
  for (let b = 0; b < hist.length; b++) if (hist[b] > maxHist) maxHist = hist[b];
  const rarityRaw = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += ch) {
    const r = data[p];
    const g = ch > 1 ? data[p + 1] : r;
    const b = ch > 2 ? data[p + 2] : r;
    const c = hist[((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)];
    rarityRaw[i] = maxHist > 0 ? 1 - c / maxHist : 0;
  }
  const rarity = boxBlur(rarityRaw, W, H, 2);

  // 3) 融合
  const w = new Float32Array(n);
  const skinRatio = skinCount / n;
  const skinOn = skinRatio >= SKIN_MIN && skinRatio <= SKIN_MAX;
  let sum = 0;
  let sx = 0;
  let sy = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dx = (x + 0.5) / W - 0.5;
      const dy = (y + 0.5) / H - 0.5;
      const center = Math.exp(-(dx * dx + dy * dy) / (2 * CENTER_SIGMA * CENTER_SIGMA));
      // 边缘轻微抑制：贴边的细节多半是背景/倒影，不该把主体顶出去
      const edgeDist = Math.min(Math.min(x + 0.5, W - 0.5 - x) / W, Math.min(y + 0.5, H - 0.5 - y) / H);
      const edge = edgeDist >= EDGE_FADE ? 1 : 0.82 + 0.18 * (edgeDist / EDGE_FADE);

      let v =
        W_CONTRAST * Math.min(1, contrast[i] / contrastP) +
        W_RARITY * rarity[i] +
        W_SAT * sat[i] +
        W_CENTER * center;
      if (skinOn) v += W_SKIN * skin[i];
      v *= edge;

      w[i] = v;
      sum += v;
      sx += v * (x + 0.5);
      sy += v * (y + 0.5);
    }
  }

  // 权重全为 0（纯色图）→ 退回均匀权重，等价居中
  if (sum <= 1e-6) {
    w.fill(1);
    sum = n;
    sx = (W * W) / 2;
    sy = (H * H) / 2;
  }
  return { w, sum, centroid: { x: sx / sum / W, y: sy / sum / H }, skinRatio };
}

/** Float32 权重 → 积分图（float64 前缀和，(W+1)*(H+1)） */
function integralImage(w, W, H) {
  const iw = W + 1;
  const acc = new Float64Array(iw * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += w[y * W + x];
      acc[(y + 1) * iw + (x + 1)] = acc[y * iw + (x + 1)] + rowSum;
    }
  }
  return acc;
}

function sumArea(acc, iw, x0, y0, x1, y1) {
  return acc[y1 * iw + x1] - acc[y0 * iw + x1] - acc[y1 * iw + x0] + acc[y0 * iw + x0];
}

/**
 * 检测焦点框。
 * @param {string} absPath 图片绝对路径
 * @param {{ ratioW?: number, ratioH?: number }} opts 目标比例（宽:高，如 2:3）
 * @returns {Promise<{ rect: {x:number,y:number,w:number,h:number}, point: {x:number,y:number}, aspect: number, skinRatio: number }>}
 */
export async function detectFocus(absPath, opts = {}) {
  const ratioW = Number(opts.ratioW) > 0 ? Number(opts.ratioW) : 1;
  const ratioH = Number(opts.ratioH) > 0 ? Number(opts.ratioH) : 1;

  const mid = await sharp(absPath, { failOn: 'none' })
    .rotate()
    .toColourspace('srgb')
    .resize(SCAN, SCAN, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = mid.info.width;
  const H = mid.info.height;
  const ch = mid.info.channels || 3;
  const sig = saliencyWeights(mid.data, W, H, ch);
  if (!sig) throw new Error('无法读取图片尺寸');

  const imageAspect = W / H;
  const targetAspect = ratioW / ratioH;
  // 归一化空间里「目标比例」对应的宽高（x/y 单位不同，要按图像宽高比换算）
  const rn = targetAspect / imageAspect;
  let winW;
  let winH;
  if (rn >= 1) {
    winW = 1;
    winH = 1 / rn;
  } else {
    winW = rn;
    winH = 1;
  }
  winW = clamp(winW, 0.02, 1);
  winH = clamp(winH, 0.02, 1);

  const pw = Math.max(1, Math.round(winW * W));
  const ph = Math.max(1, Math.round(winH * H));
  const maxX = Math.max(0, W - pw);
  const maxY = Math.max(0, H - ph);

  const acc = integralImage(sig.w, W, H);
  const iw = W + 1;

  let best = -1;
  // 第一轮：找最高分
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      const s = sumArea(acc, iw, x, y, x + pw, y + ph);
      if (s > best) best = s;
    }
  }
  if (best < 0) best = 0;

  // 第二轮：与最高分相差 1.5% 以内时，取最靠近权重质心的候选（构图更稳）
  const tol = best * 0.985;
  const cxPix = sig.centroid.x * W;
  const cyPix = sig.centroid.y * H;
  let pickX = null;
  let pickY = null;
  let pickDist = Infinity;
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      const s = sumArea(acc, iw, x, y, x + pw, y + ph);
      if (s < tol) continue;
      const dx = x + pw / 2 - cxPix;
      const dy = y + ph / 2 - cyPix;
      const d = dx * dx + dy * dy;
      if (d < pickDist) {
        pickDist = d;
        pickX = x;
        pickY = y;
      }
    }
  }
  if (pickX === null) {
    // 极端情况（maxX/maxY 为 0）：居中兜底
    pickX = Math.round(maxX / 2);
    pickY = Math.round(maxY / 2);
  }

  return {
    rect: {
      x: pickX / W,
      y: pickY / H,
      w: pw / W,
      h: ph / H,
    },
    point: { x: clamp(sig.centroid.x, 0, 1), y: clamp(sig.centroid.y, 0, 1) },
    aspect: imageAspect,
    skinRatio: sig.skinRatio,
  };
}
