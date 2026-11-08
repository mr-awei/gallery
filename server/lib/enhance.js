// 画质增强：内置模型清单、标准档位判定、本地/AI 超分调用、线上增强服务与连通性测试（从 library.js 拆出）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { db, getSettings } from '../db.js';
import { httpFetch } from '../http.js';
import { invalidateQuality } from '../quality.js';
import { removeThumbFiles } from '../thumbs.js';
import { pushEditBackup } from './undo.js';
import { aiModelOf, communityModelOf, cuganInstalled, isAiModel, isCommunityModel, listCuganModels, runUpscale } from '../ai-upscale.js';
import { runSr, srModelOf } from '../sr-deep.js';
import { computePHash } from '../phash.js';
import * as clip from '../clip.js';
import { getImage, indexPhash, removeFileRetry, toDTO, translateError, writeFileAtomic } from '../library.js';


/** 内置增强模型：全部基于 sharp 的插值 + 锐化，离线可用、无外部依赖。
 *  放大倍数按「目标标准」动态计算，保证增强后达到标准以上；
 *  模型只决定插值核与锐化风格，maxScale 为安全上限（防极端小图爆内存）。
 *
 *  必须标明这是**插值放大**：像素变多但不会合成新细节，和 AI 超分是两件事。
 *  以前四档都叫「标准增强 / 细节强化」，用户以为是 AI 模型，放大后觉得「糊还是糊」。 */
export const ENHANCE_MODELS = [
  { id: 'sharp-standard', label: '标准增强', desc: '通用清晰放大，保留细节，适合大多数照片', engine: 'resample', engineLabel: '插值放大（非 AI 超分）', kernel: 'lanczos3', sharpen: 0.6, blur: 0, maxScale: 16 },
  { id: 'sharp-anime', label: '二次元增强', desc: '保边去糊，线条更利落，适合插画/写真', engine: 'resample', engineLabel: '插值放大（非 AI 超分）', kernel: 'lanczos3', sharpen: 1.0, blur: 0, maxScale: 16 },
  { id: 'sharp-soft', label: '柔和增强', desc: '照片风，抑制噪点与锯齿，过渡更平滑', engine: 'resample', engineLabel: '插值放大（非 AI 超分）', kernel: 'cubic', sharpen: 0.2, blur: 0.5, maxScale: 16 },
  { id: 'sharp-detail', label: '细节强化', desc: '锐度更强，观感更锐利（可能略显生硬）', engine: 'resample', engineLabel: '插值放大（非 AI 超分）', kernel: 'lanczos3', sharpen: 1.4, blur: 0, maxScale: 16 },
];

/** 增强后输出的像素上限，避免极端小图放大到几十亿像素导致内存爆掉 */
const MAX_OUTPUT_PIXELS = 50_000_000;

/**
 * 「已达标、未做任何改动」的统一返回：带上 noop 标记。
 * 以前这里直接返回 toDTO(row)，调用方分不清「真的放大了」和「什么都没做」，
 * 前端就会弹「已增强至 1920×1080」而画面毫无变化；批量任务还把它算成成功。
 * 标记只用于调用方判断，路由会剥掉，不进 ImageItem。
 */
function unchangedResult(row) {
  return { ...toDTO(row), noop: true };
}

/** 标准预设：键 -> 目标分辨率（宽 × 高）。低于该尺寸的图片视为「待增强」 */
export const ENHANCE_STANDARDS = {
  '480p': { width: 854, height: 480, label: '480P（854×480）' },
  '720p': { width: 1280, height: 720, label: '720P（1280×720）' },
  '1080p': { width: 1920, height: 1080, label: '1080P（1920×1080）' },
  '2k': { width: 2560, height: 1440, label: '2K（2560×1440）' },
  '4k': { width: 3840, height: 2160, label: '4K（3840×2160）' },
  custom: { width: 0, height: 0, label: '自定义' },
};

export function getStandardResolution(standardKey, enhanceCfg = {}) {
  const key = ENHANCE_STANDARDS[standardKey] ? standardKey : '1080p';
  if (key === 'custom') {
    return {
      width: Number(enhanceCfg.customWidth) || 1920,
      height: Number(enhanceCfg.customHeight) || 1080,
    };
  }
  return { width: ENHANCE_STANDARDS[key].width, height: ENHANCE_STANDARDS[key].height };
}

/** 低于标准的图片总数 */
export function countBelowStandard(standardKey) {
  const target = getStandardResolution(standardKey, getSettings().enhance || {});
  return db.prepare('SELECT COUNT(*) AS c FROM images WHERE width < ? OR height < ?').get(target.width, target.height).c;
}

