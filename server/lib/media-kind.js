/**
 * 素材类型判别（纯函数、零依赖、可单测）。
 *
 * 从 media.js 拆出来的原因：media.js 顶层会 import ./db.js 打开 SQLite，
 * 单测只要碰一下媒体分类就得连库。判别逻辑本身只依赖扩展名与文件名，
 * 放在这里可以被 test/ 直接 import，不产生任何副作用。
 */
import path from 'node:path';

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
  // 设计文件：sharp 读不了，但文件里自带预览（PSD 合成图 / Sketch 的 preview.png /
  // RAW 的内嵌 JPEG），缩略图由 lib/design-thumb.js 提取
  design: ['psd', 'psb', 'ai', 'eps', 'sketch', 'xd', 'fig', 'indd', 'afdesign', 'afphoto', 'cdr'],
  raw: ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'sr2', 'dng', 'orf', 'raf', 'rw2', 'pef', 'srw', '3fr', 'kdc', 'mrw'],
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

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'ico']);

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
  cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef',
  arw: 'image/x-sony-arw', dng: 'image/x-adobe-dng', orf: 'image/x-olympus-orf',
  raf: 'image/x-fujifilm-raf', rw2: 'image/x-panasonic-rw2',
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
