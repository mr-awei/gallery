// @ts-check

// EPUB 阅读接口：一本书的目录/封面，以及按章取文本与插图
import path from 'node:path';
import * as lib from '../library.js';
import { openEpubFile, readChapter } from '../lib/epub.js';

const isEpub = (/** @type {string} */ p) => path.extname(p || '').toLowerCase() === '.epub';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* 目录 + 封面 + 书名作者：打开阅读器时只请求这一次 */
  app.get(
    '/api/images/:id/epub',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '图片不存在' });
      if (!isEpub(row.abs_path)) return res.status(400).json({ error: '不是 EPUB 文件' });
      const book = await openEpubFile(row.abs_path);
      res.json({
        ok: true,
        title: book.title || row.title || '',
        author: book.author || '',
        language: book.language || '',
        cover: book.cover,
        chapters: book.chapters.map((c, i) => ({ index: i, label: c.label })),
      });
    })
  );

  /* 单章正文（含插图，图片已转 data URL，前端不碰书里的 HTML） */
  app.get(
    '/api/images/:id/epub/:index',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '图片不存在' });
      if (!isEpub(row.abs_path)) return res.status(400).json({ error: '不是 EPUB 文件' });
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: '章节序号不对' });
      const book = await openEpubFile(row.abs_path);
      const chapter = await readChapter(book, index);
      if (!chapter) return res.status(404).json({ error: '没有这一章' });
      res.json({ ok: true, ...chapter, total: book.chapters.length });
    })
  );
}
