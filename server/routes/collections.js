// @ts-check
// 素材集合相关路由：图片堆叠（Stack）、笔记（含视频时间点）、保存筛选器、使用统计。
// 拆成独立模块而不是塞进 organize.js：这四类都是「围绕一张/一组素材的附加数据」，
// 与整理（标签/重命名/重复）的读写路径完全不同。
import { db } from '../db.js';
import * as lib from '../library.js';
import {
  addToStack,
  attachStackInfo,
  createStack,
  listStacks,
  mergeStacks,
  removeFromStack,
  setStackPrimary,
  stackRows,
  ungroupStack,
} from '../lib/stacks.js';
import { bumpUsage } from '../lib/usage.js';

const MAX_NOTE = 4000;

function parseQuery(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function filterDTO(row) {
  return {
    id: row.id,
    name: row.name,
    query: parseQuery(row.query),
    icon: row.icon || '',
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at || '',
  };
}

function listFilters() {
  return db
    .prepare('SELECT * FROM saved_filters ORDER BY sort_order ASC, id ASC')
    .all()
    .map(filterDTO);
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* --------------------------------- 图片堆叠 --------------------------------- */

  /** 把选中的素材合成一个堆叠（组主 = 评分最高的一张，其次是最先选中的） */
  app.post(
    '/api/stacks',
    asyncRoute(async (req, res) => {
      const r = createStack(req.body?.imageIds || []);
      res.json({ ok: true, ...r, stacks: attachStackInfo(stackRows(r.stackId).map(lib.toDTO)) });
    })
  );

  /** 现有堆叠列表：给「并入其他堆叠」的选择器用 */
  app.get('/api/stacks', (_req, res) => {
    res.json({ ok: true, stacks: listStacks() });
  });

  /** 把 :id 这一组整体并入 intoId 那一组 */
  app.post(
    '/api/stacks/:id/merge',
    asyncRoute(async (req, res) => {
      const r = mergeStacks(Number(req.params.id), Number(req.body?.intoId));
      res.json({ ok: true, ...r, stacks: attachStackInfo(stackRows(r.stackId).map(lib.toDTO)) });
    })
  );

  /** 堆叠详情：成员（含组主），按 id 升序 */
  app.get(
    '/api/stacks/:id',
    asyncRoute(async (req, res) => {
      const rows = stackRows(Number(req.params.id));
      if (!rows.length) return res.status(404).json({ error: '堆叠不存在' });
      const items = attachStackInfo(rows.map(lib.toDTO));
      res.json({ ok: true, stackId: Number(items[0].stackId) || Number(req.params.id), items });
    })
  );

  /** 追加成员（组主 id 或任意成员 id 均可） */
  app.post(
    '/api/stacks/:id/add',
    asyncRoute(async (req, res) => {
      const r = addToStack(Number(req.params.id), req.body?.imageIds || []);
      res.json({ ok: true, ...r, stacks: attachStackInfo(stackRows(r.stackId).map(lib.toDTO)) });
    })
  );

  /** 指定堆叠封面（新组主） */
  app.post(
    '/api/stacks/:id/primary',
    asyncRoute(async (req, res) => {
      const r = setStackPrimary(Number(req.params.id), Number(req.body?.imageId));
      res.json({ ok: true, ...r, stacks: attachStackInfo(stackRows(r.stackId).map(lib.toDTO)) });
    })
  );

  /** 解散整个堆叠 */
  app.delete(
    '/api/stacks/:id',
    asyncRoute(async (req, res) => {
      const r = ungroupStack(Number(req.params.id));
      res.json({ ok: true, ...r });
    })
  );

  /** 把单张图从堆叠里移出（移出组主时自动提升下一张） */
  app.delete(
    '/api/images/:id/stack',
    asyncRoute(async (req, res) => {
      const r = removeFromStack(Number(req.params.id));
      res.json({ ok: true, ...r, image: lib.toDTO(lib.getImage(Number(req.params.id))) });
    })
  );

  /* ---------------------------------- 笔记 ---------------------------------- */

  app.get(
    '/api/images/:id/notes',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '素材不存在' });
      const notes = db
        .prepare('SELECT id, body, ts, created_at FROM image_notes WHERE image_id = ? ORDER BY ts ASC, id ASC')
        .all(id)
        .map((r) => ({ id: r.id, body: r.body, ts: Number(r.ts) || 0, createdAt: r.created_at }));
      res.json({ ok: true, notes });
    })
  );

  /** 新增一条笔记；ts > 0 表示钉在音视频的某个时间点（秒） */
  app.post(
    '/api/images/:id/notes',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '素材不存在' });
      const body = String(req.body?.body || '').trim().slice(0, MAX_NOTE);
      const ts = Math.max(0, Number(req.body?.ts) || 0);
      if (!body) return res.status(400).json({ error: '笔记内容不能为空' });
      const now = new Date().toISOString();
      const ins = db
        .prepare('INSERT INTO image_notes(image_id, body, ts, created_at) VALUES (?, ?, ?, ?)')
        .run(id, body, ts, now);
      res.json({ ok: true, note: { id: Number(ins.lastInsertRowid), body, ts, createdAt: now } });
    })
  );

  app.delete(
    '/api/notes/:id',
    asyncRoute(async (req, res) => {
      const n = db.prepare('DELETE FROM image_notes WHERE id = ?').run(Number(req.params.id)).changes;
      if (!n) return res.status(404).json({ error: '笔记不存在' });
      res.json({ ok: true, removed: n });
    })
  );

  /* -------------------------------- 保存筛选器 -------------------------------- */

  app.get('/api/saved-filters', (_req, res) => {
    res.json({ ok: true, filters: listFilters() });
  });

  app.post(
    '/api/saved-filters',
    asyncRoute(async (req, res) => {
      const name = String(req.body?.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: '筛选器名称不能为空' });
      const query = JSON.stringify(parseQuery(req.body?.query));
      if (query.length > 8000) return res.status(400).json({ error: '筛选条件太大，无法保存' });
      const icon = String(req.body?.icon || '').trim().slice(0, 4);
      const now = new Date().toISOString();
      const max = Number(db.prepare('SELECT MAX(sort_order) AS m FROM saved_filters').get()?.m || 0);
      const ins = db
        .prepare(
          'INSERT INTO saved_filters(name, query, icon, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(name, query, icon, max + 1024, now, now);
      res.json({ ok: true, id: Number(ins.lastInsertRowid), filters: listFilters() });
    })
  );

  app.put(
    '/api/saved-filters/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const cur = db.prepare('SELECT * FROM saved_filters WHERE id = ?').get(id);
      if (!cur) return res.status(404).json({ error: '筛选器不存在' });
      const name = req.body?.name === undefined ? cur.name : String(req.body.name || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: '筛选器名称不能为空' });
      const query = req.body?.query === undefined ? cur.query : JSON.stringify(parseQuery(req.body.query));
      if (query.length > 8000) return res.status(400).json({ error: '筛选条件太大，无法保存' });
      const icon = req.body?.icon === undefined ? cur.icon : String(req.body.icon || '').trim().slice(0, 4);
      db.prepare('UPDATE saved_filters SET name = ?, query = ?, icon = ?, updated_at = ? WHERE id = ?').run(
        name,
        query,
        icon,
        new Date().toISOString(),
        id
      );
      res.json({ ok: true, filters: listFilters() });
    })
  );

  app.delete(
    '/api/saved-filters/:id',
    asyncRoute(async (req, res) => {
      const n = db.prepare('DELETE FROM saved_filters WHERE id = ?').run(Number(req.params.id)).changes;
      if (!n) return res.status(404).json({ error: '筛选器不存在' });
      res.json({ ok: true, removed: n, filters: listFilters() });
    })
  );

  /** 拖动排序：body.ids 是完整顺序 */
  app.post(
    '/api/saved-filters/reorder',
    asyncRoute(async (req, res) => {
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
      const upd = db.prepare('UPDATE saved_filters SET sort_order = ?, updated_at = ? WHERE id = ?');
      const now = new Date().toISOString();
      ids.forEach((id, i) => upd.run((i + 1) * 1024, now, id));
      res.json({ ok: true, filters: listFilters() });
    })
  );

  /* --------------------------------- 使用统计 --------------------------------- */

  /** 记一次使用：kind = copy | export，ids 最多 500 张 */
  app.post(
    '/api/images/usage',
    asyncRoute(async (req, res) => {
      const updated = bumpUsage(req.body?.kind, req.body?.ids || []);
      res.json({ ok: true, updated });
    })
  );

  /** 使用统计榜：最常复制 / 导出的素材（也便于找「从没用过」的闲置素材） */
  app.get('/api/usage/stats', (_req, res) => {
    const top = db
      .prepare(
        `SELECT id, title, copy_count, export_count, last_used_at, fs_mtime, cover_ver
           FROM images
          WHERE copy_count > 0 OR export_count > 0
          ORDER BY (copy_count + export_count) DESC, last_used_at DESC
          LIMIT 50`
      )
      .all();
    res.json({
      ok: true,
      items: top.map((r) => ({
        id: r.id,
        title: r.title,
        copyCount: r.copy_count,
        exportCount: r.export_count,
        lastUsedAt: r.last_used_at,
        thumbUrl: `/api/images/${r.id}/thumb?v=${Number(r.fs_mtime) || 0}-${Number(r.cover_ver) || 0}`,
      })),
      totals: db
        .prepare('SELECT SUM(copy_count) AS copies, SUM(export_count) AS exports FROM images')
        .get() || { copies: 0, exports: 0 },
    });
  });
}
