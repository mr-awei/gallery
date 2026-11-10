/**
 * AI 去背景：本地 ONNX 抠图，三档可选，纯本地推理，不新增重型依赖。
 *
 * - `u2net`：U-2-Net 人像分割，4.5MB、320px，毫秒级，发丝边缘一般（老档位，保留兜底）
 * - `birefnet-lite`：BiRefNet lite（Swin-T，MIT），224MB、1024px。发丝 / 绒毛 / 半透明
 *   边缘是当前开源里最强的一档，明显优于 U-2-Net。体积大但用户只下一次。
 *
 * 装了哪档就用哪档（精细优先），也可以用 profile 参数强制指定。
 * 输出带透明通道的 PNG（保留原分辨率），作为新图入库，原图不动。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR } from './config.js';
import { downloadModelFile, verifyModelFileDetailed, KNOWN_SHA256, isPinned } from './model-fetch.js';
import { createJob, finishJob, jobProgress } from './jobs.js';

const AI_DIR = path.join(DATA_DIR, 'ai');
const DIR = path.join(AI_DIR, 'matting');
const MIRRORS = ['https://hf-mirror.com/', 'https://huggingface.co/'];

/**
 * 档位清单。`file` 是仓库内路径；`sizeHint` 是官方文件树的字节数（未安装时用来显示预计体积）。
 * `logits: true` 表示网络输出是未过激活的原始 logits（BiRefNet 官方实现如此），
 * 必须 sigmoid 才是 0~1 的遮罩 —— 直接 clamp 会得到一张几乎全黑的图。
 * `size`/`norm` 是仓库没有 preprocessor_config.json 时的兜底：BEN2 只做 /255，不做 ImageNet 归一化，
 * 输入也被固定成 1024×1024（实测 640 会直接报维度不符）。
 */
export const MATTING_PROFILES = [
  {
    id: 'u2net',
    label: 'U-2-Net（轻量）',
    desc: '4.5MB / 320px，秒出，适合人像头像；发丝与半透明边缘一般',
    repo: 'sunseeker001/U-2-Net-Human-Seg',
    file: 'onnx/model.onnx',
    sizeHint: 4_574_652,
    logits: false,
    /** 老档位落在 data/ai/matting 根下：已装的用户不需要重下 */
    dir: DIR,
  },
  {
    id: 'birefnet-lite',
    label: 'BiRefNet lite（精细）',
    desc: '224MB / 1024px，发丝、绒毛、玻璃边缘明显更干净；CPU 单张几秒（MIT 许可）',
    repo: 'onnx-community/BiRefNet_lite-ONNX',
    file: 'onnx/model.onnx',
    sizeHint: 224_005_088,
    logits: true,
    dir: path.join(DIR, 'birefnet-lite'),
  },
  {
    id: 'ben2',
    label: 'BEN2（旗舰）',
    desc: '213MB / 1024px，2024 年的边界分割新架构，发丝、绒毛、半透明比 BiRefNet lite 更干净；CPU 单张约 6 秒（MIT 许可）',
    repo: 'PramaLLC/BEN2',
    file: 'BEN2_Base.onnx',
    sizeHint: 222_932_053,
    logits: false,
    size: 1024,
    norm: 'raw',
    /** 仓库里没有 preprocessor_config.json，别去下一份不存在的配置（会 404 整个安装失败） */
    hasConfig: false,
    dir: path.join(DIR, 'ben2'),
  },
];

const MODELS = new Map(MATTING_PROFILES.map((p) => [p.id, p]));
const configOf = (p) => ({
  // 落盘名跟仓库里的文件名走：BEN2 的权重不叫 model.onnx
  modelFile: path.join(p.dir, path.basename(p.file)),
  configFile: path.join(p.dir, 'preprocessor_config.json'),
  modelKey: `${p.repo}/${p.file}`,
  mirrorBases: MIRRORS.map((m) => `${m}${p.repo}/resolve/main/`),
});
/** 供下载中心按档位取落盘位置（同一份定义，别在别处再拼一遍路径） */
export function mattingFiles(profileId) {
  const p = MODELS.get(profileId);
  if (!p) return null;
  const { modelFile, configFile } = configOf(p);
  return { dir: p.dir, modelFile, configFile, repo: p.repo, label: p.label, sizeHint: p.sizeHint };
}

/** 按体积判断某档是否已装（>1MB 视为完整；下载中的 .part 不算） */
function profileInstalled(p) {
  const { modelFile } = configOf(p);
  try {
    return fs.statSync(modelFile).size > 1024 * 1024;
  } catch {
    return false;
  }
}

/**
 * 实际使用的档位：按清单从后往前，装了哪档质量高就用哪档（BEN2 > BiRefNet lite > U-2-Net）。
 * 「体积不重要，先保质量」——用户既然下了好模型，就该用上它，不用再去别处开关。
 */