/** 低于标准的图片（自动收录），升序排列（最小的优先处理） */
export function listBelowStandard(standardKey, limit = 1200) {
  const target = getStandardResolution(standardKey, getSettings().enhance || {});
  const rows = db
    .prepare('SELECT * FROM images WHERE width < ? OR height < ? ORDER BY width * height ASC LIMIT ?')
    .all(target.width, target.height, limit);
  return rows.map(toDTO);
}

/**
 * 本地增强：按目标标准动态放大，锐化后写回原文件（与 rotateImage 一样覆盖原图）。
 * 其他软件打开即为增强后的效果；同步更新宽高 / 大小 / pHash / 缩略图。
 */
/** 画质增强（对外入口）：统一把底层报错翻译成可读提示 */
export async function enhanceImage(id, modelId, opts = {}) {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  try {
    return await enhanceImageInner(id, modelId, opts);
  } catch (err) {
    throw translateError(err, row.abs_path);
  }
}

/**
 * 把库记录与磁盘文件重新同步（文件被手动替换 / 修改后调用）：
 * 更新宽高、体积、pHash，重建深度特征与清晰度缓存，并删除过期缩略图。
 * @returns 是否发生过变化
 */
export async function resyncImageMeta(id) {
  const row = getImage(id);
  if (!row || !row.abs_path || !fs.existsSync(row.abs_path)) return false;
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const stat = fs.statSync(row.abs_path);
  const unchanged =
    meta.width === row.width && meta.height === row.height && stat.size === row.size_bytes;
  if (unchanged) return false;
  const phash = await computePHash(row.abs_path).catch(() => '');
  // fs_mtime 同步更新：列表 API 拿它当缩略图/原图 URL 的缓存版本号，
  // 不更新的话文件被替换后浏览器会一直用旧缓存
  db.prepare(
    'UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ?, fs_mtime = ? WHERE id = ?'
  ).run(meta.width || 0, meta.height || 0, stat.size, phash, Math.round(stat.mtimeMs / 1000), id);
  if (phash) indexPhash(id, phash);
  if (clip.clipReady()) clip.reembed(id, row.abs_path);
  invalidateQuality(id);
  await removeThumbFiles(id, row.thumb);
  return true;
}

async function enhanceImageInner(id, modelId, opts = {}) {
  // 磁盘文件可能被手动替换过：先与库记录同步，否则会用旧尺寸误判「已达标」
  await resyncImageMeta(id);
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在（可能已被移动或删除）');

  const settings = getSettings();
  const target = getStandardResolution(
    opts.standard || settings.enhance?.standard || '1080p',
    settings.enhance || {}
  );

  // 真·AI 超分走独立分支：内置 Real-ESRGAN / 社区 ESRGAN 模型 / Real-CUGAN / Transformer（Swin2SR）
  const isAiUpscale =
    isAiModel(modelId) ||
    isCommunityModel(modelId) ||
    String(modelId || '').startsWith('cugan:') ||
    String(modelId || '').startsWith('onnx:');
  if (String(modelId || '').startsWith('onnx:')) {
    return enhanceImageTransformer(id, row, target, modelId, opts.onProgress);
  }
  if (isAiUpscale) return enhanceImageAi(id, row, target, modelId, opts.onProgress);

  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';
  const curW = meta.width || row.width;
  const curH = meta.height || row.height;

  const model = ENHANCE_MODELS.find((m) => m.id === modelId) || ENHANCE_MODELS[0];
  // 放大到「刚好达到标准」所需的倍数，并受输出像素上限与模型上限约束
  const needed = Math.max(target.width / (curW || 1), target.height / (curH || 1));
  const maxByPixels = Math.sqrt(MAX_OUTPUT_PIXELS / Math.max(1, curW * curH));
  const scale = Math.min(needed, maxByPixels, model.maxScale || 8);
  if (scale <= 1.001) return unchangedResult(row); // 已达标，无需增强（noop 让前端如实提示）

  const newW = Math.round(curW * scale);
  const newH = Math.round(curH * scale);
  let pipeline = sharp(row.abs_path, { failOn: 'none' }).resize(newW, newH, { kernel: model.kernel });
  if (model.sharpen) pipeline = pipeline.sharpen({ sigma: model.sharpen, m1: 0.5, m2: 0.2 });
  if (model.blur) pipeline = pipeline.blur(model.blur);
  if (format === 'png') pipeline = pipeline.png();
  else if (format === 'webp') pipeline = pipeline.webp({ quality: 92 });
  else pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return await writeEnhancedBuffer(id, row, data, info);
}

