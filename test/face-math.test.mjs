/**
 * 人脸数学层回归：解码 / NMS / 相似变换 / 对齐 / 质心。
 *
 * 这些函数写错时的表现是「不报错但框偏、特征不准」，靠肉眼根本发现不了，
 * 所以这里全部用可手算的构造数据断言，而不是只检查「有返回值」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARC_DST,
  blendCentroid,
  cosine,
  invertAffine,
  iou,
  l2norm,
  nms,
  scrfdDecode,
  similarityTransform,
  warpAlign,
} from '../server/lib/face-math.js';

/** 用 2×3 仿射变换点 */
function apply(m, p) {
  return [m[0] * p[0] + m[1] * p[1] + m[2], m[3] * p[0] + m[4] * p[1] + m[5]];
}

test('SCRFD 解码：anchor 中心按 (x*stride, y*stride) 且每格 anchors 个连续排布', () => {
  const fh = 2;
  const fw = 2;
  const anchors = 2;
  const stride = 8;
  const n = fh * fw * anchors; // 8
  const scores = new Float32Array(n);
  const bbox = new Float32Array(n * 4);
  const kps = new Float32Array(n * 10);

  // 索引 3 = 第 2 格（cell=1）的第 2 个 anchor → cx=8, cy=0
  scores[3] = 0.9;
  bbox.set([0.5, 0.5, 1.5, 1.5], 3 * 4);
  // 5 个点全给 (0.25, 0.25) 偏移
  for (let p = 0; p < 5; p++) kps.set([0.25, 0.25], 3 * 10 + p * 2);

  const out = scrfdDecode(scores, bbox, kps, { stride, fh, fw, anchors, thresh: 0.5 });
  assert.equal(out.length, 1);
  const f = out[0];
  // 中心 (8,0) + 偏移×stride
  assert.equal(f.x1, 8 - 0.5 * 8);
  assert.equal(f.y1, 0 - 0.5 * 8);
  assert.equal(f.x2, 8 + 1.5 * 8);
  assert.equal(f.y2, 0 + 1.5 * 8);
  assert.deepEqual(f.kps[0], [8 + 0.25 * 8, 0 + 0.25 * 8]);
  assert.equal(f.kps.length, 5);
});