export function activeMattingProfile() {
  const want = String(process.env.TUKU_MATTING || '').trim();
  if (want && MODELS.has(want)) return want;
  for (const p of [...MATTING_PROFILES].reverse()) if (profileInstalled(p)) return p.id;
  return 'u2net';
}

const sessions = new Map();
/** 下载中止信号：以前模型装到一半只能干等，没法取消 */
let installAbort = null;
/** 正在下载的档位 id：进度条要能说清「在下哪一个」，不能只说「下载中」 */
let installingProfile = '';
const state = { downloading: false, progress: 0, message: '', error: '', cancelled: false };

export function mattingStatus() {
  const active = activeMattingProfile();
  const profiles = MATTING_PROFILES.map((p) => {
    const { modelFile, modelKey } = configOf(p);
    let size = 0;
    try {
      size = fs.statSync(modelFile).size;
    } catch {
      /* 未安装 */
    }
    return {
      id: p.id,
      label: p.label,
      desc: p.desc,
      size,
      sizeHint: p.sizeHint,
      installed: size > 1024 * 1024,
      verified: size > 1024 * 1024 && isPinned(modelKey),
      active: p.id === active,
    };
  });
  const cur = profiles.find((p) => p.id === active);
  return {
    downloaded: profiles.some((p) => p.installed),
    downloading: state.downloading,
    progress: state.progress,
    message: state.message,
    error: state.error,
    cancelled: state.cancelled,
    model: MODELS.get(active).repo,
    size: cur ? cur.size : 0,
    verified: !!cur?.verified,
    profile: active,
    installing: installingProfile,
    profiles,
  };
}

