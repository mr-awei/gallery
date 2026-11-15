/**
 * 整理：相似图 / 缩略图 / 库健康 / 维护
 * 由 api.ts 组合成单一的 `api` 对象对外暴露（调用点不需要改 import）。
 */
import { BASE, getApiToken, request } from './core';
import type { AnnotationItem, DupeGroup, ImageComment, TagNode, Filters, ImageItem, SimilarGroups } from '../types';

export const curateAPI = {
  // 整理：相似图审查 / 主色补算 / AI 打标
  tidyStats: () =>
    request<{ total: number; noDominant: number; noAiDesc: number; noRating: number; rated: number; noObjHash: number }>(
      '/api/tidy/stats'
    ),
  /** ids 为扫描范围（当前筛选结果 / 选区），省略即全库 */
  similar: (threshold?: number, ids?: number[]) => {
    const q = new URLSearchParams();
    if (threshold) q.set('threshold', String(threshold));
    if (ids?.length) q.set('ids', ids.join(','));
    const qs = q.toString();
    return request<SimilarGroups>(`/api/similar${qs ? `?${qs}` : ''}`);
  },
  similarClip: (minCos?: number, ids?: number[]) => {
    const q = new URLSearchParams();
    if (minCos) q.set('minCos', String(minCos));
    if (ids?.length) q.set('ids', ids.join(','));
    const qs = q.toString();
    return request<SimilarGroups>(`/api/similar/clip${qs ? `?${qs}` : ''}`);
  },
  clipStatus: () =>
    request<{ running: boolean; done: number; total: number; error: string; indexed: number; model: string; loadError: string }>(
      '/api/clip/status'
    ),
  clipBackfill: () => request<{ ok: boolean; total?: number; message?: string }>('/api/clip/backfill', { method: 'POST' }),
  formatDupes: (ids?: number[]) =>
    request<SimilarGroups>(`/api/dupes/format${ids?.length ? `?ids=${ids.join(',')}` : ''}`),
  resolveSimilar: (keepId: number, removeIds: number[]) =>
    request<{ ok: boolean; removed: number; failures: { id: number; error: string }[] }>(
      '/api/similar/resolve',
      { method: 'POST', body: JSON.stringify({ keepId, removeIds }) }
    ),
  tidySkipList: () => request<{ ids: number[] }>('/api/tidy/skip'),
  tidySkipAdd: (id: number) =>
    request<{ ok: boolean; ids: number[] }>('/api/tidy/skip', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  tidySkipReset: () =>
    request<{ ok: boolean; ids: number[] }>('/api/tidy/skip/reset', { method: 'POST' }),
  backfillDominant: (limit = 300) =>
    request<{ ok: boolean; done: number; remain: number }>('/api/maintenance/dominant', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  backfillSubject: (limit = 300) =>
    request<{ ok: boolean; done: number; remain: number; skipped: number }>('/api/maintenance/subject', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  // 导入任务：上次导到哪、是否被中断；续传 = 重跑增量扫描（未变文件自动跳过）
  importJob: () =>
    request<{
      ok: boolean;
      running: boolean;
      job: {
        status: 'running' | 'interrupted' | 'done' | 'cancelled' | 'failed';
        startedAt?: string;
        finishedAt?: string;
        saved?: number;
        total?: number;
        errors?: number;
        duplicate?: number;
        syncConflicts?: number;
        error?: string;
      } | null;
    }>('/api/import/job'),
  resumeImport: () =>
    request<{ ok: boolean; saved?: number; total?: number; errors?: number; duplicate?: number }>(
      '/api/import/resume',
      { method: 'POST', body: '{}' }
    ),

  /**
   * Playground 专用：原样返回状态码与文本，不做 JSON 解析、不抛业务错误。
   * 调试页要看到「后端真正回了什么」，而不是被 api 层翻译后的结果。
   */
  playground: async (method: string, path: string, body?: string) => {
    const token = await getApiToken();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body && method !== 'GET' ? body : undefined,
    });
    const text = await res.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* 不是 JSON 就原样显示 */
    }
    return { status: res.status, text: pretty };
  },

  // 缩略图后台队列：看得见待生成 / 进行中 / 失败原因，并能一键重试
  thumbQueueStatus: () =>
    request<{
      ok: boolean;
      pending: number;
      running: number;
      syncRunning: number;
      failed: number;
      lastError: string;
      missing: number;
      failures: { id: number; reason: string; at: string }[];
    }>('/api/thumbs/status'),
  /** 不传 id = 重试全部失败项；传 id = 只重试这一张 */
  retryThumbs: (id?: number) =>
    request<{ ok: boolean; requested: number; queued: number }>('/api/thumbs/retry', {
      method: 'POST',
      body: JSON.stringify(id ? { id } : {}),
    }),
  // 清空缩略图失败明细（批量重试救不回的，清掉以免列表越堆越长）
  clearThumbFailures: () =>
    request<{ ok: boolean }>('/api/thumbs/failures/clear', { method: 'POST', body: '{}' }),

  // 库健康：路径唯一索引是否真的建起来了 + 删除是否留下孤儿关联
  libraryHealth: () =>
    request<{
      ok: boolean;
      pathIndex: { ok: boolean; duplicates: number; error: string };
      /** 孤儿行统计，与清理接口共用同一套规则（lib/integrity.js） */
      orphans: { total: number; byTable: { table: string; column: string; note: string; count: number }[] };
      warnings: string[];
    }>('/api/maintenance/health'),
  rebuildPathIndex: () =>
    request<{ ok: boolean; duplicates: number; error: string }>('/api/maintenance/path-index', { method: 'POST' }),
  // 维护工具：库体检 / 重建缩略图 / 清理孤儿缩略图 / 压缩数据库 / 重新扫描
  maintenanceStatus: () =>
    request<{
      total: number;
      withThumb: number;
      missing: number;
      thumbFiles: number;
      thumbBytes: number;
      dbPath: string;
      dbBytes: number;
      undoCount: number;
      sampleMissing: { id: number; path: string }[];
    }>('/api/maintenance/status'),
  maintenanceRebuildThumbs: (limit = 300, beforeId = 0) =>
    request<{ ok: boolean; rebuilt: number; skipped: number; failed: number; nextBeforeId: number }>(
      '/api/maintenance/rebuild-thumbs',
      { method: 'POST', body: JSON.stringify({ limit, beforeId }) }
    ),
  /** 修正 EXIF 方向：宽高换算成屏幕方向 + 清掉躺倒的 RAW/设计稿缩略图（等后台重出） */
  maintenanceFixOrientation: (limit = 300, beforeId = 0) =>
    request<{
      ok: boolean;
      rotated: number;
      dims: number;
      cleared: number;
      failed: number;
      nextBeforeId: number;
    }>('/api/maintenance/fix-orientation', { method: 'POST', body: JSON.stringify({ limit, beforeId }) }),
  /** 后台补齐所有缺缩略图的记录（旧库合并 / 上次导入被打断后的自愈） */
  maintenanceRebuildMissing: () =>
    request<{ ok: boolean; started: boolean; total?: number; reason?: string }>('/api/maintenance/rebuild-missing', {
      method: 'POST',
    }),
  maintenanceOrphanThumbs: (dryRun = true) =>
    request<{ ok: boolean; dryRun: boolean; found: number; removed: number; errors: string[]; sample: string[]; message?: string }>(
      '/api/maintenance/orphan-thumbs',
      { method: 'POST', body: JSON.stringify({ dryRun }) }
    ),

  /** 幽灵文件夹：磁盘已不存在、子树无任何素材的残留夹（侧栏「另一个库的文件夹」多为此） */
  maintenanceGhostFolders: (dryRun = true) =>
    request<{
      ok: boolean;
      dryRun: boolean;
      deleted: number;
      candidates: { id: number; name: string; path: string; anchor: string }[];
    }>('/api/maintenance/ghost-folders', { method: 'POST', body: JSON.stringify({ dryRun }) }),
  /** 关联表孤儿行对账（库里没有外键，异常退出会留下指向已删图片的行） */
  maintenanceOrphans: () =>
    request<{
      total: number;
      byTable: { table: string; column: string; parent: string; note: string; count: number }[];
    }>('/api/maintenance/orphans'),
  maintenanceCleanOrphans: (dryRun = true) =>
    request<{
      ok: boolean;
      dryRun: boolean;
      total: number;
      removed: number;
      /** 清理后重新扫描的结果（证明真的归零，而不是写死 0） */
      after: { total: number };
      byTable: { table: string; column: string; note: string; count: number }[];
    }>('/api/maintenance/orphans/clean', { method: 'POST', body: JSON.stringify({ dryRun }) }),
  /** 地图视图：按经纬度聚合出的地点（precision 为小数点后位数，默认 1） */
  geoPoints: (precision = 1) =>
    request<{ ok: boolean; precision: number; total: number; points: { lat: number; lon: number; n: number; coverId: number }[] }>(
      `/api/maintenance/geo-points?precision=${precision}`
    ),
  /** 补算历史素材的 GPS（老库导入时没有落经纬度列） */
  maintenanceGpsBackfill: (limit = 200) =>
    request<{ ok: boolean; scanned: number; found: number; remain: number }>('/api/maintenance/gps-backfill', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  /** 从 XMP sidecar 拉回元数据（用 Lightroom / digiKam 改完标签再拷回来时用） */
  maintenanceXmpImport: (limit = 500, beforeId = 0) =>
    request<{ ok: boolean; scanned: number; updated: number; nextBeforeId: number }>('/api/maintenance/xmp-import', {
      method: 'POST',
      body: JSON.stringify({ limit, beforeId }),
    }),
  maintenanceVacuum: () =>
    request<{ ok: boolean; integrity: string; before: number; after: number; saved: number }>(
      '/api/maintenance/vacuum',
      { method: 'POST' }
    ),
  maintenanceRescan: () =>
    request<{ ok: boolean; message?: string; saved?: number }>('/api/maintenance/rescan', { method: 'POST' }),
  maintenanceProbeMedia: (limit = 200) =>
    request<{ ok: boolean; probed: number; skipped: number; remain: number }>(
      '/api/maintenance/probe-media',
      { method: 'POST', body: JSON.stringify({ limit }) }
    ),
  // 撤销覆盖写回（裁切/旋转/调色/增强）：可连续撤销，撤掉的步骤还能重做
  lastUndo: (imageId?: number) =>
    request<{
      last: { id: number; imageId: number; kind: string; createdAt: string } | null;
      /** 还能撤销的步数 */
      canUndo: number;
      /** 还能重做的步数 */
      canRedo: number;
    }>(`/api/undo/last${imageId ? `?imageId=${imageId}` : ''}`),
  undo: (imageId?: number) =>
    request<{ item: ImageItem | null; kind: string; canUndo: number; canRedo: number }>('/api/undo', {
      method: 'POST',
      body: JSON.stringify({ imageId }),
    }),
  redo: (imageId?: number) =>
    request<{ item: ImageItem | null; kind: string; canUndo: number; canRedo: number }>('/api/undo/redo', {
      method: 'POST',
      body: JSON.stringify({ imageId }),
    }),
  canUndo: (id: number) => request<{ canUndo: boolean; canRedo: number }>(`/api/images/${id}/undo`),
  /**
   * 本地零样本打标（CLIP 文本塔 × 图像向量）：不配 AI 供应商、断网可用。
   * force=true 才真写库；默认只回「会打什么标签」。
   */
  localTagBatch: (opts: { limit?: number; top?: number; minCos?: number } = {}) =>
    request<{
      ok: boolean;
      error?: string;
      done: number;
      added: number;
      remain: number;
      samples?: { id: number; tags: string[] }[];
      dryRun?: boolean;
    }>('/api/ai/local-tags', { method: 'POST', body: JSON.stringify({ ...opts, dryRun: false }) }),
  /** 预演：只看会打成什么，不写库 */
  localTagPreview: (opts: { limit?: number; top?: number; minCos?: number } = {}) =>
    request<{
      ok: boolean;
      error?: string;
      done: number;
      added: number;
      remain: number;
      samples?: { id: number; tags: string[] }[];
    }>('/api/ai/local-tags', { method: 'POST', body: JSON.stringify({ ...opts, dryRun: true }) }),
  aiTagBatch: (limit = 6) =>
    request<{ ok: boolean; done: number; remain: number; results: { id: number; ok: boolean; error?: string }[] }>(
      '/api/ai/tag-batch',
      { method: 'POST', body: JSON.stringify({ limit }) }
    ),
  aiDesc: (id: number) =>
    request<{ imageId?: number; description?: string; issues?: string[]; quality?: number }>(`/api/images/${id}/ai`),
  analyzeImage: (id: number) =>
    request<{ ok: boolean; description: string; issues: string[]; quality: number }>(`/api/images/${id}/ai`, {
      method: 'POST',
    }),
  remove: (id: number) => request<{ ok: boolean }>(`/api/images/${id}`, { method: 'DELETE' }),
  markViewed: (id: number) =>
    request<{ ok: boolean; item: ImageItem }>(`/api/images/${id}/viewed`, { method: 'POST' }),
  /** 把当前筛选结果整体标记为已看 */
  markAllViewed: (filters: Filters) =>
    request<{ ok: boolean; affected: number }>('/api/images/viewed-all', {
      method: 'POST',
      body: JSON.stringify(filters),
    }),
  batch: (ids: number[], action: string, tag?: string) =>
    request<{ ok: boolean; affected: number }>('/api/images/batch', {
      method: 'POST',
      body: JSON.stringify({ ids, action, tag }),
    }),
  // 标签树：count + 分组 / 颜色 / 父标签（Eagle 的标签体系）
  tags: (opts?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.offset) qs.set('offset', String(opts.offset));
    const s = qs.toString();
    return request<{
      tags: TagNode[];
      groups: string[];
      total?: number;
      limit?: number;
      offset?: number;
    }>(`/api/tags${s ? `?${s}` : ''}`);
  },
  tagMeta: (payload: { tag: string; group?: string; color?: string; parent?: string; sortOrder?: number }) =>
    request<{ ok: boolean; meta: TagNode | null; tags: TagNode[]; groups: string[] }>('/api/tags/meta', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  reorderTags: (tags: string[]) =>
    request<{ ok: boolean; tags: TagNode[]; groups: string[] }>('/api/tags/reorder', {
      method: 'POST',
      body: JSON.stringify({ tags }),
    }),
  renameTagGroup: (from: string, to: string) =>
    request<{ ok: boolean; groups: string[]; tags: TagNode[] }>('/api/tags/group/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  deleteTagGroup: (name: string) =>
    request<{ ok: boolean; groups: string[]; tags: TagNode[] }>('/api/tags/group/delete', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  moveTag: (tag: string, parent: string) =>
    request<{ ok: boolean; tags: TagNode[]; groups: string[] }>('/api/tags/move', {
      method: 'POST',
      body: JSON.stringify({ tag, parent }),
    }),

  /* ---------------------- 标注 / 评论（Eagle Annotations） ---------------------- */
  annotations: (id: number) =>
    request<{ ok: boolean; items: AnnotationItem[]; updatedAt: string }>(`/api/images/${id}/annotations`),
  saveAnnotations: (id: number, items: AnnotationItem[]) =>
    request<{ ok: boolean; items: AnnotationItem[]; updatedAt: string }>(`/api/images/${id}/annotations`, {
      method: 'PUT',
      body: JSON.stringify({ items }),
    }),
  annotationCounts: () => request<{ ok: boolean; counts: Record<string, number> }>('/api/annotations/counts'),
  comments: (id: number) => request<{ ok: boolean; comments: ImageComment[] }>(`/api/images/${id}/comments`),
  addComment: (id: number, body: string, author = '') =>
    request<{ ok: boolean; comment: ImageComment }>(`/api/images/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, author }),
    }),
  deleteComment: (id: number) => request<{ ok: boolean }>(`/api/comments/${id}`, { method: 'DELETE' }),

  /* ------------------------------- 待整理视图 ------------------------------- */
  pending: () => request<{ total: number; noFolder: number; noTags: number; noRating: number }>('/api/organize/pending'),

  /* ------------------------- 完全重复（MD5，与 pHash 互补） ------------------------- */
  md5Dupes: () => request<{ ok: boolean; groups: DupeGroup[]; reclaim: number; missing: number }>('/api/dupes/md5'),
  md5Backfill: (limit = 400) =>
    request<{ ok: boolean; done: number; remaining: number }>('/api/dupes/md5/backfill', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  resolveDupes: (keepId: number, ids: number[]) =>
    request<{ ok: boolean; removed: number; failed?: { id: number; error: string }[]; keepId: number }>(
      '/api/dupes/md5/resolve',
      { method: 'POST', body: JSON.stringify({ keepId, ids }) }
    ),

  /* ------------------------------ 批量重命名 ------------------------------ */
  renameBatch: (
    ids: number[],
    template: string,
    start = 1,
    opts: { pad?: number; find?: string; replace?: string; caseMode?: string } = {}
  ) =>
    request<{
      ok: boolean;
      renamed: number;
      failed: number;
      results: Array<{ id: number; ok: boolean; title?: string; error?: string }>;
    }>('/api/images/rename-batch', {
      method: 'POST',
      body: JSON.stringify({ ids, template, start, ...opts }),
    }),

  /* --------------------------- 音视频元数据 / 封面 --------------------------- */
  patchMedia: (
    id: number,
    patch: { duration?: number; width?: number; height?: number; coverTs?: number; trimStart?: number; trimEnd?: number }
  ) =>
    request<{ ok: boolean; image: ImageItem }>(`/api/images/${id}/media`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  setCover: (id: number, dataUrl: string, ts?: number) =>
    request<{ ok: boolean; image: ImageItem }>(`/api/images/${id}/cover`, {
      method: 'POST',
      body: JSON.stringify({ dataUrl, ts }),
    }),
  resetCover: (id: number) =>
    request<{ ok: boolean; image: ImageItem }>(`/api/images/${id}/cover`, { method: 'DELETE' }),

  /* --------------------------- 拖拽 / 粘贴入库 --------------------------- */
  uploadFile: async (file: File, opts: { tags?: string; keyword?: string } = {}) => {
    const q = new URLSearchParams({ filename: file.name });
    if (opts.tags) q.set('tags', opts.tags);
    if (opts.keyword) q.set('keyword', opts.keyword);
    // 大文件（视频）用长超时；写操作不自动重试
    return request<{ ok: boolean; image: ImageItem }>(`/api/import/upload?${q.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
      timeoutMs: 300000,
      retries: 0,
    });
  },
};
