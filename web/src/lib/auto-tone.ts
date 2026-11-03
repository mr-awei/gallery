// 带 .ts 扩展名：Node 直接跑单测时能解析（Vite 与 allowImportingTsExtensions 同样支持）
import type { ColorMixerParams, CurvePoint, CurveSet } from '../types.ts';
import { ADJUST_DEFAULTS, makeColorMixer } from '../types.ts';
import { curveFn, wbFromRgb } from './tone.ts';
import { renderPixels } from './adjust.ts';
import { chooseLook, measureLook, subsampleRgb } from './auto-look.ts';

/**
 * 全自动调色（Auto Develop）。
 *
 * 目标是一眼好看，而不是「只做安全微调」：去灰、通透、肤色不脏、高光不糊、暗部有细节。
 * 参考的公开做法：
 *   - autocolor-go 的确定性一键调色：灰度世界白平衡 → 百分位曝光 → S 曲线 → 饱和 → 局部对比
 *   - CURL（ICPR 2020）：不预测像素，而是预测**色调曲线**，与这里「自动写一条主曲线」同路
 *   - ACR / Lightroom Auto：先钉白场黑场锚点，再补中间调
 *
 * 与旧版的区别：
 *   1. 自动写主曲线（curves.rgb）：滑块做不出「黑场压低 + 白场开到 0.985 + 中间调轻抬 + 高光带肩」，
 *      而这条曲线是「通透」的观感来源，并且用户能在曲线面板里看见、改回。
 *   2. 按场景分类决策（逆光 / 舞台 / 高调 / 灰雾 / 人像 / 常规），同一套公式不再一套参数套所有图。
 *   3. 肤色保护：人像不追加强饱和，橙红微降、橙色亮度微抬；蓝天/绿植单独加强。
 *   4. 硬约束：白场锚点上限 0.985、黑场不压穿、曝光受高光余量限制——加亮但绝不多撞白。
 */

/** 采样上限：40k 像素足够稳，10MP 也只要几毫秒 */
const MAX_SAMPLES = 40000;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const { round } = Math;

/** 图像统计（编码值 0..1，与管线同域：曝光是在编码值上做增益） */
export interface AutoStats {
  samples: number;
  p1: number;
  p2: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  /** 贴顶（≥0.99）像素占比 */
  clipHi: number;
  /** 贴底（≤0.02）像素占比 */
  clipLo: number;
  mean: number;
  std: number;
  /** 平均 HSV 饱和 */
  satMean: number;
  /** 肤色像素占比（YCbCr 判定，含偏暖的木头/沙地，宁可多保护） */
  skinFrac: number;
  /** 蓝（天空/水）像素占比 */
  blueFrac: number;
  /** 绿（植被）像素占比 */
  greenFrac: number;
  /** 可用于白平衡的低饱和像素占比（可信度） */
  neutralFrac: number;
  /** 中性像素的暖偏：meanR - meanB（0..1） */
  warmBias: number;
  /** R/G/B 三通道直方图（各 256 桶）：用来按通道精确预测「这么调之后会不会多撞白」 */
  histR: Float64Array;
  histG: Float64Array;
  histB: Float64Array;
}

/**
 * YCbCr 肤色判定，入参是 0..1 的编码值。
 * 经典阈值 Cb∈[77,127]、Cr∈[133,173] 去掉 128 偏置再除以 255 得到下面的归一值。
 */
function isSkin(r: number, g: number, b: number, y: number): boolean {
  if (y < 0.15 || y > 0.98) return false;
  const cb = 0.5 * b - 0.168736 * r - 0.331264 * g;
  const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb > -0.216 && cb < 0 && cr > 0.02 && cr < 0.19 && r > g && g > b;
}

