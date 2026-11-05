/**
 * 图片编辑：裁切 + Camera Raw 调色（白平衡校正与简单调色）。
 *
 * 与 rotateImage / enhanceImage 同一范式：物理写回原文件，其他软件打开即为编辑后的效果；
 * 同步更新宽高 / 文件大小 / pHash / 主体哈希 / CLIP 深度特征 / 缩略图 / 清晰度缓存。
 * 单张与批量共用同一套核心函数（批量只是循环 + 任务状态）。
 */
import fs from 'node:fs';
import { assertWritableDir } from './safe-path.js';
import path from 'node:path';
import sharp from 'sharp';
import { db } from '../db.js';
import { computePHash } from '../phash.js';
import { computeSubjectPHash } from './subject.js';
import * as clip from '../clip.js';
import { invalidateQuality } from '../quality.js';
import { removeThumbFiles } from '../thumbs.js';
import { getImage, indexPhash, ingest, toDTO, translateError, writeFileAtomic } from '../library.js';
import { pushEditBackup } from './undo.js';
import { detectFocus } from './focus.js';

/** 支持的预设裁切比例（宽:高）。orig = 保持原图比例，free = 自由框选 */
export const CROP_RATIOS = ['free', 'orig', '1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'];

/** 调色参数默认值（全部 0 = 原图）与合法范围 */
export const ADJUST_DEFAULTS = {
  temperature: 0, // 色温：负=偏冷(蓝)，正=偏暖(橙)   -100..100
  tint: 0, // 色调：负=偏绿，正=偏品红                    -100..100
  exposure: 0, // 曝光：整体明暗                           -100..100
  contrast: 0, // 对比度                                   -100..100
  highlights: 0, // 高光：正提亮、负压暗                     -100..100
  shadows: 0, // 阴影：正提亮、负压暗                       -100..100
  whites: 0, // 白色：正=白点更高（更通透）                 -100..100
  blacks: 0, // 黑色：正=黑点抬高（更灰）                    -100..100
  saturation: 0, // 饱和度                                -100..100
  vibrance: 0, // 自然饱和度（只作用于低饱和）               -100..100
  hue: 0, // 色相旋转（±45°）                            -100..100
  // PS「色相/饱和度」：全图 + 六个色带，各带色相/饱和度/明度 + 着色
  hueSat: {
    bands: {
      master: { h: 0, s: 0, l: 0 },
      red: { h: 0, s: 0, l: 0 },
      yellow: { h: 0, s: 0, l: 0 },
      green: { h: 0, s: 0, l: 0 },
      cyan: { h: 0, s: 0, l: 0 },
      blue: { h: 0, s: 0, l: 0 },
      magenta: { h: 0, s: 0, l: 0 },
    },
    colorize: false,
    colorizeHue: 210,
    colorizeSat: 25,
    colorizeLight: 0,
  },
  // Camera Raw「混色器」：8 个色带（红/橙/黄/绿/浅绿/蓝/紫/洋红）× 色相/饱和度/明亮度
  colorMixer: {
    bands: {
      red: { h: 0, s: 0, l: 0 },
      orange: { h: 0, s: 0, l: 0 },
      yellow: { h: 0, s: 0, l: 0 },
      green: { h: 0, s: 0, l: 0 },
      aqua: { h: 0, s: 0, l: 0 },
      blue: { h: 0, s: 0, l: 0 },
      purple: { h: 0, s: 0, l: 0 },
      magenta: { h: 0, s: 0, l: 0 },
    },
  },
  // Camera Raw「颜色分级」：阴影/中间调/高光/全局 各含色相/饱和度/明度 + 混合/平衡
  colorGrade: {
    zones: {
      shadows: { hue: 0, sat: 0, lum: 0 },
      midtones: { hue: 0, sat: 0, lum: 0 },
      highlights: { hue: 0, sat: 0, lum: 0 },
      global: { hue: 0, sat: 0, lum: 0 },
    },
    blending: 50,
    balance: 0,
  },
  clarity: 0, // 清晰度（中间调局部对比）                    0..100
  sharpen: 0, // 锐化强度                                0..100
  curves: { rgb: [], r: [], g: [], b: [] }, // 四通道曲线（PS 曲线面板同构，空数组 = 恒等）
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));

