// 关键词 / 设置 / 图库文件夹与多资源库路由（从 app.js 拆出）
import fs from 'node:fs';
import path from 'node:path';
import { applyProxy } from '../network.js';
import { SOURCES, getJobStatus, startCrawl, stopCrawl, ingestUrls } from '../crawler.js';
import { SEED_URLS } from '../config.js';
import * as ai from '../ai.js';
import * as lib from '../library.js';
import {
  addImagesToFolder,
  createVirtualFolder,
  deleteFolder,
  folderImageRows,
  listFolderTree,
  removeImagesFromFolder,
  renameFolder,
} from '../folders.js';
import {
  activateLibrary,
  createLibrary,
  deleteLibrary,
  getActiveLibrary,
  listLibraries,
  setActiveRoot,
} from '../libraries.js';
import { watchStorageDir } from '../importer.js';
import { db, getSettings, saveSettings, listKeywords, addKeyword, updateKeyword, deleteKeyword } from '../db.js';

export function register(app, ctx) {
  const { asyncRoute, sseBroadcast, startLocalImport, importState: importStateRef } = ctx;


  app.get('/api/keywords', (_req, res) => res.json(listKeywords()));

  app.post(
    '/api/keywords',
    asyncRoute(async (req, res) => {
      const id = addKeyword(req.body.text);
      res.json({ ok: true, id, keywords: listKeywords() });
    })
  );

  app.put(
    '/api/keywords/:id',
    asyncRoute(async (req, res) => {
      updateKeyword(Number(req.params.id), req.body);
      res.json({ ok: true, keywords: listKeywords() });
    })
  );

  app.delete(
    '/api/keywords/:id',
    asyncRoute(async (req, res) => {
      deleteKeyword(Number(req.params.id));
      res.json({ ok: true, keywords: listKeywords() });
    })
  );

  /** settings 对外输出脱敏：凭据（微博 Cookie / AI API Key）永不下发前端，只回报「是否已配置」 */
  function maskSettings(s) {
    const { weiboCookie, ...rest } = s;
    const ai = rest.ai ? { ...rest.ai, apiKey: '' } : rest.ai;
    return {
      ...rest,
      ai,
      weiboCookie: '',
      hasWeiboCookie: !!String(weiboCookie || '').trim(),
      hasAiApiKey: !!String(rest.ai?.apiKey || '').trim(),
    };
  }

  app.get('/api/settings', (_req, res) => res.json(maskSettings(getSettings())));

  app.put(
    '/api/settings',
    asyncRoute(async (req, res) => {
      const prev = getSettings();
      const next = saveSettings(req.body || {});
      if (next.storageDir) lib.resolveStorageDir(next);
      await applyProxy();
      watchStorageDir(); // 素材文件夹变了就切换监听目标
      // 用户指定的文件夹里往往已经有图片：fs.watch 只监听之后的变化，
      // 已有文件必须主动全量扫一次，否则新装软件选完目录仍是空图库（P0）
      if ((prev.storageDir || '') !== (next.storageDir || '')) {
        setActiveRoot(next.storageDir); // 同步回当前库的 root_path（单一权威）
        startLocalImport('已切换素材文件夹，正在扫描…');
      }
      res.json(maskSettings(next));
    })
  );

  // 资源库管理（多资源库：列表 / 新建 / 切换）
  app.get('/api/libraries', (_req, res) => {
    res.json({ libraries: listLibraries(), activeId: getActiveLibrary()?.id ?? null });
  });

  app.post(
    '/api/libraries',
    asyncRoute(async (req, res) => {
      const { name, rootPath, libFolder } = req.body || {};
      const id = createLibrary({ name, rootPath, libFolder });
      res.json({ ok: true, id });
    })
  );

  app.post(
    '/api/libraries/:id/activate',
    asyncRoute(async (req, res) => {
      const library = activateLibrary(Number(req.params.id));
      // 新库的素材目录里往往已有图片，主动全量扫一次
      if (library.root_path) startLocalImport('已切换到新资源库，正在扫描…');
      sseBroadcast('library', { path: req.path });
      res.json({ ok: true, library });
    })
  );

  // 删除资源库（只删软件自建产物，保留素材图片；默认库不可删）
  app.delete(
    '/api/libraries/:id',
    asyncRoute(async (req, res) => {
      deleteLibrary(Number(req.params.id));
      sseBroadcast('library', { path: req.path });
      res.json({ ok: true, libraries: listLibraries(), activeId: getActiveLibrary()?.id ?? null });
    })
  );

  // 文件夹树（多层级文件夹）
  app.get('/api/folders', (_req, res) => {
    res.json({ folders: listFolderTree() });
  });

  // 虚拟文件夹 CRUD（Eagle 式：只改库内映射，不碰磁盘）
  app.post(
    '/api/folders',
    asyncRoute(async (req, res) => {
      const { name, parentId } = req.body || {};
      const id = createVirtualFolder(name, parentId ?? null);
      res.json({ ok: true, id, folders: listFolderTree() });
    })
  );

  app.put(
    '/api/folders/:id',
    asyncRoute(async (req, res) => {
      renameFolder(Number(req.params.id), req.body?.name);
      res.json({ ok: true, folders: listFolderTree() });
    })
  );

  app.delete(
    '/api/folders/:id',
    asyncRoute(async (req, res) => {
      const removed = deleteFolder(Number(req.params.id));
      res.json({ ok: true, removed, folders: listFolderTree() });
    })
  );

  app.get('/api/folders/:id/images', (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(120, Math.max(12, Number(req.query.pageSize) || 48));
    const { rows, total, hasMore } = folderImageRows(Number(req.params.id), { page, pageSize });
    res.json({ items: rows.map(lib.toDTO), total, hasMore });
  });

  app.post(
    '/api/folders/:id/images',
    asyncRoute(async (req, res) => {
      const added = addImagesToFolder(Number(req.params.id), req.body?.imageIds || []);
      res.json({ ok: true, added, folders: listFolderTree() });
    })
  );

  app.delete(
    '/api/folders/:id/images/:imageId',
    asyncRoute(async (req, res) => {
      const removed = removeImagesFromFolder(Number(req.params.id), [Number(req.params.imageId)]);
      res.json({ ok: true, removed });
    })
  );

  app.get('/api/sources', (_req, res) => {
    const settings = getSettings();
    res.json(
      Object.values(SOURCES).map((s) => ({
        key: s.key,
        label: s.label,
        enabled: !!settings.sources?.[s.key],
      }))
    );
  });

  /* --------------------------------- 采集 ---------------------------------- */

  app.get('/api/crawl/status', (_req, res) => res.json(getJobStatus()));

  app.post(
    '/api/crawl/start',
    asyncRoute(async (req, res) => {
      const settings = getSettings();
      const body = req.body || {};
      let keywords = body.keywords;
      if (!Array.isArray(keywords) || !keywords.length) {
        keywords = listKeywords()
          .filter((k) => k.enabled)
          .map((k) => k.text);
      }
      const sources =
        Array.isArray(body.sources) && body.sources.length
          ? body.sources
          : Object.keys(settings.sources || {}).filter((k) => settings.sources[k]);
      const result = startCrawl({ keywords, sources, pages: body.pages ?? settings.pagesPerKeyword });
      res.json(result);
    })
  );

  app.post('/api/crawl/stop', (_req, res) => {
    stopCrawl();
    res.json({ ok: true });
  });

  /* ------------------------------- 导入 / 维护 ------------------------------ */
  // importState / startLocalImport 已在模块顶层定义（bootstrap 复用）

  app.get('/api/import/status', (_req, res) => res.json(importStateRef()));

  app.post(
    '/api/import/local',
    asyncRoute(async (_req, res) => {
      if (!startLocalImport()) return res.json({ ok: false, message: '导入任务正在运行' });
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/seed',
    asyncRoute(async (_req, res) => {
      const results = await ingestUrls(SEED_URLS);
      res.json({ ok: true, results });
    })
  );

  app.delete(
    '/api/library',
    asyncRoute(async (_req, res) => {
      const removed = lib.clearLibrary();
      res.json({ ok: true, removed });
    })
  );

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
}
