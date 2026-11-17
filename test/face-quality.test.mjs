import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_GATES,
  assessFace,
  coverRank,
  faceNativePatch,
  patchStats,
  poseFromLandmarks,
} from '../server/lib/face-quality.js';

const SIZE = 192;
const patch = (fn) => {
  const g = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) g[y * SIZE + x] = fn(x, y);
  return g;
};

const image = (w, h, fn) => {
  const rgba = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = fn(x, y);
      const i = (y * w + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
    }
  }
  return rgba;
};

test('拉普拉斯方差：细节丰富的清晰块 >> 糊成一片的渐变', () => {
  const sharp = patch((x, y) => 128 + ((x * 7 + y * 13) % 2 ? 45 : -45) + ((x * y) % 17) * 2);
  const blurry = patch((x, y) => Math.round(120 + x * 0.15 + y * 0.1));
  const a = patchStats(sharp, SIZE);
  const b = patchStats(blurry, SIZE);
  assert.ok(a.lap > QUALITY_GATES.LAP_FULL, `清晰块 lap=${a.lap}`);
  assert.ok(b.lap < QUALITY_GATES.LAP_REJECT, `模糊块 lap=${b.lap}`);
  assert.ok(a.std > b.std);
});

test('faceNativePatch：按原生分辨率取块（不重采样），纯色 → 无纹理，棋盘 → 高清晰', () => {
  const w = 400;
  const h = 400;
  const box = [0.2, 0.2, 0.6, 0.6]; // 160px 的框 + 25% 外扩 = 240px 块
  const flat = faceNativePatch(image(w, h, () => 130), w, h, box);
  assert.equal(flat.width, 240);
  assert.equal(flat.height, 240);
  const flatStats = patchStats(flat.gray, flat.width, flat.height);
  assert.equal(flatStats.lap, 0);
  assert.equal(flatStats.std, 0);

  const detailed = faceNativePatch(image(w, h, (x, y) => (128 + ((x + y) % 2 ? 60 : -60))), w, h, box);
  const detailedStats = patchStats(detailed.gray, detailed.width, detailed.height);
  assert.ok(detailedStats.lap > QUALITY_GATES.LAP_FULL, `lap=${detailedStats.lap}`);
  assert.ok(detailedStats.std > QUALITY_GATES.STD_MIN);
});

test('faceNativePatch：小脸不会被放大摊平（旧版缩放到 192 会误判成模糊）', () => {
  // 1600px 工作图里一个 40px 的小脸，sharp 棋盘纹理
  const w = 1600;
  const h = 1600;
  const box = [0.5, 0.5, 0.5 + 40 / w, 0.5 + 40 / h];
  const p = faceNativePatch(image(w, h, (x, y) => (128 + ((x + y) % 2 ? 60 : -60))), w, h, box);
  assert.equal(p.width, 60); // 40 × 1.25，不放大
  const st = patchStats(p.gray, p.width, p.height);
  assert.ok(st.lap > QUALITY_GATES.LAP_CLUSTER, `小脸 lap=${st.lap}`);
  const q = assessFace({ ...st, score: 0.9, facePx: 40, frontal: 1 });
  assert.equal(q.keep, true);
  assert.equal(q.cluster, true);
});

test('姿态：正面接近 1，大侧脸/歪头被判非正面', () => {
  const frontal = poseFromLandmarks([
    [30, 40],
    [70, 40],
    [50, 55],
    [38, 75],
    [62, 75],
  ]);
  const profile = poseFromLandmarks([
    [30, 40],
    [70, 40],
    [68, 55],
    [38, 75],
    [62, 75],
  ]);
  const tilted = poseFromLandmarks([
    [30, 20],
    [70, 60],
    [50, 55],
    [38, 75],
    [62, 75],
  ]);
  assert.ok(frontal.frontal > 0.8, `frontal=${frontal.frontal}`);
  assert.ok(profile.frontal < QUALITY_GATES.FRONTAL_MIN, `profile=${profile.frontal}`);
  assert.ok(tilted.frontal < frontal.frontal);
  assert.equal(poseFromLandmarks(null).frontal, 1); // 存量数据无关键点：中性，不误杀
  assert.equal(poseFromLandmarks([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]).frontal, 0);
});

test('assessFace：糊脸/小脸/无纹理/后脑勺硬排除，清晰正面可聚类', () => {
  const good = assessFace({ lap: 500, std: 48, score: 0.9, facePx: 110, frontal: 0.95 });
  assert.equal(good.keep, true);
  assert.equal(good.cluster, true);
  assert.deepEqual(good.reasons, []);
  assert.ok(good.quality > 0.7, `quality=${good.quality}`);

  const blurry = assessFace({ lap: 8, std: 20, score: 0.9, facePx: 150, frontal: 1 });
  assert.equal(blurry.keep, false);
  assert.equal(blurry.cluster, false);
  assert.ok(blurry.reasons.includes('模糊'));

  // 其它项再高也不能把硬门槛「平均」回来
  const flat = assessFace({ lap: 2, std: 4, score: 1, facePx: 200, frontal: 1 });
  assert.equal(flat.keep, false);
  assert.ok(flat.reasons.includes('几乎没有纹理'));

  const tiny = assessFace({ lap: 200, std: 60, score: 1, facePx: 12, frontal: 1 });
  assert.equal(tiny.keep, false);
  assert.ok(tiny.reasons.includes('人脸过小'));

  const back = assessFace({ lap: 200, std: 60, score: 1, facePx: 120, frontal: 0.1 });
  assert.equal(back.keep, false);
  assert.ok(back.reasons.includes('非正面/疑似后脑勺'));

  // 中间档：能收录（不算太糊）但不够格建新人物/当封面（分层门槛）
  const soft = assessFace({ lap: 60, std: 28, score: 0.6, facePx: 70, frontal: 0.8 });
  assert.equal(soft.keep, true);
  assert.equal(soft.cluster, false);
  assert.ok(soft.soft.includes('不够清晰'));

  const sideFace = assessFace({ lap: 300, std: 28, score: 0.8, facePx: 120, frontal: 0.4 });
  assert.equal(sideFace.keep, true);
  assert.equal(sideFace.cluster, false);
  assert.ok(sideFace.soft.includes('侧脸'));
});