/** 单遍采样：直方图 + 场景统计 + 中性像素的 Minkowski 均值（Shades-of-Gray, p=6） */
export function analyzePixels(data: Uint8ClampedArray | Uint8Array, channels: number): AutoStats {
  const pixels = Math.floor(data.length / channels);
  const hist = new Float64Array(256);
  const histR = new Float64Array(256);
  const histG = new Float64Array(256);
  const histB = new Float64Array(256);
  let n = 0;
  let clipHi = 0;
  let clipLo = 0;
  let satSum = 0;
  let satN = 0;
  let skin = 0;
  let blue = 0;
  let green = 0;
  let neutral = 0;
  let sum = 0;
  let sumSq = 0;
  let wR = 0;
  let wB = 0;

  const step = Math.max(1, Math.floor(pixels / MAX_SAMPLES)) * channels;
  for (let i = 0; i + 2 < data.length; i += step) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    hist[Math.min(255, Math.max(0, round(y * 255)))] += 1;
    n += 1;
    sum += y;
    sumSq += y * y;
    // 撞白按「任一通道顶到 250」算：只看亮度会漏掉饱和的高光（白裙、天空、灯）
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    // 三通道各存一张：白平衡是逐通道增益，只存「最大通道」会和增益错配，
    // 把「蓝通道 +9%」误算成「红通道的 255 要爆」
    histR[Math.min(255, Math.max(0, round(r * 255)))] += 1;
    histG[Math.min(255, Math.max(0, round(g * 255)))] += 1;
    histB[Math.min(255, Math.max(0, round(b * 255)))] += 1;
    if (mx >= 0.98) clipHi += 1;
    if (y <= 0.02) clipLo += 1;
    // 观感饱和度只统计「看得见的颜色」：暗部像素的 (mx-mn)/mx 天生很高（10,4,3 就有 0.7），
    // 算进去会把暗图误判成「已经很艳」，自动反而去减饱和 —— 这是「自动一按就发灰」的老病根
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    if (mx > 0.16 && mx < 0.99) {
      satSum += sat;
      satN += 1;
    }

    // 色相（只在有色时算，省一点）
    if (sat > 0.12 && mx > 0.08) {
      const d = mx - mn;
      let h = 0;
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      if (h >= 185 && h <= 265) blue += 1;
      else if (h >= 70 && h <= 165) green += 1;
    }

    if (isSkin(r, g, b, y)) skin += 1;
    // 中性像素（去掉纯白/纯黑/肤色）：Shades-of-Gray 的样本池
    if (sat < 0.26 && y > 0.06 && y < 0.96 && !isSkin(r, g, b, y)) {
      neutral += 1;
      wR += r;
      wB += b;
    }
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

  const mean = n ? sum / n : 0;
  const std = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
  return {
    samples: n,
    p1: pct(0.01),
    p2: pct(0.02),
    p5: pct(0.05),
    p25: pct(0.25),
    p50: pct(0.5),
    p75: pct(0.75),
    p90: pct(0.9),
    p95: pct(0.95),
    p99: pct(0.99),
    clipHi: n ? clipHi / n : 0,
    clipLo: n ? clipLo / n : 0,
    mean,
    std,
    satMean: satN ? satSum / satN : 0,
    skinFrac: n ? skin / n : 0,
    blueFrac: n ? blue / n : 0,
    greenFrac: n ? green / n : 0,
    neutralFrac: n ? neutral / n : 0,
    warmBias: neutral ? wR / neutral - wB / neutral : 0,
    histR,
    histG,
    histB,
  };
}

/** 撞白线：任一通道 ≥250（跟 clipHi 与统计口径共用同一个 250/255，两套线会打架） */
export const CLIP_LINE = 250 / 255;

/**
 * 预测「调完会不会真撞白」（任一通道 ≥250）。
 * 三张通道直方图逐桶推演：v 先乘该通道自己的白平衡增益 k[c]，走曲线 f，再乘曲线后的统一倍数 mPost。
 */
