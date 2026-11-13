// @ts-check
/**
 * 本机硬件探测 + 「大模型功能最低配置」判定。
 *
 * 为什么要这一层：抠图 / 超分这类功能要么吃内存、要么必须有一块能跑 Vulkan 的显卡，
 * 用户点下去才发现跑不动（黑图、闪退、几分钟无响应）时根本不知道是机器不行还是软件坏了。
 * 所以在真正开跑之前先把「你的配置」和「最低配置」摆在一起，不达标就明说原因。
 *
 * 关于数字的诚实口径（不能编）：
 * - Real-ESRGAN-ncnn-vulkan 官方 README **没有** 最低显卡/显存表，只说明它走 Vulkan、
 *   没有 CPU 开关、显存靠 `-t tile-size` 控制。这里「显存约 1GB」是我们按 x4plus
 *   默认 tile 的保守阈值，文案里必须写成「估算/保守阈值」，不能写成官方要求。
 * - onnxruntime 官方兼容页只承诺 Windows 10 实测，同样不发布内存与指令集下限；
 *   抠图/超分的内存门槛是按「权重常驻 + 输入 1024² 中间张量」的峰值估算。
 * - 消除（擦除修复）**不用模型也不用显卡**：`lib/inpaint.js` 是 chamfer 距离变换 +
 *   邻域 Jacobi 平滑的纯像素算法。它在表里存在的意义是「说清它不需要检查」，
 *   不能为了凑数给它编一条显卡要求。
 *
 * 探测本身跨平台尽力而为：读不到显卡就如实回 `unknown`，绝不当成「没有显卡」。
 */
import os from 'node:os';
import { execFile } from 'node:child_process';

const GB = 1024;
const MB = 1048576;

/* ------------------------------ 硬件探测 ------------------------------ */

/** @returns {{ model: string, cores: number, speedMHz: number, arch: string, platform: string, release: string }} */
export function readCpu() {
  const cpus = os.cpus() || [];
  return {
    model: String(cpus[0]?.model || '').trim() || '未知处理器',
    cores: cpus.length,
    speedMHz: Math.round(Number(cpus[0]?.speed) || 0),
    arch: process.arch,
    platform: process.platform,
    release: os.release(),
  };
}

/** 内存单位 MB；freeMB 是探测那一刻的余量，只用于「当前是否紧张」的提示 */
export function readRam() {
  return {
    totalMB: Math.round(os.totalmem() / MB),
    freeMB: Math.round(os.freemem() / MB),
  };
}

/**
 * 显卡名字里的关键字分类：基础显示适配器 / 虚拟显卡不可能跑 Vulkan 推理。
 * 这是纯函数，单测直接喂名字即可。
 * @param {string} name
 * @returns {'real' | 'basic' | 'virtual'}
 */
export function classifyGpu(name) {
  const n = String(name || '').toLowerCase();
  if (!n.trim()) return 'basic';
  if (/basic (display|render)|microsoft basic|标准 vga|generic pnp/.test(n)) return 'basic';
  if (/remote|parsec|virtualbox|vmware|hyper-v|virtual display|citrix|spacedesk|todesk|向日葵/.test(n)) {
    return 'virtual';
  }
  return 'real';
}

/**
 * 解析 Windows `Win32_VideoController` 的 JSON 输出（纯函数，便于单测）。
 * `AdapterRAM` 是 uint32，超过 4GB 会溢出成小值/0，这种情况如实回 null 而不是编一个数。
 * @param {unknown} raw 已 JSON.parse 的对象或数组
 */
export function parseWindowsGpus(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((d) => {
      const o = /** @type {any} */ (d) || {};
      const name = String(o.Name || '').trim();
      if (!name) return null;
      const bytes = Number(o.AdapterRAM) || 0;
      // 0 或明显溢出（>4GB 会被 uint32 截断成很小的值）都不可信
      const vramMB = bytes > 0 ? Math.round(bytes / MB) : null;
      return {
        name,
        vramMB,
        driver: String(o.DriverVersion || '').trim(),
        kind: classifyGpu(name),
      };
    })
    .filter(Boolean);
}

