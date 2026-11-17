// @ts-check
/**
 * 下载中心的静态清单 + 纯函数汇总。
 *
 * 为什么单独一个文件：清单要能被单测直接 import 而不触发数据库迁移
 * （registry 会 import face.js → db.js，测试里跑一次就会动真实库）。
 * 这里只放常量与不依赖 IO 的纯函数，状态探测与安装分发在 model-registry.js。
 *
 * `sizeHint` 是官方文件树的字节数，只在「未安装」时用来显示预计体积；
 * 已安装的体积一律以磁盘 stat 为准（清单只做参考，绝不拿来当校验依据）。
 */

/** 分组：设置页下载中心按这个顺序分块渲染 */
export const MODEL_GROUPS = [
  {
    id: 'upscale',
    label: '画质增强 / 超分',
    hint: 'Real-ESRGAN、Real-CUGAN 走 ncnn + Vulkan（吃显卡）；Swin2SR 走 ONNX（纯 CPU）。社区 .param 与内置模型同属 ESRGAN 架构，可直接互换',
  },
  { id: 'matting', label: '去背景 / 抠图', hint: '轻量档秒出，精细档专治发丝与半透明边缘' },
  { id: 'face', label: '人物聚类', hint: 'SCRFD 检测 + ArcFace 512 维特征，两个权重一起装' },
  { id: 'semantic', label: '语义检索', hint: 'CLIP 图文向量，支持用一句话搜图' },
];

/**
 * 清单条目：
 * - `id` 稳定不随显示名变化（落盘路径与 pin 都用它）
 * - `required: true` 表示这是该功能的核心权重，删掉功能就不可用
 * - `pinned: true` 表示与 KNOWN_SHA256 清单比对（可信校验）；false 只能与本机 sidecar 自洽
 * - `note` 用于写「为什么要这个体积 / 能换什么」这类决策说明
 */
