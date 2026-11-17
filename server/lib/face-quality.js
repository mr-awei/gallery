// @ts-check
/**
 * 人脸质量评估（不引入额外模型 / 权重）。
 *
 * 为什么是这些信号：
 * - PhotoPrism 用「检测分 + 最小人脸尺寸」分层门槛，聚类要求更高的分和更大的尺寸，
 *   并且允许最少 N 张脸才成组（internal/ai/face: SizeThreshold=25、ClusterSizeThreshold=60、ClusterCore=4）；
 * - Immich 用 minDetectionScore（默认 0.5，误检多时建议 0.8）+ minFaces 隐藏零散人物，
 *   封面由用户手动改（docs.immich.app/features/facial-recognition）；
 * - 学术侧 SOTA 是 MagFace（把质量编码进特征范数）、SER-FIQ / CR-FIQA / DifFIQA / FaceQAN，
 *   但都要额外模型或多次前向；这里用检测阶段已有的现成信号做轻量等价物。
 *
 * 量纲（重要）：拉普拉斯方差必须在**工作图原生分辨率**上算。
 * 早期版本把脸缩放到固定 192×192 再算，小脸被插值放大、梯度被摊平，
 * 于是「其实很清晰的小脸」被打成模糊（真实库实测排除率 45%，其中大量是误杀）；
 * 大脸被缩小同样会平滑。原生取块后同一批人脸 lap 中位数从 20 升到 437。
 *
 * 真实库（Canon 5D4，1600px 工作图）抽样标定：
 * 糊脸/后脑勺 8~55，可辨识但偏软 55~95，正常人脸 p50=437、p75=849、p90=1956。
 * 注意：扫描期和存量重算都从「长边 1600 的 RGBA 工作图」取块，保证两边同一量纲。
 */

export const QUALITY_GATES = {
  /** 硬排除：拉普拉斯方差低于此值判为失焦（真实库标定，约 p8~p10） */
  LAP_REJECT: 50,
  /** 聚类 / 建新人物要求更清晰（分层门槛） */
  LAP_CLUSTER: 75,
  /** 模糊项满分（真实库 p50≈437，取 600 让清晰脸拿到满分区间） */
  LAP_FULL: 600,
  /**
   * 工作图上人脸框短边下限。真实库 p50 只有 50px、p02≈19px，
   * 门槛定高会把一整片「远处的小脸」从人物相册里抹掉（实测 24px 会排除 14%），
   * 所以只排除真·看不清的（<18px ≈ p1.5），「小」交给聚类门槛去分层。
   */
  FACE_PX_MIN: 18,
  /** 聚类级尺寸门槛：太小的人脸特征不稳，不建新人物（约 p20） */
  FACE_PX_CLUSTER: 30,
  /** 尺寸项满分 */
  FACE_PX_FULL: 90,
  /** 纹理标准差下限：纯色块（糊成一片/后脑勺）直接排除 */
  STD_MIN: 10,
  /** 正面程度下限 */
  FRONTAL_MIN: 0.35,
  /** 聚类级正面程度 */
  FRONTAL_CLUSTER: 0.45,

  /* --- 封面资格（与「显示/收录」解耦：糊脸可以留在相册里，但绝不能当门面）--- */
  /**
   * 封面脸短边下限（**原图像素**，不是工作图）。人物卡片约 150px，
   * 64px 以下放大 2 倍以上必然发虚 —— 截图里那张「白糊块」封面只有 29px。
   */
  COVER_PX_MIN: 64,
  /** 封面脸质量分下限 */
  COVER_Q_MIN: 0.45,
  /** 封面脸检测分下限：低分基本是侧脸/帽子/背影，ArcFace 也不太认得出 */
  COVER_SCORE_MIN: 0.55,

  /** 参与聚类的检测分下限：后脑勺/耳朵的伪造特征都落在 0.5~0.65 这一段 */
  SCORE_CLUSTER: 0.6,

  /* --- 曝光（拉普拉斯管不住纯色块：白衣反光里的一块亮斑也能有高梯度）--- */
  /** 过曝像素（≥246）占比上限 */
  CLIP_HI_MAX: 0.55,
  /** 平均亮度上限/下限 */
  MEAN_MAX: 228,
  MEAN_MIN: 16,
};

