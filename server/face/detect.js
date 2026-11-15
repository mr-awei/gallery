// @ts-check
/**
 * 检测与人脸对齐：SCRFD det_10g 出检测框 + 5 点关键点，ArcFace w600k_r50 出 512 维特征。
 *
 * 关键约束：
 * - 推理跑在 HTTP 主进程，但每张图之间由扫描任务 setImmediate 让出事件循环，避免卡死接口；
 * - 预处理与对齐全项目只此一份：扫描、单图重扫、测试都走 analyzeImage，
 *   两份实现迟早分叉成「扫描出来的脸和重扫的对不上」；
 * - faces.vec 存归一化后的 float32 原始字节（不量化，聚类要精度）；
 *   faces.x1..y2 存**归一化到 0~1 的比例**而非像素 —— 原图可能被替换/旋转，
 *   比例在裁剪接口里再乘当前尺寸，比存像素稳。
 */
import sharp from 'sharp';
import { getSessions } from './model.js';
import { nms, scrfdDecode, warpAlign, l2norm, SCRFD_STRIDES } from '../lib/face-math.js';
import { assessFace, faceNativePatch, patchStats, poseFromLandmarks } from '../lib/face-quality.js';
import { DET_SIZE, ARC_SIZE, DET_THRESH, NMS_IOU, WORK_MAX, MAX_FACES } from './constants.js';

/**
 * 解码成工作分辨率 RGBA。
 * 按 EXIF 自动旋转（否则竖拍照片的人脸框会整体转 90°），并限制长边，
 * 避免一张 1 亿像素的图把内存吃光 —— 反正检测输入只有 640。
 */
export async function loadWork(absPath) {
  const { data, info } = await sharp(absPath, { failOn: 'none' })
    .rotate()
    .resize({ width: WORK_MAX, height: WORK_MAX, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** 组装 SCRFD 输入张量：等比缩放后左上角贴边补齐到 640×640（与 insightface 一致，不是居中） */
async function buildDetTensor(work) {
  const { data, width: w, height: h } = work;
  const ratio = h / w;
  let nw;
  let nh;
  if (ratio > 1) {
    nh = DET_SIZE;
    nw = Math.max(1, Math.round(DET_SIZE / ratio));
  } else {
    nw = DET_SIZE;
    nh = Math.max(1, Math.round(DET_SIZE * ratio));
  }
  const { data: small } = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .resize(nw, nh, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const plane = DET_SIZE * DET_SIZE;
  const f32 = new Float32Array(3 * plane); // 默认 0 ≈ 归一化后的 -1，补齐区就是黑
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const si = (y * nw + x) * 4;
      const di = y * DET_SIZE + x;
      f32[di] = (small[si] - 127.5) / 128;
      f32[plane + di] = (small[si + 1] - 127.5) / 128;
      f32[2 * plane + di] = (small[si + 2] - 127.5) / 128;
    }
  }
  return { f32, sx: nw / w, sy: nh / h };
}

/**
 * 检出人脸（坐标已换算回工作图，键点用于对齐）。
 * @param {{ort:any, det:any, rec:any}} sess
 * @param {{data:Buffer, width:number, height:number}} work
 */
async function detectFaces(sess, work) {
  const { f32, sx, sy } = await buildDetTensor(work);
  const out = await sess.det.run({
    [sess.det.inputNames[0]]: new sess.ort.Tensor('float32', f32, [1, 3, DET_SIZE, DET_SIZE]),
  });
  const names = sess.det.outputNames;
  // det_10g 固定 9 个输出：按 stride 8/16/32 依次给 scores、bbox、kps 三组
  // （与 insightface 的 net_outs[idx]/[idx+3]/[idx+6] 分组一致）。数量不对说明权重不对，直接报错。
  if (names.length !== 9) throw new Error(`人脸检测模型输出异常（期望 9 个张量，实际 ${names.length} 个），请重新下载模型`);
  const scoreT = names.slice(0, 3).map((n) => out[n].data);
  const boxT = names.slice(3, 6).map((n) => out[n].data);
  const kpsT = names.slice(6, 9).map((n) => out[n].data);

  const all = [];
  for (let i = 0; i < 3; i++) {
    const stride = SCRFD_STRIDES[i];
    const fh = Math.floor(DET_SIZE / stride);
    const fw = Math.floor(DET_SIZE / stride);
    all.push(...scrfdDecode(scoreT[i], boxT[i], kpsT[i], { stride, fh, fw, thresh: DET_THRESH }));
  }
  const kept = nms(all, NMS_IOU).slice(0, MAX_FACES);
  return kept.map((f) => ({
    score: f.score,
    // 640 空间 → 工作图空间
    x1: f.x1 / sx,
    y1: f.y1 / sy,
    x2: f.x2 / sx,
    y2: f.y2 / sy,
    kps: f.kps.map(([x, y]) => [x / sx, y / sy]),
  }));
}

/** 一张对齐裁剪 → 512 维归一化特征 */
async function embedAlign(sess, work, kps) {
  const chw = warpAlign(work.data, work.width, work.height, kps, ARC_SIZE);
  const out = await sess.rec.run({
    [sess.rec.inputNames[0]]: new sess.ort.Tensor('float32', chw, [1, 3, ARC_SIZE, ARC_SIZE]),
  });
  const t = out[sess.rec.outputNames[0]];
  return l2norm(Float32Array.from(t.data));
}

/**
 * 质量评估：扫描期与「存量重算」共用同一条路径（同一工作图、原生分辨率灰度块）。
 * 不能缩放到固定尺寸再算拉普拉斯——小脸被放大后梯度被摊平，会被误判成模糊。
 * kps 为 null 表示老数据没存关键点，正面程度按中性 1 处理，不误杀。
 *
 * @param {{width:number,height:number,data:Uint8Array|Buffer}} work
 * @param {number[]} box 归一化框
 * @param {{score?:number, kps?:number[][]|null, frontal?:number|null}} [opts]
 */
export function qualityFromWork(work, box, { score = 0.8, kps = null, frontal = null } = {}) {
  const patch = faceNativePatch(work.data, work.width, work.height, box);
  const stats = patchStats(patch.gray, patch.width, patch.height);
  const facePx = Math.min((box[2] - box[0]) * work.width, (box[3] - box[1]) * work.height);
  const front = frontal != null ? frontal : kps ? poseFromLandmarks(kps).frontal : 1;
  const q = assessFace({ ...stats, score, facePx, frontal: front });
  return { ...q, facePx, lap: stats.lap, std: stats.std, clipHi: stats.clipHi };
}

/** 单张图 → 人脸列表（含 512 维特征、归一化框与质量分）。 */
export async function analyzeImage(absPath) {
  const sess = await getSessions();
  const work = await loadWork(absPath);
  const found = await detectFaces(sess, work);
  const faces = [];
  for (const f of found) {
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const box = [clamp01(f.x1 / work.width), clamp01(f.y1 / work.height), clamp01(f.x2 / work.width), clamp01(f.y2 / work.height)];
    faces.push({
      score: f.score,
      box,
      vec: await embedAlign(sess, work, f.kps),
      ...qualityFromWork(work, box, { score: f.score, kps: f.kps }),
      frontalKnown: true,
    });
  }
  return { width: work.width, height: work.height, faces };
}
