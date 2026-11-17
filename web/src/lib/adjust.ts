// 带 .ts 扩展名：Node 直接跑单测时能解析（Vite 与 allowImportingTsExtensions 同样支持）
import type { AdjustParams, CurvePoint, CurveSet, HueBandKey, MixBandKey } from '../types';
import { CURVES_DEFAULTS, isColorGradeDefault, isColorMixerDefault } from '../types';
import { curveFn, toneMap } from './tone';

/**
 * 逐像素调色管线（**唯一的预览实现**，实时预览与直方图都走它）。
 * 公式与 server/lib/edit.js 的 applyRaw / buildLuts 逐项对齐，否则预览与保存结果会不一致。
 *
 * 顺序：白平衡增益 → 影调（亮度域）→ 主/单通道曲线 → 自然饱和度 → 色相/饱和度（PS）
 *      → 混色器（Camera Raw）→ 颜色分级（Camera Raw）→ 饱和度 → 色相旋转 → 曝光 → 对比度。
 *
 * 曝光/对比度也在这条循环里（乘系数、以中灰为轴仿射），后端 applyRaw 用**同样的公式**，
 * 所以「预览看到什么、存下来就是什么」，只剩锐化/清晰度这类空间处理无法实时预览。
 * 改动这里任何一个系数，必须同步 server/lib/edit.js 的 applyRaw，smoke 里有逐像素比对兜底。
 */

/** PS 色带：中心角与羽化宽度（30° 内全强度，45° 处衰减到 0） */
const BAND_DEFS: { key: Exclude<HueBandKey, 'master'>; center: number }[] = [
  { key: 'red', center: 0 },
  { key: 'yellow', center: 60 },
  { key: 'green', center: 120 },
  { key: 'cyan', center: 180 },
  { key: 'blue', center: 240 },
  { key: 'magenta', center: 300 },
];
const BAND_FULL = 30;
const BAND_EDGE = 45;

/** 某色相（度）落在某个色带上的权重 */
export function bandWeight(deg: number, center: number): number {
  let d = Math.abs(deg - center);
  if (d > 180) d = 360 - d;
  if (d <= BAND_FULL) return 1;
  if (d >= BAND_EDGE) return 0;
  return (BAND_EDGE - d) / (BAND_EDGE - BAND_FULL);
}

/** RGB(0..1) → HSL(0..1) */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

const hue2rgb = (p: number, q: number, t: number) => {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
};

/** HSL(0..1) → RGB(0..255)，写回 out */
function hslToRgb(h: number, s: number, l: number, out: Float64Array): void {
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

/** 饱和度调整（PS 式：+100 全饱和、-100 变灰） */
function satApply(v: number, d: number): number {
  return d >= 0 ? v + (1 - v) * (d / 100) : v * (1 + d / 100);
}

/** 明度调整（PS 式：+100 全白、-100 全黑） */
function lightApply(v: number, d: number): number {
  return d >= 0 ? v + (1 - v) * (d / 100) : v * (1 + d / 100);
}

/** 单通道曲线是否画过 */
function active(curve: CurvePoint[] | undefined): boolean {
  if (!curve || curve.length < 2) return false;
  return curve.some(([x, y]) => Math.abs(x - y) > 1);
}

const lutIndex = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : v | 0);
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 影调 → 亮度映射表（0..255）+ 曲线通道表，与后端 buildLuts 同构 */
export function buildLuts(p: AdjustParams): { luma: Float32Array; r: Float32Array; g: Float32Array; b: Float32Array } {
  const sh = p.shadows / 100;
  const hi = p.highlights / 100;
  const wh = p.whites / 100;
  const bl = p.blacks / 100;
  const curves: CurveSet = p.curves || CURVES_DEFAULTS;
  const main = active(curves.rgb) ? curveFn(curves.rgb) : null;
  const chR = active(curves.r) ? curveFn(curves.r) : null;
  const chG = active(curves.g) ? curveFn(curves.g) : null;
  const chB = active(curves.b) ? curveFn(curves.b) : null;

  const luma = new Float32Array(256);
  for (let i = 0; i < 256; i++) luma[i] = toneMap(i / 255, sh, hi, wh, bl) * 255;

  const mk = (ch: ((x: number) => number) | null): Float32Array => {
    const out = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      let x = i / 255;
      if (main) x = main(x);
      if (ch) x = ch(x);
      out[i] = (x < 0 ? 0 : x > 1 ? 1 : x) * 255;
    }
    return out;
  };
  return { luma, r: mk(chR), g: mk(chG), b: mk(chB) };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampSym = (v: number) => (v < -100 ? -100 : v > 100 ? 100 : v);

/* ---------------- Camera Raw「混色器」 ---------------- */