export const MODEL_CATALOG = [
  // ── 画质增强 ─────────────────────────────────────────────
  {
    id: 'upscale:realesrgan',
    group: 'upscale',
    name: 'Real-ESRGAN 运行库',
    desc: '内含 x4plus（通用照片）、x4plus-anime（二次元插画）、animevideov3（动漫/写实，最快）',
    sizeHint: 45_474_481,
    source: 'xinntao/Real-ESRGAN v0.2.5.0（zip 45.5MB，解压约 100MB）',
    license: 'BSD-3-Clause',
    required: true,
    pinned: false,
    note: '社区模型也放在这个目录里；删掉运行库会连带它们的 .param/.bin',
  },
  {
    id: 'upscale:realcugan',
    group: 'upscale',
    name: 'Real-CUGAN 运行库',
    desc: '二级增强的降噪前置引擎，含 models-se / models-pro / models-nose 三套',
    sizeHint: 45_977_449,
    source: 'nihui/realcugan-ncnn-vulkan 20220728（zip 46MB）',
    license: 'MIT',
    required: false,
    pinned: false,
  },
  {
    id: 'esrgan:4x_NMKD-Siax_200k',
    group: 'upscale',
    name: 'NMKD-Siax 200k',
    desc: '真人照片首选：画质与速度平衡，伪影少',
    sizeHint: 32_000_000,
    source: 'upscayl/custom-models',
    license: 'CC-BY-NC-SA（非商用）',
    required: false,
    pinned: true,
  },
  {
    id: 'esrgan:RealESRGAN_General_WDN_x4_v3',
    group: 'upscale',
    name: 'General WDN v3',
    desc: '带去噪，压缩噪点重的图更干净',
    sizeHint: 33_000_000,
    source: 'upscayl/custom-models',
    license: 'CC-BY-NC-SA（非商用）',
    required: false,
    pinned: true,
  },
  {
    id: 'esrgan:4x_NMKD-Superscale-SP_178000_G',
    group: 'upscale',
    name: 'NMKD Superscale SP',
    desc: '通用放大，过渡自然',
    sizeHint: 33_000_000,
    source: 'upscayl/custom-models',
    license: 'CC-BY-NC-SA（非商用）',
    required: false,
    pinned: true,
  },
  {
    id: 'esrgan:4xLSDIRplusC',
    group: 'upscale',
    name: 'LSDIRplusC',
    desc: '细节重建强，压缩图不会过度平滑',
    sizeHint: 33_000_000,
    source: 'upscayl/custom-models',
    license: 'CC-BY-NC-SA（非商用）',
    required: false,
    pinned: true,
  },
  {
    id: 'esrgan:4xNomos8kSC',
    group: 'upscale',
    name: 'Nomos8kSC',
    desc: '锐度高，适合再锐化',
    sizeHint: 34_000_000,
    source: 'upscayl/custom-models',
    license: 'CC-BY-NC-SA（非商用）',
    required: false,
    pinned: true,
  },
  {
    id: 'esrgan:4xHFA2k',
    group: 'upscale',
    name: 'HFA2k',
    desc: '平滑自然，抑制伪影',
    sizeHint: 31_000_000,
    source: 'upscayl/custom-models',
    license: 'CC-BY-NC-SA（非商用）',
    required: false,
    pinned: true,
  },
  {
    id: 'onnx:swin2SR-lightweight-x2-64',
    group: 'upscale',
    name: 'Swin2SR 轻量 ×2',
    desc: '体积最小、速度最快的一档，纯 CPU',
    sizeHint: 47_000_000,
    source: 'Xenova/swin2SR-lightweight-x2-64',
    license: 'Apache-2.0',
    required: false,
    pinned: false,
  },
  {
    id: 'onnx:swin2SR-compressed-sr-x4-48',
    group: 'upscale',
    name: 'Swin2SR 压缩修复 ×4',
    desc: '专治 JPEG 压缩噪点/模糊，网络图首选',
    sizeHint: 48_000_000,
    source: 'Xenova/swin2SR-compressed-sr-x4-48',
    license: 'Apache-2.0',
    required: false,
    pinned: false,
  },
  {
    id: 'onnx:swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    group: 'upscale',
    name: 'Swin2SR 真实世界 ×4',
    desc: '真实照片通用，细节重建强，塑料感比 Real-ESRGAN 少',
    sizeHint: 54_000_000,
    source: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    license: 'Apache-2.0',
    required: false,
    pinned: false,
  },
  {
    id: 'onnx:swin2SR-classical-sr-x2-64',
    group: 'upscale',
    name: 'Swin2SR 经典 ×2',
    desc: '干净素材（无损图）2 倍放大，质量最稳',
    sizeHint: 47_000_000,
    source: 'Xenova/swin2SR-classical-sr-x2-64',
    license: 'Apache-2.0',
    required: false,
    pinned: false,
  },

  // ── 去背景 ───────────────────────────────────────────────
  {
    id: 'matting:u2net',
    group: 'matting',
    name: 'U-2-Net（轻量）',
    desc: '320px 推理，秒级出图；人像头像够用，发丝边缘偏硬',
    sizeHint: 4_574_652,
    source: 'sunseeker001/U-2-Net-Human-Seg（ONNX）',
    license: 'Apache-2.0',
    required: false,
    pinned: false,
    note: '装了精细档之后，这档只作为「显卡/内存吃紧」时的退路',
  },
  {
    id: 'matting:birefnet-lite',
    group: 'matting',
    name: 'BiRefNet lite（精细）',
    desc: '1024px、Swin-T 主干；发丝、绒毛、玻璃与半透明边缘明显更干净',
    sizeHint: 224_005_088,
    source: 'onnx-community/BiRefNet_lite-ONNX（fp32 224MB）',
    license: 'MIT',
    required: false,
    pinned: false,
    note: 'BiRefNet 全量版 972MB 换来的提升已不明显，故选 lite；装了旗舰档之后这档是「想快一点」的退路',
  },
  {
    id: 'matting:ben2',
    group: 'matting',
    name: 'BEN2（旗舰）',
    desc: '1024px、官方 ONNX 导出；发丝、绒毛、半透明边缘最干净，CPU 单张约 6 秒',
    sizeHint: 222_932_053,
    source: 'PramaLLC/BEN2（BEN2_Base.onnx，222.9MB）',
    license: 'MIT',
    required: false,
    pinned: true,
    note: '输出已是 0~1 的遮罩（不是 logits），且只做 /255、不做 ImageNet 归一化，输入固定 1024×1024；装上后自动优先于 BiRefNet lite',
  },

  // ── 人物聚类 ─────────────────────────────────────────────
  {
    id: 'face:buffalo-l',
    group: 'face',
    name: 'SCRFD 检测 + ArcFace 特征',
    desc: 'det_10g（16.9MB）做人脸框与五点，w600k_r50（174MB）出 512 维身份向量',
    sizeHint: 191_307_687,
    source: 'insightface buffalo_l',
    license: 'insightface 模型库声明：权重仅限非商用研究（代码为 MIT）',
    required: true,
    pinned: true,
    note: '换更强的 antelopev2（ResNet100@Glint360K，407MB）要重扫全库重新聚类，且同受非商用限制，收益不值这个代价；AdaFace 许可更严、没有现成 ONNX，不采用',
  },

  // ── 语义检索 ─────────────────────────────────────────────
  {
    id: 'semantic:clip-vit-b32',
    group: 'semantic',
    name: 'CLIP ViT-B/32',
    desc: '图文双塔，512 维；文本塔 + 视觉塔两个 ONNX',
    sizeHint: 90_000_000,
    source: 'Xenova/clip-vit-base-patch32',
    license: 'MIT',
    required: true,
    pinned: false,
    note: '英文语料训练，中文查询靠弱对齐；下一轮换 Chinese-CLIP ViT-B/16（同样 512 维、有现成 ONNX）只需重建索引，是目前性价比最高的替换',
  },
];