/**
 * Transformer 系超分（Swin2SR）：重建更自然、伪影更少，但比 ESRGAN/CUGAN 慢一个量级。
 * 流程：Swin2SR 放大 → sharp 精确贴合到「刚好达到标准」→ 覆盖原文件。
 */
async function enhanceImageTransformer(id, row, target, modelId, onProgress) {
  const model = srModelOf(modelId);
  if (!model) throw new Error('未指定 Transformer 超分模型');
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';
  const curW = meta.width || row.width;
  const curH = meta.height || row.height;

  const needed = Math.max(target.width / (curW || 1), target.height / (curH || 1));
  if (needed <= 1.001) return unchangedResult(row);

  const tmpOut = `${row.abs_path}.sr-out.png`;
  try {
    const { width, height } = await runSr({ repo: model.repo, inputPath: row.abs_path, outputPath: tmpOut, onProgress });
    const f = Math.max(target.width / width, target.height / height);
    let pipeline = sharp(tmpOut, { failOn: 'none' });
    if (Math.abs(f - 1) > 0.01) {
      pipeline = pipeline.resize(Math.max(1, Math.round(width * f)), Math.max(1, Math.round(height * f)), {
        kernel: 'lanczos3',
      });
    }
    if (format === 'png') pipeline = pipeline.png();
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 92 });
    else pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return await writeEnhancedBuffer(id, row, data, info);
  } finally {
    // 清理失败只记日志：掩盖掉真正的超分错误会让问题完全没法排查
    try {
      await removeFileRetry(tmpOut);
    } catch (err) {
      console.warn('[enhance] 清理临时文件失败：', err?.message || err);
    }
  }
}

/** 解析模型标识：esrgan:<社区模型名> / cugan:<模型名> / 内置 ai-realesrgan-* */
function parseAiModel(modelId) {
  if (isCommunityModel(modelId)) {
    const m = communityModelOf(modelId);
    return { engine: 'realesrgan', name: m.name, scalable: false, maxScale: m.scale };
  }
  if (String(modelId).startsWith('cugan:')) {
    const name = String(modelId).slice(6);
    return { engine: 'realcugan', name, scalable: false, maxScale: 4 };
  }
  const builtin = aiModelOf(modelId);
  return { engine: 'realesrgan', name: builtin.name, scalable: builtin.scalable, maxScale: builtin.maxScale || 4 };
}

/** 压缩噪点 / 低质图的判据：每像素字节数越低，说明 JPEG 压缩越狠、噪点越重 */
function isNoisyImage(row, curW, curH) {
  const px = Math.max(1, (curW || row.width) * (curH || row.height));
  const bpp = (row.size_bytes || 0) / px;
  return bpp < 0.3; // 典型高质量 JPEG 约 0.5~1.5 B/像素
}

/** 单次超分：返回 { outPath, isTemp } */
async function runOneStage({ engine, name, scale, denoise, conservative }, inputPath, curW, curH, onProgress) {
  const tmpOut = `${inputPath}.stage-${engine}.png`;
  const tile = curW * curH > 1_500_000 ? 256 : 0;
  await runUpscale({ inputPath, outputPath: tmpOut, modelName: name, scale, tile, onProgress, engine, denoise, conservative });
  return tmpOut;
}

/**
 * AI 超分增强：
 * - 噪点重 / 压缩狠的图（bpp < 0.3）且已装 Real-CUGAN → 两级流程：
 *   ① Real-CUGAN 2× 降噪（保守修复，先把 JPEG 噪点压掉）
 *   ② 主模型（默认 NMKD-Siax 200k）补到「刚好达到标准」
 * - 其余图单级：主模型放大 → sharp 精确贴合到标准 → 覆盖原文件
 */