/** 8 个色带的色相环中心角（度），与 types.MIX_BANDS 一致 */
const MIX_DEFS: { key: MixBandKey; center: number }[] = [
  { key: 'red', center: 0 },
  { key: 'orange', center: 30 },
  { key: 'yellow', center: 60 },
  { key: 'green', center: 120 },
  { key: 'aqua', center: 180 },
  { key: 'blue', center: 240 },
  { key: 'purple', center: 280 },
  { key: 'magenta', center: 320 },
];
/** 到色带中心 45° 权重衰减到 0；再按总权重归一，相邻色带之间平滑过渡（Camera Raw 观感） */
const MIX_EDGE = 45;

function mixWeight(deg: number, center: number): number {
  let d = Math.abs(deg - center);
  if (d > 180) d = 360 - d;
  return d >= MIX_EDGE ? 0 : 1 - d / MIX_EDGE;
}

/* ---------------- Camera Raw「颜色分级」 ---------------- */

/**
 * 阴影/中间调/高光三区权重（和为 1）。
 * 用明度分带：soft 越大过渡越柔（对应「混合」），balance 把分界整体往暗/往亮推。
 */
function gradeWeights(l: number, blending: number, balance: number): [number, number, number] {
  const soft = 0.3 + clamp01(blending / 100) * 0.55; // 0.30..0.85
  const x = clamp01(l + (clampSym(balance) / 100) * 0.18);
  const wS = clamp01((soft - x) / soft);
  const wH = clamp01((x - (1 - soft)) / soft);
  const wM = Math.max(0, 1 - wS - wH);
  const sum = wS + wM + wH;
  return sum > 0 ? [wS / sum, wM / sum, wH / sum] : [0, 1, 0];
}

/** 是否存在需要走 HSL 的调整 */
export function needsHsl(p: AdjustParams): boolean {
  if (p.saturation || p.hue) return true;
  if (!isColorMixerDefault(p.colorMixer)) return true;
  if (!isColorGradeDefault(p.colorGrade)) return true;
  const hs = p.hueSat;
  if (!hs) return false;
  if (hs.colorize) return true;
  return Object.values(hs.bands).some((b) => b && (b.h || b.s || b.l));
}

/**
 * 就地把像素数据按调色参数处理（RGBA / RGB / 灰度都支持，只动前三个通道）。
 * data 为 Uint8ClampedArray（浏览器 ImageData.data 即为该类型）。
 */
