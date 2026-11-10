// @ts-check
/**
 * 下载中心的统一注册表：把散在各个模块里的模型状态收成一份清单，
 * 并统一收发「下载 / 取消 / 删除 / 校验」。
 *
 * 设计原则：
 * - **不改各模块的下载实现**：这里只做适配（调它们的 install/cancel/remove），
 *   下载逻辑（镜像、重试、哈希、sidecar）仍在原模块，避免两套实现漂移。
 * - **路径只认模块导出的常量**：registry 里不重新拼 data/ai/xxx，
 *   否则改目录那天必然漏一处（历史上就这么丢过孤儿文件）。
 * - **状态以磁盘为准**：清单里的 sizeHint 只是「预计体积」，已装大小一律 stat；
 *   校验能不能信，取决于有没有随包的可信哈希（pinned），没有就如实标注。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as upscaler from '../ai-upscale.js';
import * as matting from '../matting.js';
import * as face from '../face.js';
import * as srDeep from '../sr-deep.js';
import * as clip from '../clip.js';
import { MODEL_CATALOG, MODEL_GROUPS, catalogItem, mergeCatalog, summarizeCatalog } from './model-catalog.js';

/** 递归求目录体积；单个文件被占用/无权限时跳过，不因为一个文件让整行显示 0 */
function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(p);
      else total += fs.statSync(p).size;
    } catch {
      /* 并发删除/无权限：忽略这一项 */
    }
  }
  return total;
}

const fileBytes = (p) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
};

/** 进度为 -1 表示「不知道总量」，HUD 上不该画一条假进度 */
const clampProgress = (v) => (Number(v) < 0 ? -1 : Math.max(0, Math.min(100, Number(v) || 0)));

/**
 * 汇总所有模块的实时状态。
 * 每个 probe 只填自己知道的字段，缺省由 mergeCatalog 补默认值。
 */
export function collectProbes() {
  const probes = {};

  // ── 超分：运行库 + 社区模型 + Swin2SR ──────────────────
  const ai = upscaler.aiStatus();
  const aiActive = ai.downloading ? ai.target : '';
  const aiState = (id) =>
    aiActive === id
      ? {
          state: 'downloading',
          progress: clampProgress(ai.progress),
          message: ai.message || '',
          error: ai.installError || '',
        }
      : {};
  // 社区模型先算，运行库再减：它们同住 runtime/models，先减再算会拿不到准确的归属体积。
  // 只减「清单里真有条目」的模型文件 —— 连内置的 x4plus/animevideov3 一起减掉，
  // 运行库那一行就只剩 exe + dll，看着像没装成功。
  let communityBytes = 0;
  for (const m of ai.community || []) {
    // 社区模型是 .param + .bin 两个文件，任一缺失都算没装好
    const param = path.join(upscaler.MODELS_DIR, `${m.name}.param`);
    const bin = path.join(upscaler.MODELS_DIR, `${m.name}.bin`);
    const size = fileBytes(param) + fileBytes(bin);
    communityBytes += size;
    probes[m.id] = {
      installed: !!m.installed,
      size,
      path: upscaler.MODELS_DIR,
      ...aiState(m.id),
    };
  }
  probes['upscale:realesrgan'] = {
    installed: ai.installed,
    size: Math.max(0, dirBytes(upscaler.RUNTIME_DIR) - communityBytes),
    path: upscaler.RUNTIME_DIR,
    ...aiState('upscale:realesrgan'),
  };
  probes['upscale:realcugan'] = {
    installed: ai.cugan?.installed,
    size: dirBytes(upscaler.CUGAN_DIR),
    path: upscaler.CUGAN_DIR,
    error: ai.cugan?.error || '',
    ...aiState('upscale:realcugan'),
  };

  const sr = srDeep.srStatus();
  for (const m of sr.models || []) {
    probes[m.id] = {
      installed: !!m.downloaded,
      size: dirBytes(srDeep.srCacheDir(m.id)),
      path: srDeep.srCacheDir(m.id),
      ...(sr.loading === m.repo
        ? { state: 'downloading', progress: clampProgress(sr.progress), message: sr.message || '', error: sr.error || '' }
        : {}),
    };
  }

  // ── 抠图：三档 ────────────────────────────────────────
  const mt = matting.mattingStatus();
  for (const p of mt.profiles || []) {
    const files = matting.mattingFiles(p.id);
    probes[`matting:${p.id}`] = {
      installed: p.installed,
      size: p.size,
      verified: p.verified,
      path: files?.dir || '',
      ...(mt.downloading && mt.installing === p.id
        ? { state: 'downloading', progress: clampProgress(mt.progress), message: mt.message || '', error: mt.error || '' }
        : {}),
    };
  }

  // ── 人脸 ──────────────────────────────────────────────
  const fc = face.faceStatus();
  probes['face:buffalo-l'] = {
    installed: fc.downloaded,
    size: fc.size,
    verified: fc.verified,
    path: face.FACE_DIR,
    ...(fc.downloading
      ? { state: 'downloading', progress: clampProgress(fc.progress), message: fc.message || '', error: fc.error || '' }
      : {}),
  };

  // ── 语义检索 ──────────────────────────────────────────
  const dl = clip.downloadState;
  probes['semantic:clip-vit-b32'] = {
    installed: clip.clipDownloaded(),
    size: dirBytes(clip.clipCacheDir()),
    path: clip.clipCacheDir(),
    ...(dl.downloading
      ? { state: 'downloading', progress: clampProgress(dl.progress), message: dl.message || '', error: dl.error || '' }
      : {}),
  };

  return probes;
}

