/**
 * 全自动调色的「按图择优」：同一套候选网格，逐组**真渲染**打分，挑最讨好眼球的那一组。
 *
 * 为什么不再用一套固定公式决定曝光/曲线：
 *  - 固定公式只能在「别出错」的方向上保守（少提亮、少加饱和），结果就是自动一按图就发闷；
 *  - 每张图合适的参数本来就不同，唯一可靠的办法是把候选真渲染出来、按观感指标比一比。
 *
 * 打分只看**人眼关心的几件事**，不看某个滑块该是多少：
 *  1. 亮度落在该场景的舒服区间（人像/平光偏亮一档，舞台/夜本就该暗）；
 *  2. 白是白：亮部不能灰成一团（这是「自动一按就发灰」的第一来源）；
 *  3. 黑是黑：不能把暗部糊成灰浆；
 *  4. 层次：亮暗跨度要比原图更开；
 *  5. 饱和只增不减：自动把颜色调淡是最招人烦的失败；
 *  6. 撞白硬约束：多出来的撞白像素一律重罚（宁可少提亮，不许新增死白）。
 *
 * 采样只取 1 万多个像素，单次候选渲染是亚毫秒级；几十组候选加起来仍在预算内。
 */
import type { CurvePoint } from '../types';
import { ADJUST_DEFAULTS } from '../types';
import { renderPixels } from './adjust';

/** 采样点数：再多也不会让打分更准，只会更慢 */
const SAMPLE_TARGET = 12000;

export interface LookStat {
  mean: number;
  p2: number;
  p50: number;
  p90: number;
  p98: number;
  /** p90 - p10，越大越「通透」 */
  spread: number;
  /** 任一通道 ≥250 的占比 */
  clip: number;
  /** 亮度 ≤ 2/255 的占比（死黑） */
  dead: number;
  /** 观感饱和度均值（只算看得见的颜色） */
  sat: number;
}

/**
 * 观感饱和度：HSL 的 S，按「离中间调多远」加权。
 * 直接用 (mx-mn)/mx 会被暗部噪声和死白拉偏（一压暗就虚高/虚低），
 * 加权后基本不随亮度漂移，前后两次量出来才可比。
 */
function satOf(r: number, g: number, b: number, on: (s: number, w: number) => void): void {
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  if (mx <= 41 || mx >= 252) return; // 暗部噪声 / 死白不进统计
  const l = (mx + mn) / 510;
  let s = 0;
  if (mx !== mn) s = l > 0.5 ? (mx - mn) / (1020 - mx - mn) : (mx - mn) / (mx + mn);
  on(s, 1 - Math.abs(2 * l - 1) + 0.15);
}

/**
 * 把 RGBA/RGB 图按步长抽成 RGB 小块。
 * 均匀步长采样对直方图统计够用，且保证同一张图每次跑出来完全一样（可复现）。
 */
