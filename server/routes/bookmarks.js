/** 网页书签：POST /api/bookmarks { url, tags?, note? } */
import path from 'node:path';
import fs from 'node:fs';
import * as lib from '../library.js';
import { saveBookmark } from '../bookmarks.js';

export function register(app, { asyncRoute }) {
  /* 书签快照本体：供应用内「书签浏览器」的 iframe 直接加载。
   * 快照是我们自己抓的静态 HTML，禁止脚本执行（script-src 'none'），
   * 只放行样式/图片/字体，避免把第三方页面的脚本权限带进应用。
   * 外链资源（CSS/图片）允许 https，断网时退化成无样式正文，但不会白屏。 */
  app.get('/api/images/:id/snapshot', (req, res) => {
    const row = lib.getImage(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '书签不存在' });
    if (row.media_kind !== 'bookmark') return res.status(400).json({ error: '这条素材不是网页书签' });
    const file = String(row.abs_path || '');
    if (!file.toLowerCase().endsWith('.html') || !fs.existsSync(file)) {
      return res.status(404).json({ error: '快照文件缺失（可能已被清理）' });
    }
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline' https:; img-src data: https: http:; font-src data: https:; media-src https:; script-src 'none'; frame-src 'none'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type('text/html; charset=utf-8');
    // 快照可能落在 .tuku 这类点目录下：send 默认把点开头的路径段当隐藏文件回 404
    res.sendFile(path.resolve(file), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.post(
    '/api/bookmarks',
    asyncRoute(async (req, res) => {
      const url = String(req.body?.url || '').trim();
      if (!url) return res.status(400).json({ error: '缺少 url' });
      const tags = Array.isArray(req.body?.tags)
        ? req.body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 30)
        : String(req.body?.tags || '')
            .split(/[,，\s]+/)
            .filter(Boolean)
            .slice(0, 30);
      const note = String(req.body?.note || '').trim().slice(0, 2000);
      try {
        const item = await saveBookmark({ url, tags, note });
        res.json({ ok: true, item });
      } catch (err) {
        res.status(400).json({ error: err.message || '保存失败' });
      }
    })
  );
}
