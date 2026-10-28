import sharp from 'sharp';

/**
 * 主色 / 色系 / 调色板（与图片库解耦，可在 worker 线程里独立使用）。
 * 从 library.js 抽出来是为了让「派生资产」阶段能在 worker 里完成：导入上百万张时
 * 主线程只该做 SQLite 批量写入，解码/量化这类 CPU 活必须挪到 worker。
 */

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 主色提取采用业界主流的「修正中值切割量化（MMCQ / Modified Median Cut Quantization，
 * 与 color-thief、Android Palette 同源）」：在缩略图上对每个像素建箱，递归地沿「最长通道」在
 * 中位数处把箱子一分为二，得到至多 maxColors 个感知差异明显、且彼此不重叠的代表色。
 * 每个代表色自带「像素占比 pop」，与 MPEG-7 DominantColor 描述符（至多 8 个主簇 + 各自占比）
 * 一致，便于后续按“颜色占比”加权排序，让“画面主色就是该颜色”的图排在最前。
 */
function medianCutQuantize(pixels, maxColors) {
  if (!pixels.length) return [];
  const makeBox = (px) => {
    const min = [255, 255, 255];
    const max = [0, 0, 0];
    for (const p of px) {
      for (let c = 0; c < 3; c++) {
        if (p[c] < min[c]) min[c] = p[c];
        if (p[c] > max[c]) max[c] = p[c];
      }
    }
    const volume =
      (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
    return {
      px,
      min,
      max,
      volume,
      population: px.length,
      // 优先切“体积大且像素多”的箱，保证切出来的都是画面里真正存在的主体色
      score: volume * Math.log(1 + px.length),
    };
  };
  // 沿像素数最多的通道、在中位数处切分；若中点两侧同色则滑到第一个不同色边界
  const splitBox = (box) => {
    let ch = 0;
    let range = -1;
    for (let c = 0; c < 3; c++) {
      const r = box.max[c] - box.min[c];
      if (r > range) {
        range = r;
        ch = c;
      }
    }
    if (range <= 0) return null; // 箱内颜色完全一致，无法再分
    const sorted = box.px.slice().sort((a, b) => a[ch] - b[ch]);
    let cut = Math.floor(sorted.length / 2);
    while (cut > 0 && sorted[cut][ch] === sorted[cut - 1][ch]) cut--;
    if (cut === 0) {
      let k = Math.floor(sorted.length / 2);
      while (k < sorted.length && sorted[k][ch] === sorted[0][ch]) k++;
      if (k >= sorted.length) return null;
      cut = k;
    }
    return [makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut))];
  };
  let boxes = [makeBox(pixels)];
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => b.score - a.score);
    const box = boxes.shift();
    if (!box || box.score <= 0) break;
    const parts = splitBox(box);
    if (!parts) {
      boxes.push(box); // 不可再分，保留为最终色
      break;
    }
    boxes.push(parts[0], parts[1]);
  }
  return boxes
    .map((box) => {
      let r = 0, g = 0, b = 0;
      for (const p of box.px) {
        r += p[0];
        g += p[1];
        b += p[2];
      }
      const n = box.px.length;
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), pop: n };
    })
    .sort((a, b) => b.pop - a.pop);
}

/* 感知均匀颜色空间 OKLab（Björn Ottosson）。色相判断比 HSV 准得多：
 * HSV 会把棕红/褐色/肤色判进「红」（0-30°），而 OKLCH 里它们落在 40-76°（橙），
 * 与人眼一致；且与颜色搜索用的 OKLab 距离保持同一色彩空间。 */