export function subsampleRgb(data: Uint8ClampedArray | Uint8Array, channels: number, want = SAMPLE_TARGET): Uint8Array {
  const pixels = Math.floor(data.length / channels);
  if (!pixels) return new Uint8Array(0);
  const stride = Math.max(1, Math.floor(pixels / want));
  const n = Math.floor((pixels + stride - 1) / stride);
  const out = new Uint8Array(n * 3);
  let o = 0;
  for (let p = 0; p < pixels; p += stride) {
    const i = p * channels;
    out[o] = data[i];
    out[o + 1] = data[i + 1];
    out[o + 2] = data[i + 2];
    o += 3;
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** 渲染结果的观感统计（单遍扫描） */
export function measureLook(data: Uint8Array, channels = 3): LookStat {
  const hist = new Float64Array(256);
  let n = 0;
  let sum = 0;
  let clip = 0;
  let dead = 0;
  let satSum = 0;
  let satW = 0;
  for (let i = 0; i + 2 < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[y < 0 ? 0 : y > 255 ? 255 : (y + 0.5) | 0] += 1;
    n += 1;
    sum += y;
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (mx >= 250) clip += 1;
    if (y <= 2) dead += 1;
    satOf(r, g, b, (sv, w) => {
      satSum += sv * w;
      satW += w;
    });
  }
  const pct = (q: number) => {
    const target = q * n;
    let acc = 0;
    for (let v = 0; v < 256; v += 1) {
      acc += hist[v];
      if (acc >= target) return v / 255;
    }
    return 1;
  };
  return {
    mean: n ? sum / n / 255 : 0,
    p2: pct(0.02),
    p50: pct(0.5),
    p90: pct(0.9),
    p98: pct(0.98),
    spread: pct(0.9) - pct(0.1),
    clip: n ? clip / n : 0,
    dead: n ? dead / n : 0,
    sat: satW ? satSum / satW : 0,
  };
}

/** 打分所需的光源信息（结构化成接口，避免与 auto-tone 互相 import） */
export interface LookPriori {
  /** 原图撞白占比 */
  clipHi: number;
  /** 原图死黑占比 */
  clipLo: number;
  /** 原图观感饱和度 */
  satMean: number;
  /** 原图平均亮度（调完不许比它更暗） */
  inMean: number;
  /** 原图亮暗跨度 */
  inSpread: number;
  /** 亮度目标带 [下限, 上限]：按场景给 */
  band: readonly [number, number];
  /** 亮部至少要到的位置（p98）：低于这个就是「灰」 */
  wantWhite: number;
  /** 自然饱和度基调与上限 */
  vibBase: number;
  vibCap: number;
  /** 固定不参与搜索的滑块（影调/饱和/对比/白平衡） */
  fixed: {
    temperature: number;
    tint: number;
    highlights: number;
    shadows: number;
    saturation: number;
    contrast: number;
  };
  /** 按 (增益, 自然饱和度, 曲线强度, 压黑力度) 造主曲线 */
  makeCurve: (gain: number, vib: number, strength: number, crush: number) => CurvePoint[];
}

export interface LookPick {
  /** 曝光滑块值（-100..100） */
  exposure: number;
  vibrance: number;
  /** 对比度：抬高阴影之后用来把反差找回来，别让画面被抬成灰雾 */
  contrast: number;
  /** 高光回收幅度（0 表示这张图不值得为救高光去压亮部） */
  highlights: number;
  curves: CurvePoint[];
  score: number;
}

/** 单组候选的观感得分：越高越好（量级只是相对值） */
function scoreOf(m: LookStat, p: LookPriori): number {
  const [lo, hi] = p.band;
  let sc = 0;
  // 1. 亮度：带内不扣；暗了重扣（人眼最反感「闷」），亮了轻扣（过亮比过暗可接受）
  if (m.mean < lo) sc -= (lo - m.mean) * 110;
  else if (m.mean > hi) sc -= (m.mean - hi) * 55;
  // 1b. 绝不许比原图更暗：自动一按就发闷，是这套功能最招人烦的失败方式。
  //     这条权重给到最高一档 —— 宁可反差少一点点，也不能让照片整体压暗。
  sc -= Math.max(0, p.inMean - m.mean) * 900;
  // 2. 白不能灰：p98 掉到 wantWhite 以下，每一档都很刺眼
  if (m.p98 < p.wantWhite) sc -= (p.wantWhite - m.p98) * 190;
  else if (m.p98 > 0.992) sc -= (m.p98 - 0.992) * 70;
  // 3. 黑不能糊：死黑比原图多出来才扣（舞台/夜景本来就有大面积黑）
  sc -= Math.max(0, m.dead - p.clipLo - 0.02) * 240;
  // 4. 层次：跨度比原图更开给奖励，但到顶就够（别把图做成高反差怪）；
  //    反差被压平要**罚**——「一按就发灰」就是抬阴影 + 压高光把亮暗跨度吃掉的结果，
  //    只奖励不惩罚的话，挑不出「用对比度把反差找回来」的那组。
  const dSpread = m.spread - p.inSpread * 0.98;
  sc += dSpread > 0 ? Math.min(0.12, dSpread) * 190 : Math.max(-0.25, dSpread) * 300;
  // 5. 饱和只增不减：降了就重罚（这条比"更亮一点"重要）；过艳也罚，别把图调成霓虹
  sc -= Math.max(0, p.satMean - m.sat) * 520;
  sc -= Math.max(0, m.sat - 0.55) * 300;
  // 6. 撞白硬约束：不许**新增**死白。容差按原图撞白比例放大——
  //    原图已经撞白 8% 的片子（白底商品、带窗光的逆光），再多撞 1~2% 肉眼看不出，
  //    但为了把这 1% 救回来把整幅压暗 8 档，是拿整张照片陪葬。
  sc -= Math.max(0, m.clip - (p.clipHi + Math.max(0.006, p.clipHi * 0.3))) * 42000;
  return sc;
}

const clampSym = (v: number) => (v < -100 ? -100 : v > 100 ? 100 : v);
const round = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));

