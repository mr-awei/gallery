// @ts-check
/**
 * 运行环境检测 + 安装。
 *
 * 目的：onnxruntime-node 的原生二进制依赖链（onnxruntime_binding.node → onnxruntime.dll →
 * DirectML.dll）要求用户机器有 Microsoft Visual C++ Redistributable 和较新的 DirectML。
 * 缺任何一环都会在 DLL 加载阶段失败 —— 1.2.24 发布后，有用户反馈「本服务没能启动」，
 * 根因就是这台机器没装 VC++ Runtime。
 *
 * 以前：这些依赖是"装包隐式要求"，用户不知道自己缺什么，也无从补。
 * 现在：在下载中心顶部放一个「运行环境」分组，应用自己检测、自己下载、一键安装。
 *
 * 检测方法（注册表 + 原生模块探针双通道）：
 *   - VC++ Runtime：读 HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\{arch}
 *     Installed=1 才算装了；这个注册表键是 VS 2015+ 全家桶（2016/2017/2019/2022）统一写入的。
 *   - onnxruntime：直接 try require('onnxruntime-node') —— 一次就覆盖 VC++ + DirectML +
 *     asar 解包 + 平台包齐全度；比查注册表更准。
 *   - sharp：同上，sharp 的 libvips 也是原生二进制，顺便探针。
 *
 * 安装流程：
 *   1. 下载安装器到 DATA_DIR/.installer-cache/，有进度回调
 *   2. 用 execFileSync 执行静默安装（vc_redist 自带 /S /NORESTART）
 *   3. 安装完重新检测，返回最新状态
 *
 * 为什么不用 winget：不是所有 Windows 都有 winget（LTSC / 教育版常被裁掉）。
 * 为什么不用 DISM：VC++ Runtime 不是系统组件，DISM 管不了。
 * 必须走安装器包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { URL } from 'node:url';
import { DATA_DIR } from '../config.js';

/** 安装器缓存目录：下载完放这里，避免每次重新下 */
const CACHE_DIR = path.join(DATA_DIR, '.installer-cache');

/** 要检测/可安装的运行时组件清单 */
const COMPONENTS = [
  {
    id: 'vcpp_x64',
    platform: 'win32',
    label: 'Microsoft Visual C++ Runtime (x64)',
    desc: 'onnxruntime / 等原生模块的运行时基础；未安装时 AI 功能全部不可用、服务可能启动崩溃。',
    critical: true,
    /** 注册表：VS 2015-2022 统一用的键；Installed=1 才算装了 */
    registryKey: 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
    registryValue: 'Installed',
    installerUrl: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    installerName: 'vc_redist.x64.exe',
    sizeHint: 24_000_000, // ~24MB
  },
  {
    id: 'vcpp_x86',
    platform: 'win32',
    label: 'Microsoft Visual C++ Runtime (x86)',
    desc: '部分老原生模块（jpegtran / onnxruntime-web fallback）需要；可选但建议一并安装。',
    critical: false,
    registryKey: 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86',
    registryValue: 'Installed',
    installerUrl: 'https://aka.ms/vs/17/release/vc_redist.x86.exe',
    installerName: 'vc_redist.x86.exe',
    sizeHint: 22_000_000, // ~22MB
  },
];

/** 原生模块探针（这些检测能直接反映"AI 功能能不能用"） */
const NATIVE_PROBES = [
  {
    id: 'onnxruntime',
    label: 'ONNX Runtime',
    desc: 'AI 语义搜图 / AI 超分 的推理引擎；依赖 VC++ Runtime + DirectML / CPU。',
    probe: () => {
      const { createRequire } = require('node:module');
      const req = createRequire(import.meta.url);
      const ort = req('onnxruntime-node');
      // 成功加载 ≠ 能建会话，但能加载说明 DLL 链完整
      return { ok: true, version: String(ort?.version || ort?.env?.versions?.onnx || 'ok') };
    },
  },
  {
    id: 'sharp',
    label: 'Sharp (libvips)',
    desc: '图片处理底层；缺了水印、缩略图、拼图都跑不起来。',
    probe: () => {
      const sharp = require('sharp');
      // @ts-expect-error sharp 的类型导出没有 .version；运行时 .versions.vips 才是 libvips 版本
      return { ok: true, version: String(sharp?.versions?.vips || sharp?.version || 'ok') };
    },
  },
];

/** 平台适配：非 Windows 直接返回空，前端不展示这些条目 */
function supported() {
  return process.platform === 'win32';
}

/**
 * 读注册表（Windows only）。
 * 用 reg query 命令：Node 的 child_process 跑 reg.exe 比引入 WinAPI 方便得多。
 * 返回 null 表示键不存在；返回字符串表示值存在。
 */
function readRegistry(key, valueName = 'Installed') {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', key, '/v', valueName, '/t', 'REG_DWORD'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    // reg query 输出里值行长这样：
    //   Installed    REG_DWORD    0x1
    const match = out.match(new RegExp(`${valueName}\\s+REG_DWORD\\s+(0x[0-9a-fA-F]+|\\d+)`));
    if (!match) return null;
    const raw = match[1];
    return raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
  } catch {
    // 键不存在 / reg.exe 找不到都归为 null
    return null;
  }
}