/** macOS `system_profiler SPDisplaysDataType` 文本里抠显卡名（纯函数） */
export function parseMacGpus(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /Chipset Model:\s*(.+)$/.exec(line);
    if (m) {
      const name = m[1].trim();
      out.push({ name, vramMB: null, driver: '', kind: classifyGpu(name) });
    }
  }
  return out;
}

/** Linux `lspci` 输出里的 VGA / 3D 控制器（纯函数） */
export function parseLspci(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/(vga compatible|3d controller|display controller)/i.test(line)) continue;
    const name = line.replace(/^[0-9a-f:.]+\s+\S+:\s*/i, '').trim();
    if (name) out.push({ name, vramMB: null, driver: '', kind: classifyGpu(name) });
  }
  return out;
}

function execText(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * MB }, (err, stdout) => {
        // 读不到就回空串：调用方据此说「读不到」，不要抛错把整个报告带塌
        resolve(err ? '' : String(stdout || ''));
      });
    } catch {
      resolve('');
    }
  });
}

/** 平台相关的显卡枚举；失败一律回空数组（= 不知道，不是「没有」） */
async function probeGpus() {
  if (process.platform === 'win32') {
    const out = await execText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress',
    ]);
    if (!out.trim()) return [];
    try {
      return parseWindowsGpus(JSON.parse(out));
    } catch {
      return [];
    }
  }
  if (process.platform === 'darwin') {
    return parseMacGpus(await execText('system_profiler', ['SPDisplaysDataType'], 8000));
  }
  return parseLspci(await execText('lspci', [], 4000));
}

/**
 * Vulkan 能不能用的判定（纯函数）。
 * 真正的判决权在运行库自检：这里只能回答「有没有一块像样的显卡」，
 * 所以有显卡时给 unknown/true 级别的结论，并把「最终以自检为准」写进 reason。
 * @param {Array<{name: string, kind: string, vramMB: number|null}>} devices
 * @param {{ usable: boolean|null, gpu: string|null, error: string }} [evidence] 运行库自检结果
 */
export function vulkanVerdict(devices, evidence) {
  if (evidence && evidence.usable === true) {
    return {
      capable: true,
      reason: `运行库自检已通过（显卡：${evidence.gpu || '未报告'}）`,
    };
  }
  if (evidence && evidence.usable === false) {
    return {
      capable: false,
      reason: `运行库自检失败：${evidence.error || '未知原因'}`,
    };
  }
  if (!devices.length) {
    return {
      capable: null,
      reason: '没能读到显卡列表（驱动或系统限制），无法判断是否支持 Vulkan',
    };
  }
  const real = devices.filter((d) => d.kind === 'real');
  if (!real.length) {
    return {
      capable: false,
      reason: '只检测到基础显示适配器或虚拟显卡，没有能跑 Vulkan 推理的显卡',
    };
  }
  return {
    capable: null,
    reason: `检测到显卡 ${real.map((d) => d.name).join(' / ')}；Vulkan 是否可用以运行库自检为准`,
  };
}

let cache = null;
let cacheAt = 0;
const TTL = 30_000;

/**
 * 运行库自检结果（显卡名 + 能不能真跑）。
 * 按需加载：纯函数单测不该被 ai-upscale 的原生依赖拖累；模块缓存后开销可忽略。
 */
async function readSelfTest() {
  try {
    const { aiStatus } = await import('../ai-upscale.js');
    const st = aiStatus();
    return { usable: st.usable ?? null, gpu: st.gpu || null, error: st.error || '' };
  } catch {
    return null;
  }
}