function srgbToLinear(x) {
  x /= 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function hexToRgb(hex) {
  if (!hex) return null;
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
function rgbToOklab(hex) {
  const c = hexToRgb(hex);
  if (!c) return null;
  const r = srgbToLinear(c.r), g = srgbToLinear(c.g), b = srgbToLinear(c.b);
  const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l = Math.cbrt(l_), m = Math.cbrt(m_), s = Math.cbrt(s_);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}
function oklabHue(lab) {
  const h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

/** 12 个色系的原型色（与 web/src/components/FilterBar.tsx 的 HUES 保持一致，0红..11玫粉） */
const HUE_PROTOS = [
  '#ff4d4d', '#ff9a4d', '#ffe04d', '#c8ff4d', '#4dff6a', '#4dffcf',
  '#4defff', '#4da6ff', '#5c4dff', '#a64dff', '#ff4dd2', '#ff4d88',
];
// 桶边界 = 相邻原型色 OKLCH 色相角的平分线（bounds[i] 为桶 i 与桶 i+1 的分界）。
// 注意 OKLCH 色相角与 HSV 不同（纯红≈25° 而非 0°），不能用 i*30° 等分，否则会错桶。
const OKLAB_HUE_BOUNDS = HUE_PROTOS.map((hex, i) => {
  const hi = oklabHue(rgbToOklab(hex));
  const nx = oklabHue(rgbToOklab(HUE_PROTOS[(i + 1) % HUE_PROTOS.length]));
  let d = nx - hi;
  if (d < 0) d += 360;
  return (hi + d / 2) % 360;
});

const OKLAB_HUE_CHROMA_MIN = 0.03; // OKLCH 彩度基准门槛，低于此视为无色相（灰/黑/白）
const OKLAB_HUE_POP_MIN = 0.08;    // 占比低于此的代表色只是点缀，不足以定义整图色系

/** 彩度门槛随明度调整：越接近纯白/纯黑，人眼越难感知出色相，
 *  需要更高彩度才算「有色」。否则奶油色会被算成黄/橙、近黑被算成蓝。 */
function chromaFloorFor(L) {
  return (
    OKLAB_HUE_CHROMA_MIN +
    Math.max(0, L - 0.88) * 0.3 +  // 浅端：L 0.88→1.00 门槛 0.030→0.066
    Math.max(0, 0.2 - L) * 0.15    // 暗端：L 0.20→0.00 门槛 0.030→0.060
  );
}

const MAX_HUES = 3;
export function hueFromPalette(palette) {
  const arr = Array.isArray(palette) ? palette : [];
  const cands = [];
  for (const c of arr) {
    const hex = typeof c === 'string' ? c : c && typeof c.h === 'string' ? c.h : null;
    if (!hex) continue;
    const pop = typeof c === 'string' ? 1 : typeof c.p === 'number' ? c.p : 0;
    if (pop < OKLAB_HUE_POP_MIN) continue; // 占比太低只是点缀，不定义整图色系
    const lab = rgbToOklab(hex);
    if (!lab) continue;
    if (Math.hypot(lab.a, lab.b) < chromaFloorFor(lab.L)) continue; // 太灰不算有色相
    cands.push({ pop, lab });
  }
  cands.sort((a, b) => b.pop - a.pop);
  const hues = [];
  for (const c of cands) {
    if (hues.length >= MAX_HUES) break;
    const hue = oklabHue(c.lab);
    for (let i = 0; i < OKLAB_HUE_BOUNDS.length; i++) {
      const lo = OKLAB_HUE_BOUNDS[(i + 11) % 12];
      let rel = hue - lo;
      if (rel < 0) rel += 360;
      let span = OKLAB_HUE_BOUNDS[i] - lo;
      if (span < 0) span += 360;
      if (rel <= span) {
        if (!hues.includes(i)) hues.push(i); // 同一色系只记一次
        break;
      }
    }
  }
  return hues;
}

const PALETTE_EMPTY = { dominant: '#808080', hue: '', palette: [{ h: '#808080', p: 1 }] };

/**
 * 直接从已解码的原始像素（RGB/RGBA）算主色 / 色系 / 调色板。
 * 导入流水线里缩略图已经解码出一份像素，pHash 与主色都从这份像素派生，
 * 不再各自重新读文件 + 重新解码（旧实现每张图要解码 3 次）。
 */
export function dominantFromRaw(data, channels, sampleTarget = 12000) {
  const total = Math.floor(data.length / channels);
  if (!total) return PALETTE_EMPTY;
  // 均匀抽样到 sampleTarget 个左右：与旧实现「缩到 160×160 后每 2 像素取 1」规模相当
  const step = Math.max(1, Math.ceil(total / sampleTarget));
  const samples = [];
  for (let i = 0; i < total; i += step) {
    const o = i * channels;
    if (channels >= 4 && data[o + 3] < 128) continue; // 跳过透明像素
    samples.push([data[o], data[o + 1], data[o + 2]]);
  }
  if (!samples.length) return PALETTE_EMPTY;
  const MAX_COLORS = 8; // MPEG-7 DominantColor 至多 8 个主簇
  const boxes = medianCutQuantize(samples, MAX_COLORS);
  const sum = samples.length;
  const palette = boxes.map((b) => ({
    h: rgbToHex(b.r, b.g, b.b),
    p: b.pop / sum,
  }));
  const dom = boxes[0];
  const hue = hueFromPalette(palette).join(',');
  return { dominant: rgbToHex(dom.r, dom.g, dom.b), hue, palette };
}

/**
 * 取图片主色 + 色系（0-11 对应 12 个色系） + 至多 8 色带占比的调色板（入参可为路径或 Buffer）。
 * palette 用于「按颜色搜图」时与查询色做“感知距离 × 颜色占比”的匹配，比单一主色更准。
 */
export async function computeDominant(file) {
  const s = await sharp(file, { failOn: 'none' })
    .rotate()
    .resize(160, 160, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return dominantFromRaw(s.data, s.info.channels);
}

export { rgbToOklab, oklabHue, rgbToHex };
