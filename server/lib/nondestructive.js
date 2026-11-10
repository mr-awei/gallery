// @ts-check
/**
 * 非破坏性编辑（设置项 `nonDestructiveEdit`，默认关）。
 *
 * 开着时裁切 / 旋转 / 调色不再写回原文件，而是把操作记进 `edit_ops` 操作链：
 * 原图字节保持不变，浏览、预览、下载、导出都套用「原图 + 操作链」的渲染结果；
 * 「应用到底片」再一次性落盘并清空操作链，「还原」直接丢掉整条链。
 *
 * 为什么不是「另存副本」：副本会让一张图变成两条记录，标签/评分/文件夹全断；
 * 操作链保持同一条记录，撤销语义、查重、时间线口径都不受影响。
 *
 * 渲染策略：一次解码成 raw → 在内存里顺序套用操作（旋转/裁切都是像素搬运，
 * 调色走 applyRaw 与前端预览同一套公式）→ 只编码一次。避免每步都重编码掉画质。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db, getSettings } from '../db.js';
import { thumbBucketDir, ensureThumbDirFor } from '../thumbs.js';
import { logOp } from '../oplog.js';
import { cropRaw, effectiveSize, rotateRaw } from './nd-geometry.js';

// 纯几何运算放在 nd-geometry.js（可直接单测），这里转出手给路由/导出复用
export { cropRaw, effectiveSize, rotateRaw };

/** 支持的非破坏操作；即时类（增强/超分/擦除）仍写回原图，不进操作链 */
export const OP_KINDS = ['crop', 'rotate', 'adjust'];

/** 单张最多累积的步数：再多说明用户在乱点，逼他先应用到底片 */
const MAX_OPS = 50;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

export function nonDestructiveOn() {
  return !!getSettings().nonDestructiveEdit;
}

function parseParams(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 该图的操作链（按应用顺序，最早在前） */
export function listOps(imageId) {
  const rows = db
    .prepare('SELECT id, kind, params, created_at FROM edit_ops WHERE image_id = ? ORDER BY id ASC')
    .all(Number(imageId));
  return rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    params: parseParams(r.params),
    createdAt: String(r.created_at || ''),
  }));
}

/** 操作链的版本号：任何增删都会 +1，前端 URL 与派生缓存都靠它失效 */
export function opsVersion(imageId) {
  const row = db.prepare('SELECT edit_ops_ver FROM images WHERE id = ?').get(Number(imageId));
  return Number(row?.edit_ops_ver) || 0;
}

/* ------------------------------ 派生图缓存 ------------------------------
 * 缩略图 / 预览 / 原图三个档位各自缓存，文件名带 `-nd` 前缀，绝不复用普通缓存
 * （否则关闭模式后还会一直送到带操作的图）。
 * 任何操作链变更都会同步删掉它们，读的时候按需重生成 —— 「存在即可用」。
 */
function derivedCandidates(imageId) {
  const dir = thumbBucketDir(imageId);
  return [
    path.join(dir, `${imageId}-nd-t.jpg`),
    path.join(dir, `${imageId}-nd-p.jpg`),
    ...['jpg', 'png', 'webp', 'avif'].map((e) => path.join(dir, `${imageId}-nd-f.${e}`)),
  ];
}

export function removeDerived(imageId) {
  for (const p of derivedCandidates(imageId)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 删不掉不影响正确性：下面用版本号校验新鲜度 */
    }
  }
}

export function sourceFormat(row) {
  const mime = String(row?.mime || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('avif')) return 'avif';
  const ext = path.extname(String(row?.abs_path || '')).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  if (ext === '.avif') return 'avif';
  return 'jpeg';
}

function fullDerivedPath(imageId, format) {
  const ext = format === 'jpeg' ? 'jpg' : format;
  return path.join(thumbBucketDir(imageId), `${imageId}-nd-f.${ext}`);
}

/** 两个派生路径（只用于展示/测试）：kind = thumb | preview | full */
export function derivedPath(imageId, kind, format = 'jpeg') {
  if (kind === 'thumb') return path.join(thumbBucketDir(imageId), `${imageId}-nd-t.jpg`);
  if (kind === 'preview') return path.join(thumbBucketDir(imageId), `${imageId}-nd-p.jpg`);
  return fullDerivedPath(imageId, format);
}

/* ------------------------------ 操作链写入 ------------------------------ */

/** @typedef {{ dir?: unknown, rect?: unknown, ratio?: unknown, outWidth?: unknown, outHeight?: unknown }} RawOpParams */