/**
 * 本机硬件快照（带 30s 缓存：探测要起 PowerShell，不能每个请求都跑一次）。
 * @param {{ refresh?: boolean }} [opts]
 */
export async function probeHardware(opts = {}) {
  if (!opts.refresh && cache && Date.now() - cacheAt < TTL) return cache;
  const devices = await probeGpus();
  const evidence = await readSelfTest();
  cache = {
    cpu: readCpu(),
    ram: readRam(),
    gpu: {
      devices,
      vulkan: vulkanVerdict(devices, evidence || undefined),
      /** 运行库自检记录（未装/未自检时 usable 为 null，不代表不可用） */
      selfTest: evidence,
    },
    probedAt: new Date().toISOString(),
  };
  cacheAt = Date.now();
  return cache;
}

/** 单测/测试用：清掉缓存 */
export function resetHardwareCache() {
  cache = null;
  cacheAt = 0;
}

/* --------------------------- 最低配置与判定 --------------------------- */

/**
 * 「大模型功能」的最低配置表。
 * - `checks` 由 evaluateFeature 按 min 生成，`hard: true` 的项不满足 = 直接不能跑。
 * - `canProceedAnyway` 表示「性能不足但仍允许用户试一把」（慢、可能失败，但不会必然崩）。
 */
export const HARDWARE_FEATURES = [
  {
    id: 'matting',
    label: 'AI 抠图（去背景）',
    engine: 'onnxruntime-node · CPU 推理',
    models: 'U-2-Net 4.5MB / BiRefNet lite 224MB / BEN2 213MB，输入 1024×1024',
    min: { ramMB: 4096, cores: 2 },
    recommend: { ramMB: 8192, cores: 4 },
    basis: [
      'onnxruntime 官方兼容页只承诺 Windows 10 实测，不发布内存与 CPU 指令集下限',
      '内存门槛按「224MB 权重常驻 + 1024² 中间张量」的峰值估算（约 1.5GB），留一倍余量取 4GB',
      '不需要显卡：三档模型都在 CPU 上推理，单张从毫秒级到数秒',
    ],
  },
  {
    id: 'face',
    label: '人脸检测与聚类',
    engine: 'onnxruntime-node · CPU 推理（SCRFD + ArcFace）',
    models: 'det_10g 16.9MB + w600k_r50 174MB，检测 640×640、识别 112×112',
    min: { ramMB: 4096, cores: 2 },
    recommend: { ramMB: 8192, cores: 4 },
    basis: [
      'insightface buffalo_l 两套权重合计约 191MB，扫描时都要常驻内存',
      'onnxruntime 官方不发布内存下限；4GB 按「权重常驻 + 640² 检测批处理」的峰值（约 1.2GB）留余量估',
      '不需要显卡：检测与特征都在 CPU 上跑，扫全库是逐张推理，核心少只影响速度',
      '这一档是「扫一遍全库」的批量活，内存不足更容易在中途被系统结束',
    ],
  },
  {
    id: 'upscale-vulkan',
    label: 'AI 超分（Real-ESRGAN / Real-CUGAN）',
    engine: 'realesrgan-ncnn-vulkan.exe · 外部 Vulkan 程序',
    models: 'x4plus / x4plus-anime / animevideov3，社区 ESRGAN 模型与 CUGAN 降噪档',
    min: { ramMB: 4096, cores: 2, vramMB: 1024, platform: 'win32', arch: 'x64' },
    recommend: { ramMB: 8192, cores: 4, vramMB: 2048 },
    basis: [
      '官方 README 明说它只走 Vulkan、预编译包没有 CPU 开关（要 CPU 只能自行编译 ncnn）',
      '官方没有最低显卡/显存表，显存占用靠 -t tile-size 控制；1GB 是我们按 x4plus 默认 tile 取的保守阈值',
      '运行库只有 Windows x64 的官方包，其他平台给不了可用的 exe',
      '装好后跑一次自检即可确认显卡真能上（设置 → 增强 → 自检）',
    ],
  },
  {
    id: 'upscale-onnx',
    label: 'AI 超分（Swin2SR / Transformer 档）',
    engine: '@huggingface/transformers + onnxruntime-node（CPU）',
    models: 'Swin2SR compressed/realworld/classical/lightweight 四档',
    min: { ramMB: 8192, cores: 4 },
    recommend: { ramMB: 16384, cores: 8 },
    basis: [
      '窗口注意力（window=64）的中间张量比抠图大得多，内存门槛按 8GB 估',
      '官方同样不发布内存下限；这一档 CPU 单张就要数十秒，配置不足时体验极差',
      '不需要显卡：transformers.js 在 onnxruntime 的 CPU 执行器上跑',
    ],
  },
  {
    id: 'inpaint',
    label: '消除（擦除修复）',
    engine: '纯像素算法（chamfer 距离变换 + 邻域 Jacobi 平滑）',
    models: '不用模型',
    min: {},
    recommend: {},
    basis: [
      '`server/lib/inpaint.js` 是内容感知扩散，不是生成式 AI，也不用显卡',
      '工作副本长边固定 1200，内存占用有上界，普通机器都够',
      '这一行的作用是「说清它不需要硬件检查」，不是编一条要求出来',
    ],
  },
  {
    id: 'semantic',
    label: '语义检索（CLIP）',
    engine: '@huggingface/transformers（CPU）',
    models: 'CLIP ViT-B/32 文本塔 + 图像塔',
    min: { ramMB: 4096, cores: 2 },
    recommend: { ramMB: 8192, cores: 4 },
    basis: [
      '文本塔单次编码几百毫秒，图像塔批量建索引时才会吃满 CPU',
      '权重约 85MB 常驻；4GB 内存在「建索引的同时开浏览器」这种常见组合下才够',
      '不需要显卡',
    ],
  },
];

