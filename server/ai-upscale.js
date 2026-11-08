import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
// execFileSync：后面直连下载失败时用 PowerShell Invoke-WebRequest 兜底，
// 以前这里漏了导入，走到兜底分支必抛 ReferenceError（下载永远失败且看不出原因）
import { spawn, execFile, execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { DATA_DIR } from './config.js';
import { httpFetch } from './http.js';
import { KNOWN_ZIP_SHA256 } from './model-fetch.js';

/**
 * 真·AI 超分：Real-ESRGAN（ncnn + Vulkan 版，免 Python / 免 CUDA）
 * - 运行库按需从 GitHub 下载（约 43MB），解压到 data/ai/realesrgan
 * - 包内自带 5 个模型：realesrgan-x4plus / x4plus-anime / realesr-animevideov3(x2 x3 x4)
 * - 通过子进程调用，解析 stdout 的百分比输出实时回传进度
 */

const AI_DIR = path.join(DATA_DIR, 'ai');
const RUNTIME_DIR = path.join(AI_DIR, 'realesrgan');
const CUGAN_DIR = path.join(AI_DIR, 'realcugan');
const TMP_DIR = path.join(AI_DIR, 'tmp');
const EXE = path.join(RUNTIME_DIR, 'realesrgan-ncnn-vulkan.exe');
const CUGAN_EXE = path.join(CUGAN_DIR, 'realcugan-ncnn-vulkan.exe');
/** Real-ESRGAN 打包模型目录，社区模型也放这里（exe 用 -n 直接按名字调用） */
const MODELS_DIR = path.join(RUNTIME_DIR, 'models');

const RELEASE_URL =
  'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';
const CUGAN_RELEASE_URL =
  'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-windows.zip';

/**
 * 社区模型（ESRGAN 架构，ncnn 版）：来源 upscayl/custom-models。
 * 比内置 realesrgan-x4plus 更适合真人照片：涂抹感更少、细节更稳。
 */
export const COMMUNITY_MODELS = [
  {
    id: 'esrgan:4x_NMKD-Siax_200k',
    name: '4x_NMKD-Siax_200k',
    label: 'NMKD-Siax 200k（真人照片首选）',
    desc: '画质与速度的最佳平衡，伪影少',
    scale: 4,
  },
  {
    id: 'esrgan:RealESRGAN_General_WDN_x4_v3',
    name: 'RealESRGAN_General_WDN_x4_v3',
    label: 'General WDN v3（通用 + 去噪）',
    desc: '带去噪，压缩噪点重的图更干净',
    scale: 4,
  },
  {
    id: 'esrgan:4x_NMKD-Superscale-SP_178000_G',
    name: '4x_NMKD-Superscale-SP_178000_G',
    label: 'NMKD Superscale SP',
    desc: '通用放大，过渡自然',
    scale: 4,
  },
  {
    id: 'esrgan:4xLSDIRplusC',
    name: '4xLSDIRplusC',
    label: 'LSDIRplusC（细节锐利）',
    desc: '细节重建强',
    scale: 4,
  },
  {
    id: 'esrgan:4xNomos8kSC',
    name: '4xNomos8kSC',
    label: 'Nomos8kSC（锐利）',
    desc: '锐度高，适合再锐化',
    scale: 4,
  },
  {
    id: 'esrgan:4xHFA2k',
    name: '4xHFA2k',
    label: 'HFA2k（平滑）',
    desc: '平滑自然，抑制伪影',
    scale: 4,
  },
];

const COMMUNITY_BASE = 'https://raw.githubusercontent.com/upscayl/custom-models/main/models';
/** 国内直连 GitHub 常失败：先走镜像，再直连，最后由 PowerShell 继承系统代理兜底 */
const GH_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.com/', 'https://ghfast.top/'];

export function isCommunityModel(modelId) {
  return COMMUNITY_MODELS.some((m) => m.id === modelId);
}

export function communityModelOf(modelId) {
  return COMMUNITY_MODELS.find((m) => m.id === modelId) || null;
}

/** 可用的 AI 模型（对应包内 models/*.param） */
export const AI_MODELS = [
  {
    id: 'ai-realesrgan-x4plus',
    name: 'realesrgan-x4plus',
    label: 'AI 超分 · 通用照片',
    desc: 'Real-ESRGAN x4plus，真实照片通用超分（×4）',
    maxScale: 4,
    scalable: false,
  },
  {
    id: 'ai-realesrgan-x4plus-anime',
    name: 'realesrgan-x4plus-anime',
    label: 'AI 超分 · 二次元 / 插画',
    desc: 'Real-ESRGAN x4plus-anime，插画、动漫风图像（×4）',
    maxScale: 4,
    scalable: false,
  },
  {
    id: 'ai-realesr-animevideov3',
    name: 'realesr-animevideov3',
    label: 'AI 超分 · 动漫 / 写真（可变倍率）',
    desc: 'realesr-animevideov3，支持 2/3/4 倍，速度最快',
    maxScale: 4,
    scalable: true,
  },
];

export function isAiModel(modelId) {
  return AI_MODELS.some((m) => m.id === modelId || m.name === modelId);
}

export function aiModelOf(modelId) {
  return AI_MODELS.find((m) => m.id === modelId || m.name === modelId) || null;
}

export function runtimeInstalled() {
  return fs.existsSync(EXE);
}

export function cuganInstalled() {
  return fs.existsSync(CUGAN_EXE);
}

/** Real-CUGAN 包内的模型目录名（去噪档位不同） */
export function listCuganModels() {
  if (!cuganInstalled()) return [];
  const dir = path.join(CUGAN_DIR, 'models');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** 社区模型是否已安装（param + bin 齐全） */
export function communityInstalled(name) {
  return (
    fs.existsSync(path.join(MODELS_DIR, `${name}.param`)) && fs.existsSync(path.join(MODELS_DIR, `${name}.bin`))
  );
}

export function listCommunityModels() {
  return COMMUNITY_MODELS.map((m) => ({ ...m, installed: communityInstalled(m.name) }));
}

let installState = { downloading: false, progress: 0, message: '' };
let lastCheck = { gpu: null, ok: null, error: '' };
let lastCuganCheck = { ok: null, error: '' };

export function aiStatus() {
  return {
    installed: runtimeInstalled(),
    downloading: installState.downloading,
    progress: installState.progress,
    message: installState.message,
    gpu: lastCheck.gpu,
    usable: lastCheck.ok,
    error: lastCheck.error,
    runtimeDir: RUNTIME_DIR,
    models: AI_MODELS,
    // 新增：社区模型与 Real-CUGAN（两级增强用）
    community: listCommunityModels(),
    cugan: {
      installed: cuganInstalled(),
      usable: lastCuganCheck.ok,
      error: lastCuganCheck.error,
      models: listCuganModels(),
    },
  };
}

/** 安装一个社区模型（param + bin，各几 MB） */
export async function installCommunityModel(modelId) {
  const model = communityModelOf(modelId);
  if (!model) throw new Error('未知的模型');
  if (!runtimeInstalled()) throw new Error('请先安装 AI 超分运行库');
  await fsp.mkdir(MODELS_DIR, { recursive: true });
  for (const ext of ['param', 'bin']) {
    await downloadFile(
      `${COMMUNITY_BASE}/${model.name}.${ext}`,
      path.join(MODELS_DIR, `${model.name}.${ext}`)
    );
  }
  return { ok: true, model: { ...model, installed: communityInstalled(model.name) } };
}

/** 安装 Real-CUGAN 运行库（两级增强的降噪前置引擎） */
export async function installCuganRuntime() {
  if (installState.downloading) throw new Error('正在下载中，请稍候');
  installState = { downloading: true, progress: 0, message: '准备下载 Real-CUGAN…' };
  try {
    await fsp.mkdir(TMP_DIR, { recursive: true });
    const zip = path.join(TMP_DIR, 'realcugan.zip');
    await download(CUGAN_RELEASE_URL, zip, (p, bytes) => {
      if (p == null) {
        // 拿不到总体积：只报已下载体积，不编百分比（progress = -1 表示未知）
        installState.progress = -1;
        installState.message = `下载中（已下载 ${(Number(bytes || 0) / 1048576).toFixed(1)} MB）`;
        return;
      }
      installState.progress = Math.round(p * 88);
      installState.message = `下载中 ${installState.progress}%`;
    });
    installState.progress = 90;
    installState.message = '解压中…';
    const outDir = path.join(TMP_DIR, 'cugan-extract');
    await fsp.rm(outDir, { recursive: true, force: true });
    await extractZip(zip, outDir);
    const root = findRuntimeRoot(outDir, 'realcugan-ncnn-vulkan.exe');
    if (!root) throw new Error('包内未找到 realcugan-ncnn-vulkan.exe');
    installState.progress = 95;
    installState.message = '安装中…';
    await fsp.rm(CUGAN_DIR, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(CUGAN_DIR), { recursive: true });
    await fsp.rename(root, CUGAN_DIR);
    await writeSidecar(CUGAN_EXE);
    installState.message = '自检中…';
    await cuganSelfTest();
    installState = { downloading: false, progress: 100, message: 'Real-CUGAN 安装完成' };
    return aiStatus().cugan;
  } catch (err) {
    installState = { downloading: false, progress: 0, message: `安装失败：${err.message || err}` };
    throw err;
  } finally {
    await fsp.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cuganSelfTest() {
  if (!cuganInstalled()) {
    lastCuganCheck = { ok: false, error: 'Real-CUGAN 未安装' };
    return lastCuganCheck;
  }
  const models = listCuganModels();
  if (!models.length) {
    lastCuganCheck = { ok: false, error: '包内未找到模型目录' };
    return lastCuganCheck;
  }
  const dir = path.join(TMP_DIR, 'cugan-selftest');
  await fsp.mkdir(dir, { recursive: true });
  const input = path.join(dir, 'in.png');
  const output = path.join(dir, 'out.png');
  try {
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 60, b: 160 } } })
      .png()
      .toFile(input);
    await runUpscale({ engine: 'realcugan', inputPath: input, outputPath: output, modelName: models[0], scale: 2, denoise: 1 });
    if (!fs.existsSync(output)) throw new Error('自检未生成输出文件');
    lastCuganCheck = { ok: true, error: '' };
  } catch (err) {
    lastCuganCheck = { ok: false, error: String(err.message || err).slice(0, 300) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return lastCuganCheck;
}

/* ------------------------------- 下载 / 解压 ------------------------------- */

/**
 * 包体大小的兜底估算（仅用于 PowerShell 回退下载时的进度条）。
 * 以前两个包共用一个 45.5MB 的常量：Real-CUGAN 只有 10MB 左右，
 * 进度条会一直停在 20% 直到装完，看起来像卡死。
 * 现在优先用远端 Content-Length（真实值），这里只作为离线/未知时的兜底。
 */
const ZIP_SIZE_HINT = {
  [RELEASE_URL]: 45_500_000,
  [CUGAN_RELEASE_URL]: 12_000_000,
};

/** 通过 HEAD 请求拿真实体积；拿不到就回落到内置估算 */
async function remoteSize(url) {
  try {
    const res = await httpFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    const len = Number(res.headers.get('content-length') || 0);
    if (res.ok && len > 1_000_000) return len;
  } catch {
    /* 离线 / 镜像不支持 HEAD：用兜底值 */
  }
  return ZIP_SIZE_HINT[url] || 0;
}

/**
 * 下载完整性校验（sha256）：
 * - KNOWN_ZIP_SHA256 来自随包只读清单 server/model-pins.json（打包进 asar，运行时改不了）；
 *   官方 release（2022 年）未提供 digest，用 `npm run pin-models -- <zip> <URL>` 核对后固化。
 * - sidecar（<dest>.sha256）：清单没条目时只做「与上次下载一致」的自洽检查，
 *   不能算可信校验；清单有条目时清单优先，sidecar 无法覆盖。
 * - PK 签名快检：zip 前两字节必须是 'PK'，防半截文件直接进解压。
 */

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function readSidecar(dest) {
  try {
    const hex = (await fsp.readFile(`${dest}.sha256`, 'utf8')).trim();
    return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 安装完成后给运行库/权重写一份 sha256 旁注，供运行前复核 */
async function writeSidecar(file) {
  try {
    const h = await sha256File(file);
    await fsp.writeFile(`${file}.sha256`, `${h}\n`, 'utf8');
  } catch {
    /* 旁注失败不阻断安装 */
  }
}

/** 运行前复核：体积异常或哈希不匹配（被替换/损坏）都判为不可用 */
async function verifyBinary(file) {
  try {
    const st = await fsp.stat(file);
    if (st.size < 1024 * 1024) return { ok: false, reason: '体积异常（可能损坏）' };
    const expect = await readSidecar(file);
    if (!expect) return { ok: true, reason: '' };
    const digest = await sha256File(file);
    return digest === expect ? { ok: true, reason: '' } : { ok: false, reason: '哈希不匹配（可能损坏或被替换）' };
  } catch {
    return { ok: false, reason: '无法读取运行库' };
  }
}

/** 下载完成统一校验：体积 → zip 签名 → sha256（内置清单/sidecar），通过后写 sidecar */
async function verifyDownloaded(dest, url) {
  const size = fs.statSync(dest).size;
  if (size < 1024) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw new Error('下载文件过小，疑似不完整');
  }
  if (url.endsWith('.zip')) {
    const fd = await fsp.open(dest, 'r');
    try {
      const { buffer } = await fd.read(Buffer.alloc(2), 0, 2, 0);
      if (buffer.toString('latin1') !== 'PK') {
        await fsp.rm(dest, { force: true }).catch(() => {});
        throw new Error('不是有效的 zip 包（签名不符），可能被镜像替换或下载中断');
      }
    } finally {
      await fd.close().catch(() => {});
    }
  }
  const digest = await sha256File(dest);
  const pinned = KNOWN_ZIP_SHA256[url];
  const expect = pinned || (await readSidecar(dest));
  if (expect && digest !== expect.toLowerCase()) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw new Error(
      pinned
        ? 'sha256 与随包可信清单不一致：安装包可能被替换，已删除'
        : 'sha256 校验失败：文件损坏或来源异常，已删除'
    );
  }
  await fsp.writeFile(`${dest}.sha256`, `${digest}\n`, 'utf8').catch(() => {});
}

/** 直连下载（Node fetch，能拿到精确进度，但不走系统代理） */
async function downloadDirect(url, dest, onProgress) {
  const res = await httpFetch(url, {});
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const file = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      await new Promise((resolve, reject) => file.write(Buffer.from(value), (e) => (e ? reject(e) : resolve())));
      if (total) onProgress(Math.min(0.99, received / total));
    }
  } finally {
    await new Promise((r) => file.end(r));
  }
  if (total && received < total * 0.98) throw new Error('下载不完整，请重试');
}