test('小脸分层：清晰但很小的脸照常保留，只有真·看不清才硬排除', () => {
  // 真实库半数人脸只有 ~50px，门槛定高（如 24px）会一次抹掉 14% 的脸
  const small = assessFace({ lap: 300, std: 40, score: 0.85, facePx: 20, frontal: 0.9 });
  assert.equal(small.keep, true);
  assert.equal(small.cluster, false); // 尺寸不足只挡「建新人物」，不从相册里拿走
  const tooSmall = assessFace({ lap: 300, std: 40, score: 0.85, facePx: 15, frontal: 0.9 });
  assert.equal(tooSmall.keep, false);
  assert.ok(tooSmall.reasons.includes('人脸过小'));
});

test('质量分：糊脸不会被尺寸/检测分「平均」成高分（几何平均 + 对数刻度）', () => {
  // 旧公式在这组输入下给出 0.6 分，正是「0.5 分档里全是 medianLap=10 的糊脸」的成因
  const blurryButBig = assessFace({ lap: 20, std: 50, score: 1, facePx: 200, frontal: 1 });
  assert.ok(blurryButBig.quality < 0.3, `quality=${blurryButBig.quality}`);
  assert.equal(assessFace({ lap: 0, std: 50, score: 1, facePx: 200, frontal: 1 }).quality, 0);

  const typical = assessFace({ lap: 437, std: 45, score: 0.85, facePx: 80, frontal: 0.95 });
  const mid = assessFace({ lap: 120, std: 45, score: 0.85, facePx: 80, frontal: 0.95 });
  assert.ok(typical.quality > mid.quality);
  assert.ok(mid.quality > blurryButBig.quality);
});

test('封面排序依据：质量分高的脸优先于检测分高的脸', () => {
  const highQualityLowScore = assessFace({ lap: 700, std: 50, score: 0.62, facePx: 100, frontal: 0.95 });
  const lowQualityHighScore = assessFace({ lap: 70, std: 26, score: 0.99, facePx: 100, frontal: 0.95 });
  assert.ok(highQualityLowScore.quality > lowQualityHighScore.quality);
});

test('过曝：纯白/高光块即使梯度很高也不能当可用脸', () => {
  // 白衣反光里的一块亮斑 lap 很高，但脸根本看不清
  const blown = assessFace({ lap: 800, std: 40, score: 0.9, facePx: 140, frontal: 1, clipHi: 0.8 });
  assert.equal(blown.keep, false);
  assert.ok(blown.reasons.includes('过曝'), JSON.stringify(blown.reasons));

  const washedOut = assessFace({ lap: 700, std: 30, score: 0.9, facePx: 140, frontal: 1, mean: 240 });
  assert.equal(washedOut.keep, false);
  assert.ok(washedOut.reasons.includes('过曝'));

  const black = assessFace({ lap: 700, std: 30, score: 0.9, facePx: 140, frontal: 1, mean: 8 });
  assert.equal(black.keep, false);
  assert.ok(black.reasons.includes('欠曝'));

  // clipHi 是从灰度块里数出来的，不该靠调用方瞎填
  const white = patchStats(patch(() => 255), SIZE);
  assert.equal(white.clipHi, 1);
  const dark = patchStats(patch(() => 0), SIZE);
  assert.equal(dark.clipLo, 1);
});

test('封面资格：29px 的脸质量分不低也不能当封面（截图里的「白糊块」就是这么来的）', () => {
  // 真实数据：facePx=29、quality=0.533 的脸被当成封面，放大到 150px 卡片就是一团糊
  assert.equal(coverRank({ quality: 0.533, facePx: 29, score: 0.533 }), null);
  assert.equal(coverRank({ quality: 0.533, facePx: 29, score: 0.9 }), null);
  const ok = coverRank({ quality: 0.6, facePx: 120, score: 0.8 });
  assert.ok(ok != null && ok > 0);

  // 同质量下，大脸必须排在前面
  const small = coverRank({ quality: 0.7, facePx: 66, score: 0.8 });
  const large = coverRank({ quality: 0.7, facePx: 300, score: 0.8 });
  assert.ok(large > small);

  // 糊脸不给封面，但脸本身仍然保留（显示与封面解耦）
  assert.equal(coverRank({ quality: 0.2, facePx: 300, score: 0.9 }), null);
  assert.equal(coverRank({ quality: 0.9, facePx: 300, score: 0.3 }), null);
});

test('聚类门槛：检测分低的脸（后脑勺/耳朵）可以显示，但不许进人物', () => {
  // 真实库「562 张脸的人物」成员检测分中位数 0.577，正常大人物是 0.82
  const fake = assessFace({ lap: 600, std: 50, score: 0.577, facePx: 130, frontal: 1 });
  assert.equal(fake.keep, true);
  assert.equal(fake.cluster, false);
  const real = assessFace({ lap: 600, std: 50, score: 0.85, facePx: 130, frontal: 1 });
  assert.equal(real.cluster, true);
});
