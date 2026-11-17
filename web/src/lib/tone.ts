// 带 .ts 扩展名：Node 直接跑单测时能解析（Vite 与 allowImportingTsExtensions 同样支持）
import type { AdjustParams, CurvePoint, CurveSet } from '../types';
import { CURVES_DEFAULTS, hasAnyCurve } from '../types';

/**
 * 影调 / 曲线 / 白平衡的**共用公式**（预览与后端同一套常量）。
 *
 * 真正的预览渲染在 web/src/lib/adjust.ts::renderPixels —— 它也把影调作用在**亮度域**，
 * 与 server/lib/edit.js 的 applyRaw 对齐。这里只放可被两边复用的纯函数：
 * 曲线插值、影调映射、白平衡增益与反解。
 *
 * 历史包袱（已删）：曾经有一份 toneTables / previewLuts，把影调**逐通道**套进
 * SVG feComponentTransfer 的 tableValues。那套算法与成品（亮度域）不一致，
 * 会在高饱和区域产生色偏，而且早已无人调用。只保留一份实现，避免再次跑偏。
 */

/** 单调三次插值（Fritsch–Carlson），自动补 0,0 与 255,255；入参出参均为 0..1 */
export function curveFn(points: CurvePoint[]): (x: number) => number {
  const ps = points.map((p) => [p[0], p[1]] as CurvePoint).sort((a, b) => a[0] - b[0]);
  if (!ps.length) return (x) => x;
  if (ps[0][0] > 0) ps.unshift([0, 0]);
  if (ps[ps.length - 1][0] < 255) ps.push([255, 255]);
  const n = ps.length;
  const xs = ps.map((p) => p[0] / 255);
  const ys = ps.map((p) => p[1] / 255);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 影调映射（与后端 toneMap 同式） */
export function toneMap(x: number, sh: number, hi: number, wh: number, bl: number): number {
  let v = x;
  if (sh) v += sh * 0.32 * Math.pow(1 - v, 2.6);
  if (hi) v += hi * 0.32 * Math.pow(v, 2.6);
  if (wh || bl) v = bl * 0.18 + v * (1 + (wh - bl) * 0.22);
  return clamp01(v);
}

export function hasToneAdjust(p: AdjustParams): boolean {
  return !!(p.highlights || p.shadows || p.whites || p.blacks);
}

export function hasCurveAdjust(p: AdjustParams): boolean {
  return hasAnyCurve(p.curves);
}


/** 白平衡通道增益（与后端 wbMatrix 同参） */
export function wbGains(p: AdjustParams): [number, number, number] {
  const r = 1 + p.temperature * 0.0025 - p.tint * 0.0008;
  const g = 1 - p.tint * 0.0032;
  const b = 1 - p.temperature * 0.0025 - p.tint * 0.0008;
  return [r, g, b];
}

/**
 * 白平衡吸管：取样色 → 色温/色调。
 * 反解后端模型（kr=1+0.0025t-0.0008u, kg=1-0.0032u, kb=1-0.0025t-0.0008u）的一阶解：
 *   0.0025t + 0.0024u = ln(G/R)，-0.0025t + 0.0024u = ln(G/B)
 * 解得 t = ln(B/R)/0.005、u = ln(G²/(R·B))/0.0048，即让取样点三通道相等所需滑块值。
 */
export function wbFromRgb(r: number, g: number, b: number): { temperature: number; tint: number } {
  const R = Math.max(1, r);
  const G = Math.max(1, g);
  const B = Math.max(1, b);
  const A = Math.log(G / R);
  const Bv = Math.log(G / B);
  const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v)));
  return { temperature: clamp((A - Bv) / 0.005), tint: clamp((A + Bv) / 0.0048) };
}