/** 完整清单 + 汇总（设置页一次拉全量） */
export function listModels() {
  const items = mergeCatalog(collectProbes());
  return { items, summary: summarizeCatalog(items), groups: MODEL_GROUPS };
}

/**
 * 轻量快照：SSE 每帧只要「谁在下、下到哪」。
 * 这里**不重算体积**：dirBytes 要递归 stat 上千个文件，塞进 120ms 一帧的心跳会明显拖慢事件循环。
 */
export function modelsSnapshot() {
  const items = [];
  const ai = upscaler.aiStatus();
  if (ai.downloading && ai.target) {
    items.push({ id: ai.target, state: 'downloading', progress: clampProgress(ai.progress), message: ai.message || '' });
  }
  const sr = srDeep.srStatus();
  if (sr.loading) {
    const m = srDeep.srModelOf ? srDeep.srModelOf(sr.loading) : null;
    const id = (sr.models || []).find((x) => x.repo === sr.loading)?.id || m?.id;
    if (id) {
      items.push({ id, state: 'downloading', progress: clampProgress(sr.progress), message: sr.message || '' });
    }
  }
  const mt = matting.mattingStatus();
  if (mt.downloading) {
    items.push({
      id: `matting:${mt.installing || mt.profile}`,
      state: 'downloading',
      progress: clampProgress(mt.progress),
      message: mt.message || '',
    });
  }
  const fc = face.faceStatus();
  if (fc.downloading) {
    items.push({
      id: 'face:buffalo-l',
      state: 'downloading',
      progress: clampProgress(fc.progress),
      message: fc.message || '',
    });
  }
  if (clip.downloadState.downloading) {
    items.push({
      id: 'semantic:clip-vit-b32',
      state: 'downloading',
      progress: clampProgress(clip.downloadState.progress),
      message: clip.downloadState.message || '',
    });
  }
  return { active: items.length, activeId: items[0]?.id || '', items };
}

/**
 * 开始下载某一项。所有入口都立即返回，进度靠轮询 / SSE。
 * 一定要 `started` 字段：前端要知道是「这次开始下了」还是「已经在下了都被挡回来了」。
 */
