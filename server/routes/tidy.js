// 整理概览 / 相似图整理路由：CLIP 聚类、pHash 相似、格式重复、旋转重命名（从 app.js 拆出）
import * as ai from '../ai.js';
import * as clip from '../clip.js';
import * as lib from '../library.js';
import { db, getSettings } from '../db.js';

export function register(app, ctx) {
  const { asyncRoute, colorFilterIds } = ctx;

  /** 扫描范围：?ids=1,2,3 或 body.ids（当前筛选结果 / 手动选区）；缺省即全库 */
  const scopeOf = (src) => {
    const raw = src?.ids;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
    const ids = list.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return ids.length ? { ids } : {};
  };

  app.get('/api/tidy/stats', (_req, res) => {
    const total = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
    const noDominant = db.prepare("SELECT COUNT(*) AS c FROM images WHERE dominant = ''").get().c;
    const noAiDesc = db
      .prepare('SELECT COUNT(*) AS c FROM images WHERE id NOT IN (SELECT image_id FROM ai_desc)')
      .get().c;
    const noRating = db.prepare('SELECT COUNT(*) AS c FROM images WHERE rating = 0').get().c;
    const rated = db.prepare('SELECT COUNT(*) AS c FROM images WHERE rating > 0').get().c;
    const noObjHash = db.prepare("SELECT COUNT(*) AS c FROM images WHERE obj_phash = ''").get().c;
    res.json({ total, noDominant, noAiDesc, noRating, rated, noObjHash });
  });

  /* ------------------------------ 相似图整理 ------------------------------ */
  app.get(
    '/api/similar',
    asyncRoute(async (req, res) => {
      const threshold = Math.max(
        0,
        Math.min(24, Number(req.query.threshold) || getSettings().phashThreshold || 10)
      );
      const scope = scopeOf(req.query);
      const groups = lib.listSimilarGroups(threshold, undefined, undefined, scope);
      res.json({ threshold, scope: scope.ids ? scope.ids.length : 0, count: groups.length, groups });
    })
  );

  // CLIP 深度特征相似分组：能抓住 pHash 漏掉的裁剪/旋转/滤镜变体
  app.get(
    '/api/similar/clip',
    asyncRoute(async (req, res) => {
      const minCos = Math.max(0.8, Math.min(0.999, Number(req.query.minCos) || 0.92));
      if (!clip.clipReady()) {
        return res.status(503).json({ error: 'CLIP 模型尚未加载完成，稍后再试（首次需下载模型）' });
      }
      const scope = scopeOf(req.query);
      const groups = await lib.listClipSimilarGroups(minCos, undefined, scope);
      res.json({ minCos, scope: scope.ids ? scope.ids.length : 0, count: groups.length, groups });
    })
  );

  // CLIP 状态与全库补算
  app.get('/api/clip/status', (_req, res) => res.json(clip.backfillStatus()));
  app.post('/api/clip/backfill', (_req, res) => res.json(clip.startBackfill()));

  // 同名跨格式去重：同目录同名（如 5.jpg 与 5.png）视为同一张，推荐保留 PNG；删除复用 /api/similar/resolve
  app.get('/api/dupes/format', (req, res) => {
    const scope = scopeOf(req.query);
    const groups = lib.listFormatDupes(scope);
    res.json({ scope: scope.ids ? scope.ids.length : 0, count: groups.length, groups });
  });

  app.post(
    '/api/similar/resolve',
    asyncRoute(async (req, res) => {
      const keepId = Number(req.body?.keepId);
      if (!keepId) return res.status(400).json({ error: '缺少要保留的图片' });
      const result = await lib.resolveSimilar(keepId, req.body?.removeIds || []);
      res.json({ ok: true, ...result });
    })
  );

  // 整理页「这组不处理」：持久化跳过的相似组（基于组推荐保留项 id）
  app.get(
    '/api/tidy/skip',
    asyncRoute(async (_req, res) => {
      res.json({ ids: lib.getTidySkips() });
    })
  );
  app.post(
    '/api/tidy/skip',
    asyncRoute(async (req, res) => {
      const id = Number(req.body?.id);
      if (!id) return res.status(400).json({ error: '缺少组标识' });
      res.json({ ok: true, ids: lib.addTidySkip(id) });
    })
  );
  app.post(
    '/api/tidy/skip/reset',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ids: lib.resetTidySkips() });
    })
  );

  /* 老图片补算主色（分次执行，前端可重复调用）。force=true 时重算全部（修正旧调色板） */
  app.post(
    '/api/maintenance/dominant',
    asyncRoute(async (req, res) => {
      const result = await lib.backfillDominant(
        Number(req.body?.limit) || 300,
        req.body?.force === true || req.body?.force === 'true'
      );
      res.json({ ok: true, ...result });
    })
  );

  /* 补算主体哈希（白底抠图归一化 pHash）：相似分组的候选哈希升级，分次执行可重复调用 */
  app.post(
    '/api/maintenance/subject',
    asyncRoute(async (req, res) => {
      const result = await lib.backfillSubjectHash(Number(req.body?.limit) || 300);
      res.json({ ok: true, ...result });
    })
  );

  /* AI 看图打标：给还没分析过的图生成描述，供「自然语言搜索」用 */
  app.post(
    '/api/ai/tag-batch',
    asyncRoute(async (req, res) => {
      const limit = Math.max(1, Math.min(40, Number(req.body?.limit) || 6));
      const rows = db
        .prepare(
          `SELECT id FROM images WHERE id NOT IN (SELECT image_id FROM ai_desc)
           ORDER BY rating DESC, score DESC LIMIT ?`
        )
        .all(limit);
      const results = [];
      const autoFolder = getSettings().autoSmartFolder !== false;
      for (const r of rows) {
        try {
          const d = await ai.analyzeImage(r.id);
          // 打标后自动按智能文件夹规则归类（可被设置关闭）
          let folderChanges = 0;
          if (autoFolder) folderChanges = lib.applySmartFolderTags(r.id);
          results.push({ id: r.id, ok: true, description: d.description, folderChanges });
        } catch (err) {
          results.push({ id: r.id, ok: false, error: err.message });
          break; // AI 没配置好就不必继续
        }
      }
      const remain = db
        .prepare('SELECT COUNT(*) AS c FROM images WHERE id NOT IN (SELECT image_id FROM ai_desc)')
        .get().c;
      res.json({ ok: true, done: results.filter((r) => r.ok).length, remain, results });
    })
  );

  /* 单张 AI 识图（读缓存 / 重新分析） */
  app.get(
    '/api/images/:id/ai',
    asyncRoute(async (req, res) => {
      res.json(ai.getAiDesc(Number(req.params.id)) || {});
    })
  );

  app.post(
    '/api/images/:id/ai',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      try {
        res.json({ ok: true, ...(await ai.analyzeImage(id)) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    })
  );

  /* 把当前筛选结果整体标记为已看 */
  app.post(
    '/api/images/viewed-all',
    asyncRoute(async (req, res) => {
      // 复用统一筛选拼装（原来的 buildFilter 随列表逻辑收敛进 lib 后就没了，这个入口一直 500）
      const query = { ...(req.body || {}), colorIds: colorFilterIds(req.body || {}) };
      res.json({ ok: true, affected: lib.markAllViewedByFilter(query) });
    })
  );

  app.post(
    '/api/images/:id/rotate',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const dir = req.body?.dir === 'ccw' ? 'ccw' : 'cw';
      try {
        const item = await lib.rotateImage(id, dir);
        res.json({ ok: true, item });
      } catch (err) {
        res.status(500).json({ error: err.message || '旋转失败' });
      }
    })
  );
}
