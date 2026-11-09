// @ts-check
/**
 * 人脸检测 + 特征提取（SCRFD det_10g + ArcFace w600k_r50），纯本地 ONNX 推理。
 *
 * 为什么是这两个模型：SCRFD 是少数「检测框 + 5 点关键点」一次出全的模型，
 * ArcFace 的 512 维特征在余弦空间里可分性稳定，两项都是工业界通用件，
 * 且权重只 ~191MB（det 16.9MB + rec 174MB），比整套 insightface 包（288MB）省。
 *
 * 关键约束：
 * - 权重必须过 server/model-pins.json 的可信哈希清单，装/加载前都复核（被替换直接报错）；
 * - 推理跑在 HTTP 主进程，但每张图之间 setImmediate 让出事件循环，避免扫库时把接口卡死；
 * - 进度落 jobs 表（kind='face-scan'），可取消、可重试、崩了能看出停在哪。
 *
 * 结果落库：
 * - faces.vec 存归一化后的 float32 原始字节（不量化，聚类要精度）；
 * - faces.x1..y2 存**归一化到 0~1 的比例**，而不是像素 —— 原图可能被替换/旋转，
 *   比例在裁剪接口里再乘当前尺寸，比存像素稳。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR } from './config.js';
import { db, withTransaction } from './db.js';
import { downloadModelFile, verifyModelFileDetailed, KNOWN_SHA256, isPinned } from './model-fetch.js';
import { createJob, finishJob, jobProgress } from './jobs.js';
import { nms, scrfdDecode, warpAlign, l2norm, cosine, blendCentroid, SCRFD_STRIDES } from './lib/face-math.js';
import {
  assessFace,
  coverRank,
  faceNativePatch,
  patchStats,
  poseFromLandmarks,
  QUALITY_GATES,
  SOFT_QUALITY,
} from './lib/face-quality.js';

const DIR = path.join(DATA_DIR, 'ai', 'face');
const DET_FILE = path.join(DIR, 'det_10g.onnx');
const REC_FILE = path.join(DIR, 'w600k_r50.onnx');
const REPO = 'public-data/insightface';
const MIRRORS = ['https://hf-mirror.com/', 'https://huggingface.co/'];
export const DET_KEY = `${REPO}/models/buffalo_l/det_10g.onnx`;
export const REC_KEY = `${REPO}/models/buffalo_l/w600k_r50.onnx`;

const DET_SIZE = 640; // SCRFD 固定输入
const ARC_SIZE = 112; // ArcFace 固定输入
const DIM = 512;
const DET_THRESH = 0.5;
const NMS_IOU = 0.4;
/**
 * 同一人的余弦阈值默认值。
 * w600k_r50 在通用基准上 0.4 左右开始出现「把路人并成同一个人」，而同一人换角度可能掉到
 * 0.45 附近 —— 这是唯一一个没有标准答案的参数，所以做成扫描时可调，默认取偏严的 0.42。
 */
const MATCH_COS = 0.42;
/**
 * 建新人物的门槛（「高置信种子」）：只有检测分足够高的脸才有资格开一个新人物。
 * 后脑勺/耳朵/半张脸这类伪造检测的检测分中位数只有 0.58（真实库 562 张脸的簇），
 * 它们没有资格当种子；一张 0.55 分的脸只能「加入」已有的人，不能「自立门户」。
 */
const SEED_SCORE = 0.75;
const SEED_QUALITY = 0.5;
/** 加入已有人的余弦下限（比质心门槛略松，但配合同图排他与簇健康度），扫描与重建共用 */
const JOIN_COS = 0.45;
/** 簇健康度：一簇脸的平均检测分低于此值且规模够大，判定为「垃圾簇」整体解散 */
const HEALTH_MIN_SCORE = 0.68;
const HEALTH_MIN_COUNT = 15;
/** 本次扫描实际使用的阈值（状态接口如实返回，避免界面显示默认值而实际跑的是别的） */
let activeCos = MATCH_COS;

/** 人脸框短边（原图像素）。width/height 缺失时按工作分辨率 1600 估算，只为排序不至于退化。 */
const FACE_PX_EXPR = 'MIN((f.x2 - f.x1) * COALESCE(i.width, 1600), (f.y2 - f.y1) * COALESCE(i.height, 1600))';
/** 「清理模糊人脸 / 重选封面」后台任务状态，随 faceStatus 轮询推给前端 */
const cleanState = {
  running: false,
  cancelled: false,
  done: 0,
  total: 0,
  hidden: 0,
  /** 各硬门槛命中数，界面如实说明「为什么排除」（模糊/过小/无纹理/过曝/非正面） */
  reasons: { 模糊: 0, 人脸过小: 0, 几乎没有纹理: 0, 过曝: 0, 欠曝: 0, '非正面/疑似后脑勺': 0 },
  message: '',
  error: '',
};
/** 检测分辨率上限：再大也只是喂给 640 的模型，白白多花解码时间 */
const WORK_MAX = 1600;
/** 单张图最多取的人脸数：合影够用，也防极端图把一次扫描拖死 */
const MAX_FACES = 24;

/* --------------------------- 模型状态与安装 --------------------------- */

let sessionPromise = null;
let installAbort = null;
const state = { downloading: false, progress: 0, message: '', error: '', cancelled: false };

const detBytes = () => (fs.existsSync(DET_FILE) ? fs.statSync(DET_FILE).size : 0);
const recBytes = () => (fs.existsSync(REC_FILE) ? fs.statSync(REC_FILE).size : 0);
const modelsReady = () => detBytes() > 8 * 1024 * 1024 && recBytes() > 100 * 1024 * 1024;

export function faceStatus() {
  let persons = 0;
  let faces = 0;
  let pending = 0;
  let hiddenFaces = 0;
  let unassessedFaces = 0;
  let weakCoverPersons = 0;
  try {
    persons = Number(db.prepare('SELECT COUNT(*) AS c FROM persons WHERE count > 0').get()?.c) || 0;
    faces = Number(db.prepare('SELECT COALESCE(SUM(count), 0) AS c FROM persons').get()?.c) || 0;
    // 只数「待扫」：face_scanned 上建了部分索引，这个计数不会全表扫（已扫完时索引为空）
    pending = Number(db.prepare('SELECT COUNT(*) AS c FROM images WHERE face_scanned = 0').get()?.c) || 0;
    hiddenFaces = Number(db.prepare('SELECT COUNT(*) AS c FROM faces WHERE hidden = 1').get()?.c) || 0;
    unassessedFaces = Number(db.prepare('SELECT COUNT(*) AS c FROM faces WHERE quality < 0').get()?.c) || 0;
    weakCoverPersons = countWeakCoverPersons();
  } catch {
    /* 老库还没迁移完时不该让状态接口 500 */
  }
  return {
    downloaded: modelsReady(),
    downloading: state.downloading,
    progress: state.progress,
    message: state.message,
    error: state.error,
    cancelled: state.cancelled,
    model: REPO,
    size: detBytes() + recBytes(),
    /**
     * true = 两个权重都与随包清单一致（可信）；
     * false = 没下载，或只是与本机 sidecar 自洽，不能对外宣称「校验通过」。
     */
    verified: isPinned(DET_KEY) && isPinned(REC_KEY),
    persons,
    faces,
    pending,
    hiddenFaces,
    unassessedFaces,
    /** 封面脸不够清晰的人物数：人物页默认折叠这部分（可一键切回「全部」） */
    weakCoverPersons,
    /** 「不够清晰」判定线，前端只用于显示说明，不自己算 */
    softQuality: SOFT_QUALITY,
    scanning: scanState.running,
    matchCos: activeCos,
    cleaning: cleanState.running,
    cleanDone: cleanState.done,
    cleanTotal: cleanState.total,
    cleanHidden: cleanState.hidden,
    cleanReasons: { ...cleanState.reasons },
    cleanMessage: cleanState.message,
    cleanError: cleanState.error,
    /** 「重建人物分组」后台任务：只重算聚类与封面，不解码图片 */
    rebuilding: rebuildState.running,
    rebuildDone: rebuildState.done,
    rebuildTotal: rebuildState.total,
    rebuildMessage: rebuildState.message,
    rebuildError: rebuildState.error,
    qualityGates: QUALITY_GATES,
  };
}

