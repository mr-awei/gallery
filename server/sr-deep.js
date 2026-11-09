/**
 * 第二档超分：Transformer 系（Swin2SR，SwinIR 的后续工作）。
 * 走 transformers.js（项目已装，底层 ONNX Runtime），模型来自 HuggingFace。
 * 定位「高画质（慢）」：细节重建比 ESRGAN/CUGAN 更自然，但 CPU 上单张约十秒级。
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pipeline, env } from '@huggingface/transformers';
import sharp from 'sharp';
import { MODEL_CACHE_DIR } from './config.js';

// 模型缓存放可写目录：打包版代码在只读 asar 内，指向 asar 会导致首次下载必挂
env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;
env.remoteHost = process.env.CLIP_HUB_HOST || 'https://hf-mirror.com';

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

/** 模型是否已下载到本地缓存（避免 UI 显示不确定状态）。.onnx 太小视为半截损坏文件 */
function modelCached(repo) {
  try {
    const dir = path.join(env.cacheDir, repo);
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
 * 运行库可用性：包本体由顶层 import 保证存在，真正会挂的是 onnxruntime-node
 * 的原生绑定（asar 没解包 / 平台包缺失时会抛）。
 * 以前这个档位在界面上无条件标成「可用」，用户点了才在 pipeline() 里报错。
 */
let runtimeStatus = null;
export function srRuntimeStatus() {
  if (runtimeStatus) return runtimeStatus;
  try {
    const req = createRequire(import.meta.url);
    const ort = req('onnxruntime-node');
    runtimeStatus = {
      ok: true,
      version: String(ort?.env?.versions?.onnx || ort?.version || 'ok'),
    };
  } catch (err) {
    runtimeStatus = { ok: false, error: err?.message || String(err) };
  }
  return runtimeStatus;
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
  state.loading = model.repo;
  state.progress = 0;
  state.message = '准备下载…';
  state.error = '';
  try {
    const pipe = await pipeline('image-to-image', model.repo, {
      progress_callback: (p) => {
        if (typeof p?.progress === 'number') {
          state.progress = Math.min(100, Math.round(p.progress));
          state.message = p.file ? `下载中 ${state.progress}%（${p.file}）` : `下载中 ${state.progress}%`;
        }
      },
    });
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
