// @ts-check
// 标注 / 评论（对标 Eagle 4 的 Annotations）
//
// 数据形态：一张图 = 一个标注图层，整层 JSON 数组存 image_annotations.data，
// 元素形如 { id, kind: 'rect'|'arrow'|'text'|'mosaic'|'brush', x, y, w, h, color, text, size, points }
// 坐标一律存「相对原图的比例 0~1」，这样换图/缩放/裁切后不会错位。
import { db } from '../db.js';
import * as lib from '../library.js';

const KINDS = new Set(['rect', 'arrow', 'text', 'mosaic', 'brush', 'highlight', 'pen']);

/** 只保留已知字段并夹紧坐标，避免脏数据把前端画崩 */
function sanitize(item) {
  if (!item || typeof item !== 'object') return null;
  const kind = String(item.kind || '');
  if (!KINDS.has(kind)) return null;
  const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  const out = {
    id: String(item.id || ''),
    kind,
    color: String(item.color || '#ff3b30').slice(0, 20),
    size: num(item.size ?? 3, 0.5, 40),
    text: String(item.text || '').slice(0, 500),
  };
  if (kind === 'brush' || kind === 'pen') {
    out.points = (Array.isArray(item.points) ? item.points : [])
      .slice(0, 400)
      .map((p) => [num(p?.[0], 0, 1), num(p?.[1], 0, 1)]);
  } else {
    Object.assign(out, {
      x: num(item.x, 0, 1),
      y: num(item.y, 0, 1),
      w: num(item.w, 0, 1),
      h: num(item.h, 0, 1),
    });
    if (item.to) out.to = { x: num(item.to.x, 0, 1), y: num(item.to.y, 0, 1) };
  }
  return out;
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get(
    '/api/images/:id/annotations',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '图片不存在' });
      const row = db.prepare('SELECT data, updated_at FROM image_annotations WHERE image_id = ?').get(id);
      let items;
      try {
        items = JSON.parse(row?.data || '[]');
      } catch {
        items = [];
      }
      res.json({ ok: true, items: Array.isArray(items) ? items : [], updatedAt: row?.updated_at || '' });
    })
  );

  app.put(
    '/api/images/:id/annotations',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '图片不存在' });
      const input = Array.isArray(req.body?.items) ? req.body.items : [];
      const items = input.map(sanitize).filter(Boolean).slice(0, 500);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO image_annotations (image_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(image_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      ).run(id, JSON.stringify(items), now);
      res.json({ ok: true, items, updatedAt: now });
    })
  );

  /* --------------------------------- 评论 --------------------------------- */

  app.get(
    '/api/images/:id/comments',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const rows = db.prepare('SELECT * FROM image_comments WHERE image_id = ? ORDER BY id ASC').all(id);
      res.json({
        ok: true,
        comments: rows.map((r) => ({ id: r.id, body: r.body, author: r.author, createdAt: r.created_at })),
      });
    })
  );

  app.post(
    '/api/images/:id/comments',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '图片不存在' });
      const body = String(req.body?.body || '').trim();
      if (!body) return res.status(400).json({ error: '评论不能为空' });
      const info = db
        .prepare('INSERT INTO image_comments (image_id, body, author, created_at) VALUES (?, ?, ?, ?)')
        .run(id, body.slice(0, 2000), String(req.body?.author || '').slice(0, 40), new Date().toISOString());
      const row = db.prepare('SELECT * FROM image_comments WHERE id = ?').get(Number(info.lastInsertRowid));
      res.json({ ok: true, comment: { id: row.id, body: row.body, author: row.author, createdAt: row.created_at } });
    })
  );

  app.delete(
    '/api/comments/:id',
    asyncRoute(async (req, res) => {
      const row = db.prepare('SELECT id FROM image_comments WHERE id = ?').get(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '评论不存在' });
      db.prepare('DELETE FROM image_comments WHERE id = ?').run(Number(req.params.id));
      res.json({ ok: true });
    })
  );

  /** 标注数量（列表页角标用）：一次查全库，避免逐图请求 */
  app.get('/api/annotations/counts', (_req, res) => {
    const rows = db.prepare('SELECT image_id, data FROM image_annotations').all();
    const counts = {};
    for (const r of rows) {
      try {
        const n = JSON.parse(r.data || '[]').length;
        if (n) counts[r.image_id] = n;
      } catch {
        /* 忽略损坏数据 */
      }
    }
    res.json({ ok: true, counts });
  });
}