/** 取消正在进行的模型下载 */
export function cancelFaceInstall() {
  if (!state.downloading || !installAbort) return false;
  state.message = '正在取消…';
  try {
    installAbort.abort(new Error('用户取消下载'));
  } catch {
    /* ignore */
  }
  return true;
}

export function startFaceInstall() {
  if (state.downloading) return { ok: true, started: false, ...faceStatus() };
  installFaceModels().catch((err) => {
    console.warn('[face] 模型安装失败：', err?.message || err);
  });
  return { ok: true, started: true, ...faceStatus() };
}

/** 下载两个权重（~191MB），进度写 jobs 表，可在任务中心取消 */
export async function installFaceModels() {
  if (state.downloading) throw new Error('正在下载中，请稍候');
  state.downloading = true;
  state.progress = 0;
  state.error = '';
  state.cancelled = false;
  state.message = '准备下载…';
  installAbort = new AbortController();
  const signal = installAbort.signal;
  const jobId = createJob({ kind: 'model-install', title: '人脸模型（SCRFD + ArcFace）', payload: { model: 'face' } });
  // 镜像前缀：downloadModelFile 自己拼 repoPath（以前传整条文件 URL，路径重复永远 404）
  const mirrorBases = MIRRORS.map((m) => `${m}${REPO}/resolve/main/`);
  try {
    state.message = '下载检测模型（约 17MB）…';
    await downloadModelFile({
      mirrors: mirrorBases,
      repoPath: 'models/buffalo_l/det_10g.onnx',
      dest: DET_FILE,
      minBytes: 8 * 1024 * 1024,
      maxBytes: 64 * 1024 * 1024,
      sha256: KNOWN_SHA256[DET_KEY] || '',
      signal,
      onProgress: (p) => {
        state.progress = Math.round(p * 18);
        state.message = `下载检测模型 ${Math.round(p * 100)}%（约 17MB）`;
        jobProgress(jobId, { progress: state.progress, message: state.message });
      },
    });
    state.message = '下载特征模型（约 174MB）…';
    await downloadModelFile({
      mirrors: mirrorBases,
      repoPath: 'models/buffalo_l/w600k_r50.onnx',
      dest: REC_FILE,
      minBytes: 100 * 1024 * 1024,
      maxBytes: 512 * 1024 * 1024,
      sha256: KNOWN_SHA256[REC_KEY] || '',
      signal,
      onProgress: (p) => {
        state.progress = 18 + Math.round(p * 80);
        state.message = `下载特征模型 ${Math.round(p * 100)}%（约 174MB）`;
        jobProgress(jobId, { progress: state.progress, message: state.message });
      },
    });
    // 下载器已校验，这里再复核一次：防止 sha256 清单缺失时把坏权重当成好的
    const det = await verifyModelFileDetailed(DET_FILE, { minBytes: 8 * 1024 * 1024, sha256: KNOWN_SHA256[DET_KEY] || '' });
    if (!det.ok) throw new Error(`检测模型校验未通过（${det.reason || '哈希不匹配'}），请重试安装`);
    const rec = await verifyModelFileDetailed(REC_FILE, { minBytes: 100 * 1024 * 1024, sha256: KNOWN_SHA256[REC_KEY] || '' });
    if (!rec.ok) throw new Error(`特征模型校验未通过（${rec.reason || '哈希不匹配'}），请重试安装`);
    state.progress = 100;
    state.message = det.verified && rec.verified ? '下载完成（已比对可信哈希）' : '下载完成（已记录哈希，未与清单比对）';
    sessionPromise = null;
    finishJob(jobId, { status: 'done', result: { verified: det.verified && rec.verified } });
    return faceStatus();
  } catch (err) {
    const cancelled = /已取消/.test(String(err?.message || ''));
    state.cancelled = cancelled;
    state.error = cancelled ? '' : String(err?.message || err).slice(0, 200);
    state.message = cancelled ? '已取消下载' : state.message;
    // 坏文件必须删掉：留着会让「已下载」显示为真，下次扫描直接报推理失败
    await fsp.rm(DET_FILE, { force: true }).catch(() => {});
    await fsp.rm(REC_FILE, { force: true }).catch(() => {});
    finishJob(jobId, { status: cancelled ? 'canceled' : 'failed', error: state.error });
    throw err;
  } finally {
    state.downloading = false;
    installAbort = null;
  }
}

/** 加载两个 ONNX 会话（模块级缓存；校验失败删坏文件并置空，允许重装后重试） */
function getSessions() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    if (!modelsReady()) throw new Error('人脸模型未下载，请先到「设置 → 人脸识别」下载（约 191MB）');
    /** @type {Array<[string, number, string]>} */
    const checks = [
      [DET_FILE, 8 * 1024 * 1024, DET_KEY],
      [REC_FILE, 100 * 1024 * 1024, REC_KEY],
    ];
    for (const [file, min, key] of checks) {
      const check = await verifyModelFileDetailed(file, { minBytes: min, sha256: KNOWN_SHA256[key] || '' });
      if (!check.ok) {
        await fsp.rm(file, { force: true }).catch(() => {});
        throw new Error(`人脸模型损坏或哈希不匹配（${check.reason || '校验失败'}），已删除，请在设置里重新下载`);
      }
    }
    const ort = await import('onnxruntime-node');
    const det = await ort.InferenceSession.create(DET_FILE);
    const rec = await ort.InferenceSession.create(REC_FILE);
    return { ort, det, rec };
  })().catch((err) => {
    sessionPromise = null;
    throw err;
  });
  return sessionPromise;
}

/* ------------------------------ 图像预处理 ------------------------------ */

/**
 * 解码成工作分辨率 RGBA。
 * 按 EXIF 自动旋转（否则竖拍照片的人脸框会整体转 90°），并限制长边，
 * 避免一张 1 亿像素的图把内存吃光 —— 反正检测输入只有 640。
 */