export async function installModel(id) {
  const item = catalogItem(id);
  if (!item) return { ok: false, error: '未知的模型' };

  if (id === 'upscale:realesrgan') {
    if (upscaler.runtimeInstalled()) return { ok: false, error: '已经安装' };
    upscaler.installRuntime().catch((err) => console.error('[models] 运行库安装失败', err?.message || err));
    return { ok: true, started: true };
  }
  if (id === 'upscale:realcugan') {
    if (upscaler.cuganInstalled()) return { ok: false, error: '已经安装' };
    upscaler.installCuganRuntime().catch((err) => console.error('[models] CUGAN 安装失败', err?.message || err));
    return { ok: true, started: true };
  }
  if (id.startsWith('esrgan:')) {
    return await upscaler.startCommunityInstall(id);
  }
  if (id.startsWith('onnx:')) {
    return await srDeep.startSrLoad(id);
  }
  if (id.startsWith('matting:')) {
    return await matting.startMattingInstall(id.slice('matting:'.length));
  }
  if (id === 'face:buffalo-l') {
    if (face.faceStatus().downloaded) return { ok: false, error: '已经安装' };
    return await face.startFaceInstall();
  }
  if (id === 'semantic:clip-vit-b32') {
    return await clip.startClipInstall();
  }
  return { ok: false, error: '这一项没有下载入口' };
}

/** 取消下载：只有实现了可中止的模块能真停，其它如实返回不支持 */
export function cancelModel(id) {
  if (id === 'upscale:realesrgan' || id === 'upscale:realcugan' || id.startsWith('esrgan:')) {
    return { ok: false, error: '解压安装无法中途取消，请等这一步结束' };
  }
  if (id.startsWith('onnx:')) {
    return { ok: false, error: 'transformers 的下载不支持中止，请等它结束' };
  }
  if (id.startsWith('matting:')) {
    matting.cancelMattingInstall();
    return { ok: true };
  }
  if (id === 'face:buffalo-l') {
    face.cancelFaceInstall();
    return { ok: true };
  }
  if (id === 'semantic:clip-vit-b32') {
    return { ok: false, error: 'transformers 的下载不支持中止，请等它结束' };
  }
  return { ok: false, error: '这一项无法取消' };
}

/**
 * 删除已下载的模型。`required` 项允许删，但前端会二次确认（删了功能直接不可用）。
 * 返回最新状态，前端不用再拉一次。
 */
export async function removeModel(id) {
  const item = catalogItem(id);
  if (!item) return { ok: false, error: '未知的模型' };

  if (id === 'upscale:realesrgan') await upscaler.removeUpscaleRuntime('realesrgan');
  else if (id === 'upscale:realcugan') await upscaler.removeUpscaleRuntime('realcugan');
  else if (id.startsWith('esrgan:')) await upscaler.removeCommunityModel(id);
  else if (id.startsWith('onnx:')) await srDeep.removeSrModel(id);
  else if (id.startsWith('matting:')) await matting.removeMatting(id.slice('matting:'.length));
  else if (id === 'face:buffalo-l') await face.removeFaceModels();
  else if (id === 'semantic:clip-vit-b32') await clip.removeClipModel();
  else return { ok: false, error: '这一项没有删除入口' };

  return { ok: true, ...listModels() };
}

/**
 * 校验：有可信哈希的走 sha256，没有的只核对体积是否与清单相符。
 * 结果是「给用户看的可信度说明」，不是安全边界 —— 说不了真话就不说。
 */
export async function verifyModel(id) {
  const item = catalogItem(id);
  if (!item) return { ok: false, error: '未知的模型' };
  const probes = collectProbes();
  const p = probes[id];
  if (!p?.installed) return { ok: false, error: '还没下载' };
  const minBytes = Math.max(1024 * 1024, Math.floor(item.sizeHint * 0.5));
  if (p.size < minBytes) {
    return { ok: false, verified: false, error: `文件不完整（${p.size} 字节，预期约 ${item.sizeHint}）`, size: p.size };
  }
  return {
    ok: true,
    verified: !!p.verified,
    size: p.size,
    message: p.verified ? '已与随包可信哈希比对一致' : '文件体积正常（该项没有随包哈希，无法做内容比对）',
  };
}

/** 供 app.js 的 SSE 快照使用（保留导出名与调用方一致） */
export const MODEL_GROUPS_LIST = MODEL_GROUPS;

export { MODEL_CATALOG };
