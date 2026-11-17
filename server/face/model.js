// @ts-check
/**
 * 人脸模型的下载安装、可信哈希校验与 ONNX 会话加载。
 *
 * 会话是**惰性单例**：整个进程只有本模块持有 sessionPromise 这一个变量，
 * 检测/特征抽取一律走 getSessions()。拆模块时这是最容易拆坏的地方 ——
 * 如果 detect.js 再持有一份，就会把 191MB 权重加载两遍（内存翻倍、首帧慢一倍）。
 *
 * 权重必须过 server/model-pins.json 的可信哈希清单，装/加载前都复核（被替换直接报错）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { DET_FILE, REC_FILE, DET_KEY, REC_KEY, REPO, MIRRORS } from './constants.js';
import { downloadModelFile, verifyModelFileDetailed, KNOWN_SHA256 } from '../model-fetch.js';
import { createJob, finishJob, jobProgress } from '../jobs.js';
import { modelState, getInstallAbort, setInstallAbort } from './state.js';
import { createOrtSession } from '../lib/onnx-device.js';

/** 惰性单例：整进程唯一的 ONNX 会话持有者 */
let sessionPromise = null;

export const detBytes = () => (fs.existsSync(DET_FILE) ? fs.statSync(DET_FILE).size : 0);
export const recBytes = () => (fs.existsSync(REC_FILE) ? fs.statSync(REC_FILE).size : 0);
export const modelsReady = () => detBytes() > 8 * 1024 * 1024 && recBytes() > 100 * 1024 * 1024;

/** 取消正在进行的模型下载 */
export function cancelFaceInstall() {
  const abort = getInstallAbort();
  if (!modelState.downloading || !abort) return false;
  modelState.message = '正在取消…';
  try {
    abort.abort(new Error('用户取消下载'));
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * 下载两个权重（~191MB），进度写 jobs 表，可在任务中心取消。
 * 返回值只表示成功/抛错；状态请调用方自己取 faceStatus()（避免 model.js 反向依赖 status.js）。
 */
export async function installModels() {
  if (modelState.downloading) throw new Error('正在下载中，请稍候');
  modelState.downloading = true;
  modelState.progress = 0;
  modelState.error = '';
  modelState.cancelled = false;
  modelState.message = '准备下载…';
  const abort = new AbortController();
  setInstallAbort(abort);
  const signal = abort.signal;
  const jobId = createJob({ kind: 'model-install', title: '人脸模型（SCRFD + ArcFace）', payload: { model: 'face' } });
  // 镜像前缀：downloadModelFile 自己拼 repoPath（以前传整条文件 URL，路径重复永远 404）
  const mirrorBases = MIRRORS.map((m) => `${m}${REPO}/resolve/main/`);
  try {
    modelState.message = '下载检测模型（约 17MB）…';
    await downloadModelFile({
      mirrors: mirrorBases,
      repoPath: 'models/buffalo_l/det_10g.onnx',
      dest: DET_FILE,
      minBytes: 8 * 1024 * 1024,
      maxBytes: 64 * 1024 * 1024,
      sha256: KNOWN_SHA256[DET_KEY] || '',
      signal,
      onProgress: (p) => {
        modelState.progress = Math.round(p * 18);
        modelState.message = `下载检测模型 ${Math.round(p * 100)}%（约 17MB）`;
        jobProgress(jobId, { progress: modelState.progress, message: modelState.message });
      },
    });
    modelState.message = '下载特征模型（约 174MB）…';
    await downloadModelFile({
      mirrors: mirrorBases,
      repoPath: 'models/buffalo_l/w600k_r50.onnx',
      dest: REC_FILE,
      minBytes: 100 * 1024 * 1024,
      maxBytes: 512 * 1024 * 1024,
      sha256: KNOWN_SHA256[REC_KEY] || '',
      signal,
      onProgress: (p) => {
        modelState.progress = 18 + Math.round(p * 80);
        modelState.message = `下载特征模型 ${Math.round(p * 100)}%（约 174MB）`;
        jobProgress(jobId, { progress: modelState.progress, message: modelState.message });
      },
    });
    // 下载器已校验，这里再复核一次：防止 sha256 清单缺失时把坏权重当成好的
    const det = await verifyModelFileDetailed(DET_FILE, { minBytes: 8 * 1024 * 1024, sha256: KNOWN_SHA256[DET_KEY] || '' });
    if (!det.ok) throw new Error(`检测模型校验未通过（${det.reason || '哈希不匹配'}），请重试安装`);
    const rec = await verifyModelFileDetailed(REC_FILE, { minBytes: 100 * 1024 * 1024, sha256: KNOWN_SHA256[REC_KEY] || '' });
    if (!rec.ok) throw new Error(`特征模型校验未通过（${rec.reason || '哈希不匹配'}），请重试安装`);
    modelState.progress = 100;
    modelState.message = det.verified && rec.verified ? '下载完成（已比对可信哈希）' : '下载完成（已记录哈希，未与清单比对）';
    // 换了权重必须丢掉旧会话，下次扫描才会按新文件重新加载
    sessionPromise = null;
    finishJob(jobId, { status: 'done', result: { verified: det.verified && rec.verified } });
  } catch (err) {
    const cancelled = /已取消/.test(String(err?.message || ''));
    modelState.cancelled = cancelled;
    modelState.error = cancelled ? '' : String(err?.message || err).slice(0, 200);
    modelState.message = cancelled ? '已取消下载' : modelState.message;
    // 坏文件必须删掉：留着会让「已下载」显示为真，下次扫描直接报推理失败
    await fsp.rm(DET_FILE, { force: true }).catch(() => {});
    await fsp.rm(REC_FILE, { force: true }).catch(() => {});
    finishJob(jobId, { status: cancelled ? 'canceled' : 'failed', error: modelState.error });
    throw err;
  } finally {
    modelState.downloading = false;
    setInstallAbort(null);
  }
}

/** 加载两个 ONNX 会话（模块级缓存；校验失败删坏文件并置空，允许重装后重试） */
export function getSessions() {
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
    const det = await createOrtSession(ort, DET_FILE, '人脸检测 SCRFD');
    const rec = await createOrtSession(ort, REC_FILE, '人脸特征 ArcFace');
    return { ort, det, rec };
  })().catch((err) => {
    sessionPromise = null;
    throw err;
  });
  return sessionPromise;
}

/**
 * 删除两个权重（下载中心用）。
 * 先把 ONNX 会话放掉：Windows 上文件被句柄占着时 rm 会 EPERM，
 * 光删文件会留下「界面显示已删、实际还占 191MB」的假象。
 */
export async function removeModels() {
  if (modelState.downloading) throw new Error('人脸模型正在下载，请稍后再试');
  const s = sessionPromise;
  sessionPromise = null;
  try {
    const sess = s ? await s.catch(() => null) : null;
    await sess?.det?.release?.();
    await sess?.rec?.release?.();
  } catch {
    /* 老版本 runtime 没有 release；删不掉时下面的 rm 会抛真实原因 */
  }
  await fsp.rm(DET_FILE, { force: true });
  await fsp.rm(REC_FILE, { force: true });
}
