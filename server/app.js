import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, WEB_DIST } from './config.js';
import { db, getSettings } from './db.js';
import { logOp } from './oplog.js';
import * as lib from './library.js';
import { undoLastEdit, lastEdit, hasUndo } from './lib/undo.js';
import { getActiveLibrary, setImportPending, isImportPending } from './libraries.js';
import { getJobStatus } from './crawler.js';
import { editJobStatus } from './edit-job.js';
import * as clip from './clip.js';
import { importLocalImages, watchStorageDir, invalidateMissingCache } from './importer.js';
import { sweepThumbTemp } from './bulk-import.js';
import { prefetchPreviews } from './lib/preview-queue.js';
import { openFolder, revealFile, setWallpaper, platform } from './desktop.js';
import * as kb from './kb.js';
import * as search from './search.js';
import * as wallpaper from './wallpaper.js';
import * as aiUpscale from './ai-upscale.js';
import * as srDeep from './sr-deep.js';
import * as matting from './matting.js';
import * as enhanceJob from './enhance-job.js';
import * as auto from './auto.js';
import { liveBus } from './live-bus.js';
import { apiAuth } from './auth.js';
import { register as registerTidy } from './routes/tidy.js';
import { register as registerEnhance } from './routes/enhance.js';
import { register as registerFiles } from './routes/files.js';
import { register as registerStats } from './routes/stats.js';
import { register as registerCatalog } from './routes/catalog.js';
import { register as registerWallpaper } from './routes/wallpaper.js';
import { register as registerKeywords } from './routes/keywords.js';
import { register as registerEdit } from './routes/edit.js';
import { register as registerOrganize } from './routes/organize.js';
import { register as registerAnnotate } from './routes/annotate.js';
import { register as registerUpload } from './routes/upload.js';
import { register as registerExport } from './routes/export.js';
import { register as registerMaintenance } from './routes/maintenance.js';
import { register as registerJobs } from './routes/jobs.js';
import { register as registerBookmarks } from './routes/bookmarks.js';
import { register as registerExtension } from './routes/extension.js';
import { register as registerOcr } from './routes/ocr.js';
import { register as registerSource } from './routes/source.js';
import { register as registerInspect } from './routes/inspect.js';
import { register as registerActions } from './routes/actions.js';
import { register as registerTransfer } from './routes/transfer.js';
import { register as registerV1 } from './routes/v1.js';
import { register as registerPlugins } from './routes/plugins.js';
import { register as registerLan } from './routes/lan.js';
import { register as registerWorkshop } from './routes/workshop.js';
import { register as registerSync } from './routes/sync.js';
import { capabilitiesFor, platformSummary } from './lib/platform.js';
import { markInterruptedJobs, pruneJobs } from './jobs.js';
import { startThumbRebuild, thumbMissingCount } from './lib/thumb-rebuild.js';
import { autoMergeLegacy, refreshMergedRows } from './lib/legacy-db.js';
import { backfillMissingFolderLinks } from './folders.js';

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** target 是否位于 root 之内（Windows 大小写不敏感，比较前统一小写） */
function isInsideDir(root, target) {
  const rel = path.relative(path.resolve(root).toLowerCase(), path.resolve(target).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 只有图片/视频这类素材才允许「在文件夹中显示」（副本可能被保存在库外） */
const MEDIA_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|tiff?|svg|psd|mp4|webm|mov|mkv|avi)$/i;

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
 * 整库补缩略图：只按数据库里的记录补，不扫磁盘。
 *
 * 触发场景：从旧单库合并进来、上次导入被强杀（半截记录）、用户把 thumbs 目录清过。
 * 以前这种情况只能靠「卡片滚到哪补到哪」，一屏几十张排队十几秒，用户看到的就是
 * 「图片一直转圈」。这里达到阈值就后台批量补，进度写进任务表。
 */
function scheduleThumbRebuild(reason = '') {
  const missing = thumbMissingCount();
  // 少量缺图（顺手一两张）不值得起任务：在线队列很快就补上了
  if (missing < 20) return { started: false, reason: 'below-threshold', missing };
  const timer = setTimeout(() => {
    const r = startThumbRebuild({
      onProgress: (s) => {
        if (s.finished) sseBroadcast('library', { thumbRebuild: { ...s, reason } });
      },
    });
    if (r.started) console.info(`[thumb] 后台补图 ${r.total} 张（${reason || '自动'}）`);
  }, 2000);
  // 别让定时器把进程吊着（Electron 退出时）
  if (typeof timer.unref === 'function') timer.unref();
  return { started: true, scheduled: true, missing };
}

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
  // 导入前记下 image 表的最大 id：撤销「这次导入」时用它当边界（比记几千个 id 省内存，
  // 也不会因为百万级导入把 payload 撑爆）
  const importMaxId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM images').get()?.m || 0);
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
      // 导入也可撤销：记一条边界（本次新入库的都是 id > importMaxId 的行）
      if (Number(result?.saved) > 0) {
        logOp({
          op: 'import',
          summary: `导入 ${result.saved} 张（${result.source || '本地'}）`,
          payload: { maxId: importMaxId, saved: result.saved, source: result.source || '' },
        });
      }
      // 被切库叫停的任务：不算完成，也不算失败
      const cancelled = Number(result?.cancelled) > 0;
      importState = {
        running: false,
        progress: 100,
        message: cancelled ? '导入已取消（已切换资源库）' : '导入完成',
        result,
      };
      sseBroadcast('library', { imported: result.saved, cancelled });
      invalidateMissingCache(); // 文件落库/清理后，缺失检查缓存作废
      // 扫描没覆盖到的缺图（上次被打断、旧库合并进来的行）→ 后台按记录补，别再让用户滚着等
      if (!cancelled) scheduleThumbRebuild('扫描完成后的补图');
      // 批量导入不逐张建模（百万张会堆积上百万次推理），统一交给补算任务后台跑；
      // 延迟启动给用户紧接着的列表浏览让路（补算是重 CPU 任务）
      if (clip.clipReady()) setTimeout(() => clip.startBackfill(), 5_000);
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
      // error 单独留一个字段：前端靠它区分「扫描失败」和「正常完成 0 张」，
      // 否则空库页面只会显示「还没有符合条件的图片」，用户根本不知道扫描崩了
      importState = { running: false, progress: 100, message: `导入失败：${err.message}`, error: err.message, result: null };
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
  let imageCount = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
  // 当前库是空的，但素材目录里还躺着单库时代的 gallery.db：先把它合并回来再谈扫描。
  // 用户升级后最常见的状态就是这个（库注册了、数据还在老文件里），不合并就是「一张图都没有」。
  if (imageCount === 0) {
    const active = getActiveLibrary();
    if (active?.root_path) {
      try {
        const merged = autoMergeLegacy(active.root_path, { backupParent: active.path || '' });
        if (merged?.ok && merged.images > 0) {
          imageCount = Number(db.prepare('SELECT COUNT(*) AS c FROM images').get()?.c || 0);
          console.log(`[启动] 已自动合并旧库 ${merged.images} 张（备份：${merged.backup}）`);
          void refreshMergedRows()
            .then(() => scheduleThumbRebuild('旧库合并后补图'))
            .catch(() => {});
        }
      } catch (err) {
        console.warn('[启动] 旧库自动合并失败（不影响使用）:', err?.message || err);
      }
    }
  }
  console.log(`[db] 图片 ${imageCount} 张，pHash 索引 ${lib.initPhashIndex()} 条`);
  // 后台预加载 CLIP 模型（首次会下载 ~150MB，之后走本地缓存）；就绪后补算缺失特征。
  // 补算延迟 15s：万级库特征补全是持续数分钟的重 CPU 任务，启动即跑会抢占
  // 首屏（缩略图/列表 SQL）的 CPU —— 表现为打开软件后卡很久
  clip
    .clipLoad()
    .then((r) => {
      if (!r.ok) return console.log('[clip] 模型加载失败（CLIP 功能暂不可用）：', r.error);
      console.log('[clip] 模型就绪，已建模', clip.embeddingCount(), '张');
      if (clip.embeddingCount() < imageCount) setTimeout(() => clip.startBackfill(), 15_000);
    })
    .catch(() => {});
  // 有记录却大面积缺缩略图（旧库合并进来 / thumbs 目录被清过）：直接按记录后台补，
  // 不走目录扫描 —— 扫描是 O(文件数)，补图是 O(缺图数)
  const thumbGap = scheduleThumbRebuild('启动检查');
  if (thumbGap.started) console.log(`[启动] 检测到 ${thumbGap.missing} 张缺缩略图，稍后后台补`);
  // 早期版本给 RAW / 视频等非图片素材入库时漏了文件夹关联：这些素材在文件夹视图里
  // 完全不出现（只有「图库」全量视图有）。启动时补一次，幂等且只扫无关联的行。
  try {
    const linked = backfillMissingFolderLinks();
    if (linked) console.log(`[启动] 补齐 ${linked} 个素材的文件夹关联`);
  } catch (err) {
    console.warn('[启动] 补齐文件夹关联失败:', err?.message || err);
  }
  // 上次扫描被强杀打断：库里留着「已登记但缺缩略图」的半截记录，还有一批文件没登记。
  // 增量扫描会把这些补上（未变且有缩略图的全跳过），代价只是一次目录遍历。
  const resume = isImportPending();
  if (resume || imageCount === 0) {
    const msg = resume ? '上次导入未完成，正在继续…' : '启动扫描素材文件夹…';
    console.log(resume ? '[启动] 上次导入未完成，继续扫描…' : '[启动] 图库为空，开始导入工作区内已有素材…');
    // 走统一的 startLocalImport：会把进度写进 importState 并在完成时广播 library，
    // 前端无需重启就能看到启动时自动导入的图片
    startLocalImport(msg)
      ?.then((result) => {
        console.log('[导入] 完成', result);
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
  /**
   * 请求体分级：只有真正需要 base64 大图的三个入口允许到 50MB，其余写操作 8MB 封顶。
   * 以前全局一律 50MB —— 任何接口收到一个 40MB 的无关 body 都会先被完整读进内存。
   * 这里在解析之前看 Content-Length 直接拒，成本几乎为零。
   */
  const BIG_BODY_PATHS = [
    /^\/api\/extension\/ingest/,
    /^\/api\/search\/by-image/,
    /^\/api\/images\/\d+\/thumb/,
    /^\/api\/import\/upload/,
  ];
  const BODY_CAP_SMALL = 8 * 1024 * 1024;
  const BODY_CAP_BIG = 50 * 1024 * 1024;
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const declared = Number(req.headers['content-length'] || 0);
    if (!declared) return next();
    const cap = BIG_BODY_PATHS.some((re) => re.test(req.path)) ? BODY_CAP_BIG : BODY_CAP_SMALL;
    if (declared > cap) {
      return res.status(413).json({ error: `请求体超过上限（${Math.round(cap / 1024 / 1024)}MB）` });
    }
    next();
  });
  // 解析上限仍留 50MB：上面已经按路径做过更严的前置拒绝
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
  // 素材入库（采集协程 / 目录监听 / 后台批量）不经过 HTTP 中间件，
  // 必须自己广播「库已变化」：否则前端停在上一次的张数，用户得手动点刷新才看得到新图。
  // 600ms 合并窗口：采集是 24 张一批入库，逐批广播会把前端打成刷新风暴
  let ingestPending = 0;
  let ingestTimer = null;
  liveBus.on('library-changed', (payload) => {
    ingestPending += Math.max(1, Number(payload?.added) || 1);
    if (ingestTimer) return;
    ingestTimer = setTimeout(() => {
      ingestTimer = null;
      const added = ingestPending;
      ingestPending = 0;
      sseBroadcast('library', { source: 'ingest', added });
    }, 600);
    ingestTimer.unref?.();
  });

  const jobSnapshot = () => ({
    crawl: getJobStatus(),
    import: importState,
    enhance: enhanceJob.jobStatus(),
    clip: clip.backfillStatus(),
    sr: srDeep.srStatus(),
    aiUp: aiUpscale.aiStatus(),
    matting: matting.mattingStatus(),
    // 批量裁切/调色/水印以前只能各自 800ms 轮询，现在一起走 SSE 快照
    edit: editJobStatus(),
  });
  let lastJobJson = '';
  let lastJobPush = 0;
  setInterval(() => {
    if (!sseClients.size) return;
    let snap;
    try {
      snap = jobSnapshot();
    } catch {
      return;
    }
    const json = JSON.stringify(snap);
    // 有任务在跑时即使快照没变也按 5s 心跳推一帧：前端据此确认 SSE 还活着，
    // 不再各自 800ms/1s 轮询；空闲时仍然只在变化时推，避免空转刷屏。
    const running = Object.values(snap).some((s) => s && (s.running || s.downloading || s.loading));
    if (json !== lastJobJson || (running && Date.now() - lastJobPush >= 5000)) {
      lastJobPush = Date.now();
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

  // 上次进程退出时没跑完的任务（采集/批量编辑/增强/模型下载）一律标成 interrupted：
  // 否则它们会永远停在 running，任务中心显示「进行中」但实际什么都没发生
  markInterruptedJobs();
  pruneJobs(200);

  // 路由组已拆分至 routes/*.js，此处统一注册。
  // importState 是重赋值型 let（不能传对象引用），routes 经 getter 读最新值
  const ctx = {
    desktop,
    sseBroadcast,
    startLocalImport,
    asyncRoute,
    colorFilterIds,
    importState: () => importState,
    scheduleThumbRebuild,
    startThumbRebuild,
  };
  registerTidy(app, ctx);
  registerEnhance(app, ctx);
  registerFiles(app, ctx);
  registerStats(app, ctx);
  registerCatalog(app, ctx);
  registerWallpaper(app, ctx);
  registerKeywords(app, ctx);
  registerEdit(app, ctx);
  registerOrganize(app, ctx);
  registerAnnotate(app, ctx);
  registerUpload(app, ctx);
  registerExport(app, ctx);
  registerMaintenance(app, ctx);
  registerJobs(app, ctx);
  registerBookmarks(app, ctx);
  registerExtension(app, ctx);
  registerOcr(app, ctx);
  registerSource(app, ctx);
  registerInspect(app, ctx);
  registerActions(app, ctx);
  registerTransfer(app, ctx);
  registerV1(app, ctx);
  registerPlugins(app, ctx);
  registerLan(app, ctx);
  registerWorkshop(app, ctx);
  registerSync(app, ctx);

  /* -------------------------------- 系统能力 ------------------------------- */
  app.get('/api/platform', (_req, res) => {
    const caps = capabilitiesFor();
    res.json({ ok: true, ...caps, summary: platformSummary(caps) });
  });

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
      // 路径必须落在素材库根目录内：本地服务对任何进程开放，不校验就等于给了
      // 「用系统文件管理器打开任意目录」的能力（UNC 路径还能外带凭据）
      const root = lib.resolveStorageDir(getSettings());
      const dir = req.body?.path ? path.resolve(String(req.body.path)) : root;
      if (!isInsideDir(root, dir)) {
        return res.status(400).json({ error: '只能打开素材库目录内的文件夹' });
      }
      openFolder(dir);
      res.json({ ok: true, path: dir });
    })
  );

  app.post(
    '/api/system/reveal',
    asyncRoute(async (req, res) => {
      const target = req.body?.path;
      if (!target) return res.status(400).json({ error: '缺少路径' });
      const abs = path.resolve(String(target));
      const root = lib.resolveStorageDir(getSettings());
      // 库内随便定位；库外（用户自选的副本保存目录）只允许真实存在的素材文件，
      // 否则这里就成了「用资源管理器定位任意 exe / 可执行脚本」的入口
      if (!isInsideDir(root, abs) && !(fs.existsSync(abs) && MEDIA_EXT_RE.test(abs))) {
        return res.status(400).json({ error: '只能定位素材库内的文件' });
      }
      revealFile(abs);
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
      res.sendFile(result.path, { dotfiles: 'allow' });
    })
  );

  /* --------------------------------- 图片 API ------------------------------- */

  app.get(
    '/api/images',
    asyncRoute(async (req, res) => {
      // 统一走 library.listImages（结构化筛选 + FTS 搜索 + 排序 + 分页）
      const colorIds = colorFilterIds(req.query);
      const data = lib.listImages({ ...req.query, colorIds });
      res.json(data);
      // 这一页的灯箱预览图交给后台预取：用户点开时就是磁盘命中（几毫秒），
      // 而不是等着现解码 20MB 的原图（那就是「模糊一两秒」的来源）。
      // 只取前 24 张：一屏放不下更多，翻页快的人也不必为没看过的图付 CPU。
      prefetchPreviews(data.items?.slice(0, 24).map((it) => it.id));
    })
  );

  // 当前筛选条件下的全部 id（Ctrl+A 全选用）：只回 id，不翻页也不回表
  app.get(
    '/api/images/ids',
    asyncRoute(async (req, res) => {
      const colorIds = colorFilterIds(req.query);
      res.json(lib.listImageIds({ ...req.query, colorIds }));
    })
  );

  // 最近一次可撤销的编辑（前端显示「撤销」入口）
  app.get(
    '/api/undo/last',
    asyncRoute(async (_req, res) => {
      res.json({ last: lastEdit() });
    })
  );

  // 撤销一次覆盖写回。body 可带 imageId：不给就撤销全库最近一次
  app.post(
    '/api/undo',
    asyncRoute(async (req, res) => {
      const id = Number(req.body?.imageId) || 0;
      const r = await undoLastEdit(id);
      if (!r.ok) return res.status(409).json({ error: r.reason || '没有可撤销的编辑' });
      const item = lib.getImage(r.id);
      res.json({ item: item ? lib.toDTO(item) : null, kind: r.kind });
    })
  );

  app.get(
    '/api/images/:id/undo',
    asyncRoute(async (req, res) => {
      res.json({ canUndo: hasUndo(Number(req.params.id)) });
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
      const hits = await clip.topSimilar(vec, { k: limit, minCos, excludeId: id });
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
      const before = lib.getImage(id);
      if (!before) return res.status(404).json({ error: '图片不存在' });
      if (req.body.favorite !== undefined) lib.setFavorite(id, !!req.body.favorite);
      if (req.body.tags !== undefined) lib.setTags(id, req.body.tags);
      if (req.body.title !== undefined) lib.renameTitle(id, req.body.title);
      if (req.body.rating !== undefined) lib.setRating(id, req.body.rating);
      if (req.body.note !== undefined) lib.setNote(id, req.body.note);
      // 打标可撤销：记下改之前的标签串（单张的 PATCH 也要记，批量改标签同理在下面路由里记）
      if (req.body.tags !== undefined) {
        logOp({ op: 'tags', summary: `修改标签：${before.title || `图片 ${id}`}`, payload: { items: [{ id, before: before.tags || '' }] } });
      }
      res.json(lib.toDTO(lib.getImage(id)));
    })
  );

  app.delete(
    '/api/images/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const result = await lib.removeImage(id);
      // 删除进回收站也要进撤销栈：以前只有编辑类能撤销，误删只能手动翻回收站找
      if (result.ok) {
        logOp({ op: 'trash', summary: '删除 1 张图片', payload: { imageIds: [id] } });
      }
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








  /* 未知接口一律回 JSON：不写这条的话，/api/typo 会掉进前端托管的 404 或 HTML 兜底，
     前端 request() 解析 JSON 失败，只能给用户「请求失败 404 / 返回了无效数据」这种没法排查的提示 */
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

  /* -------------------------------- 前端托管 -------------------------------- */

  // 静态直出也要带 CSP（生产前端无内联脚本、无 eval，可收紧到 self）。
  // 未构建时的兜底页同样要带——「HTML 响应必带 CSP」是冒烟定期断言的安全基线，
  // 只在 dist 存在时才设头，会让「没构建」这种常态把安全回归掩盖掉。
  const htmlCsp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'";

  if (fs.existsSync(WEB_DIST)) {
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
      res.setHeader('Content-Security-Policy', htmlCsp);
      res
        .type('html')
        .send(
          '<h2>前端尚未构建</h2><p>请先运行 <code>npm run build</code>（桌面端用 <code>npm run desktop</code> 会自动构建）。</p>'
        );
    });
  }

  // 全局兜底：走到这里说明 asyncRoute 的 catch 也没兜住（同步抛错 / 中间件异常）。
  // 记下方法+路径，否则日志里只有堆栈没有「哪个接口崩的」。
  app.use((err, req, res, _next) => {
    if (res.headersSent) return;
    // 请求体本身有问题（前端传了坏 JSON / 超大 body）不是 500，别让日志被这类噪音刷屏
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法 JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: '请求体过大（上限 50MB）' });

    const status = Number(err?.status || err?.statusCode) || 500;
    console.error(`[api error] ${req.method} ${req.originalUrl || req.url}`, err);
    res.status(status).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}

/** 启动 HTTP 服务，返回 { server, port } */
export function startServer(port = PORT, options = {}) {
  const app = buildApp(options);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      // Node 25 + Express 5：监听失败时回调也会先被调用一次，此时 address() 为 null，
      // 不能读 port —— 交给下方 error 处理（reject / 换端口重试）
      const addr = server.address();
      if (!addr) return;
      bootstrap();
      auto.startScheduler();
      resolve({ server, port: addr.port });
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