async function enhanceImageAi(id, row, target, modelId, onProgress) {
  const spec = parseAiModel(modelId);
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const format = meta.format || 'jpeg';
  const curW = meta.width || row.width;
  const curH = meta.height || row.height;

  const needed = Math.max(target.width / (curW || 1), target.height / (curH || 1));
  if (needed <= 1.001) return unchangedResult(row);

  // 两级：先降噪再放大（Real-CUGAN 可用 + 判定为噪点重的图）
  const cuganModels = cuganInstalled() ? listCuganModels() : [];
  const preDenoise = isNoisyImage(row, curW, curH) && cuganModels.length > 0;

  const tmps = [];
  try {
    let inputPath = row.abs_path;
    let stageW = curW;
    let stageH = curH;

    if (preDenoise) {
      // 2× 模型优先（包内 2× 模型通常支持多档降噪），找不到就用第一个
      const twoX = cuganModels.find((m) => /2x/i.test(m)) || cuganModels[0];
      const denoised = await runOneStage(
        { engine: 'realcugan', name: twoX, scale: 2, denoise: 2, conservative: true },
        inputPath,
        stageW,
        stageH,
        onProgress
      );
      tmps.push(denoised);
      const dm = await sharp(denoised, { failOn: 'none' }).metadata();
      inputPath = denoised;
      stageW = dm.width || stageW * 2;
      stageH = dm.height || stageH * 2;
    }

    // 主模型：放大到「刚好达到标准」所需的倍数
    const rest = Math.max(target.width / (stageW || 1), target.height / (stageH || 1));
    if (rest > 1.001) {
      const aiScale = spec.scalable ? Math.max(2, Math.min(4, Math.ceil(rest))) : Math.min(spec.maxScale, 4);
      const outPixels = stageW * stageH * aiScale * aiScale;
      if (outPixels > MAX_OUTPUT_PIXELS) {
        const k = Math.sqrt(MAX_OUTPUT_PIXELS / outPixels);
        const preTmp = `${inputPath}.ai-src.png`;
        await sharp(inputPath, { failOn: 'none' })
          .resize(Math.max(64, Math.round(stageW * k)), Math.max(64, Math.round(stageH * k)), { kernel: 'lanczos3' })
          .png()
          .toFile(preTmp);
        tmps.push(preTmp);
        inputPath = preTmp;
      }
      const upscaled = await runOneStage(
        { engine: spec.engine, name: spec.name, scale: aiScale },
        inputPath,
        stageW,
        stageH,
        onProgress
      );
      tmps.push(upscaled);
      const upMeta = await sharp(upscaled, { failOn: 'none' }).metadata();
      inputPath = upscaled;
      stageW = upMeta.width || stageW * aiScale;
      stageH = upMeta.height || stageH * aiScale;
    }

    // 精确贴合到标准
    const f = Math.max(target.width / stageW, target.height / stageH);
    let pipeline = sharp(inputPath, { failOn: 'none' });
    if (Math.abs(f - 1) > 0.01) {
      pipeline = pipeline.resize(Math.max(1, Math.round(stageW * f)), Math.max(1, Math.round(stageH * f)), {
        kernel: 'lanczos3',
      });
    }
    if (format === 'png') pipeline = pipeline.png();
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 92 });
    else pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return await writeEnhancedBuffer(id, row, data, info);
  } finally {
    for (const t of tmps) {
      try {
        await removeFileRetry(t);
      } catch (err) {
        console.warn('[enhance] 清理临时文件失败：', err?.message || err);
      }
    }
  }
}

/**
 * 覆盖写回后的缓存版本号：与 edit.js 的 persistEdit 同一理由——
 * 原图/缩略图是 7 天强缓存，DTO 的 ?v= 取自 fs_mtime，不刷新就永远看不到新图
 */
function bumpFsMtime(row) {
  let v = Number(row.fs_mtime || 0) + 1;
  try {
    v = Math.max(Math.round(fs.statSync(row.abs_path).mtimeMs / 1000), v);
  } catch {
    /* 用递增兜底 */
  }
  return v;
}

/** 把 Buffer 写回原文件，复用增强后的元数据更新逻辑 */
async function writeEnhancedBuffer(id, row, data, info) {
  // 覆盖前留原件，支持撤销（增强同样不可逆）
  await pushEditBackup(row, 'enhance');
  await writeFileAtomic(row.abs_path, data);
  const newHash = await computePHash(data).catch(() => '');
  db.prepare(
    'UPDATE images SET width = ?, height = ?, size_bytes = ?, phash = ?, fs_mtime = ? WHERE id = ?'
  ).run(info.width, info.height, data.length, newHash, bumpFsMtime(row), id);
  if (newHash) indexPhash(id, newHash);
  if (clip.clipReady()) clip.reembed(id, row.abs_path); // 内容已改变，重建深度特征
  invalidateQuality(id); // 清晰度缓存同步失效，下次分组时重算
  await removeThumbFiles(id, row.thumb);
  return toDTO(getImage(id));
}

