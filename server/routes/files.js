// 文件服务路由：原图/缩略图直出、批量打包下载 zip（从 app.js 拆出）
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import * as lib from '../library.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;


  app.get(
    '/api/images/:id/thumb',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).end('not found');
      // 缩略图按需生成：增强/旋转后旧缩略图会被删除，这里负责重建
      // （否则会退回发送整张大图，图库加载会变成每张几百 KB）
      const thumb = await lib.ensureThumb(id, row.abs_path);
      const file = thumb && fs.existsSync(thumb) ? thumb : row.abs_path;
      if (!fs.existsSync(file)) return res.status(404).end('file missing');
      res.set('Cache-Control', 'public, max-age=604800');
      res.type(file); // 按真实扩展名给 Content-Type（原来是硬写 image/jpeg）
      res.sendFile(file);
    })
  );

  app.get(
    '/api/images/:id/file',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).end('not found');
      res.set('Cache-Control', 'public, max-age=604800');
      res.sendFile(row.abs_path);
    })
  );

  app.get(
    '/api/images/:id/download',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).end('not found');
      const ext = path.extname(row.abs_path) || '.jpg';
      const name = `邓紫棋_${row.id}_${row.width}x${row.height}${ext}`;
      res.set(
        'Content-Disposition',
        `attachment; filename="gem_${row.id}${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`
      );
      res.sendFile(row.abs_path);
    })
  );

  async function streamZip(ids, res) {
    const rows = ids.map((id) => lib.getImage(id)).filter((r) => r && fs.existsSync(r.abs_path));
    if (!rows.length) {
      res.status(400).json({ error: '没有可下载的图片' });
      return;
    }
    res.set(
      'Content-Disposition',
      `attachment; filename="gem-wallpapers.zip"; filename*=UTF-8''${encodeURIComponent('邓紫棋壁纸合集.zip')}`
    );
    res.set('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => res.status(500).end(err.message));
    archive.pipe(res);
    const used = new Set();
    for (const row of rows) {
      const ext = path.extname(row.abs_path) || '.jpg';
      let base = `邓紫棋_${row.width}x${row.height}_${row.id}`;
      let name = base + ext;
      let i = 1;
      while (used.has(name)) name = `${base}_${++i}${ext}`;
      used.add(name);
      archive.file(row.abs_path, { name });
    }
    await archive.finalize();
  }

  app.post(
    '/api/download/zip',
    asyncRoute(async (req, res) => {
      await streamZip((req.body.ids || []).map(Number).filter(Boolean), res);
    })
  );

  app.get(
    '/api/download/zip',
    asyncRoute(async (req, res) => {
      const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter(Boolean);
      await streamZip(ids, res);
    })
  );
}