async function loadWork(absPath) {
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

/* ------------------------------- 检测与特征 ------------------------------- */

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
function qualityFromWork(work, box, { score = 0.8, kps = null, frontal = null } = {}) {
  const patch = faceNativePatch(work.data, work.width, work.height, box);
  const stats = patchStats(patch.gray, patch.width, patch.height);
  const facePx = Math.min((box[2] - box[0]) * work.width, (box[3] - box[1]) * work.height);
  const front = frontal != null ? frontal : kps ? poseFromLandmarks(kps).frontal : 1;
  const q = assessFace({ ...stats, score, facePx, frontal: front });
  return { ...q, facePx, lap: stats.lap, std: stats.std, clipHi: stats.clipHi };
}

/**
 * 单张图 → 人脸列表（含 512 维特征、归一化框与质量分）。
 *
 * 扫描任务、单图重扫、以及测试都走同一条路径：预处理与对齐只要有两份实现，
 * 迟早会分叉成「扫描出来的脸和重扫出来的对不上」。
 */
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

/* ------------------------------- 聚类存储 ------------------------------- */

/** 扫描期的人物缓存：id → { id, count, centroid }，只在内存里更新，成批刷库 */
let personCache = null;
const dirtyPersons = new Set();

function loadPersonCache() {
  personCache = new Map();
  // 顺带读出封面脸的质量与像素尺寸：扫描中途续跑也要能比较「新脸是否比旧封面更清晰」
  for (const row of db
    .prepare(
      `SELECT p.id, p.count, p.centroid, p.cover_face_id, COALESCE(f.quality, -1) AS cover_quality, p.cover_px,
              COALESCE(p.cover_locked, 0) AS cover_locked
       FROM persons p LEFT JOIN faces f ON f.id = p.cover_face_id`
    )
    .all()) {
    const c = row.centroid
      ? new Float32Array(/** @type {Buffer} */ (row.centroid).buffer, /** @type {Buffer} */ (row.centroid).byteOffset, DIM)
      : null;
    personCache.set(Number(row.id), {
      id: Number(row.id),
      count: Number(row.count) || 0,
      centroid: c ? Float32Array.from(c) : null,
      coverFaceId: row.cover_face_id == null ? null : Number(row.cover_face_id),
      coverScore: Number(row.cover_quality) >= 0 ? coverRank({ quality: Number(row.cover_quality), facePx: Number(row.cover_px) || 0 }) : null,
      coverQuality: Number(row.cover_quality) || -1,
      coverPx: Number(row.cover_px) || 0,
      /** 用户手动锁定的封面：扫描/清理/重建都不许自动换掉 */
      coverLocked: Number(row.cover_locked) === 1,
      /** 这个人已经收录了哪些照片 —— 同图排他要靠它判断 */
      images: new Set(),
    });
  }
  for (const row of db.prepare('SELECT person_id, image_id FROM faces WHERE person_id IS NOT NULL AND hidden <> 1').all()) {
    const p = personCache.get(Number(row.person_id));
    if (p) p.images.add(Number(row.image_id));
  }
  dirtyPersons.clear();
  return personCache;
}

function flushPersons() {
  if (!personCache || !dirtyPersons.size) return;
  withTransaction(() => {
    const up = db.prepare(
      'UPDATE persons SET count = ?, centroid = ?, cover_face_id = COALESCE(?, cover_face_id), cover_px = ? WHERE id = ?'
    );
    for (const id of dirtyPersons) {
      const p = personCache.get(id);
      if (!p) continue;
      up.run(
        p.count,
        p.centroid ? Buffer.from(p.centroid.buffer, p.centroid.byteOffset, p.centroid.byteLength) : null,
        p.coverFaceId ?? null,
        p.coverPx ?? 0,
        id
      );
    }
  });
  dirtyPersons.clear();
}

/**
 * 找最像的人：返回 {person, sim} 或 null（质心数量在个人图库里通常只有几百，线性扫足够且精确）。
 * 跳过「这张照片里已经有他的脸」的人：同一张合影里出现 2~4 张同一个人的脸，只可能是误分。
 * @param {Float32Array} vec
 * @param {number} imageId
 */
function bestPerson(vec, imageId) {
  let best = null;
  let bestSim = -2;
  for (const p of personCache.values()) {
    if (!p.centroid) continue;
    if (imageId && p.images.has(imageId)) continue;
    const s = cosine(p.centroid, vec);
    if (s > bestSim) {
      bestSim = s;
      best = p;
    }
  }
  if (best && bestSim >= activeCos) return { person: best, sim: bestSim };
  return null;
}

/**
 * 把一张脸归到某个人（必要时新建），返回 person_id；不该进人物时返回 null。
 *
 * 三条规定（扫描与重建共用同一套，否则两条路径迟早分叉）：
 * 1. 同图排他：这个人已经在这张照片里出现过了 → 不再收（宁可不收也不串人）；
 * 2. 高置信种子：只有检测分/质量足够高的脸才有资格新建人物，低分伪脸只能「加入」；
 * 3. 质心用代价均摊的方式更新（blendCentroid），避免大簇被后来的错脸慢慢带跑。
 *
 * @param {Float32Array} vec
 * @param {{imageId:number, score:number, quality:number}} meta
 */
function assignPerson(vec, { imageId, score, quality }) {
  const hit = bestPerson(vec, imageId);
  if (hit) {
    const p = hit.person;
    p.centroid = blendCentroid(p.centroid, p.count, vec);
    p.count += 1;
    p.images.add(imageId);
    dirtyPersons.add(p.id);
    return p.id;
  }
  if (score < SEED_SCORE || quality < SEED_QUALITY) return null;
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO persons (name, count, centroid, cover_px, created_at) VALUES (?, 1, ?, 0, ?)').run(
    '',
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    now
  );
  const id = Number(r.lastInsertRowid);
  personCache.set(id, {
    id,
    count: 1,
    centroid: Float32Array.from(vec),
    coverFaceId: null,
    coverScore: null,
    coverQuality: -1,
    coverPx: 0,
    images: new Set([imageId]),
  });
  return id;
}

/**
 * 从库里重算某人的质心、计数与封面（合并/移脸/清理后调用）。
 *
 * 封面不是「质量分最高的脸」：一张 29px 的脸也能拿到 0.53 分，放大到 150px 卡片上就是
 * 一块白糊。所以封面必须同时满足「原图短边 ≥ COVER_PX_MIN」与质量/检测分门槛，
 * 排序分再用尺寸做惩罚（coverRank）；一条都不满足就不给封面（cover_face_id = NULL），
 * 前端把它折叠进「封面不清晰」。
 */
export function rebuildPerson(personId) {
  // hidden=1 是低质量自动排除的脸：不进质心、不进计数、不进封面
  const rows = db
    .prepare(
      `SELECT f.id, f.image_id, f.vec, f.score, f.quality, ${FACE_PX_EXPR} AS px
       FROM faces f JOIN images i ON i.id = f.image_id
       WHERE f.person_id = ? AND f.hidden <> 1`
    )
    .all(personId);
  if (!rows.length) {
    // 保留人物行（名字可能有用），但计数清零后界面自然过滤掉
    db.prepare('UPDATE persons SET count = 0, centroid = NULL, cover_face_id = NULL, cover_px = 0 WHERE id = ?').run(personId);
    personCache?.delete(personId);
    return { count: 0, removed: false };
  }
  const acc = new Float32Array(DIM);
  for (const r of rows) {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM);
    for (let i = 0; i < DIM; i++) acc[i] += v[i];
  }
  const centroid = l2norm(acc);
  const pickCover = (list) => {
    let best = null;
    for (const r of list) {
      const rank = coverRank({ quality: Number(r.quality), facePx: Number(r.px) || 0, score: Number(r.score) });
      if (rank == null) continue;
      if (!best || rank > best.rank) best = { id: Number(r.id), rank, px: Number(r.px), quality: Number(r.quality) };
    }
    return best;
  };
  const cover = pickCover(rows);
  // 用户手动锁定过封面就尊重它：只要那张脸还在这个人名下、没被排除，就原样保留。
  // 锁定的脸一旦被删/被移走（合并、单脸改派），才回落到自动挑选并解锁。
  const locked = db.prepare('SELECT cover_face_id, cover_locked FROM persons WHERE id = ?').get(personId);
  const lockedFace = Number(locked?.cover_locked) === 1 ? Number(locked?.cover_face_id) || null : null;
  const keep = lockedFace ? rows.find((r) => Number(r.id) === lockedFace) : null;
  const finalCover = keep
    ? { id: lockedFace, rank: coverRank({ quality: Number(keep.quality), facePx: Number(keep.px) || 0, score: Number(keep.score) }), px: Number(keep.px) || 0, quality: Number(keep.quality) }
    : cover;
  db.prepare('UPDATE persons SET count = ?, centroid = ?, cover_face_id = ?, cover_px = ?, cover_locked = ? WHERE id = ?').run(
    rows.length,
    Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength),
    finalCover ? finalCover.id : null,
    finalCover ? finalCover.px : 0,
    keep ? 1 : 0,
    personId
  );
  if (personCache?.has(personId)) {
    // 保留封面与质量：丢掉的话，后续扫描会误以为「这个人还没有封面」再抢一次
    personCache.set(personId, {
      id: personId,
      count: rows.length,
      centroid,
      coverFaceId: finalCover ? finalCover.id : null,
      coverScore: finalCover ? finalCover.rank : null,
      coverQuality: finalCover ? finalCover.quality : -1,
      coverPx: finalCover ? finalCover.px : 0,
      coverLocked: !!keep,
      images: new Set(rows.map((r) => Number(r.image_id)).filter((v) => v)),
    });
  }
  return { count: rows.length, removed: false };
}

