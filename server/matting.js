/**
 * AI 去背景：U-2-Net 人像分割（ONNX，仅 ~4.5MB），纯本地推理。
 * 复用项目已装的 ONNX Runtime（transformers.js 的底层依赖），不新增重型依赖。
 * 输出带透明通道的 PNG（保留原分辨率），作为新图入库，原图不动。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR } from './config.js';
import { downloadModelFile, verifyModelFileDetailed, KNOWN_SHA256, isPinned } from './model-fetch.js';
import { createJob, finishJob, jobProgress } from './jobs.js';

const AI_DIR = path.join(DATA_DIR, 'ai');
const DIR = path.join(AI_DIR, 'matting');
const MODEL_FILE = path.join(DIR, 'model.onnx');
const CONFIG_FILE = path.join(DIR, 'preprocessor_config.json');
const REPO = 'sunseeker001/U-2-Net-Human-Seg';
const MIRRORS = ['https://hf-mirror.com/', 'https://huggingface.co/'];
const fileUrls = (p) => MIRRORS.map((m) => `${m}${REPO}/resolve/main/${p}`);
const MODEL_KEY = `${REPO}/onnx/model.onnx`;

let sessionPromise = null;
/** 下载中止信号：以前模型装到一半只能干等，没法取消 */
let installAbort = null;
const state = { downloading: false, progress: 0, message: '', error: '', cancelled: false };

export function mattingStatus() {
  return {
    downloaded: fs.existsSync(MODEL_FILE) && fs.statSync(MODEL_FILE).size > 1024 * 1024,
    downloading: state.downloading,
    progress: state.progress,
    message: state.message,
    error: state.error,
    cancelled: state.cancelled,
    model: REPO,
    size: fs.existsSync(MODEL_FILE) ? fs.statSync(MODEL_FILE).size : 0,
    /**
     * true = 与 KNOWN_SHA256 里的固定哈希对上（可信）；
     * false = 只是和本机上次下载记录的 sidecar 一致，不能对外宣称「校验通过」。
     */
    verified: isPinned(MODEL_KEY),
  };
}

/** 取消正在进行的模型下载（任务中心/设置页的「取消」都走这里） */
export function cancelMattingInstall() {
  if (!state.downloading || !installAbort) return false;
  state.message = '正在取消…';
  try {
    installAbort.abort(new Error('用户取消下载'));
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * 后台安装模型：立刻返回，进度走 mattingStatus() 轮询。
 * 以前这个 HTTP 请求要等整包下完才返回，浏览器里点一下能转圈几分钟，
 * 中途想取消只能去关应用。
 */
export function startMattingInstall() {
  if (state.downloading) return { ok: true, started: false, ...mattingStatus() };
  installMatting().catch((err) => {
    console.warn('[matting] 模型安装失败：', err?.message || err);
  });
  return { ok: true, started: true, ...mattingStatus() };
}

export async function installMatting() {
  if (state.downloading) throw new Error('正在下载中，请稍候');
  state.downloading = true;
  state.progress = 0;
  state.error = '';
  state.cancelled = false;
  state.message = '准备下载…';
  installAbort = new AbortController();
  const signal = installAbort.signal;
  const jobId = createJob({ kind: 'model-install', title: '去背景模型（U-2-Net）', payload: { model: 'matting' } });
  try {
    await downloadModelFile({
      mirrors: fileUrls('preprocessor_config.json'),
      repoPath: 'preprocessor_config.json',
      dest: CONFIG_FILE,
      minBytes: 16,
      maxBytes: 1024 * 1024,
      signal,
      onProgress: (p) => {
        state.progress = Math.round(p * 8);
        state.message = `下载配置 ${Math.round(p * 100)}%`;
        jobProgress(jobId, { progress: state.progress, message: state.message });
      },
    });
    state.message = '下载模型（约 4.5MB）…';
    await downloadModelFile({
      mirrors: fileUrls('onnx/model.onnx'),
      repoPath: 'onnx/model.onnx',
      dest: MODEL_FILE,
      minBytes: 1024 * 1024,
      maxBytes: 64 * 1024 * 1024,
      sha256: KNOWN_SHA256[MODEL_KEY] || '',
      signal,
      onProgress: (p) => {
        state.progress = 8 + Math.round(p * 90);
        state.message = `下载模型 ${Math.round(p * 100)}%（约 4.5MB）`;
        jobProgress(jobId, { progress: state.progress, message: state.message });
      },
    });
    const check = await verifyModelFileDetailed(MODEL_FILE, {
      minBytes: 1024 * 1024,
      sha256: KNOWN_SHA256[MODEL_KEY] || '',
    });
    if (!check.ok) throw new Error(`模型文件校验未通过（${check.reason || '哈希不匹配'}），请重试安装`);
    state.progress = 100;
    // 没有可信清单时如实说明，别让用户以为「校验通过」了
    state.message = check.verified ? '下载完成（已比对可信哈希）' : '下载完成（已记录哈希，未与清单比对）';
    sessionPromise = null; // 让下次调用重新加载
    finishJob(jobId, { status: 'done', result: { verified: check.verified } });
    return mattingStatus();
  } catch (err) {
    const cancelled = /已取消/.test(String(err?.message || ''));
    state.cancelled = cancelled;
    state.error = cancelled ? '' : String(err?.message || err).slice(0, 200);
    state.message = cancelled ? '已取消下载' : state.message;
    // 清掉坏文件，避免「已下载」假状态卡住 UI
    await fsp.rm(MODEL_FILE, { force: true }).catch(() => {});
    finishJob(jobId, { status: cancelled ? 'canceled' : 'failed', error: state.error });
    throw err;
  } finally {
    state.downloading = false;
    installAbort = null;
  }
}

/** 读取预处理配置（失败则用常见的 ImageNet 归一化兜底） */
function preprocess() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* ignore */
  }
  const size = cfg.size?.height || cfg.size?.width || 320;
  const mean = cfg.image_mean || cfg.mean || [0.485, 0.456, 0.406];
  const std = cfg.image_std || cfg.std || [0.229, 0.224, 0.225];
  return { size, mean, std };
}