/** 按 id 取条目 */
export function catalogItem(id) {
  return MODEL_CATALOG.find((m) => m.id === id) || null;
}

/**
 * 把「清单」与「实时探测结果」合并成界面要的条目。
 * probe 结构宽松：{ installed, size, progress, state, message, error, verified, removable, updateAvailable }
 * 清单里没有的实时条目（比如老版本留下的未知社区模型）会被忽略，避免界面出现无法操作的行。
 */
export function mergeCatalog(probes = {}) {
  return MODEL_CATALOG.map((item) => {
    const p = probes[item.id] || {};
    const installed = !!p.installed;
    const size = Number(p.size) > 0 ? Number(p.size) : installed ? item.sizeHint : 0;
    return {
      ...item,
      installed,
      size,
      sizeHint: item.sizeHint,
      removable: installed && p.removable !== false,
      verified: !!p.verified,
      state: p.state || (installed ? 'installed' : 'idle'),
      progress: Math.max(0, Math.min(100, Number(p.progress) || 0)),
      message: p.message || '',
      error: p.error || '',
      updateAvailable: !!p.updateAvailable,
      path: p.path || '',
    };
  });
}

/**
 * 汇总：已装项数、占用体积、可清理体积、按分组的统计。
 * 体积用 Number 累加，超大库（十几 GB）也不会溢出到字符串拼接。
 */
export function summarizeCatalog(items = []) {
  const groups = MODEL_GROUPS.map((g) => {
    const list = items.filter((m) => m.group === g.id);
    return {
      ...g,
      total: list.length,
      installed: list.filter((m) => m.installed).length,
      bytes: list.reduce((n, m) => n + (m.installed ? m.size : 0), 0),
      updates: list.filter((m) => m.updateAvailable).length,
    };
  });
  const active = items.filter((m) => m.state === 'downloading' || m.state === 'installing');
  return {
    total: items.length,
    installed: items.filter((m) => m.installed).length,
    bytes: items.reduce((n, m) => n + (m.installed ? m.size : 0), 0),
    removableBytes: items.reduce((n, m) => n + (m.installed && m.removable ? m.size : 0), 0),
    updates: items.filter((m) => m.updateAvailable).length,
    active: active.length,
    activeId: active[0]?.id || '',
    groups,
  };
}
