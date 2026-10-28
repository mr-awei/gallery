import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, WEB_DIST, SEED_URLS } from './config.js';
import {
  db,
  getSettings,
  saveSettings,
  listKeywords,
  addKeyword,
  updateKeyword,
  deleteKeyword,
} from './db.js';
import * as lib from './library.js';
import {
  listLibraries,
  createLibrary,
  activateLibrary,
  setActiveRoot,
  getActiveLibrary,
  deleteLibrary,
  setImportPending,
  isImportPending,
} from './libraries.js';
import {
  listFolderTree,
  folderImageRows,
  createVirtualFolder,
  renameFolder,
  deleteFolder,
  addImagesToFolder,
  removeImagesFromFolder,
} from './folders.js';
import { getJobStatus, startCrawl, stopCrawl, ingestUrls, SOURCES } from './crawler.js';
import * as clip from './clip.js';
import { importLocalImages, findMissing, purgeMissing, relocateMissing, watchStorageDir } from './importer.js';
import { sweepThumbTemp } from './bulk-import.js';
import { openFolder, revealFile, setWallpaper, platform, listMonitors, isFullscreenAppRunning } from './desktop.js';
import { LIVE_HTML } from './live-page.js';
import * as ai from './ai.js';
import * as kb from './kb.js';
import * as search from './search.js';
import * as wallpaper from './wallpaper.js';
import * as aiUpscale from './ai-upscale.js';
import * as srDeep from './sr-deep.js';
import * as fit from './wallpaper-fit.js';
import * as pref from './preference.js';
import * as matting from './matting.js';
import * as enhanceJob from './enhance-job.js';
import { getNetwork, saveNetwork, applyProxy, testNetwork, PROXY_MODES } from './network.js';
import * as auto from './auto.js';
import { httpFetch } from './http.js';
import { liveBus } from './live-bus.js';
import { apiAuth } from './auth.js';
import { register as registerTidy } from './routes/tidy.js';
import { register as registerEnhance } from './routes/enhance.js';
import { register as registerFiles } from './routes/files.js';
import { register as registerStats } from './routes/stats.js';
import { register as registerCatalog } from './routes/catalog.js';
import { register as registerWallpaper } from './routes/wallpaper.js';
import { register as registerKeywords } from './routes/keywords.js';

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------- 实时事件（SSE）与导入状态 ------------------------- */
/* 放在模块级：bootstrap()（进程启动时的首次扫描）也要能广播库变化，
 * 否则「启动自动导入完成」时前端收不到通知，只能重开软件才看得到图（P0）。 */

const sseClients = new Set();
let sseSeq = 0;