function predictClip(
  s: AutoStats,
  f: (x: number) => number,
  mPost: number,
  k: readonly [number, number, number],
): number {
  const hists = [s.histR, s.histG, s.histB];
  let worst = 0;
  for (let c = 0; c < 3; c += 1) {
    const hist = hists[c];
    const kc = k[c];
    let acc = 0;
    for (let v = 0; v < 256; v += 1) {
      const cnt = hist[v];
      if (cnt && f((v / 255) * kc) * mPost >= CLIP_LINE) acc += cnt;
    }
    if (acc > worst) worst = acc;
  }
  return worst / Math.max(1, s.samples);
}

/** 白平衡估计：0 就是不用动 */
export interface WbEstimate {
  temperature: number;
  tint: number;
  /** 可用中性像素占比，越低越不可信 */
  confidence: number;
}

/**
 * Shades-of-Gray（Finlayson & Trezzi, p=6）白平衡：
 * 只吃「低饱和 + 非肤色」像素，用 Minkowski 范数代替算术平均，
 * 大面积色块（红衣、绿草地）拉不动它，而纯灰度世界很容易被拉偏。
 */
export function estimateWhiteBalance(data: Uint8ClampedArray | Uint8Array, channels: number): WbEstimate {
  const pixels = Math.floor(data.length / channels);
  const step = Math.max(1, Math.floor(pixels / MAX_SAMPLES)) * channels;
  let n = 0;
  let seen = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i + 2 < data.length; i += step) {
    seen += 1;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    if (y < 0.06 || y > 0.96) continue; // 纯黑纯白没有色偏信息
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx <= 0 || (mx - mn) / mx > 0.26) continue; // 高饱和像素是「有颜色的物体」，不是白参考
    if (isSkin(r, g, b, y)) continue;
    // 绿植 / 天空是内容色，不是色偏：把它们算进白参考，户外照会被拉成褐黄
    const d = mx - mn;
    if (d > 0) {
      let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
      if ((hue >= 70 && hue <= 165) || (hue >= 185 && hue <= 265)) continue;
    }
    n += 1;
    sr += r ** 6;
    sg += g ** 6;
    sb += b ** 6;
  }
  // 整张图都是高饱和（纯色场景 / 强色偏）：没有中性参考，退化成灰度世界
  if (!n) {
    for (let i = 0; i + 2 < data.length; i += step) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (y < 0.06 || y > 0.96) continue;
      seen += 1;
      n += 1;
      sr += r ** 6;
      sg += g ** 6;
      sb += b ** 6;
    }
    if (!n) return { temperature: 0, tint: 0, confidence: 0 };
  }
  const norm = (s: number) => (s / n) ** (1 / 6) * 255;
  const { temperature, tint } = wbFromRgb(norm(sr), norm(sg), norm(sb));
  return {
    temperature: clamp(round(temperature), -80, 80),
    tint: clamp(round(tint), -60, 60),
    confidence: seen ? n / seen : 0,
  };
}

/** 场景标签（同一套公式按场景换强度，别拿一套参数套所有图） */
export interface Scene {
  backlit: boolean;
  lowkey: boolean;
  highkey: boolean;
  flat: boolean;
  portrait: boolean;
}

export function classifyScene(s: AutoStats): Scene {
  return {
    // 大亮天空 + 暗主体：加曝光会把背景彻底送白，只能靠压高光 + 抬阴影
    backlit: s.clipHi > 0.004 && s.p50 < 0.3,
    // 舞台 / 夜空：本来就该暗，抬中间调和压黑点都会毁掉氛围
    lowkey: s.p50 < 0.16,
    // 雪景 / 白底商品 / 高调人像：已经很亮，别再往上推
    highkey: s.p50 > 0.66,
    // 灰雾 / 阴天平光：直方图挤在中间，最需要「去灰」
    flat: s.p95 - s.p5 < 0.42 || (s.p5 > 0.14 && s.p95 < 0.86),
    portrait: s.skinFrac > 0.05,
  };
}

/** 白场目标上限（显示域）：比 0.98 的撞白线低一档，永远不越线 */
const WHITE_CAP = 0.96;

