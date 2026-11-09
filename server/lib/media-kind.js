// @ts-check
/**
 * 素材类型判别（纯函数、零依赖、可单测）。
 *
 * 从 media.js 拆出来的原因：media.js 顶层会 import ./db.js 打开 SQLite，
 * 单测只要碰一下媒体分类就得连库。判别逻辑本身只依赖扩展名与文件名，
 * 放在这里可以被 test/ 直接 import，不产生任何副作用。
 */
import path from 'node:path';

/**
 * 相机 RAW 扩展名。
 *
 * 覆盖原则：每一家能拿到的专有扩展名都列上（Honeyview / 快石这类看图软件也是这么做的）。
 * 列进来不等于要解拜耳阵列 —— 缩略图统一走「抽文件自带的内嵌预览」
 * （相当于 LibRaw 的 unpack_thumb / dcraw -e），所以新增一个扩展名的成本很低。
 * 唯独没有放 bbRAW/裸 .raw 这类通用后缀：素材目录里一个随便命名的 .raw
 * 会被当成相机原片，反而制造垃圾记录。
 */
export const RAW_EXTS = [
  // Canon
  'cr2', 'cr3', 'crw',
  // Nikon
  'nef', 'nrw',
  // Sony
  'arw', 'sr2', 'srf',
  // Fujifilm
  'raf',
  // Olympus / OM System
  'orf', 'ori',
  // Panasonic / Leica
  'rw2', 'rwl',
  // Pentax
  'pef',
  // Samsung
  'srw',
  // Adobe DNG（含 iPhone ProRAW）
  'dng',
  // Hasselblad / Phase One / Leaf / Mamiya
  '3fr', 'fff', 'iiq', 'mos', 'mef',
  // Kodak / Epson / Minolta / Sigma / GoPro
  'kdc', 'dcr', 'k25', 'erf', 'mrw', 'x3f', 'gpr',
];

/** 设计文件：sharp 读不了，但文件里自带预览（PSD 合成图 / Sketch 的 preview.png） */
export const DESIGN_EXTS = ['psd', 'psb', 'ai', 'eps', 'sketch', 'xd', 'fig', 'indd', 'afdesign', 'afphoto', 'cdr'];

/** HEIF 家族的扩展名：iPhone 默认拍照格式，sharp 自带的 libheif 没有 HEVC 解码器 */
export const HEIF_EXTS = ['heic', 'heif', 'hif'];

/** 扩展名 → 素材类型 */
const KIND_BY_EXT = new Map();
export const EXT_BY_KIND = {
  video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wmv'],
  gif: ['gif'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'wma'],
  font: ['ttf', 'otf', 'woff', 'woff2'],
  pdf: ['pdf'],
  // 只收真正的文档素材。txt/md/csv 这类笔记、清单、导出表不再当成素材：
  // 素材目录里随手丢一个「说明.txt」「导出.csv」就会多出一条空壳记录，
  // 缩略图是空白、点了也打不开，比不入库更难受。
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages'],
  model: ['obj', 'fbx', 'glb', 'gltf', 'stl', 'blend', '3ds', 'dae', 'ply'],
  design: DESIGN_EXTS,
  raw: RAW_EXTS,
};

/**
 * 系统文件 / 下载残留 / Office 锁文件 / 隐藏文件：一律不入库。
 * 扫描素材目录时这些东西太常见（Thumbs.db、.DS_Store、~$报告.docx、
 * xxx.mp4.crdownload），以前会被当成素材登记成一条打不开的记录。
 */
const JUNK_EXT = new Set([
  'tmp', 'temp', 'part', 'partial', 'crdownload', 'download', 'bak', 'old',
  'swp', 'swo', 'log', 'ini', 'lnk', 'url', 'db', 'db-journal', 'db-wal', 'db-shm',
  'txt', 'md', 'csv', 'json', 'xml', 'yml', 'yaml',
]);

for (const [kind, exts] of Object.entries(EXT_BY_KIND)) {
  for (const ext of exts) KIND_BY_EXT.set(ext, kind);
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'svg', 'ico', ...HEIF_EXTS]);

/**
 * 目录扫描 / 文件监听要收的图片扩展名。
 *
 * 之前这里是「jpg/jpeg/png/webp + 所有非图片素材」，等于 iPhone 拍的 HEIC
 * 永远不会被扫进库（浏览器和 sharp 都解不了，就干脆当它不存在）。
 * HEIC 现在由 lib/heif.js 用 WASM 解码，可以放心收。
 */