function sanitizeOp(kind, params = {}) {
  const p = /** @type {RawOpParams} */ (params && typeof params === 'object' ? params : {});
  if (kind === 'rotate') {
    return { dir: p.dir === 'ccw' ? 'ccw' : 'cw' };
  }
  if (kind === 'crop') {
    const r = /** @type {{ x?: unknown, y?: unknown, w?: unknown, h?: unknown }} */ (p.rect || {});
    const rect = {
      x: clamp(r.x, 0, 1),
      y: clamp(r.y, 0, 1),
      w: clamp(r.w, 0, 1),
      h: clamp(r.h, 0, 1),
    };
    if (rect.w <= 0 || rect.h <= 0) throw new Error('裁切区域无效');
    /** @type {{ rect: typeof rect, ratio?: string, outWidth?: number, outHeight?: number }} */
    const out = { rect };
    if (p.ratio) out.ratio = String(p.ratio).slice(0, 16);
    const ow = Math.round(clamp(p.outWidth, 0, 20000));
    const oh = Math.round(clamp(p.outHeight, 0, 20000));
    if (ow >= 16 && oh >= 16) {
      out.outWidth = ow;
      out.outHeight = oh;
    }
    return out;
  }
  // adjust：调用方（edit.js）已 normalizeAdjust 过，这里只做体积兜底，
  // 避免有人把整段 base64 之类塞进操作链
  const text = JSON.stringify(p);
  if (text.length > 20000) throw new Error('调色参数过大');
  return JSON.parse(text);
}

/** 操作链变更后同步冗余列 + 清派生缓存 */
function syncOps(imageId) {
  const n = Number(
    db.prepare('SELECT COUNT(*) AS n FROM edit_ops WHERE image_id = ?').get(Number(imageId))?.n || 0
  );
  db.prepare('UPDATE images SET edit_ops_count = ?, edit_ops_ver = edit_ops_ver + 1 WHERE id = ?').run(
    n,
    Number(imageId)
  );
  removeDerived(Number(imageId));
  return n;
}

/**
 * 追加一步操作。
 * @returns {{opId:number, kind:string, params:object, ops:any[], count:number}}
 */
export function addOp(imageId, kind, params = {}, opts = {}) {
  const id = Number(imageId);
  if (!OP_KINDS.includes(kind)) throw new Error('这种编辑不支持非破坏记录');
  const row = db.prepare('SELECT id, abs_path, title FROM images WHERE id = ?').get(id);
  if (!row?.abs_path) throw new Error('图片不存在');
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM edit_ops WHERE image_id = ?').get(id)?.n || 0);
  if (n >= MAX_OPS) throw new Error(`非破坏编辑最多累积 ${MAX_OPS} 步，请先「应用到底片」`);
  const clean = sanitizeOp(kind, params);
  const r = db
    .prepare('INSERT INTO edit_ops (image_id, kind, params, created_at) VALUES (?, ?, ?, ?)')
    .run(id, kind, JSON.stringify(clean), new Date().toISOString());
  syncOps(id);
  // 一步一条撤销记录：Ctrl+Z 精确回退到上一步画面，不是整条链一起没。
  // 撤销「还原」时会重放整条链，那种情况不能再记新日志，否则撤销栈会被自己填满。
  if (opts.log !== false) {
    const label = { crop: '裁切', rotate: '旋转', adjust: '调色' }[kind] || kind;
    logOp({
      op: 'nd-edit',
      summary: `非破坏${label}：${String(row.title || `#${id}`).slice(0, 40)}`,
      payload: { id, opId: Number(r.lastInsertRowid) },
    });
  }
  return {
    opId: Number(r.lastInsertRowid),
    kind,
    params: clean,
    ops: listOps(id),
    count: n + 1,
  };
}

/** 撤销一步（按操作 id；撤销执行器与「去掉最后一步」共用） */
export function dropOp(imageId, opId) {
  const r = db
    .prepare('DELETE FROM edit_ops WHERE id = ? AND image_id = ?')
    .run(Number(opId), Number(imageId));
  if (r.changes) syncOps(Number(imageId));
  return !!r.changes;
}

export function clearOps(imageId) {
  const r = db.prepare('DELETE FROM edit_ops WHERE image_id = ?').run(Number(imageId));
  syncOps(Number(imageId));
  return Number(r.changes) || 0;
}

/* ------------------------------ 渲染 ------------------------------ */

/**
 * @typedef {{ data: Buffer, width: number, height: number, channels: number }} RawImage
 */

/** @returns {Promise<RawImage>} */
async function decodeRaw(absPath) {
  const r = await sharp(absPath, { failOn: 'none' }).rotate().raw().toBuffer({ resolveWithObject: true });
  return { data: r.data, width: r.info.width, height: r.info.height, channels: r.info.channels };
}

/**
 * 调色：颜色部分在 raw 上逐像素做（与前端预览同一套公式），
 * 清晰度/锐化必须走 sharp（局部对比），两者都不改尺寸。
 */
/**
 * sharp 的 raw 选项要求 channels 是 1|2|3|4 的字面量联合，而解码回来是 number，
 * 这里统一收口一次断言，别再让每个调用点各写一遍。
 * @param {RawImage} img
 */
function rawOptions(img) {
  return {
    width: img.width,
    height: img.height,
    channels: /** @type {import('sharp').Channels} */ (img.channels),
  };
}

