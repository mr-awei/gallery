import sharp from 'sharp';
import { phashFromGrey32 } from '../phash.js';

/**
 * 主体哈希：白底商品图去背景归一化后的 pHash。
 *
 * 为什么：全图 pHash（以及任何全图特征——哈希、CLIP 皆然）都被大面积纯白背景主导，
 * 「四角白 + 中间一坨主体」的低频结构让不同产品的汉明距离也能 ≤ 10（保温桶配钻夹头、
 * 水泵配化油器的实际误判案例）。调阈值解不开——实测真重复与异物的余弦犬牙交错。
 * 根治：抠掉白底 → 裁到主体包围盒 → 主体占满画面后再算 pHash。
 * 此后背景对哈希的贡献为零，不同产品的主体差异直接反映到汉明距离上。
 *
 * 抠图方式：阈值法（背景 ≈ 四角中位色的近白像素），不做 AI 分割——
 * 本库图片全为白底商品图，阈值法零成本且够准；AI 分割（RMBG-1.4，1024² 输入）
 * 留作非白底图占比上升后的升级路径。
 */

const SCAN = 512; // 中间图边长：一次解码全部计算都在它上面做
const CORNER_FRAC = 0.08; // 四角采样区占比（算背景色）
const BG_MAX_DEV = 26; // 像素与背景色的最大通道差，之内视为背景
const MIN_FOREGROUND = 0.02; // 前景占比下限：低于此视为「没有可用的主体」（非白底/失败）。
// 0.02 而非 0.04：白色小件（螺钉、传感器）前景只有 2~4%，门槛高了会整批误 SKIP，
// 退回全图哈希后它们恰恰是最容易撞哈希的一类；门槛内误抠的伪主体哈希与其它图距离大，不成组，无副作用
const PAD_FRAC = 0.03; // 包围盒外扩比例，保留主体边缘轮廓

/** 从 512² RGB raw 数据里求主体包围盒；返回 null 表示无法可靠抠主体 */
function foregroundBox(data, W, H) {
  const at = (x, y) => {
    const i = (y * W + x) * 3;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // 背景色 = 四角中位色（白底图四角必是背景；个别图带浅灰渐变也能取准）
  const c = CORNER_FRAC * Math.min(W, H);
  const corners = [];
  for (const [cx, cy] of [
    [0, 0],
    [W - c, 0],
    [0, H - c],
    [W - c, H - c],
  ]) {
    for (let y = Math.round(cy); y < Math.round(cy + c); y += 2) {
      for (let x = Math.round(cx); x < Math.round(cx + c); x += 2) corners.push(at(x, y));
    }
  }
  const bg = [0, 1, 2].map((k) => {
    const col = corners.map((p) => p[k]).sort((a, b) => a - b);
    return col[col.length >> 1];
  });

  // 前景 mask + 包围盒（隔行采样加速）
  let minX = W, minY = H, maxX = -1, maxY = -1, fg = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = at(x, y);
      if (
        Math.abs(r - bg[0]) > BG_MAX_DEV ||
        Math.abs(g - bg[1]) > BG_MAX_DEV ||
        Math.abs(b - bg[2]) > BG_MAX_DEV
      ) {
        fg++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const ratio = fg / (W * H);
  if (ratio < MIN_FOREGROUND || ratio > 0.97) return null; // 无主体 / 抠图疑似失效
  // 外扩并夹紧
  const pw = Math.round((maxX - minX) * PAD_FRAC) + 2;
  const ph = Math.round((maxY - minY) * PAD_FRAC) + 2;
  return {
    left: Math.max(0, minX - pw),
    top: Math.max(0, minY - ph),
    width: Math.min(W, maxX + pw) - Math.max(0, minX - pw),
    height: Math.min(H, maxY + ph) - Math.max(0, minY - ph),
    ratio,
  };
}

/** Buffer → 主体 pHash（16 hex）；无法抠出可靠主体时返回 null（调用方退回全图哈希） */
export async function computeSubjectPHash(input) {
  const mid = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(SCAN, SCAN, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = mid.info;
  if (channels < 3) return null;
  // 交叠成 RGB（sharp raw 的 channels 可能是 3，removeAlpha 后应为 3）
  const box = foregroundBox(mid.data, W, H);
  if (!box) return null;
  const cropped = await sharp(mid.data, { raw: { width: W, height: H, channels: 3 } })
    .extract(box)
    .resize(32, 32, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return phashFromGrey32(cropped.data);
}