/**
 * 自动主曲线：黑场压低 → 白场打开 → 中间调轻抬 → 高光肩部。
 * 这是「去灰 + 通透」的来源，滑块只能近似；写进曲线后用户还能手动改。
 *
 * 关键约束：曲线前面有白平衡增益、后面有曝光与振动（wb → 影调 → 曲线 → 振动 → 曝光 → 对比度）。
 * 所以白场目标要按**曲线之后**的倍数 mPost 换算回曲线域；白平衡那部分在曲线之前，
 * 由曲线自身的压缩自然吃掉。搞反了就会压缩过头，纯白被压成灰（真机上确实灰过）。
 *
 * 另一条同样重要的约束：**白场只封顶一次，绝不连环往下缩**——那会把整幅图一起拉暗。
 */
function buildAutoCurve(
  s: AutoStats,
  mPost: number,
  k: readonly [number, number, number],
  sc: Scene,
  opt?: { strength?: number; crush?: number },
): CurvePoint[] {
  const full = opt?.strength ?? (sc.lowkey ? 0.35 : sc.flat ? 0.8 : sc.portrait ? 0.55 : 0.65);
  const bIn = clamp01(s.p2);
  // 白场锚点必须停在 0.975 以内，给高光尾巴留出 255 的位置：
  // 末点留在 253 的话，curveFn 会自动补 [255,255]，最后一段斜率陡然变成 5.5，
  // 单调三次插值的限幅器只能把整条上段压塌（0.8 进来 0.63 出去，图就暗了）
  const wIn = clamp01(Math.min(Math.max(s.p99, bIn + 0.12), 0.975));
  if (wIn - bIn < 0.12) return []; // 没有可拉伸的空间
  const mIn = clamp01(s.p50);
  // 高调图（白底/雪景）和「整张图没有暗部」的图不能压黑点：压下去就是把人往灰里拽
  const crush = sc.highkey || bIn > 0.5 ? 0 : (opt?.crush ?? full);
  const gamma = sc.flat ? 0.92 : sc.lowkey ? 1.02 : sc.portrait ? 0.985 : 0.96;
  // 显示域黑场 = bIn*m*(1-crush)，换回曲线域正好把倍数约掉
  const yb = clamp01(bIn * (1 - 0.85 * crush));
  const wDisp = wIn * mPost * Math.max(k[0], k[1], k[2]); // 白场当前落在显示域的哪一位
  // 白场只在「本来就没到亮部」时才有得开：已经 0.9 以上的图再推只会推爆
  const wRoom = clamp01((0.9 - wDisp) / 0.25);

  // 判据留 0.8% 的容差：0.97~0.98 的像素被推过线在视觉上就是「白」，不该为它牺牲整幅图
  const allow = Math.max(s.clipHi + 0.005, 0.008);
  let strength = full;
  for (let iter = 0; iter < 4; iter += 1) {
    // 白场只封顶、绝不压顶：wDisp 已经到 0.96 以上的图（白底商品、带窗光的逆光片），
    // 以前会被 min(..., WHITE_CAP) 直接拽回 0.96，整幅高光压成 238 的灰 —— 一按就变灰就是这么来的。
    const tW =
      wDisp >= WHITE_CAP
        ? wDisp
        : Math.min(wDisp + (WHITE_CAP - wDisp) * strength * wRoom, WHITE_CAP);
    const yw = clamp01(tW / mPost);
    if (yw - yb < 0.02) break;
    // 高光尾巴封顶：近白像素留在线上，而不是被曲线顶上 255。
    // 目标是 (撞白线 - 一点余量) / mPost，余量留 0.004 抵消取整与影调表的小数误差
    const tail = clamp01(Math.max(yw, Math.min(1, (CLIP_LINE - 0.004) / mPost)));
    // t^gamma，gamma 随 t 增大（高光处 1.85×）→ 自然形成肩部，不硬切
    // 肩部只在「整幅被提亮」时才需要（防止提亮后高光撞白）；
    // 已经在压暗的图再压肩部就是三重压暗（曝光 + 高光滑块 + 曲线），红调/暖调会发死
    const shoulder = 0.85 * clamp01((mPost - 1) / 0.25);
    const at = (x: number) => {
      const t = clamp01((x - bIn) / (wIn - bIn));
      return clamp01(yb + (yw - yb) * t ** (gamma * (1 + shoulder * t * t)));
    };

    const pts: CurvePoint[] = [[0, 0]];
    const push = (x: number, y: number) => {
      const px = clamp(round(x * 255), 0, 255);
      const py = clamp(round(y * 255), 0, 255);
      const last = pts[pts.length - 1];
      if (px <= last[0] + 1) return; // 控制点不能叠在一起，否则单调三次会抖
      pts.push([px, Math.max(py, last[1])]);
    };
    push(bIn, yb);
    push(mIn, at(mIn));
    push(wIn, yw);
    // 高光尾巴：末点固定在 255（曲线面板的契约），但 y 留余量，
    // 这样 0.95 的近白像素不会被推成纯白，插值也不会在末端被迫陡升
    const last = pts[pts.length - 1];
    const ty = clamp(Math.max(last[1], round(Math.max(yw, tail) * 255)), last[1], 255);
    if (last[0] < 254) pts.push([255, ty]);
    else last[1] = ty;

    const dev = pts.reduce((mx, [x, y]) => Math.max(mx, Math.abs(x - y)), 0);
    if (pts.length < 3 || dev <= 2) return []; // 本来就通透的图不要硬动
    if (predictClip(s, curveFn(pts), mPost, k) <= allow) return pts;
    // 高光余量不够：**只减小抬升量**（不是把白场压下去），实在收不住就不写曲线
    strength *= 0.55;
  }
  return [];
}