/** 检测所有组件 */
export function checkRuntime() {
  if (!supported()) {
    return {
      platform: process.platform,
      supported: false,
      components: [],
      probes: [],
      summary: { total: 0, installed: 0, missing: 0, criticalMissing: 0 },
    };
  }

  const components = COMPONENTS.map((c) => {
    const val = readRegistry(c.registryKey, c.registryValue);
    const installed = val === 1; // Installed=1 才算装了（0 表示装过但被卸载）
    return {
      id: c.id,
      label: c.label,
      desc: c.desc,
      critical: c.critical,
      installed,
      installerUrl: c.installerUrl,
      installerName: c.installerName,
      sizeHint: c.sizeHint,
      localPath: path.join(CACHE_DIR, c.installerName),
    };
  });

  const probes = NATIVE_PROBES.map((p) => {
    try {
      const r = p.probe();
      return { id: p.id, label: p.label, desc: p.desc, ok: Boolean(r?.ok), version: r?.version || '' };
    } catch (err) {
      return {
        id: p.id,
        label: p.label,
        desc: p.desc,
        ok: false,
        error: err?.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200),
      };
    }
  });

  const installed = components.filter((c) => c.installed).length;
  const total = components.length;
  const missing = total - installed;
  const criticalMissing = components.filter((c) => c.critical && !c.installed).length;

  return {
    platform: process.platform,
    supported: true,
    components,
    probes,
    summary: { total, installed, missing, criticalMissing },
  };
}

/**
 * 下载安装器到本地缓存，带进度回调。
 * Node 22+ 有全局 fetch，但 streaming body 的写法有点绕，用 http/https 模块更稳。
 */
export function downloadInstaller(id, { onProgress } = /** @type {{onProgress?: (p: {progress: number, message: string}) => void}} */ ({})) {
  const comp = COMPONENTS.find((c) => c.id === id);
  if (!comp) return Promise.reject(new Error(`未知的运行时组件: ${id}`));
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, comp.installerName);

  // 已下载完整（用 sizeHint 作为近似判断；真正严谨需要哈希，这里先用轻量判断）
  if (fs.existsSync(dest)) {
    const stat = fs.statSync(dest);
    if (stat.size > 5_000_000) {
      onProgress?.({ progress: 100, message: '已存在，跳过下载' });
      return Promise.resolve({ ok: true, path: dest, skipped: true });
    }
    // 半截损坏 → 删掉重下
    fs.rmSync(dest, { force: true });
  }

  return new Promise((resolve, reject) => {
    const isHttps = comp.installerUrl.startsWith('https');
    const mod = isHttps ? require('node:https') : require('node:http');
    const url = new URL(comp.installerUrl);

    const req = mod.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'user-agent': 'TuKu-Gallery/1.2' },
      timeout: 120_000,
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('下载超时'));
    });

    req.on('response', (res) => {
      // 微软 CDN 有时会 302 重定向，手动跟随一次
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url.href);
        mod.get(redirectUrl, (redirectRes) => {
          pipeBody(redirectRes, dest, comp.sizeHint, onProgress, resolve, reject);
        }).on('error', reject);
        return;
      }
      pipeBody(res, dest, comp.sizeHint, onProgress, resolve, reject);
    });
  });
}

function pipeBody(res, dest, sizeHint, onProgress, resolve, reject) {
  if (res.statusCode >= 400) {
    reject(new Error(`下载失败 HTTP ${res.statusCode}`));
    return;
  }
  const total = parseInt(res.headers['content-length'] || String(sizeHint), 10);
  let received = 0;
  const write = fs.createWriteStream(dest);
  res.on('data', (chunk) => {
    received += chunk.length;
    const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
    onProgress?.({ progress: pct, message: `下载中 ${pct}% (${(received / 1_000_000).toFixed(1)} MB)` });
  });
  res.pipe(write);
  write.on('error', reject);
  write.on('close', () => {
    onProgress?.({ progress: 100, message: '下载完成' });
    resolve({ ok: true, path: dest });
  });
}

/**
 * 静默执行安装器（/S /NORESTART）。
 * vc_redist 的 /S 是"完全静默"；/NORESTART 防止装完强制重启。
 * 需要管理员权限时，UAC 弹窗由 exe 自己触发，应用无法绕过。
 */
export function runInstaller(id) {
  const comp = COMPONENTS.find((c) => c.id === id);
  if (!comp) return Promise.reject(new Error(`未知的运行时组件: ${id}`));
  const dest = path.join(CACHE_DIR, comp.installerName);
  if (!fs.existsSync(dest)) return Promise.reject(new Error(`安装器尚未下载，请先调用 download`));

  return new Promise((resolve, reject) => {
    const proc = spawn(dest, ['/S', '/NORESTART'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 需要管理员；shell: false 让 UAC 正常弹
      shell: false,
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      // vc_redist 返回码：0 成功；3010 成功但需重启；其他是失败
      if (code === 0 || code === 3010) {
        resolve({ ok: true, needsReboot: code === 3010 });
      } else {
        reject(new Error(`安装失败（退出码 ${code}）${stderr ? ': ' + stderr.slice(0, 200) : ''}`));
      }
    });
  });
}
