// @ts-check
/**
 * 人脸相关纯函数：SCRFD 输出解码、NMS、5 点相似变换对齐、向量归一化与质心更新。
 *
 * 单独拆出来是为了能直接单测（test/face-math.test.mjs）：
 * 这些公式一旦写错，表现是「能跑但框偏/特征不准」，没有任何报错，最难查。
 * 这里不 import sharp / onnxruntime，纯 typed array 运算。
 */

/** ArcFace 112×112 标准 5 点模板（insightface arcface_dst，顺序：左眼 右眼 鼻尖 左嘴角 右嘴角） */
export const ARC_DST = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** SCRFD 三个特征层：stride / 每格 anchor 数均为 2 */
export const SCRFD_STRIDES = [8, 16, 32];
export const SCRFD_ANCHORS = 2;

/**
 * 解码一层 SCRFD 输出。
 *
 * 模型给的是「相对 anchor 中心的偏移 × stride」，anchor 中心按
 * `(cell % fw) * stride, floor(cell / fw) * stride` 排布，且每格 anchors 个
 * 连续排列（顺序与 insightface 一致，写反了框会整体错位）。
 *
 * @param {Float32Array} scores [fh*fw*anchors, 1]
 * @param {Float32Array} bbox   [fh*fw*anchors, 4]  dx1,dy1,dx2,dy2
 * @param {Float32Array} kps    [fh*fw*anchors, 10] 5 个点的 dx,dy
 * @param {{stride:number, fh:number, fw:number, anchors?:number, thresh?:number}} opt
 * @returns {Array<{score:number, x1:number, y1:number, x2:number, y2:number, kps:number[][]}>}
 */
export function scrfdDecode(scores, bbox, kps, opt) {
  const { stride, fh, fw } = opt;
  const anchors = opt.anchors || SCRFD_ANCHORS;
  const thresh = opt.thresh ?? 0.5;
  const total = fh * fw * anchors;
  const out = [];
  for (let i = 0; i < total; i++) {
    const sc = scores[i];
    if (!(sc >= thresh)) continue;
    const a = i % anchors;
    const cell = (i - a) / anchors;
    const cx = (cell % fw) * stride;
    const cy = Math.floor(cell / fw) * stride;
    const b = i * 4;
    const k = i * 10;
    const pts = [];
    for (let p = 0; p < 5; p++) {
      pts.push([cx + kps[k + p * 2] * stride, cy + kps[k + p * 2 + 1] * stride]);
    }
    out.push({
      score: sc,
      x1: cx - bbox[b] * stride,
      y1: cy - bbox[b + 1] * stride,
      x2: cx + bbox[b + 2] * stride,
      y2: cy + bbox[b + 3] * stride,
      kps: pts,
    });
  }
  return out;
}

/** 交并比 */
export function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 贪心 NMS：按分数从高到低保留，压掉与已保留框 IoU 超阈值的候选。
 * @template {{score:number, x1:number, y1:number, x2:number, y2:number}} T
 * @param {T[]} faces
 * @param {number} thresh
 * @returns {T[]}
 */
export function nms(faces, thresh = 0.4) {
  const sorted = faces.slice().sort((a, b) => b.score - a.score);
  const keep = [];
  const dead = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    if (dead[i]) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!dead[j] && iou(sorted[i], sorted[j]) > thresh) dead[j] = 1;
    }
  }
  return keep;
}

/**
 * 2×2 矩阵 SVD（闭式解）：A = U · diag(sx, sy) · Vᵀ，U/V 均为旋转矩阵。
 *
 * 推导（设 U=R(θ), V=R(φ) 并对照 a/b/c/d 的展开式）：
 *   θ+φ = atan2(c+b, a-d)，θ-φ = atan2(c-b, a+d)
 * 角度的加减写反会让 R 变成单位矩阵（等价于没有旋转），框不会报错但会歪。
 *
 * @returns {{sx:number, sy:number, U:number[], V:number[]}} U/V 为行主序 2×2
 */
function svd2(a, b, c, d) {
  const E = (a + d) / 2;
  const F = (a - d) / 2;
  const G = (c + b) / 2;
  const H = (c - b) / 2;
  const Q = Math.hypot(E, H);
  const R = Math.hypot(F, G);
  const sx = Q + R;
  const sy = Q - R;
  const sum = Math.atan2(G, F); // θ+φ
  const diff = Math.atan2(H, E); // θ-φ
  const theta = (sum + diff) / 2;
  const phi = (sum - diff) / 2;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  return {
    sx,
    sy,
    U: [ct, -st, st, ct],
    V: [cp, -sp, sp, cp],
  };
}

/** 行主序 2×2 相乘 */
function mul2(A, B) {
  return [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
  ];
}

/**
 * 5 点相似变换（Umeyama，无反射）：求把 src 对齐到 dst 的 2×3 仿射矩阵。
 *
 * 为什么不用「随便三点求仿射」：仿射允许错切和不等比缩放，5 个点里的
 * 检测误差会被放大成脸型扭曲，ArcFace 的特征就会偏；相似变换只有
 * 旋转 + 等比缩放 + 平移，是 insightface 训练时的对齐方式。
 *
 * @param {number[][]} src 检测到的 5 个点
 * @param {number[][]} dst 模板点（默认 ARC_DST）
 * @returns {number[]} [a, b, tx, c, d, ty]
 */