/** 取消正在进行的模型下载（任务中心/设置页的「取消」都走这里） */
export function cancelMattingInstall() {
  if (!state.downloading || !installAbort) return false;
  state.message = '正在取消…';
  try {
    installAbort.abort(new Error('用户取消下载'));
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * 后台安装模型：立刻返回，进度走 mattingStatus() 轮询。
 * 以前这个 HTTP 请求要等整包下完才返回，浏览器里点一下能转圈几分钟，
 * 中途想取消只能去关应用。
 */
export function startMattingInstall(profileId = 'u2net') {
  const p = MODELS.get(profileId);
  if (!p) return { ok: false, error: '未知的模型档位' };
  if (state.downloading) return { ok: true, started: false, ...mattingStatus() };
  installMatting(profileId).catch((err) => {
    // cause 链里才是网络层真相（ECONNREFUSED / ETIMEDOUT / DNS 失败等），只记 message 排查不了
    const deep = err?.cause?.cause?.code || err?.cause?.cause?.message || err?.cause?.code || err?.cause?.message;
    console.warn('[matting] 模型安装失败：', err?.message || err, deep ? `| cause: ${deep}` : '');
  });
  return { ok: true, started: true, ...mattingStatus() };
}

export async function installMatting(profileId = 'u2net') {
  const p = MODELS.get(profileId);
  if (!p) throw new Error('未知的模型档位');
  if (state.downloading) throw new Error('正在下载中，请稍候');
  const { modelFile, configFile, modelKey, mirrorBases } = configOf(p);
  const approx = `${Math.round(p.sizeHint / 1024 / 1024)}MB`;
  state.downloading = true;
  state.progress = 0;
  state.error = '';
  state.cancelled = false;
  state.message = '准备下载…';
  installingProfile = p.id;
  installAbort = new AbortController();
  const signal = installAbort.signal;
  const jobId = createJob({
    kind: 'model-install',
    title: `去背景模型（${p.label}）`,
    payload: { model: 'matting', profile: p.id },
  });
  try {
    await fsp.mkdir(p.dir, { recursive: true });
    if (p.hasConfig !== false) {
      await downloadModelFile({
        mirrors: mirrorBases,
        repoPath: 'preprocessor_config.json',
        dest: configFile,
        minBytes: 16,
        maxBytes: 1024 * 1024,
        signal,
        onProgress: (x) => {
          state.progress = Math.round(x * 5);
          state.message = `下载配置 ${Math.round(x * 100)}%`;
          jobProgress(jobId, { progress: state.progress, message: state.message });
        },
      });
    }
    state.message = `下载 ${p.label}（约 ${approx}）…`;
    await downloadModelFile({
      mirrors: mirrorBases,
      repoPath: p.file,
      dest: modelFile,
      minBytes: 1024 * 1024,
      // 上限按档位给足：以前写死 64MB，换成 224MB 的模型会直接被拦下来
      maxBytes: Math.max(64 * 1024 * 1024, p.sizeHint * 2),
      sha256: KNOWN_SHA256[modelKey] || '',
      signal,
      onProgress: (x) => {
        state.progress = 5 + Math.round(x * 93);
        state.message = `下载模型 ${Math.round(x * 100)}%（约 ${approx}）`;
        jobProgress(jobId, { progress: state.progress, message: state.message });
      },
    });
    const check = await verifyModelFileDetailed(modelFile, {
      minBytes: 1024 * 1024,
      sha256: KNOWN_SHA256[modelKey] || '',
    });
    if (!check.ok) throw new Error(`模型文件校验未通过（${check.reason || '哈希不匹配'}），请重试安装`);
    state.progress = 100;
    // 没有可信清单时如实说明，别让用户以为「校验通过」了
    state.message = check.verified ? '下载完成（已比对可信哈希）' : '下载完成（已记录哈希，未与清单比对）';
    sessions.delete(p.id); // 让下次调用重新加载
    finishJob(jobId, { status: 'done', result: { verified: check.verified, profile: p.id } });
    return mattingStatus();
  } catch (err) {
    const cancelled = /已取消/.test(String(err?.message || ''));
    state.cancelled = cancelled;
    state.error = cancelled ? '' : String(err?.message || err).slice(0, 200);
    state.message = cancelled ? '已取消下载' : state.message;
    // 清掉坏文件，避免「已下载」假状态卡住 UI
    await fsp.rm(modelFile, { force: true }).catch(() => {});
    finishJob(jobId, { status: cancelled ? 'canceled' : 'failed', error: state.error });
    throw err;
  } finally {
    state.downloading = false;
    installingProfile = '';
    installAbort = null;
  }
}

/**
 * 删除某一档权重（下载中心用）。
 * Windows 上被 ONNX 会话打开着的文件删不掉，所以先 release 会话再删。
 */
export async function removeMatting(profileId) {
  const p = MODELS.get(profileId);
  if (!p) throw new Error('未知的模型档位');
  if (state.downloading && installingProfile === profileId) throw new Error('该模型正在下载，请先取消');
  const sess = sessions.get(profileId);
  if (sess) {
    sessions.delete(profileId);
    try {
      await sess.release?.();
    } catch {
      /* 老版本 runtime 没有 release，删不掉时由下面的报错如实反馈 */
    }
  }
  await fsp.rm(p.dir, { recursive: true, force: true });
  return mattingStatus();
}

/** 读取预处理配置（失败则用常见的 ImageNet 归一化兜底） */
function preprocess(profile) {
  const { configFile } = configOf(profile);
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    /* ignore */
  }
  const size = profile.size || cfg.size?.height || cfg.size?.width || (profile.id === 'birefnet-lite' ? 1024 : 320);
  // norm: 'raw' 的模型（BEN2）训练时只做 /255，套 ImageNet 均值方差会整体偏色、遮罩发灰
  const raw = profile.norm === 'raw';
  const mean = raw ? [0, 0, 0] : cfg.image_mean || cfg.mean || [0.485, 0.456, 0.406];
  const std = raw ? [1, 1, 1] : cfg.image_std || cfg.std || [0.229, 0.224, 0.225];
  return { size, mean, std };
}

async function getSession(profile) {
  const cached = sessions.get(profile.id);
  if (cached) return cached;
  const { modelFile, modelKey } = configOf(profile);
  const promise = (async () => {
    if (!fs.existsSync(modelFile)) throw new Error('去背景模型未下载，请先到「设置 → 下载中心」下载');
    // 运行前复核完整性：哈希不匹配（被替换/损坏）直接删掉坏文件，
    // 强制用户重新下载，而不是带着损坏权重静默推理出废图。
    const check = await verifyModelFileDetailed(modelFile, {
      minBytes: 1024 * 1024,
      sha256: KNOWN_SHA256[modelKey] || '',
    });
    if (!check.ok) {
      await fsp.rm(modelFile, { force: true }).catch(() => {});
      sessions.delete(profile.id);
      throw new Error(
        `去背景模型文件损坏或哈希不匹配（${check.reason || '校验失败'}），已删除并请在「设置 → 下载中心」重新下载`
      );
    }
    const ort = await import('onnxruntime-node');
    return ort.InferenceSession.create(modelFile);
  })().catch((err) => {
    sessions.delete(profile.id);
    throw err;
  });
  sessions.set(profile.id, promise);
  return promise;
}

/**
 * 生成抠图结果：返回 { buffer, width, height, profile }
 * 流程：缩到模型尺寸 → 归一化 → ONNX 推理 → 取 alpha → 放大回原尺寸 → 与原图合成 RGBA PNG
 */
export async function removeBackgroundBuffer(inputPath, opts = {}) {
  const profileId = opts.profile && MODELS.has(opts.profile) ? opts.profile : activeMattingProfile();
  const profile = MODELS.get(profileId);
  const sess = await getSession(profile);
  const { size, mean, std } = preprocess(profile);
  const meta = await sharp(inputPath, { failOn: 'none' }).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error('无法读取图片尺寸');

  // 预处理：resize 到模型输入尺寸，输出 RGB 归一化浮点
  const raw = await sharp(inputPath, { failOn: 'none' })
    .removeAlpha()
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer();
  const chw = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++) {
    const r = raw[i * 3] / 255;
    const g = raw[i * 3 + 1] / 255;
    const b = raw[i * 3 + 2] / 255;
    chw[i] = (r - mean[0]) / std[0];
    chw[size * size + i] = (g - mean[1]) / std[1];
    chw[2 * size * size + i] = (b - mean[2]) / std[2];
  }
  const ort = await import('onnxruntime-node');
  const inputName = sess.inputNames[0];
  const tensor = new ort.Tensor('float32', chw, [1, 3, size, size]);
  const out = await sess.run({ [inputName]: tensor });

  // 找到 [1,1,H,W] 或 [1,2,H,W] 的输出作为 mask
  let mask = null;
  for (const name of sess.outputNames) {
    const t = out[name];
    const d = t.dims;
    if (d.length === 4 && d[0] === 1) {
      const data = t.data;
      const c = d[1];
      const h = d[2];
      const w = d[3];
      const m = new Float32Array(h * w);
      if (c === 1) {
        for (let i = 0; i < h * w; i++) m[i] = data[i];
        mask = { m, w, h };
        break;
      }
      if (c === 2) {
        // 二分类：取「前景」通道（用 softmax 后的概率）
        for (let i = 0; i < h * w; i++) {
          const a = Math.exp(data[i]);
          const b = Math.exp(data[h * w + i]);
          m[i] = b / (a + b);
        }
        mask = { m, w, h };
        break;
      }
    }
  }
  if (!mask) throw new Error('模型输出无法识别为遮罩');

  /**
   * BiRefNet 这类网络输出的是未过激活的 logits（实测有 -20 ~ +20 的范围）。
   * 直接 clamp 到 0~1 会让整张图趋近全黑 —— 这里按「出现越界值」自动判定要不要 sigmoid，
   * 换模型时不用再改代码（profile.logits 只是提前声明，判定以数据为准）。
   */
  let needSigmoid = !!profile.logits;
  if (!needSigmoid) {
    for (let i = 0; i < mask.m.length; i += 97) {
      const v = mask.m[i];
      if (v < -0.001 || v > 1.001) {
        needSigmoid = true;
        break;
      }
    }
  }
  if (needSigmoid) {
    for (let i = 0; i < mask.m.length; i++) mask.m[i] = 1 / (1 + Math.exp(-mask.m[i]));
  }

  // mask → 灰度图 → 放大到原尺寸 → 作为 alpha 通道
  const maskBuf = Buffer.alloc(mask.w * mask.h);
  let covered = 0;
  for (let i = 0; i < mask.m.length; i++) {
    const v = Math.max(0, Math.min(1, mask.m[i]));
    maskBuf[i] = Math.round(v * 255);
    if (v > 0.5) covered++;
  }
  // alpha 在低分辨率上先羽化再放大：边缘会有 2~3px 的柔和过渡带。
  // 直接最近邻/硬边放大后，抠出来的图贴到别的背景上会有一圈锯齿（尤其头发与肩线）。
  const alphaPng = await sharp(maskBuf, { raw: { width: mask.w, height: mask.h, channels: 1 } })
    .blur(1)
    .resize(W, H, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const alphaRaw = await sharp(alphaPng).ensureAlpha().raw().toBuffer();
  const alpha = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = alphaRaw[i * 4]; // 取 R 通道（灰阶）

  const base = await sharp(inputPath, { failOn: 'none' }).removeAlpha().resize(W, H).raw().toBuffer();
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = base[i * 3];
    rgba[i * 4 + 1] = base[i * 3 + 1];
    rgba[i * 4 + 2] = base[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  const buffer = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  // 前景区占比：模型是**人像分割**，纯风景/物体常常抠出整片或一片空白。
  // 与其静默给出一张废图，不如把可疑度带回去让界面提示重试。
  const coverage = mask.w * mask.h ? covered / (mask.w * mask.h) : 0;
  const warning =
    coverage < 0.015
      ? '几乎没抠出主体（这张图可能不是人像，或主体与背景接近）'
      : coverage > 0.97
        ? '整张图都被当成主体（该模型是人像分割，对纯风景/物体基本无效）'
        : '';
  return { buffer, width: W, height: H, coverage: +coverage.toFixed(4), warning, profile: profile.id };
}
