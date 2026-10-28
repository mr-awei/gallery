// 统计路由：总量/来源/分辨率/方向/收藏/增长趋势等聚合视图（从 app.js 拆出）
import { getJobStatus } from '../crawler.js';
import * as lib from '../library.js';
import { db } from '../db.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;


  app.get(
    '/api/stats',
    asyncRoute(async (_req, res) => {
      const bucketExpr = `CASE
        WHEN MAX(width, height) < 1080 THEN 'sd'
        WHEN MAX(width, height) < 2048 THEN 'fhd'
        WHEN MAX(width, height) < 3840 THEN '2k'
        ELSE '4k' END`;
      const total = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
      const favorite = db.prepare('SELECT COUNT(*) AS c FROM images WHERE favorite = 1').get().c;
      const sizeRow = db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS s FROM images').get();
      const bySource = db
        .prepare('SELECT source, COUNT(*) AS count FROM images GROUP BY source ORDER BY count DESC')
        .all();
      const byBucket = db
        .prepare(`SELECT ${bucketExpr} AS bucket, COUNT(*) AS count FROM images GROUP BY bucket`)
        .all();
      const byOrientation = db
        .prepare(
          `SELECT CASE
            WHEN height > width * 1.15 THEN 'portrait'
            WHEN width > height * 1.15 THEN 'landscape'
            ELSE 'square' END AS orientation,
            COUNT(*) AS count FROM images GROUP BY orientation`
        )
        .all();
      const trendRows = db
        .prepare(
          'SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count FROM images GROUP BY date ORDER BY date DESC LIMIT 14'
        )
        .all();

      const tagCounter = new Map();
      for (const row of db.prepare("SELECT tags FROM images WHERE tags <> ''").all()) {
        for (const tag of row.tags.split(',')) {
          const t = tag.trim();
          if (t) tagCounter.set(t, (tagCounter.get(t) || 0) + 1);
        }
      }
      const topTags = [...tagCounter.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);

      const recent = db
        .prepare('SELECT * FROM images ORDER BY created_at DESC, id DESC LIMIT 12')
        .all()
        .map(lib.toDTO);
      const largest = db
        .prepare('SELECT * FROM images ORDER BY (width * height) DESC LIMIT 4')
        .all()
        .map(lib.toDTO);

      res.json({
        total,
        favorite,
        totalSize: sizeRow.s,
        bySource,
        byBucket,
        byOrientation,
        trend: trendRows.slice().reverse(),
        topTags,
        recent,
        largest,
        crawling: getJobStatus().running,
      });
    })
  );

  app.get('/api/tags', (_req, res) => {
    const counter = new Map();
    for (const row of db.prepare("SELECT tags FROM images WHERE tags <> ''").all()) {
      for (const tag of row.tags.split(',')) {
        const t = tag.trim();
        if (t) counter.set(t, (counter.get(t) || 0) + 1);
      }
    }
    res.json([...counter.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count));
  });

  /* ----------------------------------- AI ---------------------------------- */

  app.get('/api/ai/presets', (_req, res) => res.json(ai.AI_PRESETS));
  app.get('/api/ai/status', (_req, res) => res.json(ai.aiStatus()));

  app.post(
    '/api/ai/test',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...(await ai.testConnection()) });
    })
  );

  app.post(
    '/api/ai/models',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, models: await ai.listModels() });
    })
  );

  app.post(
    '/api/ai/analyze',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, ...(await ai.analyzeImage(Number(req.body?.id))) });
    })
  );

  app.get('/api/ai/desc/:id', (req, res) => res.json(ai.getAiDesc(Number(req.params.id)) || null));

  /* ------------------------------ 检索：颜色 / AI / 以图 ------------------------------ */

  /** 颜色搜索：给定 #rrggbb，返回主色/调色板相近的图片，tol 越大越宽松 */
  app.get(
    '/api/search/color',
    asyncRoute(async (req, res) => {
      const hex = String(req.query.hex || '').trim();
      if (!hex) return res.status(400).json({ error: '缺少 hex 参数（如 #aabbcc）' });
      const tol = Math.max(0, Math.min(160, Number(req.query.tol) || 48));
      const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120));
      try {
        const items = search.searchByColor(hex, tol, limit);
        res.json({ hex, tolerance: tol, total: items.length, items });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /** AI 语义搜索：自然语言 → 结构化过滤 + 关键词，复用现有 OpenAI 兼容 AI（无需 embedding） */
  app.post(
    '/api/search/ai',
    asyncRoute(async (req, res) => {
      const query = String(req.body?.query || req.body?.q || '').trim();
      if (!query) return res.status(400).json({ error: '缺少 query 参数' });
      const limit = Math.min(300, Math.max(1, Number(req.body?.limit) || 60));
      try {
        const items = await search.aiSearch(query, { limit });
        res.json({ query, total: items.length, items });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    })
  );

  /** 以图搜图（视觉搜索）：上传 base64 图片，按感知哈希找最相似的图 */
  app.post(
    '/api/search/by-image',
    asyncRoute(async (req, res) => {
      const dataUrl = req.body?.image || req.body?.dataUrl || req.body?.url;
      const maxHamming = Math.max(0, Math.min(32, Number(req.body?.maxHamming) ?? 10));
      const limit = Math.min(100, Math.max(1, Number(req.body?.limit) || 24));
      if (!dataUrl) return res.status(400).json({ error: '缺少 image（base64 data url）' });
      try {
        const items = await search.searchByImageDataUrl(dataUrl, { limit, maxHamming });
        res.json({ total: items.length, items });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /* ------------------------------ 标签管理 ------------------------------ */

  app.post(
    '/api/tags/rename',
    asyncRoute(async (req, res) => {
      const n = lib.renameTag(req.body?.oldName, req.body?.newName);
      res.json({ ok: true, affected: n, tags: lib.listTags() });
    })
  );

  app.post(
    '/api/tags/delete',
    asyncRoute(async (req, res) => {
      const n = lib.deleteTag(req.body?.name);
      res.json({ ok: true, affected: n, tags: lib.listTags() });
    })
  );

  app.post(
    '/api/tags/merge',
    asyncRoute(async (req, res) => {
      const n = lib.mergeTags(req.body?.from, req.body?.to);
      res.json({ ok: true, affected: n, tags: lib.listTags() });
    })
  );

  /* ------------------------------ 智能文件夹 ------------------------------ */

  app.get('/api/smart-folders', (_req, res) => res.json(lib.listSmartFolders()));

  app.post(
    '/api/smart-folders',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, folders: lib.createSmartFolder(req.body || {}) });
    })
  );

  app.put(
    '/api/smart-folders/:id',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, folders: lib.updateSmartFolder(Number(req.params.id), req.body || {}) });
    })
  );

  app.delete(
    '/api/smart-folders/:id',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, folders: lib.deleteSmartFolder(Number(req.params.id)) });
    })
  );

  app.get(
    '/api/smart-folders/:id/images',
    asyncRoute(async (req, res) => {
      const r = lib.previewSmartFolder(Number(req.params.id));
      res.json({ folder: r.folder, total: r.total, items: r.items });
    })
  );

  /** 文件夹标签继承：把智能文件夹的 autoTags 同步到所有命中图片 */
  app.post(
    '/api/smart-folders/:id/apply-tags',
    asyncRoute(async (req, res) => {
      const changed = lib.applySmartFolderTags(Number(req.params.id));
      res.json({ ok: true, changed, tags: lib.listTags() });
    })
  );

  app.post(
    '/api/ai/summarize',
    asyncRoute(async (_req, res) => {
      res.json(await kb.summarizeWithAI());
    })
  );

  app.post(
    '/api/ai/suggest',
    asyncRoute(async (_req, res) => {
      res.json(await kb.suggestions());
    })
  );

  /* --------------------------------- 知识库 --------------------------------- */

  app.get('/api/kb/rules', (_req, res) => res.json(kb.listRules()));

  app.put(
    '/api/kb/rules/:id',
    asyncRoute(async (req, res) => {
      kb.setRule(Number(req.params.id), req.body || {});
      kb.rescoreAll();
      res.json({ ok: true, rules: kb.listRules() });
    })
  );

  app.delete(
    '/api/kb/rules/:id',
    asyncRoute(async (req, res) => {
      kb.deleteRule(Number(req.params.id));
      kb.rescoreAll();
      res.json({ ok: true, rules: kb.listRules() });
    })
  );

  app.get('/api/kb/feedback', (_req, res) => res.json(kb.listFeedback(100)));

  app.delete(
    '/api/kb/feedback/:id',
    asyncRoute(async (req, res) => {
      kb.deleteFeedback(Number(req.params.id));
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/kb/rescore',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...kb.rescoreAll() });
    })
  );

  app.get('/api/kb/stats', (_req, res) => res.json(kb.feedbackStats()));

  /* ------------------------------ 壁纸库文件夹管理 --------------------------- */

  app.post(
    '/api/library/scan',
    asyncRoute(async (_req, res) => {
      if (importState.running) return res.json({ ok: false, message: '导入任务正在运行' });
      const result = await importLocalImages();
      res.json({ ok: true, ...result });
    })
  );

  app.get('/api/library/missing', (_req, res) => {
    const missing = findMissing();
    res.json({ count: missing.length, ids: missing.map((m) => m.id) });
  });

  app.post(
    '/api/library/purge-missing',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, removed: purgeMissing() });
    })
  );

  /** 尝试按文件名找回丢失的图片（用户移动/更换保存文件夹后修复路径） */
  app.post(
    '/api/library/relocate-missing',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...relocateMissing() });
    })
  );

  /* --------------------------------- 回收站 --------------------------------- */

  app.get('/api/trash', (_req, res) => res.json(lib.listTrash()));

  app.post(
    '/api/trash/:id/restore',
    asyncRoute(async (req, res) => {
      res.json(await lib.restoreFromTrash(Number(req.params.id)));
    })
  );

  app.delete(
    '/api/trash/:id',
    asyncRoute(async (req, res) => {
      res.json({ ok: await lib.deleteTrashItem(Number(req.params.id)) });
    })
  );

  app.post(
    '/api/trash/empty',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, removed: await lib.emptyTrash() });
    })
  );

  /* -------------------------------- 网络 / 代理 ------------------------------ */

  app.get('/api/network', (_req, res) => res.json({ ...getNetwork(), modes: PROXY_MODES }));

  app.put(
    '/api/network',
    asyncRoute(async (req, res) => {
      const net = saveNetwork(req.body || {});
      const applied = await applyProxy();
      res.json({ ...net, applied });
    })
  );

  app.post(
    '/api/network/test',
    asyncRoute(async (_req, res) => {
      res.json(await testNetwork());
    })
  );
}