/** 曲线控制点归一化：夹到 0..255、按 x 升序去重、最多 16 点 */
function normalizeCurve(input) {
  if (!Array.isArray(input)) return [];
  const pts = [];
  for (const p of input) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([Math.round(clamp(x, 0, 255)), Math.round(clamp(y, 0, 255))]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const uniq = [];
  for (const p of pts) if (!uniq.length || p[0] !== uniq[uniq.length - 1][0]) uniq.push(p);
  return uniq.slice(0, 16);
}

const HUE_BAND_KEYS = ['master', 'red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];

/** 色相/饱和度归一化：7 个通道各自夹紧，着色字段补齐 */
function normalizeHueSat(input) {
  const src = input && typeof input === 'object' ? input : {};
  const srcBands = src.bands && typeof src.bands === 'object' ? src.bands : {};
  const bands = {};
  for (const key of HUE_BAND_KEYS) {
    const b = srcBands[key] && typeof srcBands[key] === 'object' ? srcBands[key] : {};
    bands[key] = {
      h: clamp(Number(b.h), -180, 180),
      s: clamp(Number(b.s), -100, 100),
      l: clamp(Number(b.l), -100, 100),
    };
  }
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    bands,
    colorize: !!src.colorize,
    colorizeHue: clamp(num(src.colorizeHue, 210), 0, 360),
    colorizeSat: clamp(num(src.colorizeSat, 25), 0, 100),
    colorizeLight: clamp(num(src.colorizeLight, 0), -100, 100),
  };
}

/** 色相/饱和度是否真的调过 */
function hueSatActive(hs) {
  if (!hs) return false;
  if (hs.colorize) return true;
  return Object.values(hs.bands || {}).some((b) => b && (b.h || b.s || b.l));
}

const MIX_BAND_KEYS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];

/** 混色器归一化：8 个色带各自夹紧，缺省 0 */
function normalizeColorMixer(input) {
  const src = input && typeof input === 'object' ? input : {};
  const srcBands = src.bands && typeof src.bands === 'object' ? src.bands : {};
  const bands = {};
  for (const key of MIX_BAND_KEYS) {
    const b = srcBands[key] && typeof srcBands[key] === 'object' ? srcBands[key] : {};
    bands[key] = {
      h: clamp(Number(b.h), -100, 100),
      s: clamp(Number(b.s), -100, 100),
      l: clamp(Number(b.l), -100, 100),
    };
  }
  return { bands };
}

/** 混色器是否真的调过 */
function colorMixerActive(m) {
  if (!m) return false;
  return Object.values(m.bands || {}).some((b) => b && (b.h || b.s || b.l));
}

const GRADE_ZONE_KEYS = ['shadows', 'midtones', 'highlights', 'global'];

/** 颜色分级归一化：四区夹紧 + 混合/平衡 */
function normalizeColorGrade(input) {
  const src = input && typeof input === 'object' ? input : {};
  const srcZones = src.zones && typeof src.zones === 'object' ? src.zones : {};
  const zones = {};
  for (const key of GRADE_ZONE_KEYS) {
    const z = srcZones[key] && typeof srcZones[key] === 'object' ? srcZones[key] : {};
    zones[key] = {
      hue: clamp(Number(z.hue), 0, 360),
      sat: clamp(Number(z.sat), 0, 100),
      lum: clamp(Number(z.lum), -100, 100),
    };
  }
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    zones,
    blending: clamp(num(src.blending, 50), 0, 100),
    balance: clamp(num(src.balance, 0), -100, 100),
  };
}

/** 颜色分级是否真的调过（色相单独不为 0 不算：饱和度 0 时染色不生效） */
function colorGradeActive(g) {
  if (!g) return false;
  return Object.values(g.zones || {}).some((z) => z && (z.sat || z.lum));
}

/** 归一化调色参数：越界值夹紧、缺省为 0，保证脏输入不会把图调坏 */
export function normalizeAdjust(input = {}) {
  const out = {};
  for (const key of Object.keys(ADJUST_DEFAULTS)) {
    if (key === 'curves' || key === 'hueSat' || key === 'colorMixer' || key === 'colorGrade') continue;
    out[key] = clamp(Number(input[key]), key === 'sharpen' || key === 'clarity' ? 0 : -100, 100);
  }
  // 兼容老调用方直接传 curve: CurvePoint[]（视为主通道）
  const c = input.curves && typeof input.curves === 'object' ? input.curves : {};
  out.curves = {
    rgb: normalizeCurve(c.rgb !== undefined ? c.rgb : input.curve),
    r: normalizeCurve(c.r),
    g: normalizeCurve(c.g),
    b: normalizeCurve(c.b),
  };
  out.hueSat = normalizeHueSat(input.hueSat);
  out.colorMixer = normalizeColorMixer(input.colorMixer);
  out.colorGrade = normalizeColorGrade(input.colorGrade);
  return out;
}

/** 曲线是否真的改了（拖回原位不算，避免无意义重编码） */
function curveActive(curve) {
  if (!Array.isArray(curve) || curve.length < 2) return false;
  return curve.some(([x, y]) => Math.abs(x - y) > 1);
}

/** 参数是否全是 0（全 0 无需重编码，避免无意义的质量损失） */
export function isEmptyAdjust(p) {
  const { curves, hueSat, colorMixer, colorGrade, ...rest } = p;
  if (!Object.values(rest).every((v) => Math.abs(v) < 0.5)) return false;
  if (hueSatActive(hueSat)) return false;
  if (colorMixerActive(colorMixer)) return false;
  if (colorGradeActive(colorGrade)) return false;
  if (!curves) return true;
  return !Object.values(curves).some(curveActive);
}