/* -------------------------------- 扫描任务 -------------------------------- */

const scanState = { running: false, cancelled: false, jobId: 0 };

export function cancelFaceScan() {
  if (!scanState.running) return false;
  scanState.cancelled = true;
  return true;
}

/**
 * 开始全库人脸扫描。
 * force=true 时清空已有人脸重扫（改了阈值/换了模型后用）。
 */
export function startFaceScan({ limit = 0, force = false, minCos = 0 } = {}) {
  if (scanState.running) return { ok: false, message: '人脸扫描正在进行中' };
  if (!modelsReady()) return { ok: false, message: '人脸模型未下载，请先到「设置 → 人脸识别」下载（约 191MB）' };
  scanState.running = true;
  scanState.cancelled = false;
  // 阈值只接受 0.25~0.7：低于 0.25 会把整库并成一个人，高于 0.7 等于只认同一张照片
  const cos = Number(minCos) ? Math.max(0.25, Math.min(0.7, Number(minCos))) : MATCH_COS;
  runScan({ limit: Number(limit) || 0, force: !!force, minCos: cos }).catch((err) => {
    console.warn('[face] 扫描失败：', err?.message || err);
  });
  return { ok: true, started: true, ...faceStatus() };
}

async function runScan({ limit, force, minCos }) {
  const jobId = createJob({ kind: 'face-scan', title: '人脸扫描与聚类', payload: { limit, force, minCos } });
  scanState.jobId = jobId;
  activeCos = minCos;
  let done = 0;
  let failed = 0;
  let faceTotal = 0;
  try {
    if (force) {
      withTransaction(() => {
        db.exec('DELETE FROM faces');
        db.exec('DELETE FROM persons');
        db.exec('UPDATE images SET face_scanned = 0');
      });
    }
    loadPersonCache();
    const pending = Number(db.prepare('SELECT COUNT(*) AS c FROM images WHERE face_scanned = 0').get()?.c) || 0;
    const total = limit > 0 ? Math.min(limit, pending) : pending;
    jobProgress(jobId, { total, progress: 0, message: total ? '开始扫描…' : '没有待扫描的素材', force: true });
    if (!total) {
      finishJob(jobId, { status: 'done', result: { done: 0, faces: 0, failed: 0 } });
      return;
    }

    const pickBatch = db.prepare('SELECT id, abs_path FROM images WHERE face_scanned = 0 ORDER BY id LIMIT ?');
    const markScanned = db.prepare('UPDATE images SET face_scanned = 1 WHERE id = ?');
    const insertFace = db.prepare(
      `INSERT INTO faces (image_id, person_id, x1, y1, x2, y2, score, det, vec, quality, frontal, hidden, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (;;) {
      if (scanState.cancelled) break;
      if (limit > 0 && done + failed >= limit) break;
      const batch = pickBatch.all(Math.min(50, limit > 0 ? limit - done - failed : 50));
      if (!batch.length) break;

      for (const row of batch) {
        if (scanState.cancelled) break;
        try {
          const { faces } = await analyzeImage(row.abs_path);
          // 质量硬门槛（模糊 / 太小 / 无纹理 / 疑似后脑勺）直接排除，连库都不进
          const usable = faces.filter((f) => f.keep);
          if (usable.length) {
            // 特征先算完再一次事务写入：单张图的多张脸不该出现「写了一半」的中间态
            withTransaction(() => {
              const now = new Date().toISOString();
              for (const f of usable) {
                // 分层门槛只决定「能不能聚类/当封面」，不决定「显示不显示」：
                // 模糊的脸本来就没进库（上面按 keep 过滤过），而只是不够清晰的脸
                // 仍然留着（灯箱可见、可手动收录），否则人物相册会被掏空一片。
                const personId = f.cluster
                  ? assignPerson(f.vec, { imageId: Number(row.id), score: f.score, quality: f.quality })
                  : null;
                const ins = insertFace.run(
                  row.id,
                  personId,
                  f.box[0],
                  f.box[1],
                  f.box[2],
                  f.box[3],
                  f.score,
                  DET_THRESH,
                  Buffer.from(f.vec.buffer, f.vec.byteOffset, f.vec.byteLength),
                  f.quality,
                  f.frontalKnown ? f.frontal : -1,
                  0,
                  now
                );
                // 封面取舍同时看清晰度与尺寸（coverRank）：只有 29px 的脸质量分不低，
                // 但它放大到卡片上就是一块白糊，绝不能当门面
                if (f.cluster) {
                  const p = personCache.get(personId);
                  const rank = coverRank({ quality: f.quality, facePx: f.facePx, score: f.score });
                  // coverLocked：用户手动选过封面，扫描只加照片不许换门面
                  if (p && !p.coverLocked && rank != null && (p.coverScore == null || rank > p.coverScore)) {
                    p.coverFaceId = Number(ins.lastInsertRowid);
                    p.coverQuality = f.quality;
                    p.coverPx = f.facePx;
                    p.coverScore = rank;
                    dirtyPersons.add(personId);
                  }
                }
              }
            });
            faceTotal += usable.length;
          }
          markScanned.run(row.id);
          done++;
        } catch (err) {
          // 单张图坏了（损坏文件/超长边）不该让整次扫描停摆，标记已扫并计数上报
          console.warn('[face] 跳过', row.id, err?.message || err);
          markScanned.run(row.id);
          failed++;
        }
        const processed = done + failed;
        jobProgress(jobId, {
          done: processed,
          total,
          progress: Math.round((processed / total) * 100),
          failed,
          message: `已扫描 ${processed}/${total}，检出人脸 ${faceTotal} 张`,
        });
        // 让出事件循环：否则几百张连跑时整个 HTTP 服务像卡死
        await new Promise((r) => setImmediate(r));
      }
      flushPersons(); // 每批刷一次质心，进程被杀也只丢最后几十张图的聚类增量
    }

    flushPersons();
    const cancelled = scanState.cancelled;
    finishJob(jobId, {
      status: cancelled ? 'canceled' : 'done',
      result: { done, failed, faces: faceTotal, persons: personCache ? personCache.size : 0 },
    });
  } catch (err) {
    flushPersons();
    finishJob(jobId, { status: 'failed', error: String(err?.message || err).slice(0, 300) });
    throw err;
  } finally {
    scanState.running = false;
    scanState.jobId = 0;
    scanState.cancelled = false;
    personCache = null;
  }
}

/* -------------------- 存量质量重算 / 重选封面（后台任务） -------------------- */

/**
 * 老库里的人脸没有质量分，封面又是「第一张脸 / 最高检测分」选的，糊脸当门面。
 * 这个任务不跑模型、不删人脸：按同一套质量门槛回填分数、标记排除，再按质量重选封面。
 * hidden=1 只是「不显示 / 不聚类」，用户在灯箱里手动归到某个人即可找回（hidden=2）。
 */
export function startQualityCleanup() {
  if (cleanState.running || scanState.running) return { ok: true, busy: true, ...faceStatus() };
  Object.assign(cleanState, {
    running: true,
    cancelled: false,
    done: 0,
    total: 0,
    hidden: 0,
    reasons: { 模糊: 0, 人脸过小: 0, 几乎没有纹理: 0, 过曝: 0, 欠曝: 0, '非正面/疑似后脑勺': 0 },
    message: '准备重算人脸质量…',
    error: '',
  });
  runQualityCleanup().catch((err) => {
    console.warn('[face] 质量清理失败：', err?.message || err, err?.cause?.code || '');
    cleanState.error = String(err?.message || err);
    cleanState.running = false;
  });
  return { ok: true, started: true, ...faceStatus() };
}

export function cancelQualityCleanup() {
  if (!cleanState.running) return false;
  cleanState.cancelled = true;
  cleanState.message = '正在取消…';
  return true;
}

async function runQualityCleanup() {
  const jobId = createJob({ kind: 'face-quality', title: '清理模糊人脸并重选封面', payload: {} });
  try {
    const total = Number(db.prepare('SELECT COUNT(*) AS c FROM faces').get()?.c) || 0;
    cleanState.total = total;
    jobProgress(jobId, { total, progress: 0, message: total ? '开始检查人脸清晰度…' : '没有已检出的人脸', force: true });

    const pickBatch = db.prepare(
      `SELECT f.id, f.image_id, f.x1, f.y1, f.x2, f.y2, f.score, f.frontal, f.hidden, i.abs_path
       FROM faces f JOIN images i ON i.id = f.image_id
       WHERE f.id > ? ORDER BY f.id LIMIT 100`
    );
    const update = db.prepare('UPDATE faces SET quality = ?, hidden = ? WHERE id = ?');
    let lastId = 0;
    let failed = 0;
    // 解码是瓶颈（5D4 原图 resize 到 1600 约 300ms/张，串行只有 2~3 张脸/秒），
    // 按图片分组后并发跑：sharp 内部走 libuv 线程池，4 路足够喂满且不抢爆内存。
    const CONCURRENCY = 4;

    /** 一张图里的一批脸：解码一次，逐脸评分写库 */
    const scoreImageGroup = async (group) => {
      let work;
      try {
        work = await loadWork(group[0].abs_path);
      } catch (err) {
        // 单个文件缺失/损坏不该让整次清理停摆，质量留 -1，界面会如实显示「未评估」
        console.warn('[face] 质量评估跳过图片', group[0].image_id, err?.message || err);
        failed += group.length;
        cleanState.done += group.length;
        return;
      }
      for (const row of group) {
        try {
          const box = [Number(row.x1), Number(row.y1), Number(row.x2), Number(row.y2)];
          const q = qualityFromWork(work, box, {
            score: Number(row.score),
            frontal: Number(row.frontal) >= 0 ? Number(row.frontal) : 1,
          });
          // hidden=2 是用户手动保留，清理不能覆盖用户决定；
          // 只有硬门槛不通过（真糊 / 太小 / 无纹理 / 后脑勺）才隐藏，
          // 「不够清晰」只影响封面与聚类，不把整张照片从人物相册里拿走。
          const hidden = Number(row.hidden) === 2 ? 2 : q.keep ? 0 : 1;
          update.run(q.quality, hidden, Number(row.id));
          if (hidden === 1) {
            cleanState.hidden++;
            // 统计「为什么排除」，主原因计一次，避免同一张脸把多个计数器都抬高
            const why = q.reasons[0] || '清晰度不足';
            cleanState.reasons[why] = (cleanState.reasons[why] || 0) + 1;
          }
          cleanState.done++;
        } catch (err) {
          console.warn('[face] 质量评估跳过', row.id, err?.message || err);
          failed++;
          cleanState.done++;
        }
      }
    };

    for (;;) {
      const rows = pickBatch.all(lastId);
      if (!rows.length) break;
      lastId = Number(rows[rows.length - 1].id);
      if (cleanState.cancelled) break;
      // 同一张图的多张脸共用一次解码（工作图 1600px，和扫描期同量纲）
      /** @type {Map<number, typeof rows>} */
      const groups = new Map();
      for (const row of rows) {
        const key = Number(row.image_id);
        const list = groups.get(key);
        if (list) list.push(row);
        else groups.set(key, [row]);
      }
      const queue = [...groups.values()];
      const lanes = Math.max(1, Math.min(CONCURRENCY, queue.length));
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          for (;;) {
            if (cleanState.cancelled) return;
            const group = queue.shift();
            if (!group) return;
            await scoreImageGroup(group);
          }
        })
      );
      cleanState.message = `已检查 ${cleanState.done}/${total} 张脸，排除 ${cleanState.hidden} 张`;
      jobProgress(jobId, {
        done: cleanState.done,
        total,
        progress: total ? Math.round((cleanState.done / total) * 100) : 100,
        message: cleanState.message,
      });
      await new Promise((r) => setImmediate(r));
      if (cleanState.cancelled) break;
    }

    // 按新质量重算每个人物：质心、人数、封面都只吃可见的脸
    const ids = db.prepare('SELECT id FROM persons').all().map((r) => Number(r.id));
    for (const id of ids) rebuildPerson(id);
    const persons = ids.length;
    // 让用户看得见「排除了多少、为什么排除」，而不是只给一个数字
    const why = Object.entries(cleanState.reasons)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(' / ');
    const detail = why ? `（${why}）` : '';
    cleanState.message = cleanState.cancelled
      ? `已取消：检查 ${cleanState.done} 张脸，排除 ${cleanState.hidden} 张${detail}`
      : `完成：检查 ${total} 张脸、排除 ${cleanState.hidden} 张${detail}，重选 ${persons} 个人的封面`;
    finishJob(jobId, {
      status: cleanState.cancelled ? 'canceled' : 'done',
      result: { faces: total, hidden: cleanState.hidden, reasons: { ...cleanState.reasons }, persons, failed },
    });
  } catch (err) {
    finishJob(jobId, { status: 'failed', error: String(err?.message || err).slice(0, 300) });
    cleanState.error = String(err?.message || err);
    throw err;
  } finally {
    cleanState.running = false;
    cleanState.cancelled = false;
  }
}

/* ------------------------------ 人物重建（全局） ------------------------------ */

/** @type {{running:boolean, cancelled:boolean, done:number, total:number, message:string, error:string}} */
const rebuildState = { running: false, cancelled: false, done: 0, total: 0, message: '', error: '' };

export function personRebuildStatus() {
  return { ...rebuildState };
}

export function cancelPersonRebuild() {
  if (rebuildState.running) rebuildState.cancelled = true;
}

/** @param {Buffer|Uint8Array} buf */
function f32(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, DIM);
}

/**
 * 用库里已有的特征重新聚类（不解码图片，所以是秒级；也正因为不重新检测，
 * 「后脑勺」只能靠检测分与质量分筛，不能靠姿态）。
 *
 * 为什么需要它：增量聚类一旦被一批伪造特征带跑，质心就再也回不来了 ——
 * 真实库里出现过 562 张脸的「人物」，成员全是不同人的后脑勺/耳朵。
 * 全量重建可以一次性把这些簇整体判死（簇健康度），并按新规则重选封面。
 */
export async function startPersonRebuild() {
  if (rebuildState.running) throw new Error('人物重建正在进行中');
  if (scanState.running) throw new Error('扫描正在进行，等它结束再重建（扫描本身也在建组）');
  if (cleanState.running) throw new Error('请先等「清理模糊人脸」结束');
  Object.assign(rebuildState, { running: true, cancelled: false, done: 0, total: 0, message: '准备中…', error: '' });
  const jobId = createJob({ kind: 'face-rebuild', title: '重建人物分组', payload: {} });
  try {
    const rows = db
      .prepare(
        `SELECT f.id, f.image_id, f.score, f.quality, f.person_id, f.vec, ${FACE_PX_EXPR} AS px
         FROM faces f JOIN images i ON i.id = f.image_id WHERE f.hidden <> 1`
      )
      .all();
    // 只有过得了聚类门槛的脸才参与：检测分低的脸（后脑勺/耳朵）特征彼此瞎相似，
    // 放进来就是给别人「加料」；它们仍留在照片上，只是不归人物。
    const eligible = rows
      .filter((r) => Number(r.score) >= QUALITY_GATES.SCORE_CLUSTER && Number(r.quality) >= SOFT_QUALITY)
      .sort((a, b) => Number(b.score) * Number(b.quality) - Number(a.score) * Number(a.quality));
    rebuildState.total = eligible.length;
    jobProgress(jobId, { total: eligible.length, progress: 0, message: '开始重建人物分组…', force: true });

    /**
     * @type {{count:number, centroid:Float32Array, images:Set<number>, scoreSum:number,
     *         qualitySum:number, best:any, oldVotes:Map<number,number>, faces:number[]}[]}
     */
    const clusters = [];
    let dropped = 0;
    for (let i = 0; i < eligible.length; i++) {
      if (rebuildState.cancelled) break;
      const r = eligible[i];
      const v = f32(r.vec);
      const imageId = Number(r.image_id);
      let bestIdx = -1;
      let bestSim = -2;
      for (let c = 0; c < clusters.length; c++) {
        const cl = clusters[c];
        if (cl.images.has(imageId)) continue;
        const s = cosine(cl.centroid, v);
        if (s > bestSim) {
          bestSim = s;
          bestIdx = c;
        }
      }
      const joinable = bestIdx >= 0 && bestSim >= JOIN_COS;
      if (joinable) {
        const cl = clusters[bestIdx];
        cl.centroid = blendCentroid(cl.centroid, cl.count, v);
        cl.count++;
        cl.images.add(imageId);
        cl.scoreSum += Number(r.score);
        cl.qualitySum += Number(r.quality);
        cl.faces.push(Number(r.id));
        if (Number(r.person_id)) cl.oldVotes.set(Number(r.person_id), (cl.oldVotes.get(Number(r.person_id)) || 0) + 1);
        const rank = coverRank({ quality: Number(r.quality), facePx: Number(r.px) || 0, score: Number(r.score) });
        if (rank != null && (!cl.best || rank > cl.best.rank)) {
          cl.best = { id: Number(r.id), rank, px: Number(r.px) || 0 };
        }
      } else if (Number(r.score) >= SEED_SCORE && Number(r.quality) >= SEED_QUALITY) {
        const rank = coverRank({ quality: Number(r.quality), facePx: Number(r.px) || 0, score: Number(r.score) });
        clusters.push({
          count: 1,
          centroid: Float32Array.from(v),
          images: new Set([imageId]),
          scoreSum: Number(r.score),
          qualitySum: Number(r.quality),
          best: rank != null ? { id: Number(r.id), rank, px: Number(r.px) || 0 } : null,
          oldVotes: new Map(Number(r.person_id) ? [[Number(r.person_id), 1]] : []),
          faces: [Number(r.id)],
        });
      } else {
        // 既不能加入任何人，又不够格当种子 —— 不归属任何人物
        dropped++;
      }
      rebuildState.done = i + 1;
      if ((i + 1) % 400 === 0) {
        rebuildState.message = `已分配 ${rebuildState.done}/${eligible.length} 张脸`;
        jobProgress(jobId, {
          done: rebuildState.done,
          total: eligible.length,
          progress: Math.round((rebuildState.done / eligible.length) * 100),
          message: rebuildState.message,
        });
        await new Promise((res) => setImmediate(res));
        if (rebuildState.cancelled) break;
      }
    }

    // 簇健康度：一整簇脸的平均检测分都很低 = 这批「脸」本身就不成立（后脑勺、耳朵、
    // 帽子、半张脸），把它们拆开毫无意义 —— 只能整簇作废。
    let dissolved = 0;
    const kept = [];
    for (const cl of clusters) {
      const avg = cl.scoreSum / cl.count;
      if (cl.count >= HEALTH_MIN_COUNT && avg < HEALTH_MIN_SCORE) {
        dissolved++;
        dropped += cl.count;
        continue;
      }
      kept.push(cl);
    }

    // 落库：先摘掉所有归属，再按新簇写回；旧人物的名字按「多数票」迁到新簇上
    const namedOld = new Map(
      db
        .prepare("SELECT id, name FROM persons WHERE name <> ''")
        .all()
        .map((r) => [Number(r.id), String(r.name)])
    );
    const usedNames = new Set();
    // 用户手动选过的封面要跨重建保留：重建会给人物重新发 id，只能靠「封面脸所在的照片」
    // 认亲 —— 新簇里还包含那张照片，就说明还是同一个人，沿用那张脸当门面并继续锁定。
    const lockedByOld = new Map(
      db
        .prepare(
          `SELECT p.id, f.image_id FROM persons p JOIN faces f ON f.id = p.cover_face_id
           WHERE COALESCE(p.cover_locked, 0) = 1`
        )
        .all()
        .map((r) => [Number(r.id), Number(r.image_id)])
    );
    const faceMeta = new Map(rows.map((r) => [Number(r.id), { imageId: Number(r.image_id), px: Number(r.px) || 0 }]));
    withTransaction(() => {
      db.prepare('UPDATE faces SET person_id = NULL WHERE person_id IS NOT NULL').run();
      db.prepare('UPDATE persons SET count = 0, centroid = NULL, cover_face_id = NULL, cover_px = 0, cover_locked = 0').run();
      const insert = db.prepare(
        'INSERT INTO persons (name, count, centroid, cover_face_id, cover_px, cover_locked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const setFace = db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
      const now = new Date().toISOString();
      for (const cl of kept) {
        let name = '';
        let nameFrom = 0;
        let votes = 0;
        for (const [oldId, n] of cl.oldVotes) {
          if (n > votes && namedOld.has(oldId) && !usedNames.has(oldId)) {
            votes = n;
            nameFrom = oldId;
          }
        }
        if (nameFrom) {
          name = namedOld.get(nameFrom) || '';
          if (name) usedNames.add(nameFrom);
        }
        // 手动封面优先：名字来源的那个旧人物锁过封面，且新簇里还有那张照片，就沿用它
        let coverId = cl.best ? cl.best.id : null;
        let coverPx = cl.best ? cl.best.px : 0;
        let coverLocked = 0;
        const lockedImage = nameFrom ? lockedByOld.get(nameFrom) : null;
        if (lockedImage != null) {
          const fid = cl.faces.find((f) => faceMeta.get(f)?.imageId === lockedImage);
          if (fid) {
            coverId = fid;
            coverPx = faceMeta.get(fid)?.px || 0;
            coverLocked = 1;
          }
        }
        const id = Number(
          insert.run(
            name,
            cl.count,
            Buffer.from(cl.centroid.buffer, cl.centroid.byteOffset, cl.centroid.byteLength),
            coverId,
            coverPx,
            coverLocked,
            now
          ).lastInsertRowid
        );
        for (const faceId of cl.faces) setFace.run(id, faceId);
      }
      // 没被认领的旧人物：无名且空 → 删；有名字的留着（名字是用户资产）
      db.prepare("DELETE FROM persons WHERE count = 0 AND name = ''").run();
    });
    personCache = null;

    const personsLeft = Number(db.prepare('SELECT COUNT(*) AS n FROM persons WHERE count > 0').get().n) || 0;
    rebuildState.message = rebuildState.cancelled
      ? `已取消：已分配 ${rebuildState.done} 张脸`
      : `重建完成：${eligible.length} 张脸 → ${personsLeft} 个人物` +
        (dissolved ? `，解散 ${dissolved} 个不可信簇（${dropped} 张脸不再归属任何人）` : '') +
        `，封面已按清晰度与尺寸重选`;
    finishJob(jobId, {
      status: rebuildState.cancelled ? 'canceled' : 'done',
      result: { faces: eligible.length, persons: personsLeft, clusters: kept.length, dissolved, dropped },
    });
    return { persons: personsLeft, clusters: kept.length, dissolved, dropped };
  } catch (err) {
    finishJob(jobId, { status: 'failed', error: String(err?.message || err).slice(0, 300) });
    rebuildState.error = String(err?.message || err);
    throw err;
  } finally {
    rebuildState.running = false;
    rebuildState.cancelled = false;
  }
}

/* --------------------------------- 查询 --------------------------------- */

/** 单张图的人脸（含所属人物名，供灯箱侧栏展示） */
export function facesOfImage(imageId) {
  return db
    .prepare(
      `SELECT f.id, f.person_id, f.x1, f.y1, f.x2, f.y2, f.score, f.quality, f.hidden, p.name
       FROM faces f LEFT JOIN persons p ON p.id = f.person_id
       WHERE f.image_id = ? ORDER BY f.hidden ASC, f.quality DESC, f.score DESC`
    )
    .all(Number(imageId))
    .map((r) => ({
      id: Number(r.id),
      personId: r.person_id == null ? null : Number(r.person_id),
      name: String(r.name || ''),
      box: [Number(r.x1), Number(r.y1), Number(r.x2), Number(r.y2)],
      score: Number(r.score),
      quality: Number(r.quality) || 0,
      hidden: Number(r.hidden) === 1,
      /** 质量偏低：仍然显示、也计入人物，但不会当选封面／不建新人物 */
      soft: (Number(r.quality) || 0) < SOFT_QUALITY,
    }));
}

/**
 * 人物列表：按人数倒序，带封面脸 id（前端用 /api/face/crop/:faceId 取缩略图）。
 * sharpOnly=true 只返回「封面脸够清晰」的人物：只有一两张糊脸的人物多是误检，
 * 不该占满人物页第一屏；它们仍在库里，切回「全部」就能看到。
 */
export function listPersons({ limit = 200, offset = 0, minCount = 1, q = '', sharpOnly = false } = {}) {
  const needle = String(q || '').trim();
  const conditions = ['count >= ?'];
  /** @type {(string|number)[]} */
  const args = [Math.max(1, minCount)];
  if (needle) {
    conditions.push('(p.name LIKE ? OR CAST(p.id AS TEXT) LIKE ?)');
    args.push(`%${needle}%`, `%${needle}%`);
  }
  if (sharpOnly) {
    // 「有封面」= 存在一张够大够清晰的脸；cover_px 为 0 表示这个人只有糊脸/小脸
    conditions.push('p.cover_px >= ?');
    args.push(QUALITY_GATES.COVER_PX_MIN);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  return db
    .prepare(
      // count 是「人脸数」，photo_count 是「去重照片数」—— 一张合影里同一个人出现两次时两者不等，
      // 界面上必须分开写，否则「566 张人脸」会被读成「566 张照片，可我只看到 40 张」
      `SELECT p.id, p.name, p.count, p.cover_face_id, p.cover_px, COALESCE(f.quality, -1) AS cover_quality,
              f.image_id AS cover_image_id, COALESCE(p.cover_locked, 0) AS cover_locked,
              (SELECT COUNT(DISTINCT fi.image_id) FROM faces fi
                WHERE fi.person_id = p.id AND fi.hidden <> 1) AS photo_count
       FROM persons p LEFT JOIN faces f ON f.id = p.cover_face_id
       ${where} ORDER BY p.count DESC, p.id ASC LIMIT ? OFFSET ?`
    )
    .all(...args, Math.min(2000, Math.max(1, limit)), Math.max(0, offset))
    .map((r) => ({
      id: Number(r.id),
      name: String(r.name || ''),
      count: Number(r.count) || 0,
      photoCount: Number(r.photo_count) || 0,
      coverFaceId: r.cover_face_id == null ? null : Number(r.cover_face_id),
      /** 封面脸在哪张照片上：前端据此在人像照片墙上标出「当前封面」 */
      coverImageId: r.cover_image_id == null ? null : Number(r.cover_image_id),
      /** 用户手动指定过封面：按钮文案要从「设为封面」变成「正在用作封面」 */
      coverLocked: Number(r.cover_locked) === 1,
      coverPx: Number(r.cover_px) || 0,
      coverQuality: Number(r.cover_quality) || 0,
    }));
}

/** 统计符合当前筛选条件的人物总数（不受 limit 影响，前端据此提示列表被截断） */
export function countPersons({ minCount = 1, q = '', sharpOnly = false } = {}) {
  const needle = String(q || '').trim();
  const conditions = ['count >= ?'];
  /** @type {(string|number)[]} */
  const args = [Math.max(1, minCount)];
  if (needle) {
    conditions.push('(p.name LIKE ? OR CAST(p.id AS TEXT) LIKE ?)');
    args.push(`%${needle}%`, `%${needle}%`);
  }
  if (sharpOnly) {
    conditions.push('p.cover_px >= ?');
    args.push(QUALITY_GATES.COVER_PX_MIN);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM persons p LEFT JOIN faces f ON f.id = p.cover_face_id
       WHERE ${conditions.join(' AND ')}`
    )
    .get(...args);
  return Number(row?.c) || 0;
}

/** 封面不够格的人物数（没封面 / 封面脸太小）：界面据此提示被折叠的部分 */
export function countWeakCoverPersons() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM persons WHERE count >= 1 AND cover_px < ?').get(QUALITY_GATES.COVER_PX_MIN);
  return Number(row?.c) || 0;
}

