// @ts-check
// 拖拽 / 粘贴入库（Eagle 三件套里的两件；第三件截图见 electron/main.js 的全局快捷键）
//
// 为什么不用 multer：前端把 File 直接当 body 发（application/octet-stream），
// 文件名走 query，一次一个文件。省一个依赖，也避免 multipart 解析大文件时的内存抖动。
import express from 'express';
import * as lib from '../library.js';
import { getSettings } from '../db.js';
import { ingestMedia, isMediaPath } from '../lib/media.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /**
   * 上传体上限必须按「当前设置」决定，而且要在读请求体之前就拒绝。
   * 以前的顺序是 raw({limit:'512mb'}) 先按 512MB 把整个请求读进内存，
   * 业务里再拿 maxFileSize（默认 25MB）判一次 —— 一个 500MB 的请求先把内存吃掉才被拒。
   */
  const raw = (req, res, next) => {
    const maxBytes = Math.max(1, Number(getSettings().maxFileSize || 50)) * 1024 * 1024;
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > maxBytes + 1024 * 1024) {
      return res.status(413).json({ error: `文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）` });
    }
    return express.raw({ type: '*/*', limit: maxBytes + 1024 * 1024 })(req, res, next);
  };

  app.post(
    '/api/import/upload',
    raw,
    asyncRoute(async (req, res) => {
      const settings = getSettings();
      const filename = String(req.query.filename || req.query.name || '').trim();
      if (!filename) return res.status(400).json({ error: '缺少文件名' });
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) return res.status(400).json({ error: '文件为空' });
      const maxBytes = Number(settings.maxFileSize || 50) * 1024 * 1024;
      if (buf.length > maxBytes) return res.status(413).json({ error: '文件超过大小上限' });

      const tags = String(req.query.tags || '');
      const keyword = String(req.query.keyword || '');
      const source = String(req.query.source || 'local');

      if (isMediaPath(filename)) {
        const r = await ingestMedia({
          buffer: buf,
          title: filename,
          source,
          keyword,
          tags,
          copyToStorage: true,
        });
        if (!r.ok) return res.status(400).json({ error: '该格式暂不支持' });
        return res.json({ ok: true, image: lib.toDTO(lib.getImage(r.id)) });
      }

      const r = await lib.ingest({
        buffer: buf,
        title: filename,
        source,
        keyword,
        tags,
        copyToStorage: true,
      });
      if (!r.ok) {
        // 前端拿这句话直接弹 toast，别让它停在没信息的「导入失败」上
        const map = {
          small: '文件太小（低于最小体积设置）',
          oversize: '文件超过大小上限',
          format: '不支持的格式',
          lowres: '分辨率太低（长边小于最小分辨率设置）',
          duplicate: '图库里已有相同内容',
        };
        return res.status(400).json({ error: map[r.reason] || '导入失败' });
      }
      res.json({ ok: true, image: lib.toDTO(lib.getImage(r.id)) });
    })
  );
}