const featureOf = (id) => HARDWARE_FEATURES.find((f) => f.id === id) || null;

/** 把 MB 说成人话（4 GB / 7.9 GB） */
export function formatMB(mb) {
  const n = Number(mb);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  return n >= 1024 ? `${(n / GB).toFixed(n >= 10240 ? 0 : 1)} GB` : `${Math.round(n)} MB`;
}

/**
 * 判定单个功能是否达标（纯函数，单测喂假的 hw 即可）。
 * @param {any} feature HARDWARE_FEATURES 里的一项
 * @param {any} hw probeHardware 的结果
 */
export function evaluateFeature(feature, hw) {
  const min = feature?.min || {};
  /** @type {any[]} */
  const checks = [];

  if (min.ramMB) {
    const have = Number(hw?.ram?.totalMB) || 0;
    const ok = have >= min.ramMB;
    // 余量低于 1.2GB 视为「能跑但会跟系统抢内存」：达标也要提醒
    const tight = ok && Number(hw?.ram?.freeMB) > 0 && Number(hw.ram.freeMB) < 1200;
    checks.push({
      id: 'ram',
      label: '内存',
      need: `≥ ${formatMB(min.ramMB)}${feature.recommend?.ramMB ? `（建议 ${formatMB(feature.recommend.ramMB)}）` : ''}`,
      have: formatMB(have),
      ok,
      hard: false,
      note: ok ? (tight ? '当前可用内存偏少，先关掉占内存的程序更稳' : '') : '内存不足时可能卡死或直接被系统结束',
    });
  }

  if (min.cores) {
    const have = Number(hw?.cpu?.cores) || 0;
    checks.push({
      id: 'cores',
      label: '处理器核心',
      need: `≥ ${min.cores} 核`,
      have: have ? `${have} 核` : '未知',
      ok: have >= min.cores,
      hard: false,
      note: have >= min.cores ? '' : '核心太少会非常慢，仍可尝试',
    });
  }

  if (min.platform) {
    const have = String(hw?.cpu?.platform || process.platform);
    const ok = have === min.platform && (!min.arch || String(hw?.cpu?.arch || process.arch) === min.arch);
    checks.push({
      id: 'platform',
      label: '系统与架构',
      need: `${min.platform === 'win32' ? 'Windows' : min.platform}${min.arch ? ` ${min.arch}` : ''}`,
      have: `${have}${hw?.cpu?.arch ? ` ${hw.cpu.arch}` : ''}`,
      ok,
      hard: true,
      note: ok ? '' : '运行库只有 Windows x64 的官方包，这一档在当前系统上无法运行',
    });
  }

  if (min.vramMB) {
    const vulkan = hw?.gpu?.vulkan || {};
    const devices = Array.isArray(hw?.gpu?.devices) ? hw.gpu.devices : [];
    // 自检通过 = 真能跑，显卡名字与显存都不必再判
    if (vulkan.capable === true) {
      checks.push({
        id: 'gpu',
        label: '显卡 / Vulkan',
        need: `支持 Vulkan 的显卡（显存约 ${formatMB(min.vramMB)} 起）`,
        have: vulkan.reason,
        ok: true,
        hard: false,
        note: '',
      });
    } else {
      const known = devices.filter((d) => d.kind === 'real');
      const vram = known.map((d) => Number(d.vramMB)).filter((v) => v > 0);
      const vramShort = vram.length > 0 && Math.max(...vram) < min.vramMB;
      checks.push({
        id: 'gpu',
        label: '显卡 / Vulkan',
        need: `支持 Vulkan 的显卡（显存约 ${formatMB(min.vramMB)} 起）`,
        have: vulkan.reason || '未知',
        ok: false,
        // 读不到显卡列表时不下「不能跑」的结论，只提示；真读不到且用户硬要试，交给运行库报错
        hard: vulkan.capable === false,
        note: vulkan.capable === false
          ? '没有可用的 Vulkan 显卡，这一档点了也跑不起来'
          : vramShort
            ? '显存偏小，可能出黑图或中途失败'
            : '运行库装好后会自检确认；也可以先到设置页点「自检」实测',
      });
    }
  }

  const hardFail = checks.some((c) => !c.ok && c.hard);
  const softFail = checks.some((c) => !c.ok && !c.hard);
  const level = hardFail ? 'blocked' : softFail ? 'warn' : 'ok';
  return {
    id: feature.id,
    label: feature.label,
    engine: feature.engine,
    models: feature.models,
    min: min,
    recommend: feature.recommend || {},
    basis: feature.basis || [],
    checks,
    level,
    ok: level === 'ok',
    // 硬性不可用（没有 Vulkan 显卡 / 平台不对）时不给「仍然继续」，避免用户白等；
    // 只是配置偏低（内存/核心不足）时允许试一把
    canProceedAnyway: !hardFail,
    reason:
      level === 'ok'
        ? '满足最低配置'
        : checks.filter((c) => !c.ok).map((c) => `${c.label}：${c.note || c.have}`).join('；'),
  };
}

/**
 * 完整报告：硬件快照 + 每个大模型功能的判定。
 * @param {{ refresh?: boolean }} [opts]
 */
export async function hardwareReport(opts = {}) {
  const hw = await probeHardware(opts);
  return {
    ok: true,
    hardware: hw,
    features: HARDWARE_FEATURES.map((f) => evaluateFeature(f, hw)),
  };
}

/**
 * 单个功能的判定（前端在真正开跑前调用）。
 * 未知 id 回 null，调用方据此当作「不用检查」，不要用 500 惩罚调用方。
 * @param {string} id
 * @param {{ refresh?: boolean }} [opts]
 */
export async function checkFeature(id, opts = {}) {
  const feature = featureOf(id);
  if (!feature) return null;
  const hw = await probeHardware(opts);
  return evaluateFeature(feature, hw);
}

export { featureOf };
