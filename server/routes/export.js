// @ts-check
// 导出类路由：把图库里的图按需转成 jpg / png / webp / avif 另存（对标 Eagle 的「导出」）
// 以及导出为 HTML 网页画廊（单文件、图片内嵌，可离线打开/分享）
import path from 'node:path';
import sharp from 'sharp';
import * as lib from '../library.js';
import { buildGalleryHtml, safeFileName, MAX_ITEMS } from '../gallery-export.js';
import { buildStitch, suggestCrops, planGeometry } from '../lib/stitch.js';
import { STITCH_TEMPLATES, FLOW_LAYOUTS } from '../lib/stitch-templates.js';
import { eagleExportPreview, exportEagleLibrary } from '../lib/eagle-export.js';
import { startEagleExportJob } from '../eagle-export-job.js';
import { bumpUsage } from '../lib/usage.js';

const FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* 反向互通：把当前库导出成 Eagle 4 的 .library（原图 + 文件夹层级 + 标签 + 星级） */
  app.get('/api/export/eagle/preview', (_req, res) => {
    try {
      res.json(eagleExportPreview());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 后台任务版：立即返回 jobId，进度走 /api/jobs/:id 或任务中心。
  // 同步版保留给外部调用方，界面不再用（几千张原图会等到超时）。
  app.post('/api/export/eagle/job', (req, res) => {
    try {
      res.json(startEagleExportJob({ destDir: req.body?.destDir, name: req.body?.name }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post(
    '/api/export/eagle',
    asyncRoute(async (req, res) => {
      try {
        const r = await exportEagleLibrary({ destDir: req.body?.destDir, name: req.body?.name });
        res.json(r);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /* 单张导出：?format=webp&quality=82&maxSide=2048（maxSide=0 表示保持原始尺寸） */
  app.get(
    '/api/images/:id/export',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });

      const raw = String(req.query.format || 'jpeg').toLowerCase();
      const format = FORMATS.has(raw) ? raw : 'jpeg';
      const quality = Math.min(100, Math.max(40, Number(req.query.quality) || 90));
      const maxSide = Math.min(12000, Math.max(0, Math.round(Number(req.query.maxSide) || 0)));

      try {
        const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
        let pipe = sharp(row.abs_path, { failOn: 'none' }).rotate();
        const w = meta.width || 0;
        const h = meta.height || 0;
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

        const buf = await pipe.toBuffer();
        const base = path.basename(row.abs_path, path.extname(row.abs_path));
        const ext = format === 'jpeg' ? 'jpg' : format;
        res.setHeader('Content-Type', MIME[format]);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(`${base}.${ext}`)}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`
        );
        res.setHeader('Cache-Control', 'no-store');
        // 使用统计：导出成功才计数（失败的重试不算「用过」）
        bumpUsage('export', [row.id]);
        res.send(buf);
      } catch (err) {
        res.status(400).json({ error: err.message || '导出失败' });
      }
    })
  );

  /* 导出为 HTML 网页画廊。
   * GET（不是 POST）：下载由 Electron 主进程发起，只能带 ?token= 而带不上请求头；
   * URL 长度也够用（ids 上限 500 个，约 3KB）。
   * 参数：scope=folder|all / folderId / ids=1,2,3 / title / columns / theme / maxItems */
  app.get(
    '/api/export/gallery',
    asyncRoute(async (req, res) => {
      const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      const scope = req.query.scope === 'folder' ? 'folder' : 'all';
      const folderId = Number(req.query.folderId) || null;
      const title = String(req.query.title || '').slice(0, 80) || '图库画廊';
      const columns = Math.min(8, Math.max(2, Number(req.query.columns) || 4));
      const theme = ['light', 'dark', 'auto'].includes(String(req.query.theme))
        ? String(req.query.theme)
        : 'auto';
      const maxItems = Math.min(MAX_ITEMS, Math.max(1, Number(req.query.maxItems) || 200));

      const result = await buildGalleryHtml({
        scope,
        folderId,
        ids,
        title,
        columns,
        theme,
        maxItems,
      });
      // 明确勾选素材导出 HTML 画廊，也算这些素材被「用过」；
      // scope=all 不计数（否则导出一次整库，所有素材的使用次数都被刷一遍）
      if (ids.length) bumpUsage('export', ids.slice(0, 500));
      const file = `${safeFileName(title)}.html`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="gallery.html"; filename*=UTF-8''${encodeURIComponent(file)}`
      );
      res.setHeader('Cache-Control', 'no-store');
      res.send(result.html);
    })
  );

  /* 拼图模板清单：构图数据放在服务端一份，前端只负责画缩略图，
   * 避免「前端一套坐标、后端一套坐标」两边慢慢对不上 */
  app.get('/api/export/stitch/templates', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ templates: STITCH_TEMPLATES, layouts: FLOW_LAYOUTS });
  });

  /* 自动构图：让显著度检测给每格算出焦点与缩放，返回具体数值。
   * 前端点「自动构图」后要在这个结果上继续手调，所以不能只回一张图。 */
  app.get(
    '/api/export/stitch/crops',
    asyncRoute(async (req, res) => {
      const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      const crops = await suggestCrops(ids, String(req.query.template || ''), req.query.outWidth);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ crops });
    })
  );

  /* 版面坐标：前端构图台要知道每一格在画布里的位置（归一化）与缩放下限 zMin。
   * 算法版式（grid/justified/mosaic…）的格子是服务端算的，前端不能自己猜；
   * 模板的格子也走这里，保证「拖的那个框」就是「真正被裁的那块」。 */
  app.get(
    '/api/export/stitch/plan',
    asyncRoute(async (req, res) => {
      const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      const rows = ids.map((id) => lib.getImage(id)).filter(Boolean);
      if (!rows.length) return res.status(400).json({ error: '没有可用素材' });
      const geo = planGeometry(rows, req.query);
      const boxes = geo.boxes.map((b) => ({
        x: b.x / geo.W,
        y: b.y / geo.H,
        w: b.w / geo.W,
        h: b.h / geo.H,
        idx: b.idx,
      }));
      // zMin 由 planGeometry 在像素口径里算好（归一化坐标乘常数会把比例算错）
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ratio: geo.ratio, boxes, zMin: geo.zMin });
    })
  );

  /* 图片拼接 / 版面生成：GET 是为了让桌面端下载（主进程只能带 ?token=）也能用。
   * 参数：ids=1,2,3 / template=<模板 id> / crops=fx,fy,z;...（auto = 自动构图）
   *      layout=auto|grid|justified|mosaic|poster|comic|seamless|stack（模板之外的兜底版式）
   *      ratio=auto|1:1|4:5|3:4|16:9|9:16|2:3 / outWidth / columns / gap / bg / cell
   *      radius / shadow / border / backdrop（覆盖模板默认装饰）
   *      seamless=1（无缝：留白/缝隙/圆角/描边/投影全部归零）
   *      format / quality / title / subtitle / billing（后三个是海报文字层）/ file（文件名） */
  app.get(
    '/api/export/stitch',
    asyncRoute(async (req, res) => {
      const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      // 叠字用的标题与文件名分开：没填标题时不能凭空在海报上压一行「拼接图」，
      // 但没文字的模板（四格、九格…）仍然要能自己取文件名，所以单给一个 file 参数
      const title = String(req.query.title || '').slice(0, 60);
      const fileTitle = String(req.query.file || '').slice(0, 60) || title || '拼接图';
      const r = await buildStitch({
        ids,
        template: req.query.template,
        crops: req.query.crops,
        subtitle: req.query.subtitle,
        billing: req.query.billing,
        layout: req.query.layout,
        ratio: req.query.ratio,
        outWidth: req.query.outWidth,
        columns: req.query.columns,
        gap: req.query.gap,
        bg: req.query.bg,
        cell: req.query.cell,
        radius: req.query.radius,
        shadow: req.query.shadow,
        border: req.query.border,
        backdrop: req.query.backdrop,
        seamless: req.query.seamless,
        format: req.query.format,
        quality: req.query.quality,
        title,
        // 海报排版的三个可调项：字体族 / 标题字号倍率 / 标题颜色
        font: req.query.font,
        titleScale: req.query.titleScale,
        titleColor: req.query.titleColor,
      });
      const file = `${safeFileName(fileTitle)}.${r.ext}`;
      res.setHeader('Content-Type', r.mime);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="stitch.${r.ext}"; filename*=UTF-8''${encodeURIComponent(file)}`
      );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Stitch-Size', `${r.width}x${r.height}`);
      res.send(r.buffer);
    })
  );

  /* 导出面板用的候选格式与默认值 */
  app.get('/api/export/options', (_req, res) => {
    res.json({
      formats: [
        { key: 'jpeg', label: 'JPEG', ext: 'jpg', note: '体积小，适合分享' },
        { key: 'png', label: 'PNG', ext: 'png', note: '无损，适合透明图/截图' },
        { key: 'webp', label: 'WebP', ext: 'webp', note: '同画质更小，网页常用' },
        { key: 'avif', label: 'AVIF', ext: 'avif', note: '压缩率最高，老软件可能打不开' },
      ],
      // 最高档给 100：需要「一点不将就」的时候得有得选（体积会明显变大）
      qualities: [100, 95, 90, 82],
      maxSides: [0, 4096, 2048, 1024, 512],
    });
  });
}
