// @ts-check
// 关键词 / 设置 / 图库文件夹与多资源库路由（从 app.js 拆出）
import { applyProxy } from '../network.js';
import { CRAWL_LIMITS, SOURCES, getJobStatus, startCrawl, stopCrawl } from '../crawler.js';
import * as lib from '../library.js';
import {
  addImagesToFolder,
  createFoldersBatch,
  createVirtualFolder,
  deleteFolder,
  folderImageRows,
  listFolderTree,
  removeImagesFromFolder,
  renameFolder,
  reorderFolderImages,
  reorderFolders,
  setFolderAppearance,
  setFolderCover,
  setFolderTags,
} from '../folders.js';
import { attachInheritedTags } from '../lib/query.js';
import { attachStackInfo } from '../lib/stacks.js';
import {
  clearFolderPassword,
  lockedFolders,
  sealFolder,
  setFolderPassword,
  unlockFolder,
} from '../lib/privacy.js';
import {
  activateLibrary,
  createLibrary,
  deleteLibrary,
  getActiveLibrary,
  isImportPending,
  listLibraries,
  setActiveRoot,
} from '../libraries.js';
import { watchStorageDir } from '../importer.js';
import { autoMergeLegacy, refreshMergedRows } from '../lib/legacy-db.js';
import { NAME_TEMPLATE_PRESETS, NAME_TEMPLATE_TOKENS, previewNameTemplate } from '../lib/name-template.js';
import { logOp } from '../oplog.js';
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
      // 升级自旧版：素材目录里可能还躺着单库时代的 <素材目录>/gallery.db，而新库是空的。
      // 不处理的话用户升级后看到的就是「一张图都没有」（文件、标签其实都在老库里）。
      // 只在目标库为空时自动合并；有数据的库交给用户决定，避免合并出重复记录。
      let legacyMerged = 0;
      if (library.root_path) {
        const rowsNow = Number(db.prepare('SELECT COUNT(*) AS c FROM images').get()?.c || 0);
        if (!rowsNow) {
          try {
            const merged = autoMergeLegacy(library.root_path, { backupParent: library.path });
            if (merged?.ok && merged.images > 0) {
              legacyMerged = merged.images;
              console.info(`[library] 已自动合并旧库 ${merged.images} 张（备份：${merged.backup}）`);
              // 老库的 thumbs 目录多半跟着旧版本一起没了：清失效路径 + 后台批量补图
              void refreshMergedRows()
                .then(() => ctx.scheduleThumbRebuild?.('旧库合并后补图'))
                .catch(() => {});
              sseBroadcast('library', { legacyMerged });
            }
          } catch (err) {
            console.warn('[library] 旧库自动合并失败（不影响使用）:', err?.message || err);
          }
        }
      }
      // 全量扫描只在「这个库确实还没数据」时做：
      //   - 新库首次打开（images 为空）
      //   - 上次扫描被打断（import_pending）
      // 以前每次切库都无条件扫一遍，大库上就是几千张图重新解码 + 生成缩略图，
      // CPU 被打满几分钟，用户感知就是「切库要三四十秒、什么都点不动」。
      // 已有数据的库靠 fs.watch 跟进增量（activateLibrary 里已重挂监听）。
      const hasRows = Number(db.prepare('SELECT COUNT(*) AS c FROM images').get()?.c || 0) > 0;
      if (library.root_path && (!hasRows || isImportPending())) {
        // 延迟 3s：先让前端把新库的首屏数据拉完，用户立刻看到内容，扫描在后台静默补齐
        setTimeout(() => startLocalImport('已切换到新资源库，正在后台扫描素材…'), 3000);
      }
      sseBroadcast('library', { path: req.path });
      res.json({ ok: true, library, legacyMerged });
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

  /** 批量创建文件夹：names 用换行/逗号分隔，一次建一批（同父级下同名跳过） */
  app.post(
    '/api/folders/batch',
    asyncRoute(async (req, res) => {
      const { names, parentId } = req.body || {};
      const r = createFoldersBatch(names, parentId ?? null);
      sseBroadcast('folders', { path: req.path });
      res.json({ ok: true, ...r, folders: listFolderTree() });
    })
  );

  /** 文件夹手动拖拽排序：body.folderIds 是同一父级下的完整顺序 */
  app.post(
    '/api/folders/reorder',
    asyncRoute(async (req, res) => {
      const r = reorderFolders(req.body?.parentId ?? null, req.body?.folderIds || []);
      res.json({ ok: true, ...r, folders: listFolderTree() });
    })
  );

  /** 文件夹外观：emoji / 图标字符 + 主题色 */
  app.put(
    '/api/folders/:id/appearance',
    asyncRoute(async (req, res) => {
      const r = setFolderAppearance(Number(req.params.id), {
        icon: req.body?.icon,
        color: req.body?.color,
      });
      sseBroadcast('folders', { path: req.path });
      res.json({ ok: true, ...r, folders: listFolderTree() });
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

  /** 设置文件夹封面（body.imageId 省略 / 0 = 恢复自动封面） */
  app.put(
    '/api/folders/:id/cover',
    asyncRoute(async (req, res) => {
      const coverId = setFolderCover(Number(req.params.id), req.body?.imageId ?? null);
      sseBroadcast('folders', { path: req.path });
      res.json({ ok: true, coverImageId: coverId, folders: listFolderTree() });
    })
  );

  /**
   * 文件夹标签（Eagle：夹上打标签，夹内素材自动带上）。
   * 只存 folders.tags，查询期沿 path 继承 —— 删标签立刻生效，不用逐张回滚。
   */
  app.put(
    '/api/folders/:id/tags',
    asyncRoute(async (req, res) => {
      const r = setFolderTags(Number(req.params.id), req.body?.tags ?? []);
      sseBroadcast('folders', { path: req.path });
      res.json({ ok: true, tags: r.tags, folders: listFolderTree() });
    })
  );

  /** 文件夹内手动排序：body.imageIds 是拖拽后的完整顺序（只取被拖动的区间也可以） */
  app.put(
    '/api/folders/:id/order',
    asyncRoute(async (req, res) => {
      const r = reorderFolderImages(Number(req.params.id), req.body?.imageIds);
      res.json({ ok: true, ...r });
    })
  );

  app.get(
    '/api/folders/:id/images',
    asyncRoute(async (req, res) => {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(120, Math.max(12, Number(req.query.pageSize) || 48));
      try {
        const { rows, total, hasMore } = folderImageRows(Number(req.params.id), { page, pageSize });
        res.json({ items: attachStackInfo(attachInheritedTags(rows.map(lib.toDTO))), total, hasMore });
      } catch (err) {
        // 加锁夹未解锁：403 而不是 500，前端据此弹密码框
        res.status(err.statusCode || 400).json({ error: err.message });
      }
    })
  );

  /* ---------------- 隐私空间：文件夹密码锁 ---------------- */

  app.get('/api/privacy/folders', (_req, res) => {
    res.json({ folders: lockedFolders() });
  });

  app.put(
    '/api/folders/:id/password',
    asyncRoute(async (req, res) => {
      try {
        const r = setFolderPassword(Number(req.params.id), req.body?.password, req.body?.oldPassword);
        sseBroadcast('folders', { path: req.path });
        res.json({ ok: true, ...r, folders: listFolderTree() });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  app.delete(
    '/api/folders/:id/password',
    asyncRoute(async (req, res) => {
      try {
        const r = clearFolderPassword(Number(req.params.id), req.body?.password ?? req.query?.password);
        sseBroadcast('folders', { path: req.path });
        res.json({ ok: true, ...r, folders: listFolderTree() });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /** 本次会话解锁（重启应用自动回到锁定态） */
  app.post(
    '/api/folders/:id/unlock',
    asyncRoute(async (req, res) => {
      try {
        const r = unlockFolder(Number(req.params.id), req.body?.password);
        sseBroadcast('folders', { path: req.path });
        res.json({ ok: true, ...r, folders: listFolderTree() });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  /** 手动上锁（不删密码）：离开隐私文件夹时用 */
  app.post(
    '/api/folders/:id/seal',
    asyncRoute(async (req, res) => {
      try {
        const r = sealFolder(Number(req.params.id));
        sseBroadcast('folders', { path: req.path });
        res.json({ ok: true, ...r, folders: listFolderTree() });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  app.post(
    '/api/folders/:id/images',
    asyncRoute(async (req, res) => {
      const folderId = Number(req.params.id);
      const imageIds = (req.body?.imageIds || []).map(Number).filter(Boolean);
      const added = addImagesToFolder(folderId, imageIds);
      // 整理动作也要可撤销：以前「加入文件夹」只有进没有出，拖错文件夹只能手动找回来
      if (added) logOp({ op: 'folder-add', summary: `加入文件夹 ${added} 张`, payload: { folderId, imageIds } });
      res.json({ ok: true, added, folders: listFolderTree() });
    })
  );

  app.delete(
    '/api/folders/:id/images/:imageId',
    asyncRoute(async (req, res) => {
      const folderId = Number(req.params.id);
      const imageIds = [Number(req.params.imageId)];
      const removed = removeImagesFromFolder(folderId, imageIds);
      if (removed) logOp({ op: 'folder-remove', summary: '从文件夹移出 1 张', payload: { folderId, imageIds } });
      res.json({ ok: true, removed });
    })
  );

  /** 批量移出（多选工具栏用）：一次请求解除整批关联，避免 N 次往返 */
  app.delete(
    '/api/folders/:id/images',
    asyncRoute(async (req, res) => {
      const folderId = Number(req.params.id);
      const list = (req.body?.imageIds || []).map(Number).filter(Boolean);
      const removed = removeImagesFromFolder(folderId, list);
      if (removed) logOp({ op: 'folder-remove', summary: `从文件夹移出 ${removed} 张`, payload: { folderId, imageIds: list } });
      res.json({ ok: true, removed, folders: listFolderTree() });
    })
  );

  /** 某张图归属的文件夹（大图详情里展示 + 逐条移出，补上「只进不出」的缺口） */
  app.get(
    '/api/images/:id/folders',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const rows = db
        .prepare(
          `SELECT f.id, f.name, f.parent_id, f.path
             FROM image_folders i JOIN folders f ON f.id = i.folder_id
            WHERE i.image_id = ?
            ORDER BY f.path ASC`
        )
        .all(id);
      res.json({ folders: rows });
    })
  );

  /**
   * 采集源 + 采集参数的唯一事实来源。
   * 以前这里只回 key/label/enabled，前端另有一份硬编码的源列表和页面级并发常量，
   * 于是「后端支持调并发/画质阈值」在界面上根本摸不到；改一处忘一处还会对不上。
   */
  app.get('/api/sources', (_req, res) => {
    const settings = getSettings();
    const sources = Object.values(SOURCES).map((s) => ({
      key: s.key,
      label: s.label,
      hint: s.hint || '',
      needsCookie: !!s.needsCookie,
      kind: 'crawl',
      enabled: !!settings.sources?.[s.key],
    }));
    // 本地导入不是「采集源」，但筛选器/统计里是一等公民，一起下发省得前端再写死一份
    sources.push({ key: 'local', label: '本地导入', hint: '', needsCookie: false, kind: 'import', enabled: true });
    res.json({
      sources,
      limits: { maxPages: CRAWL_LIMITS.MAX_PAGES, maxConcurrency: CRAWL_LIMITS.MAX_CONCURRENCY },
      crawl: {
        pagesPerKeyword: Number(settings.pagesPerKeyword) || 3,
        concurrency: Number(settings.concurrency) || 5,
        minResolution: Number(settings.minResolution) || 0,
        minFileSize: Number(settings.minFileSize) || 0,
        maxFileSize: Number(settings.maxFileSize) || 0,
      },
    });
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
      // 只有「没传 sources」才回落到设置里的开关；显式传空数组 = 用户把源全关了，
      // 再回落等于偷偷帮他打开，界面上勾掉的东西没生效
      const sources = Array.isArray(body.sources)
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

  // 命名模板预览：用库里最近 20 张真实素材渲染，空库时用示例数据，避免「设置好却看不到效果」
  app.post(
    '/api/import/name-preview',
    asyncRoute(async (req, res) => {
      const tpl = String(req.body?.template || '').trim().slice(0, 200);
      const count = Math.min(20, Math.max(1, Number(req.body?.count) || 20));
      const meta = { presets: NAME_TEMPLATE_PRESETS, tokens: NAME_TEMPLATE_TOKENS, ok: true };
      if (!tpl) return res.json({ ...meta, names: [], sample: false });
      let rows;
      try {
        rows = db
          .prepare('SELECT title, abs_path, keyword, source, width, height, created_at FROM images ORDER BY id DESC LIMIT ?')
          .all(count);
      } catch {
        rows = [];
      }
      const sample = !rows.length;
      if (sample) {
        const now = new Date().toISOString();
        rows = Array.from({ length: Math.min(count, 5) }, (_, i) => ({
          title: `示例素材 ${i + 1}.jpg`,
          abs_path: `示例素材 ${i + 1}.jpg`,
          keyword: '壁纸',
          source: 'local',
          width: 1920,
          height: 1080,
          created_at: now,
        }));
      }
      res.json({ ...meta, names: previewNameTemplate(tpl, rows), sample });
    })
  );

  app.post(
    '/api/import/local',
    asyncRoute(async (_req, res) => {
      if (!startLocalImport()) return res.json({ ok: false, message: '导入任务正在运行' });
      res.json({ ok: true });
    })
  );

  app.delete(
    '/api/library',
    asyncRoute(async (_req, res) => {
      const { removed, failed } = await lib.clearLibrary();
      res.json({ ok: true, removed, failed });
    })
  );

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
}
