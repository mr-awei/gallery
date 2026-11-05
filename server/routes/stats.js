// 统计路由：总量/来源/分辨率/方向/收藏/增长趋势等聚合视图（从 app.js 拆出）
import { getJobStatus } from '../crawler.js';
import * as lib from '../library.js';
import * as ai from '../ai.js';
import * as kb from '../kb.js';
import { getMissingCached, importLocalImages, purgeMissing, relocateMissing } from '../importer.js';
import { getNetwork, saveNetwork, testNetwork, applyProxy, PROXY_MODES } from '../network.js';
// 用命名空间引入：本文件同时用到 searchByColor / searchByImageDataUrl / aiSearch，
// 之前只解构了 searchByColor，导致 /api/search/ai 与 /api/search/by-image 一调用就 ReferenceError
import * as search from '../search.js';
import { db } from '../db.js';
import { currentLibraryInfo } from '../libraries.js';
import { logOp } from '../oplog.js';
import { hiddenImagesClause } from '../lib/privacy.js';

export function register(app, ctx) {
  // ctx.importState 是 getter 函数（app.js 里 `importState: () => importState`）
  const { asyncRoute, sseBroadcast, importState: importStateRef } = ctx;


  app.get(
    '/api/stats',
    asyncRoute(async (_req, res) => {
      const bucketExpr = `CASE
        WHEN MAX(width, height) < 1080 THEN 'sd'
        WHEN MAX(width, height) < 2048 THEN 'fhd'
        WHEN MAX(width, height) < 3840 THEN '2k'
        ELSE '4k' END`;
      // 隐私空间：锁住未解锁的文件夹，其素材连同统计一起隐形（否则仪表盘缩略图会漏出去）
      const hidden = hiddenImagesClause();
      const lockSql = hidden ? ` AND ${hidden.sql}` : '';
      const lockParams = hidden ? hidden.params : [];
      const total = db.prepare(`SELECT COUNT(*) AS c FROM images WHERE 1=1${lockSql}`).get(...lockParams).c;
      const favorite = db
        .prepare(`SELECT COUNT(*) AS c FROM images WHERE favorite = 1${lockSql}`)
        .get(...lockParams).c;
      const sizeRow = db
        .prepare(`SELECT COALESCE(SUM(size_bytes),0) AS s FROM images WHERE 1=1${lockSql}`)
        .get(...lockParams);
      const bySource = db
        .prepare(`SELECT source, COUNT(*) AS count FROM images WHERE 1=1${lockSql} GROUP BY source ORDER BY count DESC`)
        .all(...lockParams);
      const byBucket = db
        .prepare(`SELECT ${bucketExpr} AS bucket, COUNT(*) AS count FROM images WHERE 1=1${lockSql} GROUP BY bucket`)
        .all(...lockParams);
      const byOrientation = db
        .prepare(
          `SELECT CASE
            WHEN height > width * 1.15 THEN 'portrait'
            WHEN width > height * 1.15 THEN 'landscape'
            ELSE 'square' END AS orientation,
            COUNT(*) AS count FROM images WHERE 1=1${lockSql} GROUP BY orientation`
        )
        .all(...lockParams);
      const trendRows = db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count FROM images
             WHERE 1=1${lockSql} GROUP BY date ORDER BY date DESC LIMIT 14`
        )
        .all(...lockParams);

      // 热点标签：直接走 item_tags 倒排表（主键是 tag 前缀，GROUP BY tag 可走索引）。
      // 旧实现把整列 tags 拉进 Node 逐条 split 再聚合，百万级要几十秒并吃掉大量内存。
      // 有隐私夹时要 join images 才能套用同一段排除条件；没有的话保持原来的快路径
      const topTags = db
        .prepare(
          `SELECT t.tag, COUNT(*) AS count FROM item_tags t${
            hidden ? ' JOIN images images ON images.id = t.image_id' : ''
          } WHERE 1=1${lockSql} GROUP BY t.tag ORDER BY count DESC, t.tag ASC LIMIT 12`
        )
        .all(...lockParams);

      const recent = db
        .prepare(`SELECT * FROM images WHERE 1=1${lockSql} ORDER BY created_at DESC, id DESC LIMIT 12`)
        .all(...lockParams)
        .map(lib.toDTO);
      const largest = db
        .prepare(`SELECT * FROM images WHERE 1=1${lockSql} ORDER BY (width * height) DESC LIMIT 4`)
        .all(...lockParams)
        .map(lib.toDTO);

      // 当前库身份：详情面板要回答「这张图在哪个库里」。
      // 多库各存各的 gallery.db，图片记录本身不带库字段，库身份只能由服务端给出。
      // 这里必须永远给一个库：返回 null 时前端只能显示「—」，用户就没法定位图片了
      res.json({
        library: currentLibraryInfo(),
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

  // 标签树：count + 分组 / 颜色 / 父标签 / 排序（Eagle 的标签体系）
  // 兼容老前端：每项仍带 tag / count，新字段视作附加信息
  app.get('/api/tags', (_req, res) => {
    res.json({ tags: lib.listTagsRich(), groups: lib.listTagGroups() });
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

  /** 自然语言搜图：本地 CLIP 文本塔做跨模态召回（不依赖云端 AI） */
  app.post(
    '/api/search/semantic',
    asyncRoute(async (req, res) => {
      const query = String(req.body?.query || req.body?.q || '').trim();
      if (!query) return res.status(400).json({ error: '缺少 query 参数' });
      const limit = Math.min(300, Math.max(1, Number(req.body?.limit) || 60));
      try {
        const r = await search.semanticSearch(query, { limit });
        res.json({
          query,
          total: r.items.length,
          items: r.items,
          engine: r.engine,
          degraded: r.degraded,
          reason: r.reason,
          keywords: r.keywords,
          covered: r.covered,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
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
        const r = await search.aiSearch(query, { limit });
        // engine: llm = 真的过了 LLM 抽词；keyword = 其实只是关键词 LIKE。
        // degraded 只在「配了 AI 但解析失败」时为 true，前端据此决定提示文案。
        res.json({
          query,
          total: r.items.length,
          items: r.items,
          engine: r.engine,
          degraded: r.degraded,
          reason: r.reason,
          keywords: r.keywords,
        });
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
      // 以前写 Number(x) ?? 10：Number(undefined) 是 NaN 而不是 null/undefined，
      // ?? 兜不住，Math.min/max 一路把结果算成 NaN，相似图搜索只能返回空。
      const rawHamming = req.body?.maxHamming;
      const hammingNum = Number(rawHamming);
      const maxHamming =
        rawHamming == null || rawHamming === '' || !Number.isFinite(hammingNum)
          ? 10
          : Math.max(0, Math.min(32, hammingNum));
      const limit = Math.min(100, Math.max(1, Number(req.body?.limit) || 24));
      if (!dataUrl) return res.status(400).json({ error: '缺少 image（base64 data url）' });
      try {
        const r = await search.searchByImageDataUrl(dataUrl, { limit, maxHamming });
        // engine: clip = 深度特征（语义级相似）；phash = 哈希（构图/像素级相似）。
        // 前端必须按引擎改文案，否则哈希结果会被说成「几乎相同」。
        res.json({ total: r.items.length, items: r.items, engine: r.engine });
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

  /* --------------------------- 标签别名 / 同义词 --------------------------- */

  app.get('/api/tags/aliases', (_req, res) => {
    res.json({ aliases: lib.listAliases() });
  });

  app.put(
    '/api/tags/alias',
    asyncRoute(async (req, res) => {
      try {
        const aliases = lib.setAlias(req.body?.alias, req.body?.tag);
        sseBroadcast('tags', { path: req.path });
        res.json({ ok: true, aliases });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  app.delete(
    '/api/tags/alias/:alias',
    asyncRoute(async (req, res) => {
      try {
        const aliases = lib.deleteAlias(decodeURIComponent(req.params.alias));
        sseBroadcast('tags', { path: req.path });
        res.json({ ok: true, aliases });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
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
      // limit 必须夹紧：同文件其它接口都 clamp，这里 ?limit=1000000 会把整库 DTO 拉进内存
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const r = lib.previewSmartFolder(Number(req.params.id), limit, offset);
      res.json({ folder: r.folder, total: r.total, items: r.items, limit: r.limit, offset: r.offset });
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
      kb.requestRescore();
      res.json({ ok: true, rules: kb.listRules() });
    })
  );

  app.delete(
    '/api/kb/rules/:id',
    asyncRoute(async (req, res) => {
      kb.deleteRule(Number(req.params.id));
      kb.requestRescore();
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
      if (importStateRef().running) return res.json({ ok: false, message: '导入任务正在运行' });
      const result = await importLocalImages();
      res.json({ ok: true, ...result });
    })
  );

  app.get('/api/library/missing', (_req, res) => {
    // 前端首屏必拉：走异步并发检查 + 60s 缓存，不再同步全表 existsSync 阻塞事件循环
    getMissingCached().then((r) => res.json(r));
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
      res.json({ ok: true, ...(await relocateMissing()) });
    })
  );

  /* --------------------------------- 回收站 --------------------------------- */

  app.get('/api/trash', (req, res) => {
    const limit = Number(req.query.limit || 0);
    if (!limit) return res.json(lib.listTrash());
    return res.json(
      lib.listTrash({ limit, offset: Number(req.query.offset || 0), q: String(req.query.q || '') })
    );
  });

  app.post(
    '/api/trash/:id/restore',
    asyncRoute(async (req, res) => {
      const trashId = Number(req.params.id);
      // 恢复前的 image_id 记下来：撤销「恢复」= 把这张再删回回收站
      const row = db.prepare('SELECT image_id FROM trash WHERE id = ?').get(trashId);
      const result = await lib.restoreFromTrash(trashId);
      const newId = Number(result?.item?.id || result?.id || 0);
      if (newId) {
        logOp({
          op: 'restore',
          summary: `从回收站恢复 1 张（原 id ${row?.image_id ?? '?'}）`,
          payload: { imageIds: [newId] },
        });
      }
      res.json(result);
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
