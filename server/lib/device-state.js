// @ts-check
/**
 * 「这台机器上的显卡后端已经试过、结果崩了」的持久化记录。
 *
 * 为什么要落盘而不是只记在内存：显卡后端（Windows 的 DirectML、Linux 的 CUDA）
 * 出问题的方式有两种——
 *   1. 建会话时抛 JS 异常：进程还能活，记住结论就行；
 *   2. 建会话时原生崩溃（0xC0000005）：整个服务进程被系统打死，JS 层没有任何机会
 *      执行 catch，也就没法记「别再用显卡了」。下次启动照样撞同一堵墙，启动失败循环。
 * 所以第 2 种只能由「外面的人」记：Electron 主进程看到子进程以原生崩溃码退出时
 * 写这个文件；下次子进程启动时读它，直接走 CPU。
 *
 * 升级后自动重试一次：ORT / 驱动 / 本程序任何一个变了，那堵墙可能已经不在，
 * 而用户没有义务知道去删哪个文件。所以记录里带 version，版本不一致即视为过期。
 *
 * 文件位置：<用户数据目录>/data/ai/device-state.json
 * 手动恢复：删掉该文件（日志里会把完整路径打出来）。
 *
 * 第 2 种情况的另一半责任在服务进程自己身上（gpuProbe）：
 * 真正去建显卡会话之前先落一个 probing 标记，建成后清掉。进程若在这中途被
 * 原生崩溃打死，标记就留在盘上，下次启动据此直接走 CPU。
 * 这样 `npm run dev`（没有 Electron 主进程看着退出码）也能自愈，
 * 否则开发环境会陷入「每次启动都崩、永远修不好」的死循环。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库/应用根目录。**不要**改成从 server/config.js 取 APP_ROOT：
 * 本模块被 Electron 主进程静态引用（server-host.js → device-state），而主进程是
 * 「先求值整张 import 图、再执行 main.js 函数体」，那时 TUKU_USER_DATA 还没注入。
 * config.js 在被求值时就会 mkdirSync 建目录，于是打包版会拿 app.asar 当根目录,
 * Windows 下直接 ENOTDIR、整个应用起不来（1.2.18 构建时的真实事故）。
 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEVICE_STATE_FILE = 'device-state.json';

/**
 * 盘上那张小纸条的形状。
 * `probing` 表示「进程正在试显卡」，其余字段是「试完的结论」。
 * @typedef {{ gpuDisabled?: boolean, probing?: boolean, reason?: string, at?: string, code?: number, version?: string }} DeviceState
 */

/** 原生崩溃码 → 人话。都是 NTSTATUS 的 0xC0000xxx 段 */
const NATIVE_CRASH_TEXT = {
  0xc0000005: '内存访问违例',
  0xc000001d: '非法指令',
  0xc00000fd: '栈溢出',
  0xc0000374: '堆损坏',
  0xc0000409: '栈缓冲区溢出（进程被系统终止）',
  0xc0000135: '缺少依赖 DLL',
};

/**
 * 进程退出码是否是原生崩溃。
 * Windows 上这类码以有符号整数传回来（0xC0000005 → -1073741819 或 3221225477），
 * 统一按无符号比较。
 * @param {unknown} code
 */
export function isNativeCrashCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return false;
  const u = code >>> 0;
  return u >= 0xc0000000 && u <= 0xc0000500;
}

/** 崩溃码 → 可读文本，例如 `0xC0000005（内存访问违例）` */
export function crashText(code) {
  const u = typeof code === 'number' ? code >>> 0 : 0;
  const hex = `0x${u.toString(16).toUpperCase().padStart(8, '0')}`;
  const hint = NATIVE_CRASH_TEXT[/** @type {keyof typeof NATIVE_CRASH_TEXT} */ (u)];
  return hint ? `${hex}（${hint}）` : hex;
}

/** 环境变量强制走 CPU（排查用，也用于崩溃后本次会话的降级重启） */
export function gpuForcedOff(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.TUKU_FORCE_CPU || '').trim());
}

let cachedVersion = null;

/** 本程序版本：升级后允许重试显卡（驱动 / ORT 可能已经好了） */
export function appVersion() {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    cachedVersion = String(pkg.version || '');
  } catch {
    /* 读不到就不做版本判断 */
  }
  return cachedVersion;
}

/** 默认的用户数据根目录（口径与 server/config.js 的 USER_ROOT 一致：环境变量优先） */
export function defaultUserRoot(env = process.env) {
  return env.TUKU_USER_DATA || APP_ROOT;
}

/** @param {string} userRoot */
export function statePath(userRoot) {
  return path.join(userRoot, 'data', 'ai', DEVICE_STATE_FILE);
}

/**
 * 读旧结论；文件不存在 / 损坏都返回 null（损坏等同于没有结论，不能因此永久禁用显卡）
 * @param {string} userRoot
 * @returns {DeviceState | null}
 */
export function readDeviceState(userRoot) {
  try {
    const raw = fs.readFileSync(statePath(userRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 写入结论（合并到已有内容之上）
 * @param {string} userRoot
 * @param {Record<string, unknown>} patch
 */
export function writeDeviceState(userRoot, patch) {
  const file = statePath(userRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prev = readDeviceState(userRoot) || {};
    fs.writeFileSync(file, `${JSON.stringify({ ...prev, ...patch }, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn('[gpu] 记录显卡状态失败：', err instanceof Error ? err.message : err);
    return false;
  }
}

/** 清掉结论（用户手动「重新尝试显卡」或版本升级后自动调用） */
export function clearDeviceState(userRoot) {
  try {
    fs.rmSync(statePath(userRoot), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录「正在尝试显卡」。
 * 这张小纸条的唯一用途：进程若在建会话阶段原生崩溃，JS 层没有任何机会收尾，
 * 下次启动看到它还在，就知道该走 CPU 了。
 * @param {string} userRoot
 */
export function writeGpuProbe(userRoot) {
  return writeDeviceState(userRoot, { probing: true, at: new Date().toISOString(), version: appVersion() });
}

/** 显卡会话建成（或已明确失败）后撤掉纸条；其余字段保留 */
export function clearGpuProbe(userRoot) {
  const st = readDeviceState(userRoot);
  if (!st?.probing) return false;
  return writeDeviceState(userRoot, { probing: false });
}

/**
 * 记录是否说明「上次死在试显卡阶段」。
 * 只有 true 才算：字段缺失、文件损坏、正常记录（probing:false）都不降级，
 * 否则一次误判会让显卡加速永久失效。
 * @param {DeviceState | Record<string, unknown> | null | undefined} st
 */
export function gpuProbeCrashed(st) {
  return !!st && typeof st === 'object' && /** @type {DeviceState} */ (st).probing === true;
}