// 白平衡不再需要 sharp.recomb 的 3x3 矩阵：色温/色调就是 applyRaw 里的三个通道增益
// （kr/kg/kb，与前端 preview 的 wbGains 同一条公式），这也是唯一实现。

/** 曲线采样：单调三次插值（Fritsch–Carlson），自动补 0,0 与 255,255 */
function curveFn(points) {
  const ps = points.slice();
  if (ps[0][0] > 0) ps.unshift([0, 0]);
  if (ps[ps.length - 1][0] < 255) ps.push([255, 255]);
  const n = ps.length;
  const xs = ps.map((p) => p[0] / 255);
  const ys = ps.map((p) => p[1] / 255);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  // 限幅，保证不过冲（曲线不会自己"鼓包"出亮度断层）
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
    );
  };
}

/**
 * 影调映射（高光/阴影/白色/黑色），输入输出 0..1。
 * 暗部权重 (1-x)^2.6、高光权重 x^2.6，力量上限约 1/3 避免硬块；
 * 与 ACR 一致作用在**亮度**上（不是逐通道），所以推明暗时不会带出色偏。
 */
function toneMap(x, sh, hi, wh, bl) {
  if (sh) x += sh * 0.32 * Math.pow(1 - x, 2.6);
  if (hi) x += hi * 0.32 * Math.pow(x, 2.6);
  if (wh || bl) x = bl * 0.18 + x * (1 + (wh - bl) * 0.22);
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const lutIndex = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : v | 0);

/**
 * 影调 → 亮度映射表；主曲线 × 单通道曲线 → 三个通道 LUT。
 * 顺序同 PS 曲线面板：先影调、再主通道曲线、最后单通道曲线。
 */
function buildLuts(p) {
  const sh = p.shadows / 100;
  const hi = p.highlights / 100;
  const wh = p.whites / 100;
  const bl = p.blacks / 100;
  const tone = !!(sh || hi || wh || bl);
  const c = p.curves || {};
  const main = curveActive(c.rgb) ? curveFn(c.rgb) : null;
  const chR = curveActive(c.r) ? curveFn(c.r) : null;
  const chG = curveActive(c.g) ? curveFn(c.g) : null;
  const chB = curveActive(c.b) ? curveFn(c.b) : null;
  if (!tone && !main && !chR && !chG && !chB) return null;

  // 用 Float32Array 而不是 Uint8Array：取整会让「亮度映射 + 按比例缩放」多出最多 1 级的误差，
  // 再被后面的饱和度/对比度放大，预览与成品就肉眼可见地不一样了。前端 buildLuts 同样是 Float32。
  const luma = new Float32Array(256);
  for (let i = 0; i < 256; i++) luma[i] = toneMap(i / 255, sh, hi, wh, bl) * 255;

  const mk = (ch) => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      let x = i / 255;
      if (main) x = main(x);
      if (ch) x = ch(x);
      lut[i] = (x < 0 ? 0 : x > 1 ? 1 : x) * 255;
    }
    return lut;
  };

  return { tone, luma, curve: !!(main || chR || chG || chB), r: mk(chR), g: mk(chG), b: mk(chB) };
}

/**
 * 是否必须逐像素处理。
 * 除锐化/清晰度（空间卷积，sharp 原生更快）之外的**所有**调色项都在 applyRaw 里做，
 * 这样成品与预览才是同一套公式；只调清晰度时才走纯 sharp 路径。
 */
function needsRaw(p) {
  const { clarity, sharpen, curves, ...rest } = p;
  if (Object.values(rest).some((v) => typeof v === 'number' && v !== 0)) return true;
  const c = curves || {};
  return !!(
    hueSatActive(p.hueSat) ||
    colorMixerActive(p.colorMixer) ||
    colorGradeActive(p.colorGrade) ||
    curveActive(c.rgb) ||
    curveActive(c.r) ||
    curveActive(c.g) ||
    curveActive(c.b)
  );
}

/* ===== PS 色相/饱和度：HSL 工具（与 web/src/lib/adjust.ts 保持同一套公式） ===== */
const HUE_BAND_DEFS = [
  { key: 'red', center: 0 },
  { key: 'yellow', center: 60 },
  { key: 'green', center: 120 },
  { key: 'cyan', center: 180 },
  { key: 'blue', center: 240 },
  { key: 'magenta', center: 300 },
];
const BAND_FULL = 30; // 中心 ±30° 全强度
const BAND_EDGE = 45; // ±45° 处衰减到 0

/** 某色相（度）落在某色带上的权重 */
function bandWeight(deg, center) {
  let d = Math.abs(deg - center);
  if (d > 180) d = 360 - d;
  if (d <= BAND_FULL) return 1;
  if (d >= BAND_EDGE) return 0;
  return (BAND_EDGE - d) / (BAND_EDGE - BAND_FULL);
}