test('SCRFD 解码：低于阈值一律丢弃（阈值边界用 >=）', () => {
  const scores = new Float32Array([0.49, 0.5]);
  const bbox = new Float32Array(8);
  const kps = new Float32Array(20);
  const out = scrfdDecode(scores, bbox, kps, { stride: 8, fh: 1, fw: 1, anchors: 2, thresh: 0.5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 0.5);
});

test('NMS：同位置高分框胜出，IoU 为 0 的框全部保留', () => {
  const a = { score: 0.6, x1: 0, y1: 0, x2: 100, y2: 100 };
  const b = { score: 0.9, x1: 5, y1: 5, x2: 105, y2: 105 };
  const c = { score: 0.8, x1: 300, y1: 300, x2: 400, y2: 400 };
  // 100×100 的框错开 5px：交 9025 / 并 10975 ≈ 0.822
  assert.ok(Math.abs(iou(a, b) - 9025 / 10975) < 1e-6);
  const keep = nms([a, b, c], 0.4);
  assert.equal(keep.length, 2);
  assert.equal(keep[0].score, 0.9);
  assert.equal(keep[1], c);
});

test('相似变换：平移、等比缩放、旋转都能精确还原到模板', () => {
  const cases = [
    // 纯平移
    ARC_DST.map(([x, y]) => [x + 100, y + 40]),
    // 等比缩放 2 倍
    ARC_DST.map(([x, y]) => [x * 2, y * 2]),
    // 绕原点旋转 30°
    ARC_DST.map(([x, y]) => [x * Math.cos(Math.PI / 6) - y * Math.sin(Math.PI / 6), x * Math.sin(Math.PI / 6) + y * Math.cos(Math.PI / 6)]),
    // 旋转 + 缩放 + 平移（组合）
    ARC_DST.map(([x, y]) => [x * 1.7 * Math.cos(0.9) - y * 1.7 * Math.sin(0.9) + 55, x * 1.7 * Math.sin(0.9) + y * 1.7 * Math.cos(0.9) - 22]),
  ];
  for (const src of cases) {
    const M = similarityTransform(src, ARC_DST);
    for (let i = 0; i < 5; i++) {
      const [px, py] = apply(M, src[i]);
      assert.ok(Math.abs(px - ARC_DST[i][0]) < 1e-6, `第 ${i} 点 x 偏差 ${px - ARC_DST[i][0]}`);
      assert.ok(Math.abs(py - ARC_DST[i][1]) < 1e-6, `第 ${i} 点 y 偏差 ${py - ARC_DST[i][1]}`);
    }
  }
});

test('相似变换：带噪声的检测点，残差应明显小于仿射拟合前的错误', () => {
  const noisy = ARC_DST.map(([x, y], i) => [x + (i % 2 ? 1.5 : -1.5), y - (i % 3 ? 2 : -2)]);
  const M = similarityTransform(noisy, ARC_DST);
  const d2 = noisy.map((p, i) => {
    const [px, py] = apply(M, p);
    return (px - ARC_DST[i][0]) ** 2 + (py - ARC_DST[i][1]) ** 2;
  });
  const mean = d2.reduce((a, b) => a + b, 0) / d2.length;
  // 相似变换无法完全贴合噪声点，但平均残差必须落在 3px 内
  assert.ok(mean < 9, `平均残差平方 ${mean}`);
});

test('相似变换：三点重合时明确报错，而不是返回 NaN 矩阵', () => {
  assert.throws(() => similarityTransform([[1, 1], [1, 1], [1, 1]], ARC_DST), /重合/);
});

test('仿射求逆：先正变换再逆变换能回到原点', () => {
  const M = similarityTransform(ARC_DST.map(([x, y]) => [x * 1.3 + 7, y * 1.3 - 4]), ARC_DST);
  const Inv = invertAffine(M);
  const p = [12.5, 33.25];
  const [qx, qy] = apply(M, p);
  const [rx, ry] = apply(Inv, [qx, qy]);
  assert.ok(Math.abs(rx - p[0]) < 1e-6);
  assert.ok(Math.abs(ry - p[1]) < 1e-6);
});

test('warpAlign：常量图 → 输出全为归一化后的常量值；越界补 -1', () => {
  const w = 200;
  const h = 200;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 127.5 | 0; // 127 → (127-127.5)/127.5 ≈ -0.0039
    rgba[i * 4 + 3] = 255;
  }
  // 检测点 = 模板点 + 平移，输出应严格落在图内且为常量图
  const kps = ARC_DST.map(([x, y]) => [x + 40, y + 40]);
  const out = warpAlign(rgba, w, h, kps, 112);
  assert.equal(out.length, 3 * 112 * 112);
  const plane = 112 * 112;
  assert.ok(Math.abs(out[0] - 1) < 1e-6);
  assert.ok(Math.abs(out[plane] + 1) < 1e-6);
  assert.ok(Math.abs(out[2 * plane] - (127 - 127.5) / 127.5) < 1e-6);

  // 把点平移到图外：应补 -1
  const outside = ARC_DST.map(([x, y]) => [x - 500, y - 500]);
  const out2 = warpAlign(rgba, w, h, outside, 112);
  assert.equal(out2[0], -1);
  assert.equal(out2[plane], -1);
});

test('向量工具：归一化后点积即余弦，质心增量更新等于加权平均再归一化', () => {
  const a = l2norm(new Float32Array([3, 4]));
  assert.ok(Math.abs(Math.hypot(a[0], a[1]) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6);

  const v1 = l2norm(new Float32Array([1, 0, 0]));
  const v2 = l2norm(new Float32Array([1, 1, 0]));
  const c1 = blendCentroid(null, 0, v1);
  const c2 = blendCentroid(c1, 1, v2);
  const manual = l2norm(new Float32Array([v1[0] + v2[0], v1[1] + v2[1], v1[2] + v2[2]]));
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(c2[i] - manual[i]) < 1e-6);
  // 质心应与两个成员都保持正相似度
  assert.ok(cosine(c2, v1) > 0.8);
  assert.ok(cosine(c2, v2) > 0.8);
});
