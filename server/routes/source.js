// @ts-check
// 素材「来源」相关：外部以图搜图、一键换大图
import sharp from 'sharp';
import * as lib from '../library.js';
import { findLargerSource, listProviders, reverseSearch } from '../lib/external-search.js';
import { replaceSourceImage } from '../lib/edit.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* 这张图能用哪些搜图渠道（含不可用原因） */
  app.get('/api/images/:id/search-providers', (req, res) => {
    const row = lib.getImage(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '图片不存在' });
    res.json({
      ok: true,
      sourceUrl: row.source_url || '',
      providers: listProviders(row),
    });
  });

  /* 执行搜图：upload 类由服务端上传，url/keyword 类返回要打开的链接 */
  app.post(
    '/api/images/:id/reverse-search',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const engine = String(req.body?.engine || '');
      const r = await reverseSearch(row, engine);
      res.json(r);
    })
  );

  /* 预览「换大图」能不能换：只探测，不落盘 */
  app.get(
    '/api/images/:id/upgrade-source/preview',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const r = await findLargerSource(row, { minGain: Number(req.query.minGain) || 1.1 });
      // 探测结果的 buffer 不往响应里塞（几十 MB），只回尺寸与来源
      res.json({
        ok: true,
        found: r.found,
        before: r.before,
        after: r.found ? { width: r.width, height: r.height, url: r.url } : null,
        tried: r.tried.map((t) => ({ url: t.url, error: t.error, width: t.width, height: t.height })),
      });
    })
  );

  /* 真正替换：下载 -> 校验 -> 写回原文件（留撤销备份、重算哈希、清缩略图） */
  app.post(
    '/api/images/:id/upgrade-source',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const r = await findLargerSource(row, { minGain: Number(req.body?.minGain) || 1.1 });
      if (!r.found) {
        return res.status(409).json({
          error: '没有找到更大的版本',
          before: r.before,
          tried: r.tried.map((t) => ({ url: t.url, error: t.error })),
        });
      }
      const info = await sharp(r.buffer, { failOn: 'none' }).metadata();
      const out = await replaceSourceImage(id, r.buffer, { width: info.width, height: info.height }, '换大图');
      res.json({
        ok: true,
        before: r.before,
        after: { width: r.width, height: r.height, url: r.url },
        bytes: r.buffer.length,
        item: out.item,
      });
    })
  );
}