/** 某人的所有图（按人脸质量排，同一张图多张脸只出一次；低质量脸不混进来） */
export function personImages(personId, { limit = 500, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT f.image_id, MAX(f.score) AS score, MAX(f.quality) AS quality, MIN(f.id) AS face_id
       FROM faces f WHERE f.person_id = ? AND f.hidden <> 1
       GROUP BY f.image_id ORDER BY quality DESC, score DESC, f.image_id DESC LIMIT ? OFFSET ?`
    )
    .all(Number(personId), Math.min(2000, Math.max(1, limit)), Math.max(0, offset))
    .map((r) => ({ imageId: Number(r.image_id), faceId: Number(r.face_id), score: Number(r.score) }));
}

/* -------------------------------- 编辑动作 -------------------------------- */

export function renamePerson(personId, name) {
  const clean = String(name || '').trim().slice(0, 60);
  const r = db.prepare('UPDATE persons SET name = ? WHERE id = ?').run(clean, Number(personId));
  if (!r.changes) throw new Error('人物不存在');
  return { ok: true, id: Number(personId), name: clean };
}

/**
 * 手动指定人物封面：用户在某张照片上点「设为封面」。
 *
 * 封面存的是**脸**的 id（/api/face/crop/:faceId 直接出裁切图），所以要先在这张照片里
 * 找到属于这个人的脸 —— 合影里可能有这个人两张脸，取质量最高的那张。
 * 选定后打上 cover_locked，后续扫描 / 清理 / 重建都不会再自动换掉，
 * 否则用户会看到「刚设的封面过一会儿自己变了」。
 */
export function setPersonCover(personId, imageId) {
  const pid = Number(personId);
  const iid = Number(imageId);
  if (!pid || !iid) throw new Error('需要人物与照片');
  const person = db.prepare('SELECT id FROM persons WHERE id = ?').get(pid);
  if (!person) throw new Error('人物不存在');
  const face = db
    .prepare(
      `SELECT f.id, ${FACE_PX_EXPR} AS px, f.quality, f.score
       FROM faces f JOIN images i ON i.id = f.image_id
       WHERE f.person_id = ? AND f.image_id = ? AND f.hidden <> 1
       ORDER BY f.quality DESC, f.score DESC LIMIT 1`
    )
    .get(pid, iid);
  if (!face) throw new Error('这张照片里没有这个人的人脸记录');
  const px = Number(face.px) || 0;
  db.prepare('UPDATE persons SET cover_face_id = ?, cover_px = ?, cover_locked = 1 WHERE id = ?').run(
    Number(face.id),
    px,
    pid
  );
  // 缓存同步：不更新的话，扫描线程仍按旧封面比较，重启前界面和库里会是两套数据
  const cached = personCache?.get(pid);
  if (cached) {
    cached.coverFaceId = Number(face.id);
    cached.coverPx = px;
    cached.coverQuality = Number(face.quality) || -1;
    cached.coverScore = coverRank({ quality: Number(face.quality), facePx: px, score: Number(face.score) });
    cached.coverLocked = true;
  }
  return { ok: true, id: pid, coverFaceId: Number(face.id), coverImageId: iid, coverPx: px, coverLocked: true };
}

/** 合并：把 fromId 的人脸全部改挂到 toId，然后按实际人脸重算 toId 的质心 */
export function mergePersons(fromId, toId) {
  const from = Number(fromId);
  const to = Number(toId);
  if (!from || !to || from === to) throw new Error('合并需要两个不同的人物');
  const exists = db.prepare('SELECT id FROM persons WHERE id = ?').get(to);
  if (!exists) throw new Error('目标人物不存在');
  let moved = 0;
  withTransaction(() => {
    const r = db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(to, from);
    moved = Number(r.changes) || 0;
    // 名字保留目标；源人物被合并后名字若无意义就一并清掉行
    db.prepare('DELETE FROM persons WHERE id = ?').run(from);
    personCache?.delete(from);
  });
  rebuildPerson(to);
  return { ok: true, moved };
}

/** 把一张脸移到指定人物（personId=null 则单独成新人物） */
export function reassignFace(faceId, personId) {
  const face = db.prepare('SELECT id, image_id, person_id, vec, score FROM faces WHERE id = ?').get(Number(faceId));
  if (!face) throw new Error('人脸记录不存在');
  const oldPerson = face.person_id == null ? null : Number(face.person_id);
  let target = personId == null ? null : Number(personId);
  withTransaction(() => {
    if (target == null) {
      const vec = new Float32Array(face.vec.buffer, face.vec.byteOffset, DIM);
      const r = db
        .prepare('INSERT INTO persons (name, count, centroid, cover_face_id, created_at) VALUES (?, 1, ?, ?, ?)')
        .run('', Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), Number(face.id), new Date().toISOString());
      target = Number(r.lastInsertRowid);
    }
    // 用户主动把低质量脸归到某个人 = 手动保留：清理任务不能再自动把它排除掉
    db.prepare('UPDATE faces SET person_id = ?, hidden = CASE WHEN hidden = 1 THEN 2 ELSE hidden END WHERE id = ?').run(
      target,
      Number(face.id)
    );
  });
  if (oldPerson) rebuildPerson(oldPerson);
  rebuildPerson(target);
  return { ok: true, personId: target };
}

/**
 * 手动保留 / 重新排除一张脸。
 * 灯箱里看到被自动排除的低质量脸，用户点「仍要收录」→ hidden=false（记为 2，清理任务不再覆盖）；
 * 点「排除」→ hidden=true（1）。两者都不删记录，随时可反悔。
 */
export function setFaceHidden(faceId, hidden) {
  const id = Number(faceId);
  const face = db.prepare('SELECT id, person_id FROM faces WHERE id = ?').get(id);
  if (!face) throw new Error('人脸记录不存在');
  db.prepare('UPDATE faces SET hidden = ? WHERE id = ?').run(hidden ? 1 : 2, id);
  const personId = face.person_id == null ? null : Number(face.person_id);
  if (personId) rebuildPerson(personId);
  return { ok: true, id, hidden: !!hidden };
}

/** 不是人脸 / 不想收录：删掉这条记录（并修正所属人物） */
export function deleteFace(faceId) {
  const face = db.prepare('SELECT id, person_id FROM faces WHERE id = ?').get(Number(faceId));
  if (!face) throw new Error('人脸记录不存在');
  const personId = face.person_id == null ? null : Number(face.person_id);
  db.prepare('DELETE FROM faces WHERE id = ?').run(Number(face.id));
  if (personId) rebuildPerson(personId);
  return { ok: true };
}

/** 删除整个「人物」：他名下的所有人脸记录一并清掉，图片本身不动 */
export function deletePerson(personId) {
  const id = Number(personId);
  let removedFaces = 0;
  withTransaction(() => {
    const r = db.prepare('DELETE FROM faces WHERE person_id = ?').run(id);
    removedFaces = Number(r.changes) || 0;
    db.prepare('DELETE FROM persons WHERE id = ?').run(id);
  });
  personCache?.delete(id);
  return { ok: true, removedFaces };
}

/** 清空全部人脸数据（保留图片），用于换模型或彻底重来 */
export function resetFaces() {
  withTransaction(() => {
    db.exec('DELETE FROM faces');
    db.exec('DELETE FROM persons');
    db.exec('UPDATE images SET face_scanned = 0');
  });
  personCache = null;
  return { ok: true };
}

/** 人脸裁切图（百分比框 → 当前原图尺寸），带 25% 外扩以便看清五官 */
export async function faceCrop(faceId, size = 192) {
  const row = db
    .prepare('SELECT f.x1, f.y1, f.x2, f.y2, i.abs_path FROM faces f JOIN images i ON i.id = f.image_id WHERE f.id = ?')
    .get(Number(faceId));
  if (!row) throw new Error('人脸记录不存在');
  const px = Math.max(32, Math.min(512, Number(size) || 192));
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const swap = Number(meta.orientation) >= 5;
  const W = swap ? Number(meta.height) : Number(meta.width);
  const H = swap ? Number(meta.width) : Number(meta.height);
  if (!W || !H) throw new Error('无法读取图片尺寸');

  const padX = (row.x2 - row.x1) * 0.25;
  const padY = (row.y2 - row.y1) * 0.25;
  const l = Math.max(0, Math.round((row.x1 - padX) * W));
  const t = Math.max(0, Math.round((row.y1 - padY) * H));
  const r = Math.min(W, Math.round((row.x2 + padX) * W));
  const b = Math.min(H, Math.round((row.y2 + padY) * H));
  const width = Math.max(1, r - l);
  const height = Math.max(1, b - t);
  return sharp(row.abs_path, { failOn: 'none' })
    .rotate()
    .extract({ left: l, top: t, width, height })
    .resize(px, px, { fit: 'cover' })
    .jpeg({ quality: 86 })
    .toBuffer();
}
