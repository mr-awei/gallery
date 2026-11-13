import { api } from '../api';
import { hardwareGate } from '../components/Dialogs';
import type { HardwareReport } from '../types';

/**
 * 大模型功能的硬件门槛（前端这一侧）。
 *
 * 分工：判定全在服务端 `server/lib/hardware.js`（最低配置表 + 探测都在那边），
 * 这里只做三件事：缓存一份报告、按模型名映射到功能、不达标时弹一次说明。
 *
 * 一条硬规矩：**探测失败不挡人**。读不到硬件信息时返回 true，让功能照常去试，
 * 底层真跑不动会自己报错；反过来「读不到就禁止使用」等于用一次 PowerShell 超时
 * 把能用的机器全锁死。
 */

let cache: HardwareReport | null = null;
let inflight: Promise<HardwareReport | null> | null = null;

/** 取硬件报告（默认走缓存；refresh=true 强制服务端重探） */
export async function loadHardware(refresh = false): Promise<HardwareReport | null> {
  if (!refresh && cache) return cache;
  if (!refresh && inflight) return inflight;
  const p = api
    .hardware(refresh)
    .then((r) => {
      cache = r;
      return r;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  inflight = p;
  return p;
}

/** 设置页「重新检测」用：清缓存并重探 */
export async function refreshHardware(): Promise<HardwareReport | null> {
  cache = null;
  return loadHardware(true);
}

/** 测试/切库后清缓存 */
export function clearHardwareCache() {
  cache = null;
  inflight = null;
}

/**
 * 模型标识 → 硬件门槛功能 id。
 * - `onnx:` 前缀 = Swin2SR 这类 Transformer 档，走 onnxruntime CPU，吃内存
 * - `ai-*` / `esrgan:` / `cugan:` = realesrgan-ncnn-vulkan 外部程序，必须有 Vulkan 显卡
 * - 其余（内置插值 / sharp 重采样）不碰模型，返回空串 = 不用检查
 */
export function hardwareFeatureForModel(modelId: string): string {
  const id = String(modelId || '');
  if (!id) return '';
  if (id.startsWith('onnx:')) return 'upscale-onnx';
  if (id.startsWith('ai-') || id.startsWith('esrgan:') || id.startsWith('cugan:')) return 'upscale-vulkan';
  return '';
}

/**
 * 开跑前的硬件关口：达标直接返回 true（不弹窗），不达标弹说明，
 * 用户选「仍然继续」才返回 true。没有 dialog host（比如测试环境）时按不通过处理。
 */
export async function ensureHardware(featureId: string): Promise<boolean> {
  if (!featureId) return true;
  const report = await loadHardware();
  if (!report) return true; // 探测失败不挡人，见文件头
  const feature = report.features.find((f) => f.id === featureId);
  if (!feature || feature.level === 'ok') return true;
  return hardwareGate(feature, report.hardware);
}