export interface AutoTone {
  temperature: number;
  tint: number;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  saturation: number;
  vibrance: number;
  curves: CurveSet;
  colorMixer: ColorMixerParams;
}

function emptyTone(): AutoTone {
  return {
    temperature: 0,
    tint: 0,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    saturation: 0,
    vibrance: 0,
    curves: { rgb: [], r: [], g: [], b: [] },
    colorMixer: makeColorMixer(),
  };
}

/** 全自动调色：返回一整套参数（含主曲线与混色器），直接覆盖进调色面板 */
export function autoToneFromPixels(data: Uint8ClampedArray | Uint8Array, channels: number): AutoTone {
  const s = analyzePixels(data, channels);
  const sc = classifyScene(s);
  const out = emptyTone();
  if (!s.samples) return out;

  /* ---- 白平衡：Shades-of-Gray 打底，人像/暖调场景只吃七成，避免把人脸洗成灰白 ---- */
  const wb = estimateWhiteBalance(data, channels);
  // 绿植 + 天空占比高＝户外实景，暖光是「当时的阳光」而不是偏色：相机在这里通常比我们准
  const nature = clamp01((s.greenFrac + s.blueFrac - 0.15) / 0.2);
  const wbStrength =
    (wb.confidence < 0.03 ? 0.45 : 0.75) * (sc.portrait ? 0.85 : 1) * (s.warmBias > 0.16 ? 0.8 : 1) * (1 - 0.75 * nature);
  // 自动调色不做大幅校色：估错了色的代价远大于不校色（整张图被拉黄/拉绿是最难看的失败）
  out.temperature = clamp(round(wb.temperature * wbStrength), -30, 30);
  out.tint = clamp(round(wb.tint * wbStrength), -18, 18);

  /* ---- 先定「救数据」的两项：高光回收 + 逆光抬阴影（不参与择优，救的是已经压死的信息） ---- */
  // 已经撞白的高光，曲线救不回来（信息没了），只能往回压；
  // 但压高光是「把整段上亮部往下拽」，压狠了整张图发闷 —— 所以幅度按撞白比例给，
  // 上限只到 8，具体压不压、压多少交给择优（候选里有 0 这一档，它会拿亮度和层次去否决）。
  out.highlights = s.clipHi > 0.004 ? -clamp(round(s.clipHi * 80), 2, 8) : 0;
  // 逆光主体在暗部：抬阴影比抬曝光安全。但抬多了暗部糊成灰浆、反差全丢，
  // 所以上限收到 18，抬的幅度也按「暗部到底有多暗」算得更克制。
  out.shadows = sc.backlit
    ? clamp(round((0.13 - s.p5) * 160), 3, 18)
    : sc.lowkey
      ? clamp(round((0.07 - s.p5) * 110), 0, 8)
      : 0;
  out.whites = 0;
  out.blacks = 0;

  /* ---- 曝光/曲线/自然饱和度：按图择优 ----
   * 不再用一套固定公式定死「这张图该多亮」：同样的平均亮度，平光人像想更亮、舞台想更暗、
   * 阴天要抬通透、白底要留白。候选真渲染打分（见 auto-look.ts），谁顺眼选谁。
   */
  const kR = 1 + out.temperature * 0.0025 - out.tint * 0.0008;
  const kG = 1 - out.tint * 0.0032;
  const kB = 1 - out.temperature * 0.0025 - out.tint * 0.0008;
  const k = [kR, kG, kB] as const;
  // 振动在曲线之后乘，和它同域
  const vibKOf = (vib: number) => 1 + (Math.max(0, vib) / 100) * 0.9 * 0.3;
  const makeCurve = (gain: number, vib: number, strength: number, crush: number) =>
    buildAutoCurve(s, gain * vibKOf(vib), k, sc, { strength, crush });

  // 亮度目标带：台下的暗、台上的亮，各有各的好看
  const band: [number, number] = sc.lowkey
    ? [0.16, 0.4]
    : sc.highkey
      ? [0.58, 0.82]
      : sc.backlit
        ? [0.38, 0.55]
        : sc.flat
          ? [0.46, 0.6]
          : [0.45, 0.59];
  // 亮部至少要到的位置：低调用不着纯白，别的图亮部一发灰整张就闷
  const wantWhite = sc.lowkey ? 0.55 : sc.backlit ? 0.86 : 0.9;

  // 增益的安全包络：只拿 p99 判「还能往上提多少」。
  // 以前还乘了 0.945/p95，结果画面里只要有一块该亮的东西（舞台灯、白墙、窗外天）,
  // p95 就接近 1，整幅图的曝光被强行压到 -6，照片立刻变暗变灰 —— 明明是局部过曝，
  // 却拿整张照片的亮度去陪葬。那些像素在原图里已经没有信息，压曝光也救不回来。
  // 所以：包络只负责封上限（不许提太亮），下限永远不低于 1（不许因为亮部就把图压暗）。
  const whiteRoom = 0.985 / Math.max(0.3, s.p99); // 顶部还有多少余量（<1 表示已经贴白）
  const hiCap = s.clipHi > 0.06 ? 1 : clamp(whiteRoom + 0.12, 1.05, 1.6);
  const maxGain = sc.lowkey ? Math.min(1.12, hiCap) : sc.backlit ? Math.min(1.24, hiCap) : Math.min(1.32, hiCap);
  // 只有「整体就偏亮」的图才允许压暗；一般的图压暗只会把照片做闷
  const minGain = sc.highkey || s.p50 > 0.6 ? 0.86 : 0.94;

  // 采样量与打分共用同一套统计：前后两边量法一致，"饱和只增不减"才说得准
  const sample = subsampleRgb(data, channels);
  const base = measureLook(sample);
  // 已经在「这个场景该有的亮度带」里就别动曝光 —— 硬把 0.33 拉到带心 0.28，
  // 观感上就是把一张本来正常的照片往下压，是「变暗」最直接的来源
  const target = clamp(base.mean, band[0], band[1]);
  const baseGain = clamp(target / Math.max(0.06, base.mean), minGain, maxGain);

  // 「灰」的图往 0.42 的观感饱和度推；本来就很艳的绝不降艳（自动把颜色调淡最招人烦）
  const vibBase = clamp(round((0.42 - base.sat) * 190), 0, sc.portrait ? 10 : 28);
  const vibCap = sc.portrait ? 12 : 30;

  const pick = chooseLook(
    sample,
    {
      clipHi: s.clipHi,
      clipLo: s.clipLo,
      satMean: base.sat,
      inMean: base.mean,
      inSpread: base.spread,
      band,
      wantWhite,
      vibBase,
      vibCap,
      fixed: {
        temperature: out.temperature,
        tint: out.tint,
        highlights: out.highlights,
        shadows: out.shadows,
        saturation: 0,
        contrast: 0,
      },

      makeCurve,
    },
    baseGain,
    minGain,
    maxGain,
  );

  out.exposure = clamp(pick.exposure, -30, 100);
  out.vibrance = pick.vibrance;
  // 高光回收与对比度由择优定：它们和曝光/曲线是联动的，分开算必然互相打架
  out.highlights = clamp(pick.highlights, -100, 100);
  out.contrast = clamp(pick.contrast, -100, 100);
  out.curves = { rgb: pick.curves, r: [], g: [], b: [] };

  /* ---- 兜底护栏：整幅不许比原图更暗 ----
   * 择优是多项加权挑出来的，个别图（大面积撞白、白底商品）会为了「少撞白一点」
   * 把曝光往下收，观感就是整张闷掉。这里只在**确实变暗**时把曝光往回加最小的一档，
   * 本来就不暗的图一步都不会动；提亮也救不回来（已经撞白裁切）就停手。
   */
  const renderSample = (exposure: number) => {
    const buf = new Uint8Array(sample.length);
    buf.set(sample);
    renderPixels(buf, 3, {
      ...ADJUST_DEFAULTS,
      temperature: out.temperature,
      tint: out.tint,
      highlights: out.highlights,
      contrast: out.contrast,
      exposure,
      vibrance: out.vibrance,
      curves: out.curves,
    });
    return measureLook(buf);
  };
  // 护栏也受安全包络约束：包络说「这图不许提亮」时，最多只把多收的曝光还回去，不能越线
  const maxExposure = clamp(round((maxGain - 1) / 0.008), -30, 100);
  let stat = renderSample(out.exposure);
  for (let i = 0; i < 8 && stat.mean < base.mean - 0.004 && out.exposure < maxExposure; i += 1) {
    const nextExposure = Math.min(maxExposure, out.exposure + 2);
    const next = renderSample(nextExposure);
    if (next.mean <= stat.mean) break; // 提亮反而更暗（撞白被裁掉）就别硬提
    out.exposure = nextExposure;
    stat = next;
  }

  /* ---- 混色器：肤色保护 + 天空/绿植加强（量都很小，只做「提气色」） ---- */
  const bands = out.colorMixer.bands;
  if (sc.portrait) {
    bands.orange = { h: 0, s: -clamp(round(s.skinFrac * 45), 2, 8), l: clamp(round(s.skinFrac * 30), 2, 7) };
    bands.red = { h: 0, s: -clamp(round(s.skinFrac * 20), 1, 4), l: 0 };
  }
  if (s.blueFrac > 0.04) {
    bands.blue = { h: -1, s: clamp(round(s.blueFrac * 25), 2, 6), l: -clamp(round(s.blueFrac * 15), 1, 4) };
  }
  if (s.greenFrac > 0.06) {
    bands.green = { h: 0, s: clamp(round(s.greenFrac * 18), 1, 5), l: 0 };
  }
  return out;
}

/** 「自动白平衡」按钮：不做折减，给出完整估计 */
export function autoWbFromPixels(data: Uint8ClampedArray | Uint8Array, channels: number): { temperature: number; tint: number } {
  const wb = estimateWhiteBalance(data, channels);
  return { temperature: wb.temperature, tint: wb.tint };
}
