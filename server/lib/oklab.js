// @ts-check
/**
 * OKLab 感知均匀颜色空间（Björn Ottosson）的纯函数实现。
 * 从 color.js / search.js 抽出来的唯一实现：OKLab 欧氏距离才是「感知色差」，
 * 不是 RGB 欧氏距离。本模块不依赖 sharp，可在迁移回填 / 颜色打分 / 查询里共用。
 */

export function srgbToLinear(x) {
  x /= 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function hexToRgb(hex) {
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

export function rgbToOklab(hex) {
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

export function oklabDist(c1, c2) {
  const dl = c1.L - c2.L, da = c1.a - c2.a, db = c1.b - c2.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

export function oklabChroma(c) {
  return Math.hypot(c.a, c.b);
}

export function oklabHue(lab) {
  const h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}
