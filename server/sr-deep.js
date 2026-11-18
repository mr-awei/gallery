/**
 * 第二档超分：Transformer 系（Swin2SR，SwinIR 的后续工作）。
 * 走 transformers.js（项目已装，底层 ONNX Runtime），模型来自 HuggingFace。
 * 定位「高画质（慢）」：细节重建比 ESRGAN/CUGAN 更自然，但 CPU 上单张约十秒级。
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { MODEL_CACHE_DIR } from './config.js';
import { withDevicePreference } from './lib/onnx-device.js';

/**
 * 懒加载 @huggingface/transformers。
 *
 * 为什么不在顶层 import：ESM 顶层 import 在模块加载时立即执行，会触发 onnxruntime-node
 * 的原生二进制链式加载（onnxruntime_binding.node → onnxruntime.dll → DirectML.dll）。
 * 用户机器缺 VC++ Runtime 或杀毒软件拦截 DLL 时，异常在 ESM import 层面抛出，整个
 * app.js 加载失败 → 服务进程直接崩溃 → 主进程弹「本服务没能启动」。
 * 动态 import 是运行时行为，可以被 try-catch 捕获；只有真正用到 SR 功能时才加载。
 */
let transformersPromise = null;
async function getTransformers() {
  if (!transformersPromise) {
    transformersPromise = (async () => {
      const mod = await import('@huggingface/transformers');
      mod.env.cacheDir = MODEL_CACHE_DIR;
      mod.env.allowLocalModels = false;
      mod.env.remoteHost = process.env.CLIP_HUB_HOST || 'https://hf-mirror.com';
      return mod;
    })();
  }
  return transformersPromise;
}

/** 可用模型（x2/x4；48/64 为训练窗口大小） */
export const SR_MODELS = [
  {
    id: 'onnx:swin2SR-compressed-sr-x4-48',
    repo: 'Xenova/swin2SR-compressed-sr-x4-48',
    label: 'Swin2SR · 压缩修复 x4',
    desc: '专治 JPEG 压缩噪点/模糊，网络图首选',
    scale: 4,
  },
  {
    id: 'onnx:swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    repo: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    label: 'Swin2SR · 真实世界 x4',
    desc: '真实照片通用，细节重建强',
    scale: 4,
  },
  {
    id: 'onnx:swin2SR-classical-sr-x2-64',
    repo: 'Xenova/swin2SR-classical-sr-x2-64',
    label: 'Swin2SR · 经典 x2',
    desc: '干净素材 2 倍放大，质量最稳',
    scale: 2,
  },
  {
    id: 'onnx:swin2SR-lightweight-x2-64',
    repo: 'Xenova/swin2SR-lightweight-x2-64',
    label: 'Swin2SR · 轻量 x2（较快）',
    desc: '体积最小、速度最快的一档',
    scale: 2,
  },
];

/** 输入像素上限：超分注意力对显存/内存敏感，过大的图先缩下来再放大回去 */
const MAX_INPUT_PIXELS = 700_000;

export function srModelOf(modelId) {
  return SR_MODELS.find((m) => m.id === modelId) || null;
}

const pipes = new Map(); // repo -> pipeline
const state = { loading: '', progress: 0, message: '', error: '' };

/** 下载中心用：模型在 HF 缓存里的落地目录（同一份拼法，别另抄） */
export function srCacheDir(modelId) {
  const m = srModelOf(modelId);
  return m ? path.join(MODEL_CACHE_DIR, m.repo) : '';
}

/** 删除权重并释放已加载的 pipeline（Windows 上句柄不放就删不掉） */
export async function removeSrModel(modelId) {
  const m = srModelOf(modelId);
  if (!m) throw new Error('未知的模型');
  if (state.loading === modelId) throw new Error('该模型正在加载/下载，请稍后再试');
  const pipe = pipes.get(m.repo);
  if (pipe) {
    pipes.delete(m.repo);
    try {
      await pipe.dispose?.();
    } catch {
      /* 老版本没有 dispose；文件删不动时下面的报错会如实反馈 */
    }
  }
  await fsp.rm(path.join(MODEL_CACHE_DIR, m.repo), { recursive: true, force: true });
  return srStatus();
}