/** RGB(0..1) → [h(0..1), s(0..1), l(0..1)] */
function rgbToHsl(r, g, b) {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

const hue2rgb = (p, q, t) => {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
};

/** HSL(0..1) → 写回 out=[r,g,b] (0..255) */
function hslToRgb(h, s, l, out) {
  if (s <= 0) {
    const v = l * 255;
    out[0] = v;
    out[1] = v;
    out[2] = v;
    return;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hue2rgb(p, q, h + 1 / 3) * 255;
  out[1] = hue2rgb(p, q, h) * 255;
  out[2] = hue2rgb(p, q, h - 1 / 3) * 255;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampSym = (v) => (v < -100 ? -100 : v > 100 ? 100 : v);

/* ===== Camera Raw 混色器：8 色带色相环中心角 ===== */
const MIX_DEFS = [
  { key: 'red', center: 0 },
  { key: 'orange', center: 30 },
  { key: 'yellow', center: 60 },
  { key: 'green', center: 120 },
  { key: 'aqua', center: 180 },
  { key: 'blue', center: 240 },
  { key: 'purple', center: 280 },
  { key: 'magenta', center: 320 },
];
/** 到色带中心 45° 权重衰减到 0，再按总权重归一（相邻色带平滑过渡） */
const MIX_EDGE = 45;

function mixWeight(deg, center) {
  let d = Math.abs(deg - center);
  if (d > 180) d = 360 - d;
  return d >= MIX_EDGE ? 0 : 1 - d / MIX_EDGE;
}

/** 颜色分级三区权重（和为 1）：blending 控制过渡宽度、balance 平移分界 */
function gradeWeights(l, blending, balance) {
  const soft = 0.3 + clamp01(blending / 100) * 0.55;
  const x = clamp01(l + (clampSym(balance) / 100) * 0.18);
  const wS = clamp01((soft - x) / soft);
  const wH = clamp01((x - (1 - soft)) / soft);
  const wM = Math.max(0, 1 - wS - wH);
  const sum = wS + wM + wH;
  return sum > 0 ? [wS / sum, wM / sum, wH / sum] : [0, 1, 0];
}

/** 饱和度（PS 式：+100 全饱和、-100 变灰） */
const satApply = (v, d) => (d >= 0 ? v + (1 - v) * (d / 100) : v * (1 + d / 100));
/** 明度（PS 式：+100 全白、-100 全黑） */
const lightApply = (v, d) => (d >= 0 ? v + (1 - v) * (d / 100) : v * (1 + d / 100));

/**
 * 逐像素调色（**成品与前端预览 renderPixels 的唯一实现**，公式必须逐项对齐）：
 * 白平衡增益 → 亮度影调 → 通道曲线 → 自然饱和度 → PS 色相/饱和度 → 混色器/颜色分级
 * → 饱和度/色相旋转 → 曝光 → 对比度。
 */
export function applyRaw(data, channels, p, luts) {
  const kb = 1 - p.temperature * 0.0025 - p.tint * 0.0008;
  const kg = 1 - p.tint * 0.0032;
  const kr = 1 + p.temperature * 0.0025 - p.tint * 0.0008;
  const wb = !!(p.temperature || p.tint);
  const vib = p.vibrance / 100;
  const sat = p.saturation;
  const hueDeg = p.hue * 0.45;
  // 曝光/对比度也在这里做：以前交给 sharp.modulate / sharp.linear，
  // 但 modulate 是在 LCh 明度上乘系数、linear 是在 8bit 上做仿射，
  // 与预览的「RGB 乘/加」公式不同 → 大幅调整时预览与成品亮度对不上。
  const bright = Math.max(0.05, 1 + p.exposure * 0.008);
  const ca = 1 + p.contrast * 0.006;
  const cb = 128 * (1 - ca);
  const exposure = bright !== 1;
  const contrast = !!p.contrast;
  const useTone = !!luts?.tone;
  const useCurve = !!luts?.curve;
  const luma = luts?.luma;
  const lutR = luts?.r;
  const lutG = luts?.g;
  const lutB = luts?.b;

  const hs = p.hueSat;
  const hasHs = hueSatActive(hs);
  const colorize = !!(hs && hs.colorize);
  const cHue = (hs?.colorizeHue || 0) / 360;
  const cSat = (hs?.colorizeSat || 0) / 100;
  const cLight = hs?.colorizeLight || 0;
  const mBand = hs?.bands?.master;
  const bandArr = hs ? HUE_BAND_DEFS.map((d) => ({ center: d.center, b: hs.bands[d.key] })) : [];
  const anyBand = bandArr.some((x) => x.b && (x.b.h || x.b.s || x.b.l));

  // 混色器 / 颜色分级（只在真正调过时进入 HSL 分支）
  const cg = p.colorGrade;
  const hasGrade = colorGradeActive(cg);
  const gradeZones = cg && cg.zones ? [cg.zones.shadows, cg.zones.midtones, cg.zones.highlights, cg.zones.global] : [];
  const gradeBlending = cg ? cg.blending : 50;
  const gradeBalance = cg ? cg.balance : 0;
  const cmx = p.colorMixer;
  const hasMix = colorMixerActive(cmx);
  const mixLive = cmx
    ? MIX_DEFS.filter((d) => cmx.bands[d.key] && (cmx.bands[d.key].h || cmx.bands[d.key].s || cmx.bands[d.key].l)).map(
        (d) => ({ center: d.center, b: cmx.bands[d.key] })
      )
    : [];
  const hasMixGrade = hasGrade || hasMix;

  const useHsl = hasHs || !!sat || !!hueDeg || hasMixGrade;
  const hsl = [0, 0, 0];

  for (let i = 0; i < data.length; i += channels) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (wb) {
      r *= kr;
      g *= kg;
      b *= kb;
    }
    if (useTone) {
      // 亮度域调整：newLuma 按比例缩放三通道，色相/饱和度变化与 PS 的观感一致
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const ny = luma[lutIndex(y)];
      const k = y > 0.0001 ? ny / y : 0;
      if (k) {
        r *= k;
        g *= k;
        b *= k;
      } else {
        r = ny;
        g = ny;
        b = ny;
      }
    }
    if (useCurve) {
      r = lutR[lutIndex(r)];
      g = lutG[lutIndex(g)];
      b = lutB[lutIndex(b)];
    }
    if (vib) {
      // 自然饱和度：按当前饱和度加权，越灰的像素增益越大，肤色/高饱和区基本不动
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const s0 = mx > 0 ? (mx - mn) / mx : 0;
      const k = (1 - s0) * vib * 0.9;
      const avg = (r + g + b) / 3;
      r += (r - avg) * k;
      g += (g - avg) * k;
      b += (b - avg) * k;
    }

    if (useHsl) {
      const cr = r < 0 ? 0 : r > 255 ? 255 : r;
      const cg = g < 0 ? 0 : g > 255 ? 255 : g;
      const cb2 = b < 0 ? 0 : b > 255 ? 255 : b;

      if (hasHs) {
        const cur = rgbToHsl(cr / 255, cg / 255, cb2 / 255);
        let h;
        let s;
        let l;
        if (colorize) {
          h = cHue;
          s = cSat;
          l = lightApply(cur[2], cLight);
        } else {
          const deg = cur[0] * 360;
          let dH = mBand ? mBand.h : 0;
          let dS = mBand ? mBand.s : 0;
          let dL = mBand ? mBand.l : 0;
          if (anyBand) {
            for (const item of bandArr) {
              if (!item.b || (!item.b.h && !item.b.s && !item.b.l)) continue;
              const w = bandWeight(deg, item.center);
              if (!w) continue;
              dH += item.b.h * w;
              dS += item.b.s * w;
              dL += item.b.l * w;
            }
          }
          if (!dH && !dS && !dL) {
            h = -1;
          } else {
            h = (cur[0] + dH / 360) % 1;
            if (h < 0) h += 1;
            s = satApply(cur[1], clamp(dS, -100, 100));
            l = lightApply(cur[2], clamp(dL, -100, 100));
          }
        }
        if (h >= 0) {
          hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1), hsl);
          r = hsl[0];
          g = hsl[1];
          b = hsl[2];
        }
      }

      // 混色器 + 颜色分级：同在 HSL 域一次往返（先混色器、再分级，与 Camera Raw 面板顺序一致）
      if (hasMixGrade) {
        const cur = rgbToHsl(
          (r < 0 ? 0 : r > 255 ? 255 : r) / 255,
          (g < 0 ? 0 : g > 255 ? 255 : g) / 255,
          (b < 0 ? 0 : b > 255 ? 255 : b) / 255
        );
        let h = cur[0];
        let s = cur[1];
        let l = cur[2];

        if (hasMix) {
          const deg = h * 360;
          let dH = 0;
          let dS = 0;
          let dL = 0;
          let wsum = 0;
          for (const it of mixLive) {
            const w = mixWeight(deg, it.center);
            if (!w) continue;
            dH += it.b.h * w;
            dS += it.b.s * w;
            dL += it.b.l * w;
            wsum += w;
          }
          if (wsum > 1) {
            dH /= wsum;
            dS /= wsum;
            dL /= wsum;
          }
          if (dH || dS || dL) {
            h = (h + (clampSym(dH) * 0.6) / 360) % 1;
            if (h < 0) h += 1;
            s = satApply(s, clampSym(dS));
            l = lightApply(l, clampSym(dL));
          }
        }

        if (hasGrade) {
          const [wS, wM, wH] = gradeWeights(l, gradeBlending, gradeBalance);
          let vx = 0;
          let vy = 0;
          let lumAdj = 0;
          for (let k = 0; k < 4; k++) {
            const z = gradeZones[k];
            if (!z) continue;
            const wt = k === 3 ? 1 : k === 0 ? wS : k === 1 ? wM : wH;
            if (!wt) continue;
            if (z.sat > 0) {
              const a = wt * (z.sat / 100);
              const rad = (z.hue * Math.PI) / 180;
              vx += a * Math.cos(rad);
              vy += a * Math.sin(rad);
            }
            lumAdj += wt * z.lum;
          }
          const mag = Math.sqrt(vx * vx + vy * vy);
          if (mag > 0.0001) {
            const alpha = Math.min(1, mag) * 0.7;
            const target = (Math.atan2(vy, vx) / (Math.PI * 2) + 1) % 1;
            let dh = target - h;
            if (dh > 0.5) dh -= 1;
            if (dh < -0.5) dh += 1;
            h = (h + dh * alpha + 1) % 1;
            s = s + (1 - s) * alpha * 0.7;
          }
          if (lumAdj) l = lightApply(l, clampSym(lumAdj) * 0.55);
        }

        hslToRgb(clamp01(h), clamp01(s), clamp01(l), hsl);
        r = hsl[0];
        g = hsl[1];
        b = hsl[2];
      }

      if (sat || hueDeg) {
        const cur = rgbToHsl(
          (r < 0 ? 0 : r > 255 ? 255 : r) / 255,
          (g < 0 ? 0 : g > 255 ? 255 : g) / 255,
          (b < 0 ? 0 : b > 255 ? 255 : b) / 255
        );
        let h = cur[0];
        let s = cur[1];
        if (sat) s = satApply(s, sat);
        if (hueDeg) {
          h = (h + hueDeg / 360) % 1;
          if (h < 0) h += 1;
        }
        hslToRgb(h, clamp(s, 0, 1), cur[2], hsl);
        r = hsl[0];
        g = hsl[1];
        b = hsl[2];
      }
    }

    if (exposure) {
      r *= bright;
      g *= bright;
      b *= bright;
    }
    if (contrast) {
      r = r * ca + cb;
      g = g * ca + cb;
      b = b * ca + cb;
    }

    data[i] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5;
  }
}