/**
 * 封面排序分：质量分 × 尺寸惩罚。返回 null 表示「不够格当封面」。
 * 单看质量分会让 29px 的脸靠检测分拿到 0.53 分继续当门面，所以尺寸必须单独扣。
 * @param {{quality?:number, facePx?:number, score?:number}} f
 */
export function coverRank({ quality = 0, facePx = 0, score = 0 } = {}) {
  const G = QUALITY_GATES;
  if (!(facePx >= G.COVER_PX_MIN) || quality < G.COVER_Q_MIN || score < G.COVER_SCORE_MIN) return null;
  return quality * Math.min(1, facePx / 96) ** 0.5;
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/**
 * 从工作图 RGBA 里按**原生分辨率**取一张脸的灰度块（框外扩 25%，与 faceCrop 一致）。
 * 不做插值重采样——重采样会改变拉普拉斯的量纲，小脸被放大后会被误判成模糊。
 * @param {Uint8Array|Buffer} rgba 4 通道 RGBA
 * @param {number} w 工作图宽
 * @param {number} h 工作图高
 * @param {number[]} box 归一化框 [x1,y1,x2,y2]（0..1）
 */
export function faceNativePatch(rgba, w, h, box) {
  const [nx1, ny1, nx2, ny2] = box;
  const x1 = Math.max(0, Math.min(w, nx1 * w));
  const y1 = Math.max(0, Math.min(h, ny1 * h));
  const x2 = Math.max(x1, Math.min(w, nx2 * w));
  const y2 = Math.max(y1, Math.min(h, ny2 * h));
  const padX = (x2 - x1) * 0.25;
  const padY = (y2 - y1) * 0.25;
  const sx0 = Math.max(0, Math.floor(x1 - padX));
  const sy0 = Math.max(0, Math.floor(y1 - padY));
  const sx1 = Math.min(w, Math.ceil(x2 + padX));
  const sy1 = Math.min(h, Math.ceil(y2 + padY));
  const pw = Math.max(3, sx1 - sx0);
  const ph = Math.max(3, sy1 - sy0);
  const gray = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const row = (sy0 + y) * w;
    for (let x = 0; x < pw; x++) {
      const i = (row + sx0 + x) * 4;
      gray[y * pw + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  return { gray, width: pw, height: ph };
}

/**
 * 灰度块统计量：拉普拉斯方差（失焦判据）+ 亮度 + 对比度。
 * @param {Uint8Array} gray
 * @param {number} w
 * @param {number} [h]
 */
export function patchStats(gray, w, h = w) {
  const inset = Math.max(1, Math.round(Math.min(w, h) * 0.08)); // 外扩 25% 的边框区域不算，避免背景/头发主导
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  let meanSum = 0;
  let mean2Sum = 0;
  let hi = 0;
  let lo = 0;
  for (let y = inset; y < h - inset; y++) {
    for (let x = inset; x < w - inset; x++) {
      const i = y * w + x;
      const c = gray[i];
      const L = 4 * c - gray[i - w] - gray[i + w] - gray[i - 1] - gray[i + 1];
      sum += L;
      sum2 += L * L;
      meanSum += c;
      mean2Sum += c * c;
      if (c >= 246) hi++;
      else if (c <= 8) lo++;
      n++;
    }
  }
  const mean = meanSum / Math.max(1, n);
  return {
    lap: Math.max(0, sum2 / Math.max(1, n) - (sum / Math.max(1, n)) ** 2),
    mean,
    std: Math.sqrt(Math.max(0, mean2Sum / Math.max(1, n) - mean * mean)),
    // 过曝/欠曝像素占比：拉普拉斯只看「有没有梯度」，一块纯白墙面梯度为 0 却也常被
    // 高光糊住的半张脸骗过（检测框落在白衣/反光上），单看 lap 会漏
    clipHi: n ? hi / n : 0,
    clipLo: n ? lo / n : 0,
  };
}

/**
 * SCRFD 5 点关键点 → 正面程度（0..1）。尺度无关，所以工作图像素坐标可直接用。
 * 顺序：[左眼, 右眼, 鼻尖, 左嘴角, 右嘴角]
 */
export function poseFromLandmarks(kps) {
  if (!Array.isArray(kps) || kps.length < 5) return { frontal: 1, yaw: 0, roll: 0, pitch: 0 };
  const [le, re, nose, lm, rm] = kps;
  const eyeDist = Math.hypot(re[0] - le[0], re[1] - le[1]);
  if (!Number.isFinite(eyeDist) || eyeDist < 1e-6) return { frontal: 0, yaw: 1, roll: 0, pitch: 1 };
  const ex = (le[0] + re[0]) / 2;
  const ey = (le[1] + re[1]) / 2;
  const my = (lm[1] + rm[1]) / 2;
  const yaw = Math.abs(nose[0] - ex) / eyeDist;
  const roll = Math.abs(Math.atan2(re[1] - le[1], re[0] - le[0]));
  const pitch = Math.abs((my - ey) / eyeDist - 1);
  return {
    frontal: clamp01(1 - yaw * 1.6 - roll * 1.2 - pitch * 0.8),
    yaw,
    roll,
    pitch,
  };
}

/**
 * 综合质量分（只用来排序选封面，不参与收录判定）。
 *
 * 用几何平均而不是加权和：加权和有个致命地板——拉普拉斯为 0 的糊脸照样能靠
 * 尺寸/检测分拿到 0.6 分，于是「0.5 分档里有 medianLap=10 的糊脸」。
 * 几何平均下任意一项塌陷都会把总分拉下来，符合「封面不能由糊脸当选」的要求。
 * 拉普拉斯项取对数刻度：该分布重尾（p50=437、p90=1956），线性刻度会把中位数以上的脸全挤到满分。
 *
 * 收录判定走 reasons + 分层门槛，不受质量分影响。
 */
export function assessFace({ lap, mean = 128, std = 40, score = 0.8, facePx = 90, frontal = 1, clipHi = 0 }) {
  const G = QUALITY_GATES;
  const reasons = [];
  if (lap < G.LAP_REJECT) reasons.push('模糊');
  if (facePx < G.FACE_PX_MIN) reasons.push('人脸过小');
  if (std < G.STD_MIN) reasons.push('几乎没有纹理');
  if (clipHi > G.CLIP_HI_MAX || mean > G.MEAN_MAX) reasons.push('过曝');
  if (mean < G.MEAN_MIN) reasons.push('欠曝');
  if (frontal < G.FRONTAL_MIN) reasons.push('非正面/疑似后脑勺');

  const soft = [];
  if (lap < G.LAP_CLUSTER) soft.push('不够清晰');
  if (facePx < G.FACE_PX_CLUSTER) soft.push('尺寸偏小');
  if (frontal < G.FRONTAL_CLUSTER) soft.push('侧脸');

  const parts = {
    blur: clamp01(Math.log(Math.max(lap, 1) / G.LAP_REJECT) / Math.log(G.LAP_FULL / G.LAP_REJECT)),
    size: clamp01((facePx - G.FACE_PX_MIN) / (G.FACE_PX_FULL - G.FACE_PX_MIN)),
    frontal: clamp01(frontal),
    det: clamp01((score - 0.5) / 0.4),
    contrast: clamp01((std - 12) / 35),
    brightness: clamp01(1 - Math.abs(mean - 128) / 110),
  };
  const quality = clamp01(
    parts.blur ** 0.5 *
      parts.size ** 0.2 *
      parts.frontal ** 0.15 *
      parts.det ** 0.1 *
      parts.contrast ** 0.03 *
      parts.brightness ** 0.02
  );
  const keep = reasons.length === 0;
  return {
    quality,
    keep,
    /**
     * 是否够格参与聚类 / 建新人物（分层门槛，比 keep 更严）。
     * 检测分单独再卡一道：真实库里「后脑勺/耳朵」这类伪造脸检测分集中在 0.5~0.65
     * （大杂烩人物 562 张脸的中位数只有 0.577，正常大人物是 0.82），
     * 它们的 ArcFace 特征彼此相似得离谱，放进来一定串成一锅。
     */
    cluster: keep && soft.length === 0 && score >= G.SCORE_CLUSTER,
    frontal: parts.frontal,
    reasons,
    soft,
    parts,
  };
}

/**
 * 「质量偏低」分界：正好卡在聚类门槛上的那张脸值多少分。
 * 前端要打标记时引用这里，避免在界面上另抄一个魔法数字（改门槛后两边立刻不一致）。
 */
export const SOFT_QUALITY = assessFace({
  lap: QUALITY_GATES.LAP_CLUSTER,
  std: 30,
  score: 0.8,
  facePx: 60,
  frontal: 0.6,
}).quality;