function sseBroadcast(type, data) {
  if (!sseClients.size) return;
  const frame = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

let importState = { running: false, progress: 0, message: '', result: null };

/**
 * 后台扫描素材文件夹：把磁盘上已有、库中未登记的图片补登记进来。
 * 完成/失败都广播 library 事件 —— 否则前端只收到「任务已开始」那一次推送，
 * 用户看到导入完成提示却看不到任何新图（P0）。
 */
// 上一个扫描任务还在收尾时又来了新的扫描请求（典型场景：切库时旧库扫描被叫停，
// 但它的循环还要跑几毫秒才结束）。直接丢弃会让「切到新库后自动扫描」整个失效，
// 所以记下来，等旧任务结束立刻补跑。
let pendingImportMessage = null;

function startLocalImport(message = '扫描本地图片…') {
  if (importState.running) {
    pendingImportMessage = message;
    return null;
  }
  importState = { running: true, progress: 0, message, result: null };
  // 落盘标记：进程若被强杀，重启后据此接着扫（半截记录 + 未登记的文件）
  const pendingLibId = getActiveLibrary()?.id;
  setImportPending(true, pendingLibId);
  let lastPush = 0;
  return importLocalImages({
    onProgress: (progress, file, result) => {
      importState = {
        running: true,
        progress,
        message: `导入 ${path.basename(file)}（已保存 ${result.saved}）`,
        result,
      };
      // 边导边推（1s 节流）：前端收到 library 就能增量加载，用户不必等全部
      // 640 张入库后才看到第一张图
      const now = Date.now();
      if (now - lastPush >= 1000) {
        lastPush = now;
        sseBroadcast('library', { imported: result.saved, progress, running: true });
      }
    },
  })
    .then((result) => {
      setImportPending(false, pendingLibId);
      // 被切库叫停的任务：不算完成，也不算失败
      const cancelled = Number(result?.cancelled) > 0;
      importState = {
        running: false,
        progress: 100,
        message: cancelled ? '导入已取消（已切换资源库）' : '导入完成',
        result,
      };
      sseBroadcast('library', { imported: result.saved, cancelled });
      // 批量导入不逐张建模（百万张会堆积上百万次推理），统一交给补算任务后台跑
      if (clip.clipReady()) clip.startBackfill();
      // 收尾后补跑排队中的扫描（新库的自动扫描）
      if (pendingImportMessage) {
        const next = pendingImportMessage;
        pendingImportMessage = null;
        return startLocalImport(next);
      }
      return result;
    })
    .catch((err) => {
      setImportPending(false, pendingLibId);
      importState = { running: false, progress: 100, message: `导入失败：${err.message}`, result: null };
      sseBroadcast('library', { imported: 0, error: err.message });
      if (pendingImportMessage) {
        const next = pendingImportMessage;
        pendingImportMessage = null;
        return startLocalImport(next);
      }
      return null;
    });
}

/* ---------------------------------- 工具 ---------------------------------- */

/** 精确颜色筛选：解析 colorHex/colorTol，返回按颜色质量降序的全量 id；未启用时返回 null */
function colorFilterIds(query) {
  const hex = String(query.colorHex || '').trim();
  if (!hex) return null;
  const tol = Number(query.colorTol);
  return search.scoreByColor(hex, Number.isFinite(tol) ? tol : 48).map((s) => s.id);
}

/** 启动时的初始化：载入 pHash 索引，图库为空则导入本地素材 */
function bootstrap() {
  // 连接已在 db.js 启动时切回上次激活的库；这里补上依赖 storageDir 的素材目录监听
  // （storageDir 是全局设置，上次切库时已持久化）
  watchStorageDir();
  // 上次被强杀时留下的 .tmp 缩略图残留
  sweepThumbTemp();
  const imageCount = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
  console.log(`[db] 图片 ${imageCount} 张，pHash 索引 ${lib.initPhashIndex()} 条`);
  // 后台预加载 CLIP 模型（首次会下载 ~150MB，之后走本地缓存）；就绪后补算缺失特征
  clip
    .clipLoad()
    .then((r) => {
      if (!r.ok) return console.log('[clip] 模型加载失败（CLIP 功能暂不可用）：', r.error);
      console.log('[clip] 模型就绪，已建模', clip.embeddingCount(), '张');
      if (clip.embeddingCount() < imageCount) clip.startBackfill();
    })
    .catch(() => {});
  // 上次扫描被强杀打断：库里留着「已登记但缺缩略图」的半截记录，还有一批文件没登记。
  // 增量扫描会把这些补上（未变且有缩略图的全跳过），代价只是一次目录遍历。
  const resume = isImportPending();
  if (resume || imageCount === 0) {
    const msg = resume ? '上次导入未完成，正在继续…' : '启动扫描素材文件夹…';
    console.log(resume ? '[启动] 上次导入未完成，继续扫描…' : '[启动] 图库为空，开始导入工作区内已有素材…');
    // 走统一的 startLocalImport：会把进度写进 importState 并在完成时广播 library，
    // 前端无需重启就能看到启动时自动导入的图片
    startLocalImport(msg)
      ?.then(async (result) => {
        console.log('[导入] 完成', result);
        const seeds = await ingestUrls(SEED_URLS);
        console.log('[种子素材]', seeds.map((s) => (s.ok ? 'ok' : s.reason)).join(', '));
      })
      .catch((err) => console.error('[导入] 失败', err));
  }
}

export function buildApp({ desktop = false } = {}) {
  const app = express();
  // 本地 API 鉴权：拦住本机任意网页的跨站调用与无令牌的裸调用（规则见 auth.js）
  app.use(apiAuth);
  // 基础安全头：防 MIME 嗅探 / 点击劫持 / 引用泄漏（CSP 由 meta 承担 dev，生产 HTML 再叠加严格头）
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  // 限制请求体大小：50MB 足够大图 base64 导入，同时防止恶意超大请求打爆内存
  app.use(express.json({ limit: '50mb' }));

  /* ----------------------------- 实时事件（SSE） ----------------------------- */
  // 前端所有任务进度 / 库变化由此推送，替代各页面散落的 setInterval 轮询。
  // sseClients / sseBroadcast 已在模块顶层定义（bootstrap 也要广播）。

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`id: ${++sseSeq}\nevent: hello\ndata: {"time":${Date.now()}}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        /* close 时由 req close 统一清理 */
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // 动态壁纸配置变更：Electron 主进程已在监听，这里转发给网页端
  liveBus.on('changed', (cfg) => sseBroadcast('live', { mode: cfg?.mode || '' }));

  // 服务端单点采样：任务状态全在进程内存里，1.5s 对比一次，变化才广播。
  // 此前是「N 个页面 × 各自 setInterval × HTTP 请求」，现在收敛为进程内一次快照对比。
  const jobSnapshot = () => ({
    crawl: getJobStatus(),
    import: importState,
    enhance: enhanceJob.jobStatus(),
    clip: clip.backfillStatus(),
    sr: srDeep.srStatus(),
    aiUp: aiUpscale.aiStatus(),
    matting: matting.mattingStatus(),
  });
  let lastJobJson = '';
  setInterval(() => {
    if (!sseClients.size) return;
    let snap;
    try {
      snap = jobSnapshot();
    } catch {
      return;
    }
    const json = JSON.stringify(snap);
    if (json !== lastJobJson) {
      lastJobJson = json;
      sseBroadcast('job', snap);
    }
  }, 1500).unref?.();

  // 写操作统一广播「库已变化」：App 端据此刷新统计/列表，无需页面各自轮询
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400 && body && body.ok !== false) {
        setImmediate(() => sseBroadcast('library', { path: req.path }));
      }
      return originalJson(body);
    };
    next();
  });

  // 路由组已拆分至 routes/*.js，此处统一注册。
  // importState 是重赋值型 let（不能传对象引用），routes 经 getter 读最新值
  const ctx = { desktop, sseBroadcast, startLocalImport, asyncRoute, colorFilterIds, importState: () => importState };
  registerTidy(app, ctx);
  registerEnhance(app, ctx);
  registerFiles(app, ctx);
  registerStats(app, ctx);
  registerCatalog(app, ctx);
  registerWallpaper(app, ctx);
  registerKeywords(app, ctx);

  /* -------------------------------- 系统能力 ------------------------------- */

  app.get('/api/system/info', (_req, res) => {
    const settings = getSettings();
    res.json({
      platform,
      desktop,
      storageDir: settings.storageDir,
      hasBuild: fs.existsSync(WEB_DIST),
    });
  });

  app.post(
    '/api/system/open-folder',
    asyncRoute(async (req, res) => {
      const dir = req.body?.path || getSettings().storageDir;
      lib.resolveStorageDir(getSettings());
      openFolder(dir);
      res.json({ ok: true, path: dir });
    })
  );

  app.post(
    '/api/system/reveal',
    asyncRoute(async (req, res) => {
      const target = req.body?.path;
      if (!target) return res.status(400).json({ error: '缺少路径' });
      revealFile(target);
      res.json({ ok: true });
    })
  );

  /** 设为桌面壁纸：竖版图会合成「完整竖图居中 + 氛围底」，不裁切 */
  app.post(
    '/api/images/:id/wallpaper',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).json({ error: '图片不存在' });
      try {
        const style = req.body?.style || getSettings().wallpaperFill || 'blur';
        const result = await wallpaper.buildWallpaper(Number(req.params.id), style);
        await setWallpaper(result.path);
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: `设置壁纸失败：${err.message}` });
      }
    })
  );

  /** 预览合成后的壁纸（不会真的设置） */
  app.get(
    '/api/images/:id/wallpaper-preview',
    asyncRoute(async (req, res) => {
      const style = String(req.query.style || getSettings().wallpaperFill || 'blur');
      const result = await wallpaper.buildWallpaper(Number(req.params.id), style);
      res.set('Cache-Control', 'no-store');
      res.sendFile(result.path);
    })
  );

  /* --------------------------------- 图片 API ------------------------------- */

  app.get(
    '/api/images',
    asyncRoute(async (req, res) => {
      // 统一走 library.listImages（结构化筛选 + FTS 搜索 + 排序 + 分页）
      const colorIds = colorFilterIds(req.query);
      res.json(lib.listImages({ ...req.query, colorIds }));
    })
  );

  app.get(
    '/api/images/:id',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '图片不存在' });
      res.json(lib.toDTO(row));
    })
  );

  // 找出与某张图相似的其他图（CLIP 余弦，阈值可调；缺特征时现算并入库）
  app.get(
    '/api/images/:id/similar',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const minCos = Math.max(0.5, Math.min(0.999, Number(req.query.minCos) || 0.9));
      const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
      if (!clip.clipReady()) {
        return res.status(503).json({ error: 'CLIP 模型尚未加载完成，稍后再试' });
      }
      let vec = clip.getEmbedding(id);
      if (!vec) {
        vec = await clip.embedImage(row.abs_path);
        clip.saveEmbedding(id, vec);
      }
      const hits = clip.topSimilar(vec, { k: limit, minCos, excludeId: id });
      const cosById = new Map(hits.map((h) => [h.id, h.cos]));
      const items = hits.length
        ? db
            .prepare(`SELECT * FROM images WHERE id IN (${hits.map(() => '?').join(',')})`)
            .all(...hits.map((h) => h.id))
            .sort((a, b) => cosById.get(b.id) - cosById.get(a.id))
            .map((r) => ({ ...lib.toDTO(r), cos: +cosById.get(r.id).toFixed(4) }))
        : [];
      res.json({ minCos, count: items.length, items });
    })
  );

  app.patch(
    '/api/images/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '图片不存在' });
      if (req.body.favorite !== undefined) lib.setFavorite(id, !!req.body.favorite);
      if (req.body.tags !== undefined) lib.setTags(id, req.body.tags);
      if (req.body.title !== undefined) lib.renameTitle(id, req.body.title);
      if (req.body.rating !== undefined) lib.setRating(id, req.body.rating);
      if (req.body.note !== undefined) lib.setNote(id, req.body.note);
      res.json(lib.toDTO(lib.getImage(id)));
    })
  );

  app.delete(
    '/api/images/:id',
    asyncRoute(async (req, res) => {
      const result = await lib.removeImage(Number(req.params.id));
      res.json(result);
    })
  );

  /** 删除并留下「为什么不满意」的反馈（只记录原因，AI 归纳在知识库页手动触发） */
  app.post(
    '/api/images/:id/delete-reason',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const { reasons = [], note = '', aiAnalysis = '' } = req.body || {};
      const feedbackId = kb.addFeedback({ imageId: id, reasons, note, aiAnalysis });
      const removed = await lib.removeImage(id, { reason: (reasons || []).join('/') });
      if (!removed.ok) return res.status(500).json({ error: removed.error, feedbackId });
      res.json({ ok: removed.ok, feedbackId });
    })
  );

  app.post(
    '/api/images/:id/rename',
    asyncRoute(async (req, res) => {
      const updated = await lib.renameImage(Number(req.params.id), req.body?.title || '');
      res.json(updated);
    })
  );

  /** 物理旋转图片（写回原文件），其他软件打开即为旋转后效果 */
  /* 已读标记（大图预览时调用，用于「未看过」筛选） */
  app.post(
    '/api/images/:id/viewed',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      if (!lib.getImage(id)) return res.status(404).json({ error: '图片不存在' });
      res.json({ ok: true, item: lib.markViewed(id) });
    })
  );








  /* -------------------------------- 前端托管 -------------------------------- */

  if (fs.existsSync(WEB_DIST)) {
    // 静态直出也要带 CSP（生产前端无内联脚本、无 eval，可收紧到 self）
    const htmlCsp =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
    app.use(
      express.static(WEB_DIST, {
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          if (String(filePath).endsWith('.html')) res.setHeader('Content-Security-Policy', htmlCsp);
        },
      })
    );
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      // 生产托管的 HTML 叠加更严格的 CSP 响应头
      res.setHeader('Content-Security-Policy', htmlCsp);
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .type('html')
        .send(
          '<h2>前端尚未构建</h2><p>请先运行 <code>npm run build</code>（桌面端用 <code>npm run desktop</code> 会自动构建）。</p>'
        );
    });
  }

  app.use((err, _req, res, _next) => {
    console.error('[api error]', err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}

/** 启动 HTTP 服务，返回 { server, port } */
export function startServer(port = PORT, options = {}) {
  const app = buildApp(options);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      bootstrap();
      auto.startScheduler();
      resolve({ server, port: actualPort });
    });
    server.on('error', (err) => {
      if (err?.code === 'EADDRINUSE' && port !== 0 && options.desktop) {
        // 桌面端兜底：固定端口被占（比如残留实例）就换随机端口，不让整个应用起不来
        console.warn(`[server] 端口 ${port} 被占用，改用随机端口`);
        server.removeAllListeners('error');
        startServer(0, options).then(resolve, reject);
        return;
      }
      reject(err);
    });
  });
}