/**
 * 只挂**空间类**处理（清晰度/锐化）。
 * 颜色相关的一切（白平衡/影调/曲线/饱和度/色相/曝光/对比度）都在 applyRaw 里逐像素完成，
 * 用 sharp 的 modulate/linear 会得到与预览不同的数值（LCh 明度 vs RGB 乘系数），预览就对不上了。
 */
function applyAdjust(pipeline, p) {
  let s = pipeline;
  if (p.clarity > 0) s = s.sharpen({ sigma: 2.2, m1: (p.clarity / 100) * 0.9, m2: 0.6 }); // 大半径 = 中间调局部对比
  if (p.sharpen > 0) s = s.sharpen({ sigma: 0.4 + (p.sharpen / 100) * 1.4 });
  return s;
}

/** 按原文件格式编码（JPEG 高质量重编码；PNG/WebP 用无损档） */
async function encode(pipeline, format) {
  if (format === 'png') return pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  if (format === 'webp') return pipeline.webp({ quality: 95 }).toBuffer({ resolveWithObject: true });
  if (format === 'avif') return pipeline.avif({ quality: 60 }).toBuffer({ resolveWithObject: true });
  return pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer({ resolveWithObject: true });
}

/** 居中最大可用框（按目标宽高比），用于预设比例与批量裁切 */
function centerRect(W, H, ratioW, ratioH) {
  const target = ratioW / ratioH;
  let width = W;
  let height = Math.round(W / target);
  if (height > H) {
    height = H;
    width = Math.round(H * target);
  }
  return { left: Math.round((W - width) / 2), top: Math.round((H - height) / 2), width, height };
}