/**
 * 在候选网格里挑一组最顺眼的参数。
 * 曝光只朝「场景允许」的方向取值；曲线强度与压黑力度一起搜，因为「通透」正是这两者配合出来的。
 */
export function chooseLook(
  sample: Uint8Array,
  p: LookPriori,
  baseGain: number,
  minGain = 0.9,
  maxGain = 1.9,
): LookPick {
  const empty: CurvePoint[] = [];
  if (sample.length < 30) {
    return {
      exposure: round((baseGain - 1) / 0.008),
      vibrance: p.vibBase,
      contrast: p.fixed.contrast,
      highlights: p.fixed.highlights,
      curves: empty,
      score: 0,
    };
  }

  const base = {
    ...ADJUST_DEFAULTS,
    temperature: p.fixed.temperature,
    tint: p.fixed.tint,
    highlights: p.fixed.highlights,
    shadows: p.fixed.shadows,
    saturation: p.fixed.saturation,
    contrast: p.fixed.contrast,
  };

  const gains = [0.94, 1, 1.06, 1.13, 1.22]
    .map((k) => Math.min(maxGain, Math.max(minGain, baseGain * k)))
    .filter((g, i, a) => a.indexOf(g) === i);
  const vibs = [p.vibBase, Math.min(p.vibCap, p.vibBase + 8)].filter((v, i, a) => a.indexOf(v) === i);
  const strengths = [0.65, 1];
  const crushes = [0, 0.7];
  // 高光回收和对比度也进候选：抬阴影/压高光一定会吃掉反差，得让「补回对比」这组一起比，
  // 否则只能在一堆同样发灰的组合里挑一个。
  const hls = p.fixed.highlights ? [0, p.fixed.highlights] : [0];
  const contrasts = p.fixed.contrast ? [p.fixed.contrast, p.fixed.contrast + 12] : [0, 12];

  let best: LookPick | null = null;
  const out = new Uint8Array(sample.length);

  for (const strength of strengths) {
    for (const crush of crushes) {
      for (const gain of gains) {
        for (const vib of vibs) {
          const exposure = clampSym(round((gain - 1) / 0.008));
          const curves = p.makeCurve(1 + exposure * 0.008, vib, strength, crush);
          for (const highlights of hls) {
            for (const contrast of contrasts) {
              out.set(sample);
              renderPixels(out, 3, {
                ...base,
                highlights,
                contrast,
                exposure,
                vibrance: vib,
                curves: { rgb: curves, r: [], g: [], b: [] },
              });
              const score = scoreOf(measureLook(out), p);
              if (!best || score > best.score) best = { exposure, vibrance: vib, contrast, highlights, curves, score };
            }
          }
        }
      }
    }
  }
  return best ?? { exposure: 0, vibrance: p.vibBase, contrast: p.fixed.contrast, highlights: p.fixed.highlights, curves: empty, score: 0 };
}
