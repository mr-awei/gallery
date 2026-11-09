// @ts-check
// 文件服务路由：原图/缩略图直出、批量打包下载 zip（从 app.js 拆出）
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as lib from '../library.js';
import { bumpUsage } from '../lib/usage.js';
import { existingPreviewPath, existingThumbPath, ensurePreview, mtimeOf } from '../thumbs.js';
import {
  noteForegroundEnd,
  noteForegroundStart,
  previewQueueStats,
  prioritizePreviews,
} from '../lib/preview-queue.js';
import { queueThumb, trySyncThumb } from '../lib/thumb-queue.js';

/** 打包导出时允许的转码格式（空 = 保持原文件不动） */
const ZIP_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
const ZIP_EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };
const MAX_ZIP_ITEMS = 500;

/** 文件名去掉非法字符，避免解压后在不同系统上炸开 */
function safeBase(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\.[^.]+$/, '')
    .trim()
    .slice(0, 80);
}

/** 把归档里的一张图按目标格式编码（非图片素材保持原样） */
async function encodeEntry(row, format, quality, maxSide) {
  if (!format) return null;
  const kind = row.media_kind || 'image';
  if (kind !== 'image' && kind !== 'gif') return null;
  let pipe = sharp(row.abs_path, { failOn: 'none' }).rotate();
  const w = row.width || 0;
  const h = row.height || 0;
  if (maxSide > 0 && Math.max(w, h) > maxSide) {
    pipe = pipe.resize({
      width: w >= h ? maxSide : undefined,
      height: h > w ? maxSide : undefined,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  if (format === 'png') pipe = pipe.png({ compressionLevel: 9 });
  else if (format === 'webp') pipe = pipe.webp({ quality });
  else if (format === 'avif') pipe = pipe.avif({ quality: Math.min(90, quality) });
  else pipe = pipe.jpeg({ quality, mozjpeg: true });
  return pipe.toBuffer();
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  // 库数据就放在 <素材目录>/.tuku 下，而 Express 的 send 默认把路径里以点开头的
  // 目录当隐藏文件直接回 404 —— 表现就是「缩略图/预览全在转圈，但磁盘上文件明明在」。
  // 这些路径全部来自数据库（我们自己的缓存与原图），必须显式放开。
  const SEND_OPTS = { dotfiles: 'allow' };


  app.get(
    '/api/images/:id/thumb',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).end('not found');
      // 视频/音频/字体/PDF/3D 这类素材 sharp 解不了：只有用户设过封面帧才有缩略图，
      // 没有就 404，让前端回落到 <video>/图标，别去触发 sharp 报错。
      const kind = row.media_kind || 'image';
      if (kind !== 'image' && kind !== 'gif') {
        const custom = row.thumb && fs.existsSync(row.thumb) ? row.thumb : '';
        if (custom) {
          res.set('Cache-Control', 'public, max-age=604800');
          res.type(custom);
          return res.sendFile(custom, SEND_OPTS);
        }
        // RAW / 设计稿可以从文件里抽内嵌预览：给一次插队生成的机会（卡片正看着这张）。
        // 以前这里直接 404 且不带 Cache-Control —— Electron 会把这次「暂缺」长期缓存，
        // 补图完成后 URL 又没变，卡片就永远停在「暂无预览」（磁盘上缩略图明明已存在）。
        if (kind === 'raw' || kind === 'design') {
          if (req.query.retry) {
            const made = await trySyncThumb(id);
            if (made && fs.existsSync(made)) {
              res.set('Cache-Control', 'public, max-age=604800');
              res.type(made);
              return res.sendFile(made, SEND_OPTS);
            }
          }
          queueThumb(id);
        }
        res.set('Cache-Control', 'no-store');
        return res.status(404).end('thumb pending');
      }
      // 已有缩略图：直发（绝大多数请求走这条，零解码）。
      // 必须比对原图 mtime：按 id 命名的缓存可能是「上一辈子这个 id」的残留，
      // 只判断存在就会把别人的图当自己的发出去（列表和大图对不上的来源之一）。
      const cached = existingThumbPath(id, mtimeOf(row.abs_path));
      if (cached) {
        res.set('Cache-Control', 'public, max-age=604800');
        res.type(cached);
        return res.sendFile(cached, SEND_OPTS);
      }
      // 缺缩略图（上次导入被打断、增强/旋转后重建）：绝不在这里现场解码 ——
      // 首屏几十张并发 sharp 会把 CPU 打满，切库后要三四十秒才出图。
      // 带 retry=1 的（用户正看着的卡片）给一次插队机会，其余只排队并立刻 404 占位。
      if (req.query.retry) {
        const made = await trySyncThumb(id);
        if (made && fs.existsSync(made)) {
          res.set('Cache-Control', 'public, max-age=604800');
          res.type(made);
          return res.sendFile(made, SEND_OPTS);
        }
      }
      queueThumb(id);
      // 404 不能带缓存：否则 Electron 会把「暂缺」记住，补图完成后卡片仍不显示
      res.set('Cache-Control', 'no-store');
      return res.status(404).end('thumb pending');
    })
  );

  /**
   * 可见区预热：前端把当前屏幕上真正看得见的图片 id 发上来，服务端把它们挪到
   * 预取队首。没有这个，一页 120 张按顺序做，用户滚到页尾点开一张就要干等。
   * 只排队、不生成，立刻返回，前端可以随手调用（滚动 direction 变化时 debounce 一次）。
   */
  app.post(
    '/api/images/previews/warm',
    asyncRoute(async (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200) : [];
      const r = prioritizePreviews(ids);
      res.json({ ok: true, ...r, ...previewQueueStats() });
    })
  );

  /**
   * 灯箱预览图：长边 1920 的 JPEG。
   * 原图平均 8MB+（棚拍 PNG 能到 20MB），灯箱直接加载要下载 + 解码一两秒；
   * 这里给一档 300~550KB 的中间图，正常浏览够清晰，放大到 1.4 倍以上时前端再换原图。
   *
   * 绝大多数请求应该走「磁盘命中」这条（列表返回时已经把整页排进后台预取队列，
   * 见 lib/preview-queue.js）；没命中才现做，那时是 150~250ms。
   */
  const previewInflight = new Map();
  app.get(
    '/api/images/:id/preview',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).end('not found');
      // 带 ?v=（文件指纹）的请求可以放心长缓存：增强/旋转写回后指纹变，URL 也就变了。
      // 不带版本的保持 no-cache + ETag，避免外部直连拿到旧图。
      const cacheHeader = req.query.v ? 'private, max-age=604800' : 'no-cache';
      // 预览图同样按 id 命名，同样要比 mtime：早于原图的一定是旧 id 的残留，重新生成
      const hit = existingPreviewPath(id, mtimeOf(row.abs_path));
      if (hit) {
        res.set('Cache-Control', cacheHeader);
        res.type(hit);
        return res.sendFile(hit, SEND_OPTS);
      }
      // 同一张图的并发请求共享一次生成（预加载 + 灯箱同时要很常见）。
      // 以前超过 2 个就回 503，前端只能退回去加载 21MB 的原图 —— 那才是「模糊一两秒」。
      // 现在排队等，并且让后台预取队列先停一停，把 CPU 让给用户正等着看的这张。
      let job = previewInflight.get(id);
      if (!job) {
        noteForegroundStart();
        job = ensurePreview(id, row.abs_path).finally(() => {
          previewInflight.delete(id);
          noteForegroundEnd();
        });
        previewInflight.set(id, job);
      }
      const made = await job;
      if (made && fs.existsSync(made)) {
        res.set('Cache-Control', cacheHeader);
        res.type(made);
        return res.sendFile(made, SEND_OPTS);
      }
      // 生成失败（文件损坏等）：404 但不能缓存，否则这张图再也出不来
      res.set('Cache-Control', 'no-store');
      return res.status(404).end('preview failed');
    })
  );

  app.get(
    '/api/images/:id/file',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).end('not found');
      res.set('Cache-Control', 'public, max-age=604800');
      // PDF / Office 预览用 <iframe> 内嵌同源文件，全局的 X-Frame-Options: DENY 会把它们挡成“拒绝连接”。
      // 这里只对文件流放宽到同源可框，其余页面仍保持 DENY。
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      res.sendFile(row.abs_path, SEND_OPTS);
    })
  );

  app.get(
    '/api/images/:id/download',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).end('not found');
      const ext = path.extname(row.abs_path) || '.jpg';
      const name = `壁纸_${row.id}_${row.width}x${row.height}${ext}`;
      res.set(
        'Content-Disposition',
        `attachment; filename="tuku_${row.id}${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`
      );
      // 使用统计：下载也记一次「导出」（用户心智里下载下来用过就算用过）
      bumpUsage('export', [row.id]);
      res.sendFile(row.abs_path, SEND_OPTS);
    })
  );

  /**
   * 批量打包：默认原样打包；带 format/quality/maxSide 时逐张重编码（对标 Eagle 的批量导出）。
   * 文件名优先用素材标题（重名自动加序号），比「壁纸_WxH_id」更好认。
   */
  async function streamZip(ids, res, opts = {}) {
    const rows = ids
      .map((id) => lib.getImage(id))
      .filter((r) => r && fs.existsSync(r.abs_path))
      .slice(0, MAX_ZIP_ITEMS);
    if (!rows.length) {
      res.status(400).json({ error: '没有可下载的图片' });
      return;
    }
    const rawFormat = String(opts.format || '').toLowerCase();
    const format = ZIP_FORMATS.has(rawFormat) ? rawFormat : '';
    const quality = Math.min(100, Math.max(40, Number(opts.quality) || 90));
    const maxSide = Math.min(12000, Math.max(0, Math.round(Number(opts.maxSide) || 0)));
    const zipName = format ? `图库导出_${rows.length}张_${ZIP_EXT[format]}.zip` : `图库导出_${rows.length}张.zip`;

    res.set('Content-Disposition', `attachment; filename="tuku_export.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.set('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => res.status(500).end(err.message));
    archive.pipe(res);
    const used = new Set();
    for (const row of rows) {
      const ext = format ? `.${ZIP_EXT[format]}` : path.extname(row.abs_path) || '.jpg';
      const base = safeBase(row.title || path.basename(row.abs_path)) || `image_${row.id}`;
      let name = base + ext;
      let i = 1;
      while (used.has(name)) name = `${base}_${++i}${ext}`;
      used.add(name);
      const buf = await encodeEntry(row, format, quality, maxSide);
      if (buf) archive.append(buf, { name });
      else archive.file(row.abs_path, { name: format ? base + (path.extname(row.abs_path) || '.bin') : name });
    }
    await archive.finalize();
  }

  const zipOpts = (src = {}) => ({
    format: src.format,
    quality: src.quality,
    maxSide: src.maxSide,
  });

  app.post(
    '/api/download/zip',
    asyncRoute(async (req, res) => {
      await streamZip((req.body.ids || []).map(Number).filter(Boolean), res, zipOpts(req.body));
    })
  );

  app.get(
    '/api/download/zip',
    asyncRoute(async (req, res) => {
      const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter(Boolean);
      await streamZip(ids, res, zipOpts(req.query));
    })
  );
}