/**
 * @param {RawImage} img
 * @param {unknown} params
 * @returns {Promise<RawImage>}
 */
async function applyAdjustOp(img, params) {
  // 动态 import：edit.js 静态依赖 library.js，nondestructive 又被 library 依赖，
  // 静态互引会形成环；这里只在真正渲染时加载，模块已求值过，没有副作用。
  const mod = await import('./edit.js');
  const p = mod.normalizeAdjust(params || {});
  if (!mod.isEmptyAdjust(p)) {
    mod.applyRaw(img.data, img.channels, p, mod.buildLuts(p));
  }
  if (p.clarity > 0 || p.sharpen > 0) {
    const out = await mod
      .applyAdjust(sharp(img.data, { raw: rawOptions(img) }), p)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: out.data, width: img.width, height: img.height, channels: img.channels };
  }
  return img;
}

/**
 * 把操作链渲染成图片。
 * @param {object} row images 行
 * @param {any[]} ops 操作链
 * @param {{maxEdge?:number, format?:string, quality?:number}} opts maxEdge=0 表示原尺寸
 */
export async function renderOps(row, ops, opts = {}) {
  const { maxEdge = 0, format = 'jpeg', quality = 92 } = opts;
  if (!row?.abs_path) throw new Error('图片不存在');
  /** @type {RawImage} */
  let img = await decodeRaw(row.abs_path);
  let resizeTo = null;
  for (const op of ops || []) {
    if (op.kind === 'rotate') img = rotateRaw(img, op.params?.dir);
    else if (op.kind === 'crop') {
      img = cropRaw(img, op.params);
      if (op.params?.outWidth >= 16 && op.params?.outHeight >= 16) {
        resizeTo = { width: op.params.outWidth, height: op.params.outHeight };
      }
    } else if (op.kind === 'adjust') img = await applyAdjustOp(img, op.params);
  }

  let pipeline = sharp(img.data, { raw: rawOptions(img) });
  if (resizeTo) pipeline = pipeline.resize(resizeTo.width, resizeTo.height, { fit: 'fill' });
  else if (maxEdge > 0 && Math.max(img.width, img.height) > maxEdge) {
    pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  }

  if (format === 'png') {
    const r = await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    return { data: r.data, width: r.info.width, height: r.info.height };
  }
  if (format === 'webp') {
    const r = await pipeline.webp({ quality: Math.max(80, quality) }).toBuffer({ resolveWithObject: true });
    return { data: r.data, width: r.info.width, height: r.info.height };
  }
  if (format === 'avif') {
    const r = await pipeline.avif({ quality: 60 }).toBuffer({ resolveWithObject: true });
    return { data: r.data, width: r.info.width, height: r.info.height };
  }
  const r = await pipeline
    .jpeg({ quality, mozjpeg: true, progressive: true })
    .toBuffer({ resolveWithObject: true });
  return { data: r.data, width: r.info.width, height: r.info.height };
}

/**
 * 按需生成派生图并返回路径；没有操作链或渲染失败返回 ''（调用方回落到原图）。
 * @param {'thumb'|'preview'|'full'} kind
 */
export async function ensureDerived(row, kind, attempt = 0) {
  const id = Number(row?.id);
  if (!id || !row?.abs_path) return '';
  const format = kind === 'full' ? sourceFormat(row) : 'jpeg';
  const target = derivedPath(id, kind, format);
  try {
    const st = fs.statSync(target);
    if (st.size > 0) return target;
  } catch {
    /* 还没生成 */
  }
  const ops = listOps(id);
  if (!ops.length) return '';
  const ver = opsVersion(id);
  const maxEdge = kind === 'thumb' ? 640 : kind === 'preview' ? 1920 : 0;
  const { data } = await renderOps(row, ops, {
    maxEdge,
    format,
    quality: kind === 'full' ? 95 : 82,
  }).catch((err) => {
    console.error('[nd-edit] 渲染失败', id, err?.message || err);
    return { data: null };
  });
  if (!data) return '';
  // 渲染期间操作链又被改了（连续点撤销/追加）：这次结果已经过期，丢掉重来
  if (opsVersion(id) !== ver) {
    if (attempt < 2) return ensureDerived(row, kind, attempt + 1);
    return '';
  }
  await ensureThumbDirFor(id);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, target).catch(async () => {
    // Windows 上目标被并发请求占用：另一路已经写好了同一份内容，直接用它
    await fsp.rm(tmp, { force: true }).catch(() => {});
  });
  return fs.existsSync(target) ? target : '';
}

/** 操作链的中文摘要（撤销记录 / 界面展示共用） */
export function opsSummary(ops) {
  const name = { crop: '裁切', rotate: '旋转', adjust: '调色' };
  const counts = new Map();
  for (const op of ops || []) counts.set(op.kind, (counts.get(op.kind) || 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${name[k] || k}${n > 1 ? `×${n}` : ''}`).join(' + ');
}