/**
 * 回退下载：走 PowerShell 的 Invoke-WebRequest（继承系统代理，国内环境通常更通）。
 * 无法拿到实时进度，改为轮询已写入文件的体积来估算。
 */
function downloadViaPowerShell(url, dest, onProgress, expectedBytes = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing`,
      ],
      { windowsHide: true }
    );
    let err = '';
    child.stderr?.on('data', (d) => {
      err += String(d);
    });
    const tick = setInterval(() => {
      try {
        const size = fs.statSync(dest).size;
        // 不知道总体积时只报「已下载体积」（p = null），绝不按固定总大小编百分比
        if (expectedBytes > 0) onProgress(Math.min(0.95, size / expectedBytes), size);
        else onProgress(null, size);
      } catch {
        /* 还没开始写 */
      }
    }, 500);
    child.on('error', (e) => {
      clearInterval(tick);
      reject(new Error(`无法调用 PowerShell：${e.message}`));
    });
    child.on('close', (code) => {
      clearInterval(tick);
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      // 门槛按真实体积推算：写死 10MB 会把约 9MB 的 Real-CUGAN 包判成失败
      const minSize = expectedBytes > 0 ? Math.floor(expectedBytes * 0.8) : 1_000_000;
      if (code === 0 && size >= minSize) resolve();
      else reject(new Error(`系统代理下载失败（退出码 ${code}，${size} 字节）${err.slice(0, 200)}`));
    });
  });
}

async function download(url, dest, onProgress) {
  await fsp.rm(dest, { force: true });
  const errors = [];
  // 真实体积（HEAD）优先：PowerShell 回退路径只能靠它算百分比
  const expectedBytes = await remoteSize(url);
  // 1) GitHub 镜像（国内可直接访问）
  for (const mirror of GH_MIRRORS) {
    try {
      await downloadDirect(mirror + url, dest, onProgress);
      await verifyDownloaded(dest, url);
      return;
    } catch (e) {
      errors.push(`镜像 ${mirror}：${e.message}`);
    }
  }
  // 2) 直连
  try {
    await downloadDirect(url, dest, onProgress);
    await verifyDownloaded(dest, url);
    return;
  } catch (e) {
    errors.push(`直连：${e.message}`);
  }
  // 3) PowerShell 继承系统代理
  try {
    await downloadViaPowerShell(url, dest, onProgress, expectedBytes);
    await verifyDownloaded(dest, url);
    return;
  } catch (e) {
    errors.push(`系统代理：${e.message}`);
  }
  throw new Error(`下载失败：${errors.join('；').slice(0, 300)}`);
}

/** 小文件（模型 param/bin）：镜像优先，失败再由系统代理兜底 */
async function downloadFile(url, dest) {
  await fsp.rm(dest, { force: true });
  const errors = [];
  for (const mirror of GH_MIRRORS) {
    try {
      const res = await httpFetch(mirror + url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
      await verifyDownloaded(dest, url);
      return;
    } catch (e) {
      errors.push(`${mirror}：${e.message}`);
    }
  }
  try {
    const res = await httpFetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    await verifyDownloaded(dest, url);
    return;
  } catch (e) {
    errors.push(`直连：${e.message}`);
  }
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing`,
      ],
      { windowsHide: true, timeout: 120000 }
    );
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      await verifyDownloaded(dest, url);
      return;
    }
    throw new Error('系统代理下载为空');
  } catch (e) {
    errors.push(`系统代理：${e.message}`);
  }
  throw new Error(`下载失败：${errors.join('；').slice(0, 300)}`);
}

