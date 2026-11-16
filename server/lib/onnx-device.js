// @ts-check
/**
 * 本地模型的推理设备选择：能让显卡干的，就别让 CPU 干。
 *
 * Windows 走 DirectML（onnxruntime-node 自带 dml 二进制，NVIDIA / AMD / Intel 核显都能用），
 * Linux x64 走 CUDA，其余平台保持 CPU。两条路都留了回退：
 * 显卡驱动太老、显存不够、或者某个算子 DML 没实现时，ORT 会在建会话阶段抛出来——
 * 这时退回纯 CPU 再建一次，而不是把一串 DML 报错甩给用户。
 *
 * 为什么不是「先探测有没有显卡再决定」：判断有无显卡本身要建一个会话（或者装一个
 * 额外的原生探测库），代价比直接试一次高。试一次的失败成本就几十毫秒，且失败后
 * 进程内记住结论，后面的模型不再重复撞墙。
 */
import process from 'node:process';

let gpuDisabled = false; // 本进程内已经确认显卡后端用不了
let backend = null; // 'directml' | 'cuda' | 'cpu'，成功建过一次会话后才知道

/** 这个平台理论上有没有 GPU 的 EP 可用 */
export function gpuCandidate() {
  if (gpuDisabled) return false;
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux' && process.arch === 'x64') return true;
  return false;
}

/** 给 transformers.js 的 device：'auto' 会按 dml/cuda → cpu 的顺序挑 */
export function preferredDevice() {
  return gpuCandidate() ? 'auto' : 'cpu';
}

/** 给裸 onnxruntime-node 的 executionProviders（顺序即优先级） */
export function ortProviders() {
  if (process.platform === 'win32') return ['dml', 'cpu'];
  if (process.platform === 'linux' && process.arch === 'x64') return ['cuda', 'cpu'];
  return ['cpu'];
}

function fallbackLabel() {
  return process.platform === 'win32' ? 'DirectML' : 'CUDA';
}

/** 记录成功使用的后端；只用于界面显示「现在跑在哪」 */
export function noteBackend(used) {
  backend = used;
}

/** 供硬件说明 / 设置页展示 */
export function gpuStatus() {
  const candidate = gpuCandidate();
  return {
    platform: process.platform,
    arch: process.arch,
    /** 当前进程实际用上的后端（还没跑过推理时是 null） */
    backend,
    /** 这台机器试过、且结论是「显卡能用」 */
    gpuUsable: backend === 'directml' || backend === 'cuda',
    /** 理论上可以尝试（不代表一定成功） */
    candidate,
    /** 试过并失败了，本进程内已退回 CPU */
    disabledForSession: gpuDisabled,
    note: candidate
      ? `${fallbackLabel()} 优先，失败自动回退 CPU`
      : '该平台没有可用的 GPU 执行器，走 CPU',
  };
}

/**
 * 裸 onnxruntime-node：先按 GPU 建会话，失败退回 CPU。
 * @param {{ InferenceSession: { create: (f: string, o?: any) => Promise<any> } }} ort
 * @param {string} file 模型文件
 * @param {string} [label] 日志用标签
 */
export async function createOrtSession(ort, file, label = '') {
  if (gpuCandidate()) {
    try {
      const session = await ort.InferenceSession.create(file, { executionProviders: ortProviders() });
      noteBackend(process.platform === 'win32' ? 'directml' : 'cuda');
      return session;
    } catch (err) {
      gpuDisabled = true;
      console.info('[gpu] 显卡后端建会话失败，本进程改用 CPU', label, '·', err?.message || err);
    }
  }
  noteBackend('cpu');
  return ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
}

/**
 * transformers.js 的 pipeline / 模型加载：先 auto（有卡就用卡），失败退回 cpu。
 * @template T
 * @param {(device: string) => Promise<T>} create
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export async function withDevicePreference(create, label = '') {
  if (gpuCandidate()) {
    try {
      const out = await create(preferredDevice());
      noteBackend(process.platform === 'win32' ? 'directml' : 'cuda');
      return out;
    } catch (err) {
      gpuDisabled = true;
      console.info('[gpu] 显卡后端不可用，本进程改用 CPU', label, '·', err?.message || err);
    }
  }
  noteBackend('cpu');
  return create('cpu');
}