/** 模型是否已下载到本地缓存（避免 UI 显示不确定状态）。.onnx 太小视为半截损坏文件 */
function modelCached(repo) {
  try {
    const dir = path.join(MODEL_CACHE_DIR, repo);
    if (!fs.existsSync(dir)) return false;
    return fs
      .readdirSync(dir, { recursive: true })
      .some((f) => {
        const name = String(f);
        if (!name.endsWith('.onnx')) return false;
        try {
          return fs.statSync(path.join(dir, name)).size > 512 * 1024;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/**
 * 运行库可用性：**懒探针**，不启动时就碰 onnxruntime。
 * 以前在启动阶段（或 SR 功能第一次被请求时）立刻 `require('onnxruntime-node')` ——
 * 用户机器缺 VC++ Runtime 或杀毒软件拦截 DLL 时，这个同步 require 会让整个服务
 * 进程崩溃。现在缓存占位状态，真正调用 SR 时才探针；前端查询状态看到 ok: true 只是
 * 「还没试」，不代表一定能用。
 */
let runtimeProbed = false;
let runtimeCache = { ok: true, lazy: true };
export function srRuntimeStatus() {
  if (!runtimeProbed) return runtimeCache;
  return runtimeCache;
}

/** 真正跑推理前的强制探针（失败会 reject，上层 catch 住后 SR 功能显示不可用） */
async function ensureRuntime() {
  if (runtimeProbed) return runtimeCache;
  runtimeProbed = true;
  const { createRequire } = require('node:module');
  const req = createRequire(import.meta.url);
  try {
    const ort = req('onnxruntime-node');
    runtimeCache = { ok: true, version: String(ort?.env?.versions?.onnx || ort?.version || 'ok') };
  } catch (err) {
    runtimeCache = { ok: false, error: err?.message || String(err) };
  }
  return runtimeCache;
}

export function srStatus() {
  const runtime = srRuntimeStatus();
  return {
    loading: state.loading,
    progress: state.progress,
    message: state.message,
    error: state.error,
    runtime,
    models: SR_MODELS.map((m) => ({
      ...m,
      downloaded: modelCached(m.repo),
      loaded: pipes.has(m.repo),
      // 运行库不可用时不能标成可用，否则用户点下去才看到一串原生模块报错
      available: runtime.ok,
      unavailableReason: runtime.ok ? '' : runtime.error,
    })),
  };
}

/**
 * 后台加载 / 预热：立刻返回，进度走 job 心跳（sr 帧）。
 * 以前接口同步等整个下载（几百 MB），前端 20s 超时弹「请求超时」，
 * 用户以为失败了，其实下载还在后台继续——提示与事实相反，比没有提示更糟。
 */
export function startSrLoad(modelId) {
  const model = srModelOf(modelId);
  if (!model) return { ok: false, error: '未知的超分模型' };
  if (pipes.has(model.repo)) return { ok: true, ...srStatus() };
  if (state.loading) return { ok: true, busy: true, ...srStatus() };
  // 先同步置「加载中」：保证响应第一帧就带 loading，前端立刻进进度显示
  state.loading = model.repo;
  state.progress = 0;
  state.message = '准备下载…';
  state.error = '';
  loadSrModel(modelId).catch((err) =>
    console.error('[sr] 模型下载失败', model.repo, err?.message || err, err?.cause?.code || '')
  );
  return { ok: true, ...srStatus() };
}

/** 加载 / 预热某个模型（首次会下载，带进度） */
export async function loadSrModel(modelId) {
  const model = srModelOf(modelId);
  if (!model) throw new Error('未知的超分模型');
  if (pipes.has(model.repo)) return srStatus();
  // 启动时不碰 onnxruntime，真正加载模型前才探针（缺 VC++ Runtime 的机器在这里被 catch）
  const rt = await ensureRuntime();
  if (!rt.ok) throw new Error(`onnxruntime 不可用：${rt.error}`);
  state.loading = model.repo;
  state.progress = 0;
  state.message = '准备下载…';
  state.error = '';
  try {
    // transformers 也懒加载：只在真正用到时才触发 native 依赖链
    const { pipeline: tfPipeline } = await getTransformers();
    // Swin2SR 是这一档最慢的环节，能从 CPU 挪到显卡就挪（DirectML / CUDA，失败自动回退）
    const pipe = await withDevicePreference(
      (device) =>
        tfPipeline('image-to-image', model.repo, {
          device,
          progress_callback: (p) => {
            if (typeof p?.progress === 'number') {
              state.progress = Math.min(100, Math.round(p.progress));
              state.message = p.file ? `下载中 ${state.progress}%（${p.file}）` : `下载中 ${state.progress}%`;
            }
          },
        }),
      `Swin2SR ${model.repo}`
    );
    pipes.set(model.repo, pipe);
    state.message = '已就绪';
  } catch (err) {
    state.error = String(err?.message || err).slice(0, 300);
    throw err;
  } finally {
    state.loading = '';
    state.progress = 100;
  }
  return srStatus();
}

/**
 * 用 Transformer 模型超分一张图，输出 PNG 到 outputPath。
 * 返回输出尺寸；超大图先等比缩小再放大（结果分辨率仍会贴合目标标准）。
 *
 * onProgress(p, info)：transformers.js 的 image-to-image pipeline **不给推理中间进度**，
 * 过去这里硬报 0.3 / 0.85，界面上「30%」能卡十几秒，纯属编的。
 * 现在：准备阶段报 0，推理阶段报 `{ indeterminate: true }` 让界面显示「推理中」，
 * 结束才报 1。宁可说「不知道」，也不要给假百分比。
 */
export async function runSr({ repo, inputPath, outputPath, onProgress }) {
  let pipe = pipes.get(repo);
  if (!pipe) {
    const model = SR_MODELS.find((m) => m.repo === repo);
    await loadSrModel(model ? model.id : SR_MODELS[0].id);
    pipe = pipes.get(repo);
  }
  const meta = await sharp(inputPath, { failOn: 'none' }).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  let src = inputPath;
  let tmpDown = null;
  if (w * h > MAX_INPUT_PIXELS) {
    const k = Math.sqrt(MAX_INPUT_PIXELS / (w * h));
    tmpDown = `${inputPath}.sr-in.png`;
    await sharp(inputPath, { failOn: 'none' })
      .resize(Math.max(64, Math.round(w * k)), Math.max(64, Math.round(h * k)), { kernel: 'lanczos3' })
      .png()
      .toFile(tmpDown);
    src = tmpDown;
  }
  try {
    onProgress?.(0, { phase: 'prepare' });
    const data = await sharp(src).removeAlpha().png().toBuffer();
    onProgress?.(0, { phase: 'inference', indeterminate: true });
    const out = await pipe(new Blob([data]));
    onProgress?.(0.99, { phase: 'encode' });
    const buf = await sharp(out.data, {
      raw: { width: out.width, height: out.height, channels: out.channels },
    })
      .removeAlpha()
      .png()
      .toBuffer();
    await sharp(buf).toFile(outputPath);
    onProgress?.(1);
    return { width: out.width, height: out.height };
  } finally {
    if (tmpDown) await fs.promises.rm(tmpDown, { force: true }).catch(() => {});
  }
}
