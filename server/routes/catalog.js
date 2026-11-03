// 清单（playlist）路由：分组管理的增删改查与批量加入（从 app.js 拆出）
import * as lib from '../library.js';
import { db, withTransaction } from '../db.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;


  const listPlaylists = () =>
    db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) AS count
         FROM playlists p ORDER BY p.updated_at DESC`
      )
      .all();

  app.get('/api/playlists', (_req, res) => res.json(listPlaylists()));

  app.post(
    '/api/playlists',
    asyncRoute(async (req, res) => {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: '清单名称不能为空' });
      const now = new Date().toISOString();
      try {
        db.prepare('INSERT INTO playlists(name, description, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
          name,
          String(req.body?.description || ''),
          now,
          now
        );
      } catch {
        return res.status(400).json({ error: '已存在同名清单' });
      }
      res.json({ ok: true, playlists: listPlaylists() });
    })
  );

  app.put(
    '/api/playlists/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (req.body?.name !== undefined) {
        db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(
          String(req.body.name).trim(),
          new Date().toISOString(),
          id
        );
      }
      if (req.body?.description !== undefined) {
        db.prepare('UPDATE playlists SET description = ?, updated_at = ? WHERE id = ?').run(
          String(req.body.description),
          new Date().toISOString(),
          id
        );
      }
      res.json({ ok: true, playlists: listPlaylists() });
    })
  );

  app.delete(
    '/api/playlists/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
      db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
      res.json({ ok: true, playlists: listPlaylists() });
    })
  );

  app.get(
    '/api/playlists/:id/images',
    asyncRoute(async (req, res) => {
      const rows = db
        .prepare(
          `SELECT i.* FROM playlist_items pi JOIN images i ON i.id = pi.image_id
           WHERE pi.playlist_id = ? ORDER BY pi.id DESC`
        )
        .all(Number(req.params.id));
      res.json(rows.map(lib.toDTO));
    })
  );

  app.post(
    '/api/playlists/:id/images',
    asyncRoute(async (req, res) => {
      const playlistId = Number(req.params.id);
      if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlistId)) {
        return res.status(404).json({ error: '清单不存在' });
      }
      // 去重 + 上限，防止一次塞十几万条把连接锁住
      const ids = [...new Set((req.body?.ids || []).map(Number).filter(Boolean))].slice(0, 5000);
      const now = new Date().toISOString();
      // 单条 SQL 完成「图片存在 + 未重复」校验，整批一个事务：
      // 旧实现每张图一次 SELECT 一次 INSERT，几千张就是几千次往返，中途失败还留半批数据
      const added = withTransaction(() => {
        const ins = db.prepare(
          `INSERT OR IGNORE INTO playlist_items(playlist_id, image_id, added_at)
           SELECT ?, id, ? FROM images WHERE id = ?`
        );
        let n = 0;
        for (const imageId of ids) n += Number(ins.run(playlistId, imageId, now).changes || 0);
        db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId);
        return n;
      });
      res.json({ ok: true, added, skipped: ids.length - added, playlists: listPlaylists() });
    })
  );

  app.delete(
    '/api/playlists/:id/images/:imageId',
    asyncRoute(async (req, res) => {
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND image_id = ?').run(
        Number(req.params.id),
        Number(req.params.imageId)
      );
      res.json({ ok: true, playlists: listPlaylists() });
    })
  );
}