export function similarityTransform(src, dst = ARC_DST) {
  const n = Math.min(src.length, dst.length);
  if (n < 3) throw new Error('相似变换至少需要 3 个点');
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0];
    sy += src[i][1];
    dx += dst[i][0];
    dy += dst[i][1];
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;

  // varX = 平均平方距离；cov = (1/n) Σ (dst-μd)(src-μs)ᵀ
  let varX = 0;
  let c00 = 0;
  let c01 = 0;
  let c10 = 0;
  let c11 = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx;
    const py = src[i][1] - sy;
    const qx = dst[i][0] - dx;
    const qy = dst[i][1] - dy;
    varX += px * px + py * py;
    c00 += qx * px;
    c01 += qx * py;
    c10 += qy * px;
    c11 += qy * py;
  }
  varX /= n;
  c00 /= n;
  c01 /= n;
  c10 /= n;
  c11 /= n;
  if (varX <= 1e-12) throw new Error('检测点重合，无法估计对齐变换');

  const { sx: s1, sy: s2, U, V } = svd2(c00, c01, c10, c11);
  // 反射（行列式为负）时翻转最小奇异值方向，保证只允许旋转
  const sign = c00 * c11 - c01 * c10 >= 0 ? 1 : -1;
  // R = U · diag(1, sign) · Vᵀ
  const S = [1, 0, 0, sign];
  const Vt = [V[0], V[2], V[1], V[3]]; // 2×2 转置
  const Rm = mul2(U, mul2(S, Vt));
  const scale = (s1 + s2 * sign) / varX;

  const a = Rm[0] * scale;
  const b = Rm[1] * scale;
  const c = Rm[2] * scale;
  const d = Rm[3] * scale;
  const tx = dx - (a * sx + b * sy);
  const ty = dy - (c * sx + d * sy);
  return [a, b, tx, c, d, ty];
}

/** 2×3 仿射求逆（返回同样布局的 2×3）：(u,v) → 源图坐标 */
export function invertAffine(m) {
  const det = m[0] * m[4] - m[1] * m[3];
  if (Math.abs(det) < 1e-12) throw new Error('仿射矩阵不可逆');
  const ia = m[4] / det;
  const ib = -m[1] / det;
  const ic = -m[3] / det;
  const id = m[0] / det;
  return [ia, ib, -(ia * m[2] + ib * m[5]), ic, id, -(ic * m[2] + id * m[5])];
}

/**
 * 按 5 点对齐并裁剪出 size×size 的 RGB，归一化后按 NCHW 平铺。
 * ArcFace 的预处理是 (px - 127.5) / 127.5，与 insightface 一致。
 *
 * @param {Uint8Array|Buffer} rgba 源图 RGBA
 * @param {number} w
 * @param {number} h
 * @param {number[][]} kps
 * @param {number} size
 * @returns {Float32Array} 3 * size * size
 */
export function warpAlign(rgba, w, h, kps, size = 112) {
  const M = invertAffine(similarityTransform(kps, ARC_DST));
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 目标像素中心 → 源图坐标
      const u = x + 0.5;
      const v = y + 0.5;
      const px = M[0] * u + M[1] * v + M[2] - 0.5;
      const py = M[3] * u + M[4] * v + M[5] - 0.5;
      const di = y * size + x;
      if (px < 0 || py < 0 || px > w - 1 || py > h - 1) {
        // 出界补 0（黑），归一化后是 -1，与 cv2.warpAffine 的 borderValue=0 一致
        out[di] = -1;
        out[plane + di] = -1;
        out[2 * plane + di] = -1;
        continue;
      }
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(x0 + 1, w - 1);
      const y1 = Math.min(y0 + 1, h - 1);
      const fx = px - x0;
      const fy = py - y0;
      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v00 = rgba[i00 + ch];
        const v10 = rgba[i10 + ch];
        const v01 = rgba[i01 + ch];
        const v11 = rgba[i11 + ch];
        const top = v00 + (v10 - v00) * fx;
        const bottom = v01 + (v11 - v01) * fx;
        const val = (top + (bottom - top) * fy - 127.5) / 127.5;
        out[ch * plane + di] = val;
      }
    }
  }
  return out;
}

/** 原地 L2 归一化（零向量保持零） */
export function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 1e-12) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** 余弦（两个向量都已归一化时就是点积） */
export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * 增量更新质心：newCount = count + 1，centroid' = normalize(centroid*count + vec)。
 * 除数 (count+1) 是正标量，归一化后可以省掉。
 * @param {Float32Array|null} centroid
 * @param {number} count
 * @param {Float32Array} vec
 */
export function blendCentroid(centroid, count, vec) {
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = (centroid ? centroid[i] * count : 0) + vec[i];
  return l2norm(out);
}