/** 按 "a.b.c" 路径取嵌套字段 */
function getByPath(obj, p) {
  return String(p)
    .split('.')
    .filter(Boolean)
    .reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * 手工拼 multipart 表单体。
 * 不用 FormData：Electron 的 net.fetch 走 Chromium 实现，与 Node 的 FormData/File 不互通。
 */
function buildMultipart(parts, file) {
  const boundary = `----TuKuEnhance${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const p of parts) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.key}"\r\n\r\n${p.value}\r\n`, 'utf8')
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.mime}\r\n\r\n`,
      'utf8'
    )
  );
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * 调用线上增强服务：上传 → （可选）取回结果地址 → 下载结果。
 * 走 httpFetch（桌面端用 Electron 网络栈，自动跟随应用内代理设置）。
 */
async function callRemoteService(service, buf, mime) {
  if (!service?.uploadUrl) throw new Error('未配置上传地址');

  const headers = {};
  if (service.apiKey) headers.Authorization = `Bearer ${service.apiKey}`;
  for (const h of service.headers || []) {
    if (h && h.key) headers[h.key] = h.value;
  }

  const method = service.method || 'POST';
  let body;
  if (service.bodyMode === 'binary') {
    headers['Content-Type'] = mime;
    body = buf;
  } else {
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const mp = buildMultipart(service.params || [], {
      field: service.fileField || 'file',
      filename: `image.${ext}`, // 固定 ASCII 文件名，避免中文名在部分服务端出问题
      mime,
      buffer: buf,
    });
    headers['Content-Type'] = mp.contentType;
    body = mp.body;
  }

  // 线上增强服务常是用户自建的（本机 / 局域网），这条通道显式允许私网地址；
  // 其余出站请求仍然默认拒绝，避免把「用户可控 URL」变成内网探测器。
  const up = await httpFetch(service.uploadUrl, { method, headers, body }, { allowPrivate: true });
  const status = up.status;
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    throw new Error(`上传失败（HTTP ${status}）：${text.slice(0, 240)}`);
  }

  let resultBuf;
  if ((service.resultType || 'json') === 'direct') {
    resultBuf = Buffer.from(await up.arrayBuffer());
  } else {
    const text = await up.text().catch(() => '');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`服务未返回 JSON：${text.slice(0, 240)}`);
    }
    const url = service.resultUrlPath
      ? getByPath(json, service.resultUrlPath)
      : json.url || json.result || json.output || json.output_url;
    if (!url) throw new Error(`未找到结果地址（可在服务配置里指定字段路径）：${text.slice(0, 240)}`);
    const dl = await httpFetch(
      String(url),
      { headers: service.apiKey ? { Authorization: `Bearer ${service.apiKey}` } : {} },
      { allowPrivate: true }
    );
    if (!dl.ok) throw new Error(`下载结果失败（HTTP ${dl.status}）`);
    resultBuf = Buffer.from(await dl.arrayBuffer());
  }

  if (!resultBuf?.length) throw new Error('服务返回内容为空');
  const info = await sharp(resultBuf, { failOn: 'none' }).metadata().catch(() => null);
  if (!info?.width) throw new Error(`返回内容不是可识别的图片（${resultBuf.length} 字节）`);
  return { resultBuf, info };
}

/**
 * 线上增强：软件负责「上传图片 → 设置参数 → 下载结果 → 覆盖原文件」全流程。
 * service 配置见 web 端「设置 → 画质增强 → 线上增强服务」。
 */
export async function enhanceImageRemote(id, service) {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  try {
    return await enhanceImageRemoteInner(id, service);
  } catch (err) {
    throw translateError(err, row.abs_path);
  }
}

async function enhanceImageRemoteInner(id, service) {
  const row = getImage(id);
  if (!row || !row.abs_path) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在（可能已被移动或删除）');

  const buf = await fsp.readFile(row.abs_path);
  const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
  const mime = meta.format === 'png' ? 'image/png' : meta.format === 'webp' ? 'image/webp' : 'image/jpeg';

  const { resultBuf, info } = await callRemoteService(service, buf, mime);
  // 写入统一交给 writeEnhancedBuffer（避免重复写同一文件、加大被占用概率）
  return writeEnhancedBuffer(id, row, resultBuf, {
    width: info.width || row.width,
    height: info.height || row.height,
  });
}

/** 连通性测试：用一张合成小图走完整流程，返回耗时与返回体摘要（不触碰任何真实图片） */
export async function testRemoteService(service) {
  const buf = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 60, b: 160 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  const t0 = Date.now();
  try {
    const { resultBuf, info } = await callRemoteService(service, buf, 'image/jpeg');
    return {
      ok: true,
      elapsed: Date.now() - t0,
      bytes: resultBuf.length,
      width: info.width,
      height: info.height,
      message: `成功：返回 ${info.width}×${info.height}（${Math.round(resultBuf.length / 1024)} KB）`,
    };
  } catch (err) {
    return { ok: false, elapsed: Date.now() - t0, message: String(err.message || err) };
  }
}