export const SCAN_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', ...HEIF_EXTS];

const RAW_SET = new Set(RAW_EXTS);
const DESIGN_SET = new Set(DESIGN_EXTS);
const HEIF_SET = new Set(HEIF_EXTS);

export function isRawExt(ext) {
  return RAW_SET.has(String(ext || '').toLowerCase());
}

export function isDesignExt(ext) {
  return DESIGN_SET.has(String(ext || '').toLowerCase());
}

export function isHeifExt(ext) {
  return HEIF_SET.has(String(ext || '').toLowerCase());
}

/** 需要走「抽内嵌预览」而不是 sharp 直接解码的格式 */
export function isPreviewOnlyExt(ext) {
  const e = String(ext || '').toLowerCase();
  return RAW_SET.has(e) || DESIGN_SET.has(e) || HEIF_SET.has(e);
}

const MIME_BY_EXT = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
  gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  ogg: 'audio/ogg', m4a: 'audio/mp4', opus: 'audio/opus', wma: 'audio/x-ms-wma',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/x-iwork-keynote-sffkey',
  numbers: 'application/x-iwork-numbers-sffnumbers',
  pages: 'application/x-iwork-pages-sffpages',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  obj: 'model/obj', fbx: 'model/fbx', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  stl: 'model/stl', blend: 'model/blend', '3ds': 'model/3ds', dae: 'model/vnd.collada+xml', ply: 'model/ply',
  psd: 'image/vnd.adobe.photoshop', psb: 'image/vnd.adobe.photoshop',
  ai: 'application/postscript', eps: 'application/postscript',
  sketch: 'application/x-sketch', xd: 'application/vnd.adobe.xd', fig: 'application/x-figma',
  indd: 'application/x-indesign', afdesign: 'application/x-affinity-designer',
  afphoto: 'application/x-affinity-photo', cdr: 'application/cdr',
  cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', crw: 'image/x-canon-crw',
  nef: 'image/x-nikon-nef', nrw: 'image/x-nikon-nrw',
  arw: 'image/x-sony-arw', sr2: 'image/x-sony-sr2', srf: 'image/x-sony-srf',
  dng: 'image/x-adobe-dng', orf: 'image/x-olympus-orf', ori: 'image/x-olympus-orf',
  raf: 'image/x-fujifilm-raf', rw2: 'image/x-panasonic-rw2', rwl: 'image/x-leica-rwl',
  pef: 'image/x-pentax-pef', srw: 'image/x-samsung-srw',
  '3fr': 'image/x-hasselblad-3fr', fff: 'image/x-hasselblad-fff',
  iiq: 'image/x-phaseone-iiq', mos: 'image/x-leaf-mos', mef: 'image/x-mamiya-mef',
  kdc: 'image/x-kodak-kdc', dcr: 'image/x-kodak-dcr', k25: 'image/x-kodak-k25',
  erf: 'image/x-epson-erf', mrw: 'image/x-minolta-mrw', x3f: 'image/x-sigma-x3f',
  gpr: 'image/x-gopro-gpr',
  heic: 'image/heic', heif: 'image/heif', hif: 'image/heif',
};

/** 媒体扩展名集合（不含图片） */
export const MEDIA_EXTS = new Set(KIND_BY_EXT.keys());

export function extOf(p) {
  return String(path.extname(String(p || '')) || '').slice(1).toLowerCase();
}

export function isJunkFile(p) {
  const base = String(path.basename(String(p || ''))).toLowerCase();
  if (!base) return true;
  if (base.startsWith('.') || base.startsWith('~$') || base === 'thumbs.db' || base === 'desktop.ini') {
    return true;
  }
  return JUNK_EXT.has(extOf(base));
}

/** 按扩展名判断素材类型；图片返回 image，未知/垃圾文件返回 other */
export function kindOfPath(p) {
  if (isJunkFile(p)) return 'other';
  const ext = extOf(p);
  if (!ext) return 'other';
  if (KIND_BY_EXT.has(ext)) return KIND_BY_EXT.get(ext);
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'other';
}

export function mimeOfPath(p) {
  const ext = extOf(p);
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

/** 是否走「非图片」入库通道 */
export function isMediaPath(p) {
  const kind = kindOfPath(p);
  return kind !== 'image' && kind !== 'other';
}