async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    if (!fs.existsSync(MODEL_FILE)) throw new Error('去背景模型未下载，请先到「设置」下载（约 4.5MB）');
    const ort = await import('onnxruntime-node');
    const sess = await ort.InferenceSession.create(MODEL_FILE);
    return sess;
  })().catch((err) => {
    sessionPromise = null;
    throw err;
  });
  return sessionPromise;
}

/**
 * 生成抠图结果：返回 { buffer, width, height }
 * 流程：缩到模型尺寸 → 归一化 → ONNX 推理 → 取 alpha → 放大回原尺寸 → 与原图合成 RGBA PNG
 */
export async function removeBackgroundBuffer(inputPath) {
  const sess = await getSession();
  const { size, mean, std } = preprocess();
  const meta = await sharp(inputPath, { failOn: 'none' }).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error('无法读取图片尺寸');

  // 预处理：resize 到模型输入尺寸，输出 RGB 归一化浮点
  const raw = await sharp(inputPath, { failOn: 'none' })
    .removeAlpha()
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer();
  const chw = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++) {
    const r = raw[i * 3] / 255;
    const g = raw[i * 3 + 1] / 255;
    const b = raw[i * 3 + 2] / 255;
    chw[i] = (r - mean[0]) / std[0];
    chw[size * size + i] = (g - mean[1]) / std[1];
    chw[2 * size * size + i] = (b - mean[2]) / std[2];
  }
  const ort = await import('onnxruntime-node');
  const inputName = sess.inputNames[0];
  const tensor = new ort.Tensor('float32', chw, [1, 3, size, size]);
  const out = await sess.run({ [inputName]: tensor });

  // 找到 [1,1,H,W] 或 [1,2,H,W] 的输出作为 mask
  let mask = null;
  for (const name of sess.outputNames) {
    const t = out[name];
    const d = t.dims;
    if (d.length === 4 && d[0] === 1) {
      const data = t.data;
      const c = d[1];
      const h = d[2];
      const w = d[3];
      const m = new Float32Array(h * w);
      if (c === 1) {
        for (let i = 0; i < h * w; i++) m[i] = data[i];
        mask = { m, w, h };
        break;
      }
      if (c === 2) {
        // 二分类：取「前景」通道（用 softmax 后的概率）
        for (let i = 0; i < h * w; i++) {
          const a = Math.exp(data[i]);
          const b = Math.exp(data[h * w + i]);
          m[i] = b / (a + b);
        }
        mask = { m, w, h };
        break;
      }
    }
  }
  if (!mask) throw new Error('模型输出无法识别为遮罩');

  // mask → 灰度图 → 放大到原尺寸 → 作为 alpha 通道
  const maskBuf = Buffer.alloc(mask.w * mask.h);
  let covered = 0;
  for (let i = 0; i < mask.m.length; i++) {
    const v = Math.max(0, Math.min(1, mask.m[i]));
    maskBuf[i] = Math.round(v * 255);
    if (v > 0.5) covered++;
  }
  // alpha 在低分辨率上先羽化再放大：边缘会有 2~3px 的柔和过渡带。
  // 直接最近邻/硬边放大后，抠出来的图贴到别的背景上会有一圈锯齿（尤其头发与肩线）。
  const alphaPng = await sharp(maskBuf, { raw: { width: mask.w, height: mask.h, channels: 1 } })
    .blur(1)
    .resize(W, H, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const alphaRaw = await sharp(alphaPng).ensureAlpha().raw().toBuffer();
  const alpha = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = alphaRaw[i * 4]; // 取 R 通道（灰阶）

  const base = await sharp(inputPath, { failOn: 'none' }).removeAlpha().resize(W, H).raw().toBuffer();
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = base[i * 3];
    rgba[i * 4 + 1] = base[i * 3 + 1];
    rgba[i * 4 + 2] = base[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  const buffer = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  // 前景区占比：模型是**人像分割**，纯风景/物体常常抠出整片或一片空白。
  // 与其静默给出一张废图，不如把可疑度带回去让界面提示重试。
  const coverage = mask.w * mask.h ? covered / (mask.w * mask.h) : 0;
  const warning =
    coverage < 0.015
      ? '几乎没抠出主体（这张图可能不是人像，或主体与背景接近）'
      : coverage > 0.97
        ? '整张图都被当成主体（该模型是人像分割，对纯风景/物体基本无效）'
        : '';
  return { buffer, width: W, height: H, coverage: +coverage.toFixed(4), warning };
}
