/**
 * 逐格构图的几何：纯数值、无 DOM，可单测（test/stitch-geom.test.mjs）。
 *
 * 它只回答一件事：给定格子尺寸、源图尺寸和 {fx, fy, z}，图摆在哪、还能往哪挪。
 * 这是服务端 cropWindow 的逆运算，公式必须一致，否则所见非所得。
 *
 * 单位口径由调用方决定：传像素就全是像素，传归一化比例就全是比例。
 * 但**同一处计算里不能混**——拖动位移是像素，所以交互路径（按下、移动、滚轮）
 * 一律传 getBoundingClientRect() 的宽高；渲染路径传「模板归一化坐标 × 画布比例」，
 * 因为写进 transform 的只是 left/rw0 这种比值，两种口径等价。
 * 早先按下时传的是比例、位移却加像素，1px 手抖等于几百像素，
 * 一拖就撞 clamp 边界、松手后再也拉不回来。
 */
import type { StitchCrop } from '../api';

/** 源图只要宽高，ImageItem / 探针结果都兼容 */
export interface Size2D {
  width: number;
  height: number;
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/** 相对比较：像素口径下 1e-9 已远小于半像素，比例口径下也够区分「恰好装满」与「差一截」 */
function nearly(a: number, b: number) {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

export interface CoverGeom {
  /** 实际生效的倍率（已夹进 [min(zMin,1), 4]） */
  z: number;
  zMin: number;
  /** 图摆放后的尺寸（与 boxW/boxH 同口径） */
  rw: number;
  rh: number;
  /** 图左上角相对格子左上角的偏移（与 boxW/boxH 同口径） */
  left: number;
  top: number;
  minL: number;
  maxL: number;
  minT: number;
  maxT: number;
  /** 两向都没余量：图正好装进/铺满格子，拖不动是几何必然，得先放大 */
  dry: boolean;
  /** 渲染样式：宽高按 z=1 的基准写死，位移与缩放全走 transform */
  style: { width: string; height: string; transform: string };
}

/**
 * 一格的渲染几何：把源图按 cover 放大 z 倍，再平移让焦点落在格子中心。
 *
 * z 可以小于 1（缩到图比格子还小），这时图不再裁切、整体居中，多出来的是底色；
 * 下限 zMin 由服务端按每格算好传进来，缩到那儿正好是「整张图都在」。
 */
export function coverGeom(
  item: Size2D,
  boxW: number,
  boxH: number,
  crop: StitchCrop,
  zMin = 1
): CoverGeom {
  const iw = item.width > 0 ? item.width : 4;
  const ih = item.height > 0 ? item.height : 3;
  const z = clamp(Number(crop.z) || 1, Math.min(zMin, 1), 4);
  // 基准（z=1）尺寸只跟格子与原图比例有关：box 用 CSS 定死，缩放交给 transform
  const k0 = Math.max(boxW / iw, boxH / ih);
  const rw0 = iw * k0;
  const rh0 = ih * k0;
  const rw = rw0 * z;
  const rh = rh0 * z;
  // 图比格子大 → 只能推到贴边；图比格子小 → 只能在格子里挪，不能挪出去
  const minL = Math.min(0, boxW - rw);
  const maxL = Math.max(0, boxW - rw);
  const minT = Math.min(0, boxH - rh);
  const maxT = Math.max(0, boxH - rh);
  const fx = clamp(Number.isFinite(crop.fx) ? crop.fx : 0.5, 0, 1);
  const fy = clamp(Number.isFinite(crop.fy) ? crop.fy : 0.5, 0, 1);
  const left = clamp(boxW / 2 - fx * rw, minL, maxL);
  const top = clamp(boxH / 2 - fy * rh, minT, maxT);
  return {
    z,
    zMin,
    rw,
    rh,
    left,
    top,
    minL,
    maxL,
    minT,
    maxT,
    dry: nearly(boxW, rw) && nearly(boxH, rh),
    // 宽高按 z=1 的基准写死，位移/缩放全用 transform：
    // 拖图时每帧只改合成层，不重排不重绘，才跟得上手
    style: {
      width: `${boxW > 0 ? (rw0 / boxW) * 100 : 100}%`,
      height: `${boxH > 0 ? (rh0 / boxH) * 100 : 100}%`,
      transform: `translate(${rw0 > 0 ? (left / rw0) * 100 : 0}%, ${rh0 > 0 ? (top / rh0) * 100 : 0}%) scale(${z})`,
    },
  };
}

/**
 * 滚轮缩放的锚点：光标压住的那一点在图上的相对位置不变，才像「往这里推近」。
 *
 * 旧写法是 `(box/2 - top + (p-0.5)(rh-nh))/nh`，倍数一改焦点就跟着乘上去——
 * 放大 1.14 倍、焦点也变 1.14 倍，光标压在格子中心时图会往左上跳一截（随后被 clamp 卡住）。
 * 正确的关系是：先算出光标落在图上的比例 f，缩放后让同一个 f 回到同一个像素位置。
 *
 * @param factor 这一下滚轮的倍率（如 1.14 / 0.88），内部再夹进 [zMin, 4]
 * @param px 光标在格子内的相对位置 0~1
 * @returns 新的 crop；已经到头（倍率没变化）返回 null
 */
export function zoomAt(
  item: Size2D,
  boxW: number,
  boxH: number,
  crop: StitchCrop,
  zMin: number,
  factor: number,
  px: number,
  py: number
): StitchCrop | null {
  const g = coverGeom(item, boxW, boxH, crop, zMin);
  const z2 = clamp(g.z * factor, g.zMin, 4);
  if (Math.abs(z2 - g.z) < 1e-4) return null; // 已经到头了，别再抖动
  const ratio2 = z2 / g.z;
  // 放大 1.14 倍，图的尺寸就是乘 1.14（早先写成除，等于「放大反而变小」，
  // 再配上前一版焦点公式，滚轮一滚图就往一个角上缩）
  const nw = g.rw * ratio2;
  const nh = g.rh * ratio2;
  if (!(nw > 0) || !(nh > 0)) return null;
  const fxp = clamp(px, 0, 1);
  const fyp = clamp(py, 0, 1);
  // 光标那一点在图上的相对位置（可能落在图外的底色上，故不夹）
  const underX = (boxW * fxp - g.left) / g.rw;
  const underY = (boxH * fyp - g.top) / g.rh;
  return {
    fx: clamp(underX + ((0.5 - fxp) * boxW) / nw, 0, 1),
    fy: clamp(underY + ((0.5 - fyp) * boxH) / nh, 0, 1),
    z: z2,
  };
}