export function renderPixels(data: Uint8ClampedArray | Uint8Array, channels: number, p: AdjustParams): void {
  const kr = 1 + p.temperature * 0.0025 - p.tint * 0.0008;
  const kg = 1 - p.tint * 0.0032;
  const kb = 1 - p.temperature * 0.0025 - p.tint * 0.0008;
  const wb = !!(p.temperature || p.tint);
  const bright = Math.max(0.05, 1 + p.exposure * 0.008);
  const ca = 1 + p.contrast * 0.006;
  const cb = 128 * (1 - ca);
  const contrast = !!p.contrast;
  const vib = p.vibrance / 100;
  const sat = p.saturation;
  const hueDeg = p.hue * 0.45;

  const { luma, r: lutR, g: lutG, b: lutB } = buildLuts(p);
  // 影调与曲线是**两个独立开关**（与后端 useTone / useCurve 一一对应）：
  // 没调影调却跑亮度表，会因为「查表下标取整」把 k 算成 floor(y)/y < 1，整幅图被悄悄压暗。
  const ct = p.curves || CURVES_DEFAULTS;
  const hasTone = !!(p.shadows || p.highlights || p.whites || p.blacks);
  const hasCurve = active(ct.rgb) || active(ct.r) || active(ct.g) || active(ct.b);

  const hs = p.hueSat;
  const hasHs = needsHsl(p);
  const colorize = !!hs?.colorize;
  const cHue = (hs?.colorizeHue ?? 0) / 360;
  const cSat = (hs?.colorizeSat ?? 0) / 100;
  const cLight = hs?.colorizeLight ?? 0;
  const mBand = hs?.bands?.master;
  const bandArr = hs ? BAND_DEFS.map((d) => ({ center: d.center, b: hs.bands[d.key] })) : [];
  const anyBand = bandArr.some((x) => x.b && (x.b.h || x.b.s || x.b.l));

  // 混色器 / 颜色分级：只在真正调过时才进入 HSL 分支
  const cg = p.colorGrade;
  const hasGrade = !isColorGradeDefault(cg);
  const gradeZones = cg?.zones ? [cg.zones.shadows, cg.zones.midtones, cg.zones.highlights, cg.zones.global] : [];
  const gradeBlending = cg?.blending ?? 50;
  const gradeBalance = cg?.balance ?? 0;
  const cmx = p.colorMixer;
  const hasMix = !isColorMixerDefault(cmx);
  const mixLive = cmx
    ? MIX_DEFS.filter((d) => cmx.bands[d.key] && (cmx.bands[d.key].h || cmx.bands[d.key].s || cmx.bands[d.key].l)).map(
        (d) => ({ center: d.center, b: cmx.bands[d.key] })
      )
    : [];
  const hasMixGrade = hasGrade || hasMix;

  const hsl = new Float64Array(3);

  for (let i = 0; i < data.length; i += channels) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    if (wb) {
      r *= kr;
      g *= kg;
      b *= kb;
    }
    if (hasTone) {
      // 影调作用在亮度上（按比例缩放三通道，保色相）
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
    if (hasCurve) {
      r = lutR[lutIndex(r)];
      g = lutG[lutIndex(g)];
      b = lutB[lutIndex(b)];
    }
    if (vib) {
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const s0 = mx > 0 ? (mx - mn) / mx : 0;
      const k2 = (1 - s0) * vib * 0.9;
      const avg = (r + g + b) / 3;
      r += (r - avg) * k2;
      g += (g - avg) * k2;
      b += (b - avg) * k2;
    }

    if (hasHs) {
      let h = 0;
      let s = 0;
      let l = 0;
      if (colorize) {
        // 着色：整幅图归到单一色相，明度按滑块
        const lr = clamp255(r) / 255;
        const lg = clamp255(g) / 255;
        const lb = clamp255(b) / 255;
        const cur = rgbToHsl(lr, lg, lb);
        h = cHue;
        s = cSat;
        l = lightApply(cur[2], cLight);
      } else {
        const cur = rgbToHsl(clamp255(r) / 255, clamp255(g) / 255, clamp255(b) / 255);
        const deg = cur[0] * 360;
        let dH = mBand ? mBand.h : 0;
        let dS = mBand ? mBand.s : 0;
        let dL = mBand ? mBand.l : 0;
        if (anyBand) {
          for (let k = 0; k < bandArr.length; k++) {
            const item = bandArr[k];
            if (!item.b || (!item.b.h && !item.b.s && !item.b.l)) continue;
            const w = bandWeight(deg, item.center);
            if (!w) continue;
            dH += item.b.h * w;
            dS += item.b.s * w;
            dL += item.b.l * w;
          }
        }
        if (!dH && !dS && !dL) {
          // 没有可作用的值，跳过 HSL 往返
          h = -1;
        } else {
          h = (cur[0] + dH / 360) % 1;
          if (h < 0) h += 1;
          s = satApply(cur[1], Math.max(-100, Math.min(100, dS)));
          l = lightApply(cur[2], Math.max(-100, Math.min(100, dL)));
        }
      }
      if (h >= 0) {
        hslToRgb(h, s < 0 ? 0 : s > 1 ? 1 : s, l < 0 ? 0 : l > 1 ? 1 : l, hsl);
        r = hsl[0];
        g = hsl[1];
        b = hsl[2];
      }
    }

    // 混色器 + 颜色分级：同在 HSL 域，合并成一次往返（先混色器、再颜色分级，与 Camera Raw 面板顺序一致）
    if (hasMixGrade) {
      const cur = rgbToHsl(clamp255(r) / 255, clamp255(g) / 255, clamp255(b) / 255);
      let h = cur[0];
      let s = cur[1];
      let l = cur[2];

      if (hasMix) {
        const deg = h * 360;
        let dH = 0;
        let dS = 0;
        let dL = 0;
        let wsum = 0;
        for (let k = 0; k < mixLive.length; k++) {
          const it = mixLive[k];
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
          // 色相滑块 ±100 → ±60°（Camera Raw 的幅度观感）
          h = (h + (clampSym(dH) * 0.6) / 360) % 1;
          if (h < 0) h += 1;
          s = satApply(s, clampSym(dS));
          l = lightApply(l, clampSym(dL));
        }
      }

      if (hasGrade) {
        // 三区按像素明度加权（global 全图叠加）；色相用向量和合成，多区不同色相也不会互相抵消
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
          const target = ((Math.atan2(vy, vx) / (Math.PI * 2) + 1) % 1);
          let dh = target - h;
          if (dh > 0.5) dh -= 1;
          if (dh < -0.5) dh += 1;
          h = (h + dh * alpha + 1) % 1;
          s = s + (1 - s) * alpha * 0.7; // 染色同时把该区饱和度顶上来（ACR 的色轮效果）
        }
        if (lumAdj) l = lightApply(l, clampSym(lumAdj) * 0.55);
      }

      hslToRgb(clamp01(h), clamp01(s), clamp01(l), hsl);
      r = hsl[0];
      g = hsl[1];
      b = hsl[2];
    }

    if (sat || hueDeg) {
      const cur = rgbToHsl(clamp255(r) / 255, clamp255(g) / 255, clamp255(b) / 255);
      let h = cur[0];
      let s = cur[1];
      if (sat) s = satApply(s, sat);
      if (hueDeg) {
        h = (h + hueDeg / 360) % 1;
        if (h < 0) h += 1;
      }
      hslToRgb(h, s < 0 ? 0 : s > 1 ? 1 : s, cur[2], hsl);
      r = hsl[0];
      g = hsl[1];
      b = hsl[2];
    }

    if (bright !== 1) {
      r *= bright;
      g *= bright;
      b *= bright;
    }
    if (contrast) {
      r = r * ca + cb;
      g = g * ca + cb;
      b = b * ca + cb;
    }

    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}