/** 用 PowerShell 解压（Windows 自带，无需额外依赖） */
function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err) => (err ? reject(new Error(`解压失败：${err.message}`)) : resolve())
    );
  });
}

function findRuntimeRoot(dir, exeName = 'realesrgan-ncnn-vulkan.exe') {
  if (fs.existsSync(path.join(dir, exeName))) return dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findRuntimeRoot(path.join(dir, entry.name), exeName);
      if (found) return found;
    }
  }
  return null;
}

export async function installRuntime() {
  if (installState.downloading) throw new Error('正在下载中，请稍候');
  installState = { downloading: true, progress: 0, message: '准备下载…' };
  try {
    await fsp.mkdir(TMP_DIR, { recursive: true });
    const zip = path.join(TMP_DIR, 'realesrgan.zip');
    await download(RELEASE_URL, zip, (p, bytes) => {
      if (p == null) {
        installState.progress = -1;
        installState.message = `下载中（已下载 ${(Number(bytes || 0) / 1048576).toFixed(1)} MB）`;
        return;
      }
      installState.progress = Math.round(p * 88);
      installState.message = `下载中 ${installState.progress}%`;
    });

    installState.progress = 90;
    installState.message = '解压中…';
    const outDir = path.join(TMP_DIR, 'extract');
    await fsp.rm(outDir, { recursive: true, force: true });
    await extractZip(zip, outDir);

    const root = findRuntimeRoot(outDir);
    if (!root) throw new Error('包内未找到 realesrgan-ncnn-vulkan.exe');

    installState.progress = 95;
    installState.message = '安装中…';
    await fsp.rm(RUNTIME_DIR, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(RUNTIME_DIR), { recursive: true });
    await fsp.rename(root, RUNTIME_DIR);
    await writeSidecar(EXE);

    installState.message = '自检中…';
    await selfTest();

    installState = { downloading: false, progress: 100, message: '安装完成' };
    return aiStatus();
  } catch (err) {
    installState = { downloading: false, progress: 0, message: `安装失败：${err.message || err}` };
    throw err;
  } finally {
    await fsp.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

/* --------------------------------- 运行 --------------------------------- */

export const GPU_RE = /\[(\d+)\s+(.+?)\]\s/;

/** 自检：跑一张 64×64 合成图，确认 Vulkan 可用并记录显卡名 */
export async function selfTest() {
  if (!runtimeInstalled()) {
    lastCheck = { gpu: null, ok: false, error: '运行库未安装' };
    return lastCheck;
  }
  const dir = path.join(TMP_DIR, 'selftest');
  await fsp.mkdir(dir, { recursive: true });
  const input = path.join(dir, 'in.png');
  const output = path.join(dir, 'out.png');
  try {
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 60, b: 160 } },
    })
      .png()
      .toFile(input);
    const { output: log } = await runUpscale({ inputPath: input, outputPath: output, modelName: 'realesrgan-x4plus' });
    if (!fs.existsSync(output)) throw new Error('自检未生成输出文件');
    const gpu = GPU_RE.exec(log)?.[2] || null;
    lastCheck = { gpu, ok: true, error: '' };
  } catch (err) {
    lastCheck = { gpu: null, ok: false, error: String(err.message || err).slice(0, 300) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return lastCheck;
}

/**
 * 调用 Real-ESRGAN 放大单张图片。
 * onProgress 会收到 0~1 的进度（解析 exe 的百分比输出）。
 */
export function runUpscale({
  inputPath,
  outputPath,
  modelName,
  scale = 4,
  tile = 0,
  onProgress,
  engine = 'realesrgan',
  denoise = 0,
  conservative = false,
}) {
  const useCugan = engine === 'realcugan';
  const exe = useCugan ? CUGAN_EXE : EXE;
  if (!fs.existsSync(exe)) {
    return Promise.reject(
      new Error(
        useCugan
          ? 'Real-CUGAN 运行库未安装，请先到「设置 → 画质增强」下载'
          : 'AI 运行库未安装，请先到「设置 → 画质增强」下载'
      )
    );
  }
  // 运行前复核：运行库损坏或被替换时删掉并明确报错，引导重新下载，
  // 而不是带着坏文件跑出奇怪的结果。
  return verifyBinary(exe).then((binCheck) => {
    if (!binCheck.ok) {
      return fsp.rm(exe, { force: true }).then(() => {
        throw new Error(`AI 运行库${useCugan ? '（Real-CUGAN）' : ''}${binCheck.reason}，已删除并请重新下载`);
      });
    }
    return new Promise((resolve, reject) => {
      const cwd = useCugan ? CUGAN_DIR : RUNTIME_DIR;
      const args = ['-i', inputPath, '-o', outputPath, '-n', modelName, '-s', String(scale)];
    if (useCugan) {
      args.push('-d', String(denoise));
      if (conservative) args.push('-c');
    }
    if (tile) args.push('-t', String(tile));
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    // 进度百分比走 stderr，且用 \r 原地刷新，取每段里最后一个百分比即为当前进度
    const scanProgress = (s) => {
      const m = [...s.matchAll(/(\d+(?:\.\d+)?)%/g)];
      if (m.length && onProgress) onProgress(Math.min(1, Number(m[m.length - 1][1]) / 100));
    };
    child.stdout?.on('data', (d) => {
      const s = String(d);
      out += s;
      scanProgress(s);
    });
    child.stderr?.on('data', (d) => {
      const s = String(d);
      err += s;
      scanProgress(s);
    });
    child.on('error', (e) => reject(new Error(`无法启动 AI 程序：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ output: out + err });
      } else {
        reject(new Error(`AI 超分失败（退出码 ${code}）：${(err || out).slice(-300) || '无输出'}`));
      }
    });
    });
  });
}

/** 后台预热：启动时异步自检一次（失败不影响应用） */
export function warmupCheck() {
  if (!runtimeInstalled()) return;
  selfTest().catch(() => {});
}
