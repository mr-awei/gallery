// 图片编辑路由：裁切（预设比例/原比例/自由框）+ Camera Raw 调色，单张与批量
import fs from 'node:fs';
import { CROP_RATIOS, ADJUST_DEFAULTS, adjustImage, cropImage } from '../lib/edit.js';
import { detectFocus, parseRatioSpec } from '../lib/focus.js';
import { systemFonts } from '../lib/fonts.js';
import { GEO_REGIONS } from '../lib/geo.js';
import { previewWatermark, watermarkImage, watermarkOptions } from '../lib/watermark.js';
import { getImage } from '../library.js';
import { cancelEditJob, editJobStatus, startEditJob } from '../edit-job.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* 编辑选项：裁切比例清单 + 调色参数默认值（0 = 原图） */
  app.get('/api/edit/options', (_req, res) => {
    res.json({ ratios: CROP_RATIOS, adjust: ADJUST_DEFAULTS });
  });

  /* 自动检测图像焦点：给定目标比例，返回最该保留的归一化框（批量裁切台用） */
  app.get(
    '/api/images/:id/focus',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = getImage(id);
      if (!row || !row.abs_path) return res.status(404).json({ error: '图片不存在' });
      if (!fs.existsSync(row.abs_path)) return res.status(404).json({ error: '本地文件不存在' });
      const spec = parseRatioSpec(req.query.ratio || '1:1');
      if (!spec) return res.status(400).json({ error: '比例格式不对，示例：2:3' });
      try {
        const r = await detectFocus(row.abs_path, { ratioW: spec[0], ratioH: spec[1] });
        res.json({ ok: true, ratio: `${spec[0]}:${spec[1]}`, ...r });
      } catch (err) {
        res.status(400).json({ error: err.message || '焦点检测失败' });
      }
    })
  );

  /* 单张裁切：{ ratio: '1:1' } 居中最大框，或 { ratio:'free'|'orig', rect:{x,y,w,h} } 使用框选区域 */
  app.post(
    '/api/images/:id/crop',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      try {
        const r = await cropImage(id, req.body || {});
        res.json({ ok: true, item: r.item, savedPath: r.savedPath, copied: !!r.copied, note: r.note || '' });
      } catch (err) {
        res.status(400).json({ error: err.message || '裁切失败' });
      }
    })
  );

  /* 单张调色：{ temperature, tint, exposure, contrast, saturation, sharpen }，全部 0 时原样返回 */
  app.post(
    '/api/images/:id/adjust',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      try {
        const r = await adjustImage(id, req.body || {});
        res.json({ ok: true, item: r.item, savedPath: r.savedPath, copied: !!r.copied, note: r.note || '' });
      } catch (err) {
        res.status(400).json({ error: err.message || '调色失败' });
      }
    })
  );

  /* 水印 / 相框样式表：23 + 20 款、可选字段、品牌清单、本机字体 */
  app.get('/api/watermark/options', (_req, res) => res.json(watermarkOptions()));

  /* 拍摄地点的三级选择器数据（省 → 市 → 区/县）：55KB，前端打开面板时取一次并缓存 */
  app.get('/api/geo/regions', (_req, res) => res.json({ provinces: GEO_REGIONS }));

  /* 本机字体清单：?refresh=1 重新扫描（用户刚装完字体时点「刷新」） */
  app.get('/api/watermark/fonts', (req, res) => {
    res.json({ fonts: systemFonts({ refresh: req.query.refresh === '1' }) });
  });

  /* 水印预览：返回 JPEG 二进制。调参时前端高频刷新，所以长边压到 1400 以内 */
  app.post(
    '/api/images/:id/watermark/preview',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      try {
        const r = await previewWatermark(id, req.body || {});
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        // 预览可能「出了图但没画水印」（这张图没有可显示的信息），把原因带走。
        // HTTP 头只能是 Latin-1，中文必须编码后再传，前端 decodeURIComponent 还原
        if (r.note) res.setHeader('X-Watermark-Note', encodeURIComponent(r.note));
        // 跨域（dev 下 5173 → 3001）默认只暴露安全头，自定义头要让浏览器读得到
        res.setHeader('Access-Control-Expose-Headers', 'X-Watermark-Note');
        res.end(r.data);
      } catch (err) {
        // 预览失败用 JSON 说明原因，前端把它显示在预览区（不会污染图片响应）
        res.status(400).json({ error: err.message || '预览失败' });
      }
    })
  );

  /* 单张水印 / 相框：{ style, frame, fields[], logo, brand, size, opacity, color, saveMode } */
  app.post(
    '/api/images/:id/watermark',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      try {
        const r = await watermarkImage(id, req.body || {});
        res.json({
          ok: true,
          item: r.item,
          savedPath: r.savedPath,
          copied: !!r.copied,
          note: r.note || '',
          width: r.width,
          height: r.height,
        });
      } catch (err) {
        res.status(400).json({ error: err.message || '水印合成失败' });
      }
    })
  );

  /* 批量编辑：{ ids:[], op:'crop'|'adjust'|'watermark', params:{...} }，异步任务，进度用 /api/edit/job 轮询 */
  app.post(
    '/api/images/batch/edit',
    asyncRoute(async (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      try {
        const job = startEditJob(ids, String(req.body?.op || ''), req.body?.params || {});
        res.json({ ok: true, job });
      } catch (err) {
        res.status(400).json({ error: err.message || '批量编辑启动失败' });
      }
    })
  );

  app.get('/api/edit/job', (_req, res) => res.json(editJobStatus()));

  app.post('/api/edit/job/cancel', (_req, res) => res.json(cancelEditJob()));
}