/**
 * 焦点检测 → 像素矩形（摆正后坐标系）。失败一律返回 null，由调用方退回居中。
 * 检测本身是纯像素启发式（显著性 + 肤色 + 中心先验），单张几十毫秒。
 */
async function focusRect(absPath, vW, vH, ratioW, ratioH) {
  try {
    const f = await detectFocus(absPath, { ratioW, ratioH });
    const left = Math.round(f.rect.x * vW);
    const top = Math.round(f.rect.y * vH);
    return {
      left: Math.max(0, Math.min(left, vW - 8)),
      top: Math.max(0, Math.min(top, vH - 8)),
      width: Math.max(8, Math.min(Math.round(f.rect.w * vW), vW - Math.max(0, left))),
      height: Math.max(8, Math.min(Math.round(f.rect.h * vH), vH - Math.max(0, top))),
    };
  } catch {
    return null;
  }
}

/** 解析比例字符串：'1:1' → [1,1]；'free'/'orig' → null（由调用方决定） */
function parseRatio(ratio) {
  const m = String(ratio || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : null;
}

/** 另存副本的文件名：原名 + 操作后缀（ASCII 后缀，避免导出目录的编码差异） */
function buildCopyName(srcPath, tag) {
  const ext = path.extname(srcPath) || '.jpg';
  const base = path.basename(srcPath, ext);
  return `${base}_${tag}${ext}`;
}

/** 目标目录内重名则自动加序号，绝不覆盖已有文件 */
function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 2; i < 999; i++) {
    p = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/**
 * 写入编辑结果。
 * - saveMode='overwrite'（默认）：写回原文件，同步宽高/pHash/主体哈希/CLIP/缩略图
 * - saveMode='copy'：写到 targetDir 下的新文件，原图不动；addToLibrary 时可把副本登记入库
 * 返回 { item, savedPath, copied } —— item 在另存且未入库时为 null（原图没变，前端无需刷新卡片）
 */
export async function persistEdit(id, row, data, info, opts, tag) {
  if (opts.saveMode === 'copy') {
    const dir = assertWritableDir(opts.targetDir, '保存位置');
    if (!dir) throw new Error('请先选择保存位置');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const outPath = uniquePath(dir, buildCopyName(row.abs_path, tag));
    await writeFileAtomic(outPath, data);
    let item = null;
    let note = '';
    if (opts.addToLibrary) {
      const r = await ingest({
        absPath: outPath,
        source: 'local',
        skipPhashDupe: true, // 编辑产物就是要入库，不走查重
      }).catch(() => null);
      if (r && r.ok) item = r.image || toDTO(getImage(r.id));
      else note = r?.reason ? `（副本未入库：${r.reason}）` : '';
    }
    return { item, savedPath: outPath, copied: true, note };
  }

  const absPath = row.abs_path;
  // 覆盖前留一份原件，配合「撤销」——覆盖写回不可逆，误点一次就是永久损失
  await pushEditBackup(row, tag);
  await writeFileAtomic(absPath, data);
  const newHash = await computePHash(data).catch(() => '');
  // 内容已变：主体哈希重算（失败记 SKIP，等同「不可抠图」，分组自动退回全图哈希）
  let objHash;
  try {
    objHash = (await computeSubjectPHash(absPath)) || 'SKIP';
  } catch {
    objHash = 'SKIP';
  }
  // 缓存版本号必须跟着换：原图/缩略图响应是 max-age=7天 的强缓存，DTO 里 ?v= 又取自 fs_mtime。
  // 不刷新的话文件明明改了，浏览器还是按旧 URL 用旧图（用户看到「改完没反应」）。
  // 取 max(真实 mtime, 上次+1)：保证同一秒内连续两次编辑也能让版本号变化；
  // 比真实 mtime 大 1 时增量扫描会多处理这一张一次，随后自愈，代价可忽略。
  let fsMtime = Number(row.fs_mtime || 0) + 1;
  try {
    const st = fs.statSync(absPath);
    fsMtime = Math.max(Math.round(st.mtimeMs / 1000), fsMtime);
  } catch {
    /* 取不到就用递增兜底值 */
  }
  db.prepare(
    'UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ?, obj_phash = ?, fs_mtime = ? WHERE id = ?'
  ).run(info.width, info.height, data.length, newHash, objHash, fsMtime, id);
  if (newHash) indexPhash(id, newHash);
  if (clip.clipReady()) clip.reembed(id, absPath); // 内容已改变，重建深度特征
  invalidateQuality(id);
  await removeThumbFiles(id, row.thumb); // 旧缩略图过期，按需重生成
  return { item: toDTO(getImage(id)), savedPath: absPath, copied: false };
}

/**
 * 用一段新的图片数据替换原图内容（「换大图」用）。
 * 走和裁切/调色同一条写回链路：留撤销备份、重算 pHash/CLIP、清缩略图缓存。
 */
export async function replaceSourceImage(id, data, info, tag = '换大图') {
  const row = getImage(id);
  if (!row) throw new Error('图片不存在');
  if (!row.abs_path) throw new Error('这张素材没有原文件');
  if (!info?.width || !info?.height) throw new Error('无法识别新文件的尺寸');
  return persistEdit(id, row, data, info, { saveMode: 'overwrite' }, tag);
}

/**
 * 裁切（单张）。
 * opts.ratio: 'free' | 'orig' | '1:1' | '4:3' ...；其中 free/orig 必须带归一化框
 * opts.rect: { x, y, w, h } —— 相对原图的 0..1 归一化坐标（前端框选直接给这个）
 * 未给 rect 的预设比例 → 居中取最大可用框；'orig' 未给 rect → 不裁切（原样返回）
 */
export async function cropImage(id, opts = {}) {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在');
  try {
    return await cropInner(id, row, opts);
  } catch (err) {
    throw translateError(err, row.abs_path);
  }
}

async function cropInner(id, row, opts) {
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error('无法读取图片尺寸');
  const format = meta.format || 'jpeg';
  // 输出尺寸（批量裁切台的「宽/高」输入框）：给了就裁完再重采样到该像素，
  // 不给则保持裁切后的自然尺寸（Eagle 的「不进行大小调整」）
  const outW = Math.round(clamp(Number(opts.outWidth) || 0, 0, 20000));
  const outH = Math.round(clamp(Number(opts.outHeight) || 0, 0, 20000));
  const resizeTo = outW >= 16 && outH >= 16 ? { width: outW, height: outH } : null;

  // 画幅方向：EXIF orientation 5~8 是旋转 90°，pipeline 里先 .rotate() 再 extract，
  // 所以按比例的框必须在「摆正后」的坐标系里算，否则竖拍图会偏一大截
  const swapped = meta.orientation >= 5 && meta.orientation <= 8;
  const vW = swapped ? H : W;
  const vH = swapped ? W : H;

  let rect;
  // 'detected' = 用了焦点检测；'center' = 检测失败/显式居中；'' = 用户自己框的
  let focusMode = '';
  const norm = opts.rect || null;
  if (norm && Number(norm.w) > 0 && Number(norm.h) > 0) {
    // 前端框选：归一化 → 像素，夹紧到图内，至少 8px
    const left = Math.round(clamp(Number(norm.x), 0, 0.999) * W);
    const top = Math.round(clamp(Number(norm.y), 0, 0.999) * H);
    const width = Math.round(clamp(Number(norm.w), 0.001, 1) * W);
    const height = Math.round(clamp(Number(norm.h), 0.001, 1) * H);
    rect = {
      left: Math.min(left, W - 1),
      top: Math.min(top, H - 1),
      width: Math.max(8, Math.min(width, W - left)),
      height: Math.max(8, Math.min(height, H - top)),
    };
  } else {
    const ratio = parseRatio(opts.ratio);
    if (!ratio) {
      // 'orig' 或 'free' 没给框：保持原样，明确提示而不是悄悄产出半张图
      throw new Error('自由裁切需要先框选区域');
    }
    // 按比例裁切不再一律切中间：先用焦点检测把框放到主体上（人像/主体偏一侧时差别很大）。
    // 检测失败或显式要求居中（opts.center）时再退回 centerRect，并把兜底情况回报给界面。
    rect = opts.center ? null : await focusRect(row.abs_path, vW, vH, ratio[0], ratio[1]);
    focusMode = rect ? 'detected' : 'center';
    if (!rect) rect = centerRect(vW, vH, ratio[0], ratio[1]);
  }

  // 框等于整图且不改尺寸 → 无实际裁切，直接返回（避免无意义重编码掉质量）。
  // 但「另存为副本」模式下仍要产出文件，此时不短路
  if (
    opts.saveMode !== 'copy' &&
    !resizeTo &&
    rect.left === 0 &&
    rect.top === 0 &&
    rect.width === vW &&
    rect.height === vH
  ) {
    return { item: toDTO(row), savedPath: row.abs_path, copied: false };
  }

  let pipeline = sharp(row.abs_path, { failOn: 'none' })
    .rotate() // 先按 EXIF 摆正（之后丢 EXIF，避免下游二次旋转）
    .extract(rect);
  if (resizeTo) pipeline = pipeline.resize(resizeTo.width, resizeTo.height, { fit: 'fill' });
  const { data, info } = await encode(pipeline, format);
  const out = await persistEdit(id, row, data, info, opts, 'crop');
  return focusMode ? { ...out, focus: focusMode } : out;
}

/**
 * Camera Raw 调色（单张）：白平衡（色温/色调）+ 曝光/对比度/饱和度/锐化。
 * 参数全 0 时直接返回，不做无意义重编码。
 */
export async function adjustImage(id, params = {}) {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在');
  const p = normalizeAdjust(params);
  // 全 0 参数不重编码；「另存为副本」例外（用户明确要一份文件）
  if (isEmptyAdjust(p) && params.saveMode !== 'copy') {
    return { item: toDTO(row), savedPath: row.abs_path, copied: false };
  }
  try {
    return await adjustInner(id, row, p, params);
  } catch (err) {
    throw translateError(err, row.abs_path);
  }
}

/** raw 是原始入参（含 saveMode/targetDir），p 只是归一化后的调色数值 */
async function adjustInner(id, row, p, raw) {
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';
  let input = sharp(row.abs_path, { failOn: 'none' }).rotate();
  // 除锐化/清晰度外的所有颜色调整都在 applyRaw 逐像素做（与前端预览 renderPixels 同一套公式）
  if (needsRaw(p)) {
    const rawBuf = await input.raw().toBuffer({ resolveWithObject: true });
    applyRaw(rawBuf.data, rawBuf.info.channels, p, buildLuts(p));
    input = sharp(rawBuf.data, {
      raw: { width: rawBuf.info.width, height: rawBuf.info.height, channels: rawBuf.info.channels },
    });
  }
  const { data, info } = await encode(applyAdjust(input, p), format);
  return persistEdit(id, row, data, info, raw, 'edit');
}
