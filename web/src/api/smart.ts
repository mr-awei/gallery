/**
 * 智能文件夹与其余零散接口
 * 由 api.ts 组合成单一的 `api` 对象对外暴露（调用点不需要改 import）。
 */
import { request } from './core';
import type { SmartFolder, VersionInfo, ActionStep, ActionConditions, ActionDef, ActionPreviewStep } from './types';
import type { FaceStatus, FacePerson, ReverseEngine, ReverseNetwork, ReverseSearchResponse, StitchTemplate, StitchCrop, StitchPlan } from './models';
import type { ImageItem } from '../types';

export const smartAPI = {
  // 智能文件夹
  smartFolders: () => request<SmartFolder[]>('/api/smart-folders'),
  createSmartFolder: (payload: { name: string; rules?: Record<string, unknown>; autoTags?: string[] }) =>
    request<{ ok: boolean; folders: SmartFolder[] }>('/api/smart-folders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateSmartFolder: (
    id: number,
    patch: { name?: string; rules?: Record<string, unknown>; autoTags?: string[] }
  ) =>
    request<{ ok: boolean; folders: SmartFolder[] }>(`/api/smart-folders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteSmartFolder: (id: number) =>
    request<{ ok: boolean; folders: SmartFolder[] }>(`/api/smart-folders/${id}`, { method: 'DELETE' }),
  previewSmartFolder: (id: number, opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.offset) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return request<{ folder: SmartFolder; total: number; items: ImageItem[]; limit: number; offset: number }>(
      `/api/smart-folders/${id}/images${qs ? `?${qs}` : ''}`
    );
  },
  applySmartFolderTags: (id: number) =>
    request<{ ok: boolean; changed: number; tags: { tag: string; count: number }[] }>(
      `/api/smart-folders/${id}/apply-tags`,
      { method: 'POST' }
    ),

  /* ------------------------- 图内文字（OCR） ------------------------- */
  ocrStatus: () =>
    request<{ platform: string; available: boolean; engine: string; note: string }>('/api/ocr/status'),
  ocrGet: (id: number) =>
    request<{ ok: boolean; id: number; text: string; lang: string; engine: string; createdAt: string }>(
      `/api/images/${id}/ocr`
    ),
  ocrRun: (id: number, force = false) =>
    request<{ ok: boolean; id: number; text: string; lang: string; engine: string; cached: boolean; chars?: number }>(
      `/api/images/${id}/ocr`,
      { method: 'POST', body: JSON.stringify({ force }) }
    ),
  ocrClear: (id: number) => request<{ ok: boolean; id: number }>(`/api/images/${id}/ocr`, { method: 'DELETE' }),
  ocrBatch: (ids: number[], force = false) =>
    request<{
      ok: boolean;
      total: number;
      okCount: number;
      truncated: boolean;
      results: { id: number; ok: boolean; error?: string; text?: string; chars?: number; cached?: boolean }[];
    }>('/api/images/ocr-batch', { method: 'POST', body: JSON.stringify({ ids, force }) }),

  /* --------------------- 来源：以图搜图 / 换大图 --------------------- */
  searchProviders: (id: number) =>
    request<{
      ok: boolean;
      sourceUrl: string;
      pageUrl: string;
      providers: {
        id: string;
        name: string;
        kind: 'upload' | 'url' | 'keyword';
        desc: string;
        ready: boolean;
        reason: string;
        url?: string;
      }[];
    }>(`/api/images/${id}/search-providers`),
  reverseSearch: (id: number, engine: string) =>
    request<{
      ok: boolean;
      engine: string;
      mode: 'upload' | 'url' | 'keyword';
      url?: string;
      note: string;
      results?: { similarity: number; title: string; detail: string; thumb: string; link: string }[];
    }>(`/api/images/${id}/reverse-search`, { method: 'POST', body: JSON.stringify({ engine }) }),
  upgradePreview: (id: number, minGain = 1.1) =>
    request<{
      ok: boolean;
      found: boolean;
      before: { width: number; height: number };
      after: { width: number; height: number; url: string } | null;
      tried: { url: string; error?: string; width?: number; height?: number }[];
    }>(`/api/images/${id}/upgrade-source/preview?minGain=${minGain}`),
  upgradeSource: (id: number, minGain = 1.1) =>
    request<{
      ok: boolean;
      before: { width: number; height: number };
      after: { width: number; height: number; url: string };
      bytes: number;
      item: ImageItem;
    }>(`/api/images/${id}/upgrade-source`, { method: 'POST', body: JSON.stringify({ minGain }) }),

  /* ------------------------ 检查器：EXIF / PDF / 版本 ------------------------ */
  exif: (id: number) =>
    request<{
      ok: boolean;
      width: number;
      height: number;
      format: string;
      space?: string;
      density?: number;
      hasAlpha?: boolean;
      pages?: number;
      exif: Record<string, string | number>;
      error?: string;
    }>(`/api/images/${id}/exif`),
  pdfInfo: (id: number) =>
    request<{ ok: boolean; pages: number; exact: boolean; size: number }>(`/api/images/${id}/pdf-info`),
  /** EPUB：目录与封面（打开阅读器时一次） */
  epubOutline: (id: number) =>
    request<{
      ok: boolean;
      title: string;
      author: string;
      language: string;
      cover: string;
      chapters: { index: number; label: string }[];
    }>(`/api/images/${id}/epub`),
  /** EPUB：单章正文（服务端已把 HTML 转成纯文本块 + data URL 插图） */
  epubChapter: (id: number, index: number) =>
    request<{
      ok: boolean;
      index: number;
      label: string;
      total: number;
      blocks: ({ type: 'text'; text: string } | { type: 'image'; src: string })[];
    }>(`/api/images/${id}/epub/${index}`),
  versions: (id: number) =>
    request<{
      ok: boolean;
      id: number;
      title: string;
      current: VersionInfo;
      versions: (VersionInfo & { id: number; label: string })[];
    }>(`/api/images/${id}/versions`),
  restoreVersion: (id: number, versionId: number) =>
    request<{ ok: boolean; id: number; restored: number; item: ImageItem }>(
      `/api/images/${id}/versions/${versionId}/restore`,
      { method: 'POST' }
    ),
  /* 一图多区域裁切：每个框另存一份副本（saveMode 固定 copy，原图不动） */
  cropRegions: (
    id: number,
    regions: { x: number; y: number; w: number; h: number }[],
    opts: { targetDir: string; addToLibrary?: boolean }
  ) =>
    request<{
      ok: boolean;
      count: number;
      results: { ok: boolean; rect: { x: number; y: number; w: number; h: number }; error?: string }[];
    }>(`/api/images/${id}/crop-regions`, {
      method: 'POST',
      body: JSON.stringify({ regions, targetDir: opts.targetDir, addToLibrary: opts.addToLibrary !== false }),
    }),

  /* ------------------------------ 动作 Actions ------------------------------ */
  actions: () =>
    request<{
      ok: boolean;
      types: Record<string, { label: string; desc: string }>;
      actions: ActionDef[];
    }>('/api/actions'),
  saveAction: (action: {
    id?: number;
    name: string;
    icon?: string;
    steps: ActionStep[];
    conditions?: ActionConditions;
  }) =>
    request<{ ok: boolean; id: number }>(action.id ? `/api/actions/${action.id}` : '/api/actions', {
      method: action.id ? 'PUT' : 'POST',
      body: JSON.stringify(action),
    }),
  deleteAction: (id: number) => request<{ ok: boolean }>(`/api/actions/${id}`, { method: 'DELETE' }),
  /** dryRun=true 只预演不写库（不调模型、不改数据） */
  runAction: (id: number, ids: number[], opts: { dryRun?: boolean } = {}) =>
    request<{
      ok: boolean;
      dryRun?: boolean;
      action: { id: number; name: string };
      total: number;
      okCount: number;
      skipped: number;
      failed: number;
      items: {
        id: number;
        ok: boolean;
        skipped?: string;
        error?: string;
        logs: string[];
        preview?: ActionPreviewStep[];
      }[];
    }>(`/api/actions/${id}/run`, { method: 'POST', body: JSON.stringify({ ids, dryRun: !!opts.dryRun }) }),
  actionCount: (ids: number[]) =>
    request<{ ok: boolean; count: number }>('/api/actions/count', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  /* --------------------------- 数据出口（备份/迁移） --------------------------- */
  transferPreview: () =>
    request<{
      ok: boolean;
      library: { id?: number; name?: string; rootPath: string; dbPath: string };
      counts: { images: number; folders: number; tags: number; playlists: number; actions: number; ocr: number };
      thumbsBytes: number;
      storageDir: string;
    }>('/api/transfer/preview'),
  transferBackup: (targetDir: string, includeThumbs = true) =>
    request<{
      ok: boolean;
      dir: string;
      bytes: number;
      thumbsBytes: number;
      counts: Record<string, number>;
      note: string;
    }>('/api/transfer/backup', { method: 'POST', body: JSON.stringify({ targetDir, includeThumbs }) }),
  /* 恢复前预检：按 manifest 报「缺哪个文件 / 哪个校验和不符」 */
  /** 自动备份排程配置（每个资源库一份：可以备到不同盘） */
  transferAuto: () =>
    request<{
      enabled: boolean;
      dir: string;
      everyDays: number;
      keep: number;
      lastAt: string;
      lastPath: string;
      lastError: string;
    }>('/api/transfer/auto'),
  transferAutoSave: (patch: { enabled?: boolean; dir?: string; everyDays?: number; keep?: number }) =>
    request<{ enabled: boolean; dir: string; everyDays: number; keep: number; lastAt: string; lastPath: string; lastError: string }>(
      '/api/transfer/auto',
      { method: 'POST', body: JSON.stringify(patch) }
    ),
  transferAutoRun: () =>
    request<{ ok: boolean; skipped?: boolean; reason?: string; dir?: string; removed?: number; error?: string }>(
      '/api/transfer/auto/run',
      { method: 'POST' }
    ),
  transferVerify: (sourceDir: string) =>
    request<{
      ok: boolean;
      problems: string[];
      warnings: string[];
      counts: Record<string, number> | null;
    }>('/api/transfer/verify', { method: 'POST', body: JSON.stringify({ sourceDir }) }),
  transferRestore: (sourceDir: string, name?: string, rootPath?: string) =>
    request<{
      ok: boolean;
      id: number;
      name: string;
      rootPath: string;
      dbPath: string;
      thumbsBytes: number;
      counts: Record<string, number> | null;
      remapped: number;
      missing: number;
      note: string;
    }>('/api/transfer/restore', { method: 'POST', body: JSON.stringify({ sourceDir, name, rootPath }) }),
  /* 迁库是长任务：单轮上限 limit 个素材，返回 remaining 供前端提示「再点一次继续」 */
  transferImportEagle: (srcDir: string, name?: string, rootPath?: string, limit?: number) =>
    request<{
      ok: boolean;
      total: number;
      processed: number;
      imported: number;
      skipped: number;
      existing: number;
      failed: number;
      folders: number;
      remaining: number;
      items: { id: number; title: string; folder?: boolean }[];
      errors: string[];
      error?: string;
    }>('/api/transfer/import-eagle', {
      method: 'POST',
      body: JSON.stringify({ srcDir, name, rootPath, limit }),
      timeoutMs: 15 * 60 * 1000,
    }),

  /* 导出前的预览：当前库会被写成 Eagle 库的内容规模（不写任何文件） */
  eagleExportPreview: () =>
    request<{ images: number; bytes: number; folders: number; storageDir: string; name: string }>(
      '/api/export/eagle/preview'
    ),
  /* 导出面板可用的格式 / 质量 / 尺寸候选（服务端单一来源，避免前端硬编码） */
  exportOptions: () =>
    request<{
      formats: { key: string; label: string; ext: string; note: string }[];
      qualities: number[];
      maxSides: number[];
    }>('/api/export/options'),
  /* 后台任务版：立即返回 jobId，进度用 api.jobs('eagle-export', 1) 轮询；可取消 */
  exportEagleStart: (destDir: string, name?: string) =>
    request<{ ok: boolean; jobId: number }>('/api/export/eagle/job', {
      method: 'POST',
      body: JSON.stringify({ destDir, name }),
    }),

  /* ------------------------------ 图片拼接 ------------------------------ */
  stitchUrl: (
    ids: number[],
    opts: {
      template?: string;
      crops?: string;
      layout?: string;
      ratio?: string;
      outWidth?: number;
      columns?: number;
      gap?: number;
      bg?: string;
      cell?: number;
      radius?: number;
      shadow?: number;
      border?: boolean;
      backdrop?: boolean;
      /** 无缝：留白 / 缝隙 / 圆角 / 描边 / 投影全部归零 */
      seamless?: boolean;
      format?: string;
      quality?: number;
      title?: string;
      subtitle?: string;
      billing?: string;
      /** 海报文字样式：本机字体 key（sys:家族名）/ 标题字号倍率 / 标题颜色 #rrggbb */
      font?: string;
      titleScale?: number;
      titleColor?: string;
      file?: string;
    } = {}
  ) => {
    const q = new URLSearchParams({ ids: ids.join(',') });
    if (opts.template) q.set('template', opts.template);
    if (opts.crops) q.set('crops', opts.crops);
    if (opts.layout) q.set('layout', opts.layout);
    if (opts.ratio) q.set('ratio', opts.ratio);
    if (opts.outWidth) q.set('outWidth', String(opts.outWidth));
    if (opts.columns) q.set('columns', String(opts.columns));
    if (opts.gap != null) q.set('gap', String(opts.gap));
    if (opts.bg) q.set('bg', opts.bg);
    if (opts.cell) q.set('cell', String(opts.cell));
    if (opts.radius != null) q.set('radius', String(opts.radius));
    if (opts.shadow != null) q.set('shadow', String(opts.shadow));
    if (opts.border != null) q.set('border', opts.border ? '1' : '0');
    if (opts.backdrop != null) q.set('backdrop', opts.backdrop ? '1' : '0');
    if (opts.seamless) q.set('seamless', '1');
    if (opts.format) q.set('format', opts.format);
    if (opts.quality) q.set('quality', String(opts.quality));
    if (opts.title) q.set('title', opts.title);
    if (opts.subtitle) q.set('subtitle', opts.subtitle);
    if (opts.billing) q.set('billing', opts.billing);
    if (opts.font) q.set('font', opts.font);
    if (opts.titleScale != null && opts.titleScale !== 1) q.set('titleScale', String(opts.titleScale));
    if (opts.titleColor) q.set('titleColor', opts.titleColor);
    if (opts.file) q.set('file', opts.file);
    return `/api/export/stitch?${q.toString()}`;
  },
  /* 版面坐标：每格的归一化位置 + 缩放下限。算法版式的格子是服务端算的，
     前端不能自己猜，否则「拖的那个框」不是「真正被裁的那块」 */
  stitchPlan: (
    ids: number[],
    opts: {
      template?: string;
      layout?: string;
      ratio?: string;
      outWidth?: number;
      columns?: number;
      cell?: number;
      gap?: number;
      seamless?: boolean;
    } = {}
  ) => {
    const q = new URLSearchParams({ ids: ids.join(',') });
    if (opts.seamless) q.set('seamless', '1');
    if (opts.template) q.set('template', opts.template);
    if (opts.layout) q.set('layout', opts.layout);
    if (opts.ratio) q.set('ratio', opts.ratio);
    if (opts.outWidth) q.set('outWidth', String(opts.outWidth));
    if (opts.columns) q.set('columns', String(opts.columns));
    if (opts.cell) q.set('cell', String(opts.cell));
    if (opts.gap != null) q.set('gap', String(opts.gap));
    return request<StitchPlan>(`/api/export/stitch/plan?${q.toString()}`);
  },
  /* 本机字体（海报文字选字体用）：走水印那套扫描结果，有 60 秒缓存，不带 refresh */
  stitchFonts: () => request<{ fonts: { key: string; name: string; group: string }[] }>('/api/watermark/fonts'),
  /* 模板清单：构图数据只在服务端存一份，前端画缩略图和叠加框都用它 */
  stitchTemplates: () =>
    request<{ templates: StitchTemplate[]; layouts: { id: string; name: string; hint: string }[] }>(
      '/api/export/stitch/templates'
    ),
  /* 自动构图：显著度检测给出的每格焦点/缩放，返回后可继续手调 */
  stitchAutoCrops: (ids: number[], template: string) =>
    request<{ crops: StitchCrop[] }>(
      `/api/export/stitch/crops?ids=${ids.join(',')}&template=${encodeURIComponent(template)}`
    ),

  /* ------------------------------ 人脸识别 ------------------------------ */
  faceStatus: () => request<FaceStatus>('/api/face/status'),
  faceInstall: () => request<FaceStatus & { ok: boolean; started: boolean }>('/api/face/install', { method: 'POST' }),
  faceInstallCancel: () => request<{ ok: boolean }>('/api/face/install/cancel', { method: 'POST' }),
  faceScan: (opts: { limit?: number; force?: boolean; minCos?: number } = {}) =>
    request<FaceStatus & { ok: boolean }>('/api/face/scan', { method: 'POST', body: JSON.stringify(opts) }),
  faceScanCancel: () => request<{ ok: boolean }>('/api/face/scan/cancel', { method: 'POST' }),
  facePersons: (opts: { limit?: number; offset?: number; minCount?: number; q?: string; all?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.offset) q.set('offset', String(opts.offset));
    if (opts.minCount) q.set('minCount', String(opts.minCount));
    if (opts.q) q.set('q', opts.q);
    if (opts.all) q.set('all', '1');
    const qs = q.toString();
    // total = 当前筛选下的人物数（不受 limit 影响），allTotal = 不筛封面质量时的总数
    return request<{ persons: FacePerson[]; total: number; allTotal: number }>(
      `/api/face/persons${qs ? `?${qs}` : ''}`
    );
  },
  /** 某个人的图（直接给 DTO，灯箱/网格都能直接用） */
  facePersonItems: (id: number, opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.offset) q.set('offset', String(opts.offset));
    const qs = q.toString();
    // total = 这个人的去重图片总数（不受 limit 影响）
    return request<{ items: ImageItem[]; total: number }>(`/api/face/persons/${id}/items${qs ? `?${qs}` : ''}`);
  },
  /** 单个人物（灯箱里点人名跳人物页时用，不必整页拉列表再 find） */
  facePerson: (id: number) => request<FacePerson>(`/api/face/persons/${id}`),
  /** 全网以图搜图引擎清单 + 国际网络体检（refresh 强制重新探测，忽略 60s 缓存） */
  reverseEngines: (refresh = false) =>
    request<{ ok: boolean; engines: ReverseEngine[]; network: ReverseNetwork }>(
      `/api/reverse/engines${refresh ? '?refresh=1' : ''}`
    ),
  /**
   * 多引擎并发搜图：给 imageId，或给 personId 让服务端挑「最清晰最完整」的那张。
   * 注意与上面的 reverseSearch(id, engine) 区分：那个是「素材来源」单渠道检索。
   */
  reverseSearchAll: (body: { imageId?: number; personId?: number; engines: string[] }) =>
    request<ReverseSearchResponse>('/api/reverse/search', { method: 'POST', body: JSON.stringify(body) }),
  faceRename: (id: number, name: string) =>
    request<{ ok: boolean; id: number; name: string }>(`/api/face/persons/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  /** 手动指定人物封面：传那张照片的 imageId，服务端取该照片里属于这个人的脸 */
  facePersonCover: (id: number, imageId: number) =>
    request<{ ok: boolean; id: number; coverFaceId: number; coverImageId: number; coverPx: number }>(
      `/api/face/persons/${id}/cover`,
      { method: 'POST', body: JSON.stringify({ imageId }) }
    ),
  faceDeletePerson: (id: number) =>
    request<{ ok: boolean; removedFaces: number }>(`/api/face/persons/${id}`, { method: 'DELETE' }),
  faceMerge: (fromId: number, toId: number) =>
    request<{ ok: boolean; moved: number }>('/api/face/persons/merge', {
      method: 'POST',
      body: JSON.stringify({ fromId, toId }),
    }),
  /** 这张图里有谁（灯箱侧栏用）；hidden=低质量被自动排除，可手动收录 */
  imageFaces: (imageId: number) =>
    request<{
      faces: {
        id: number;
        personId: number | null;
        name: string;
        box: number[];
        score: number;
        quality: number;
        hidden: boolean;
        /** 质量偏低：仍显示、计入人物，但不当封面／不建新人物 */
        soft: boolean;
      }[];
    }>(`/api/images/${imageId}/faces`),
  /** 存量质量重算 + 重选封面（后台任务，进度走 faceStatus 轮询） */
  faceQualityCleanup: () => request<FaceStatus & { ok: boolean; busy?: boolean }>('/api/face/quality/cleanup', { method: 'POST' }),
  faceQualityCancel: () => request<{ ok: boolean }>('/api/face/quality/cancel', { method: 'POST' }),
  /** 用已有特征重建人物分组（清掉「一堆后脑勺凑成一个人」），进度走 faceStatus 轮询 */
  faceRebuild: () => request<FaceStatus & { ok: boolean }>('/api/face/rebuild', { method: 'POST' }),
  faceRebuildCancel: () => request<{ ok: boolean }>('/api/face/rebuild/cancel', { method: 'POST' }),
  /** 手动保留（hidden=false）/ 重新排除（hidden=true）一张低质量脸 */
  faceSetHidden: (faceId: number, hidden: boolean) =>
    request<{ ok: boolean; id: number; hidden: boolean }>(`/api/face/faces/${faceId}/hidden`, {
      method: 'POST',
      body: JSON.stringify({ hidden }),
    }),
  faceDelete: (faceId: number) => request<{ ok: boolean }>(`/api/face/faces/${faceId}`, { method: 'DELETE' }),
  faceAssign: (faceId: number, personId: number | null) =>
    request<{ ok: boolean; personId: number }>(`/api/face/faces/${faceId}/person`, {
      method: 'POST',
      body: JSON.stringify({ personId }),
    }),
  faceReset: () => request<{ ok: boolean }>('/api/face/reset', { method: 'POST' }),
};
