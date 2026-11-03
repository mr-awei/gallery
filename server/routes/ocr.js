// 图内文字识别（OCR）：识别一次 -> 存 image_ocr -> 关键词搜索自动命中
// 系统引擎（Windows.Media.Ocr）离线、零下载；非 Windows 明确告知不可用，不假装能跑。
import fs from 'node:fs';
import path from 'node:path';
import * as lib from '../library.js';
import { db } from '../db.js';
import { ocrImage, ocrPlatformSupported } from '../lib/ocr.js';

// 能喂给 OCR 的只有位图；设计稿/RAW/3D/视频没有可识别像素
const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.gif']);
const MAX_BATCH = 30;

function readCached(id) {
  const row = db.prepare('SELECT text, lang, engine, created_at FROM image_ocr WHERE image_id = ?').get(id);
  if (!row) return null;
  return { text: row.text, lang: row.lang, engine: row.engine, createdAt: row.created_at };
}

function saveCache(id, r) {
  db.prepare(
    `INSERT INTO image_ocr (image_id, text, lang, engine, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET text = excluded.text, lang = excluded.lang,
       engine = excluded.engine, created_at = excluded.created_at`
  ).run(id, r.text, r.lang, r.engine, new Date().toISOString());
}

async function runOne(row, { force = false } = {}) {
  const id = row.id;
  if (!force) {
    const cached = readCached(id);
    if (cached) return { id, ok: true, cached: true, ...cached };
  }
  const ext = path.extname(String(row.abs_path || '')).toLowerCase();
  if (!row.abs_path || !fs.existsSync(row.abs_path)) {
    return { id, ok: false, error: '原文件不存在（可能被移动或删除）' };
  }
  if (!RASTER.has(ext)) {
    return { id, ok: false, error: `这个格式（${ext || '未知'}）不是位图，无法做文字识别` };
  }
  const r = await ocrImage(row.abs_path);
  if (!r.ok) return { id, ok: false, error: r.error };
  saveCache(id, r);
  return { id, ok: true, cached: false, ...r, chars: r.text.length };
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/ocr/status', (_req, res) => {
    res.json({
      platform: process.platform,
      available: ocrPlatformSupported(),
      engine: 'windows-ocr',
      note: ocrPlatformSupported()
        ? '使用 Windows 系统自带的离线文字识别（无需下载模型）'
        : '系统 OCR 仅 Windows 10/11 可用；当前系统没有可用的离线识别引擎',
    });
  });

  /* 读取已缓存的识别结果（不触发识别） */
  app.get('/api/images/:id/ocr', (req, res) => {
    const id = Number(req.params.id);
    const cached = readCached(id);
    if (!cached) return res.status(404).json({ error: '还没有识别过' });
    res.json({ ok: true, id, ...cached });
  });

  /* 识别单张：?force=1 重新识别 */
  app.post(
    '/api/images/:id/ocr',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      if (!ocrPlatformSupported()) {
        return res.status(409).json({ error: '系统 OCR 仅 Windows 可用（当前系统没有离线识别引擎）', code: 'UNSUPPORTED' });
      }
      const r = await runOne(row, { force: Boolean(req.body?.force) || req.query.force === '1' });
      if (!r.ok) return res.status(400).json({ error: r.error, id });
      res.json(r);
    })
  );

  /* 批量识别（当前选区）：串行跑，避免 30 个 PowerShell 同时起把机器拖死 */
  app.post(
    '/api/images/ocr-batch',
    asyncRoute(async (req, res) => {
      if (!ocrPlatformSupported()) {
        return res.status(409).json({ error: '系统 OCR 仅 Windows 可用（当前系统没有离线识别引擎）', code: 'UNSUPPORTED' });
      }
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, MAX_BATCH);
      if (!ids.length) return res.status(400).json({ error: '没有选择任何素材' });
      const force = Boolean(req.body?.force);
      const results = [];
      for (const id of ids) {
        const row = lib.getImage(id);
        if (!row) {
          results.push({ id, ok: false, error: '图片不存在' });
          continue;
        }
        try {
          results.push(await runOne(row, { force }));
        } catch (err) {
          results.push({ id, ok: false, error: err.message });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      res.json({ ok: okCount > 0, total: ids.length, okCount, truncated: ids.length >= MAX_BATCH, results });
    })
  );

  /* 删除识别结果（隐私/误识别） */
  app.delete('/api/images/:id/ocr', (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM image_ocr WHERE image_id = ?').run(id);
    res.json({ ok: true, id });
  });
}
