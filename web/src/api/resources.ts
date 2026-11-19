/**
 * 资源库 / 文件夹 / 素材列表
 * 由 api.ts 组合成单一的 `api` 对象对外暴露（调用点不需要改 import）。
 */
import { request, buildQuery } from './core';
import type { TagNode, ModelsPayload, Filters, FolderNode, ImageItem, ImageNote, SavedFilter, Library, Stats, TimelineDay, TimelineSummary, RuntimeComponent, RuntimeProbe } from '../types';

export const resourcesAPI = {
  stats: () => request<Stats>('/api/stats'),
  /** 时间线：月份索引 + 总量 + 待重建数量 */
  timelineSummary: () => request<TimelineSummary>('/api/timeline/summary'),
  /** 时间线：某月的日期索引（每天几张，每月最多 31 条） */
  timelineDays: (month: string) =>
    request<{ month: string; total: number; days: TimelineDay[] }>(
      `/api/timeline/days?month=${encodeURIComponent(month)}`
    ),
  /** 时间线：某天的图片（按拍摄时间倒序分页） */
  timelineDay: (day: string, offset = 0, limit = 120) =>
    request<{ day?: string; month: string; total: number; limit: number; offset: number; items: ImageItem[] }>(
      `/api/timeline?day=${encodeURIComponent(day)}&offset=${offset}&limit=${limit}`
    ),
  /** 按 EXIF 重建拍摄时间（后台任务） */
  timelineBackfill: () =>
    request<{ ok: boolean; jobId: number; already?: boolean }>('/api/timeline/backfill', { method: 'POST' }),
  cancelTimelineBackfill: () =>
    request<{ ok: boolean }>('/api/timeline/backfill/cancel', { method: 'POST' }),
  /** 按 id 批量取素材（无限画布恢复布局）：顺序与入参一致，已删除的 id 会被跳过 */
  imagesByIds: (ids: number[], opts?: { signal?: AbortSignal }) =>
    request<{ items: ImageItem[] }>(`/api/images/by-ids?ids=${ids.join(',')}`, { signal: opts?.signal }),
  images: (filters: Filters, page: number, pageSize: number, opts?: { signal?: AbortSignal }) =>
    request<{ items: ImageItem[]; total: number; page: number; pageSize: number; hasMore: boolean }>(
      `/api/images?${buildQuery(filters, page, pageSize)}`, opts
    ),
  /** 当前筛选条件下的全部 id（全选）：不翻页、不返回 DTO。
   *  文件夹视图必须带上 folderId，否则 Ctrl+A 会选中全库（跨文件夹批量操作）。 */
  imageIds: (filters: Filters, opts?: { signal?: AbortSignal; folderId?: number | null }) =>
    request<{ ids: number[]; total: number; truncated?: boolean }>(
      `/api/images/ids?${buildQuery(filters, 1, 1)}${opts?.folderId ? `&folderId=${opts.folderId}` : ''}`,
      { signal: opts?.signal }
    ),
  // 资源库（多资源库）
  libraries: () => request<{ libraries: Library[]; activeId: number | null }>('/api/libraries'),
  createLibrary: (payload: { name: string; rootPath?: string; libFolder?: string }) =>
    request<{ ok: boolean; id: number }>('/api/libraries', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  /** 切换到某个库；加密库必须带 password（缺密码/密码错 → 423，不会切过去） */
  activateLibrary: (id: number, password?: string) =>
    request<{ ok: boolean; library: Library }>(`/api/libraries/${id}/activate`, {
      method: 'POST',
      body: password ? JSON.stringify({ password }) : undefined,
    }),
  /** 解锁当前库（本次会话有效） */
  unlockLibrary: (id: number, password: string) =>
    request<{ ok: boolean; hasPassword: boolean; locked: boolean }>(`/api/libraries/${id}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  /** 立即上锁（不改密码） */
  lockLibrary: (id: number) =>
    request<{ ok: boolean; hasPassword: boolean; locked: boolean }>(`/api/libraries/${id}/lock`, { method: 'POST' }),
  /** 设置 / 修改库密码（已有密码必须带 oldPassword） */
  setLibraryPassword: (id: number, password: string, oldPassword = '') =>
    request<{ ok: boolean; hasPassword: boolean; locked: boolean }>(`/api/libraries/${id}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password, oldPassword }),
    }),
  /** 移除库密码（必须验证原密码） */
  clearLibraryPassword: (id: number, password: string) =>
    request<{ ok: boolean; hasPassword: boolean; locked: boolean }>(`/api/libraries/${id}/password`, {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    }),
  deleteLibrary: (id: number) =>
    request<{ ok: boolean; libraries: Library[]; activeId: number | null }>(`/api/libraries/${id}`, {
      method: 'DELETE',
    }),
  // 文件夹树（多层级文件夹）
  folders: () => request<{ folders: FolderNode[] }>('/api/folders'),
  folderImages: (id: number, page: number, pageSize: number, opts?: { signal?: AbortSignal }) =>
    request<{ items: ImageItem[]; total: number; hasMore: boolean }>(
      `/api/folders/${id}/images?page=${page}&pageSize=${pageSize}`, opts
    ),
  createFolder: (name: string, parentId?: number | null) =>
    request<{ ok: boolean; id: number; folders: FolderNode[] }>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    }),
  renameFolder: (id: number, name: string) =>
    request<{ ok: boolean; folders: FolderNode[] }>(`/api/folders/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  deleteFolder: (id: number) =>
    request<{ ok: boolean; removed: number; folders: FolderNode[] }>(`/api/folders/${id}`, {
      method: 'DELETE',
    }),
  addToFolder: (id: number, imageIds: number[]) =>
    request<{ ok: boolean; added: number; folders: FolderNode[] }>(`/api/folders/${id}/images`, {
      method: 'POST',
      body: JSON.stringify({ imageIds }),
    }),
  /** 设置文件夹封面；imageId 省略 = 恢复自动封面 */
  setFolderCover: (id: number, imageId?: number | null) =>
    request<{ ok: boolean; coverImageId: number | null; folders: FolderNode[] }>(`/api/folders/${id}/cover`, {
      method: 'PUT',
      body: JSON.stringify({ imageId: imageId ?? null }),
    }),
  /** 文件夹标签（夹内素材搜索时自动继承） */
  setFolderTags: (id: number, tags: string[]) =>
    request<{ ok: boolean; tags: string[]; folders: FolderNode[] }>(`/api/folders/${id}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tags }),
    }),

  /** 文件夹内手动排序：传拖动后的完整顺序 */
  reorderFolder: (id: number, imageIds: number[]) =>
    request<{ ok: boolean; folderId: number; updated: number }>(`/api/folders/${id}/order`, {
      method: 'PUT',
      body: JSON.stringify({ imageIds }),
    }),

  /** 文件夹外观：emoji / 图标字符 + 主题色（空串 = 清除） */
  setFolderAppearance: (id: number, appearance: { icon?: string; color?: string }) =>
    request<{ ok: boolean; icon?: string; color?: string; folders: FolderNode[] }>(
      `/api/folders/${id}/appearance`,
      { method: 'PUT', body: JSON.stringify(appearance) }
    ),

  /** 文件夹拖拽排序：同一父级下的完整顺序 */
  reorderFolders: (parentId: number | null, folderIds: number[]) =>
    request<{ ok: boolean; parentId: number | null; updated: number; folders: FolderNode[] }>(
      '/api/folders/reorder',
      { method: 'POST', body: JSON.stringify({ parentId, folderIds }) }
    ),

  /** 批量创建文件夹：一行/逗号一个名字，同父级下同名跳过 */
  createFoldersBatch: (names: string[], parentId?: number | null) =>
    request<{ ok: boolean; created: string[]; skipped: string[]; folders: FolderNode[] }>('/api/folders/batch', {
      method: 'POST',
      body: JSON.stringify({ names, parentId: parentId ?? null }),
    }),

  /** 批量创建标签（可同时归入一个分组） */
  createTagsBatch: (names: string[], group?: string) =>
    request<{ ok: boolean; created: string[]; tags: TagNode[]; groups: string[] }>('/api/tags/batch', {
      method: 'POST',
      body: JSON.stringify({ names, group }),
    }),

  /* ---------------------------- 图片堆叠（Stack） ---------------------------- */

  /** 把选中的素材合成一个堆叠（组主 = 评分最高的一张） */
  createStack: (imageIds: number[]) =>
    request<{ ok: boolean; stackId: number; ids: number[]; stacks: ImageItem[] }>('/api/stacks', {
      method: 'POST',
      body: JSON.stringify({ imageIds }),
    }),
  stackMembers: (id: number) =>
    request<{ ok: boolean; stackId: number; items: ImageItem[] }>(`/api/stacks/${id}`),
  /** 现有堆叠列表（并入其他堆叠时选目标） */
  stacksList: () =>
    request<{ ok: boolean; stacks: { stackId: number; title: string; count: number; thumbUrl: string }[] }>(
      '/api/stacks'
    ),
  /** 把 :id 这一组整体并入 intoId 那一组 */
  mergeStacks: (id: number, intoId: number) =>
    request<{ ok: boolean; stackId: number; added: number; stacks: ImageItem[] }>(`/api/stacks/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ intoId }),
    }),
  addToStack: (id: number, imageIds: number[]) =>
    request<{ ok: boolean; stackId: number; added: number; stacks: ImageItem[] }>(`/api/stacks/${id}/add`, {
      method: 'POST',
      body: JSON.stringify({ imageIds }),
    }),
  /** 指定堆叠封面（不按评分，用户点谁就是谁） */
  setStackPrimary: (id: number, imageId: number) =>
    request<{ ok: boolean; stackId: number; stacks: ImageItem[] }>(`/api/stacks/${id}/primary`, {
      method: 'POST',
      body: JSON.stringify({ imageId }),
    }),
  ungroupStack: (id: number) =>
    request<{ ok: boolean; removed: number }>(`/api/stacks/${id}`, { method: 'DELETE' }),
  removeFromStack: (id: number) =>
    request<{ ok: boolean; stackId: number; removed: number; image: ImageItem }>(`/api/images/${id}/stack`, {
      method: 'DELETE',
    }),

  /* ------------------------------- 下载中心 ------------------------------- */

  /** 全量模型清单（含体积、状态、分组汇总） */
  listModels: () => request<ModelsPayload>('/api/models'),
  /** 「下载全部」的排队状态与待下数量（服务端排队，一次只下一个） */
  installAllModelsStatus: () =>
    request<{ ok: boolean; running: boolean; jobId: number; pending: number }>('/api/models/install-all'),
  installAllModels: () =>
    request<{ ok: boolean; started?: boolean; already?: boolean; jobId?: number; total?: number; error?: string }>(
      '/api/models/install-all',
      { method: 'POST' }
    ),
  cancelInstallAllModels: () => request<{ ok: boolean }>('/api/models/install-all/cancel', { method: 'POST' }),
  installModel: (id: string) =>
    request<{ ok: boolean; started?: boolean; error?: string; message?: string }>(
      `/api/models/${encodeURIComponent(id)}/install`,
      { method: 'POST' }
    ),
  cancelModelDownload: (id: string) =>
    request<{ ok: boolean; error?: string }>(`/api/models/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  removeModel: (id: string) =>
    request<{ ok: boolean; error?: string } & ModelsPayload>(`/api/models/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  verifyModel: (id: string) =>
    request<{ ok: boolean; verified?: boolean; size?: number; message?: string; error?: string }>(
      `/api/models/${encodeURIComponent(id)}/verify`,
      { method: 'POST' }
    ),

  /* ------------------------------- 运行环境 ------------------------------- */

  /** 检测当前机器的运行时（VC++ / onnxruntime / sharp） */
  listRuntime: () =>
    request<{
      ok: boolean;
      supported: boolean;
      platform: string;
      components: RuntimeComponent[];
      probes: RuntimeProbe[];
      summary: { total: number; installed: number; missing: number; criticalMissing: number };
      state: Record<string, { status: string; progress: number; message: string; error: string; needsReboot: boolean }>;
    }>('/api/runtime'),
  /** 下载某个组件的安装器（后台异步，状态走 listRuntime 返回的 state） */
  downloadRuntime: (id: string) =>
    request<{ ok: boolean; started: boolean }>(`/api/runtime/${encodeURIComponent(id)}/download`, {
      method: 'POST',
    }),
  /** 静默下载 + 执行安装；安装完成后返回 needsReboot 提示 */
  installRuntime: (id: string) =>
    request<{ ok: boolean; needsReboot?: boolean; error?: string }>(`/api/runtime/${encodeURIComponent(id)}/install`, {
      method: 'POST',
    }),

  /* ------------------------------- 素材笔记 ------------------------------- */

  imageNotes: (id: number) => request<{ ok: boolean; notes: ImageNote[] }>(`/api/images/${id}/notes`),
  /** ts > 0 = 钉在音视频的某个时间点（秒） */
  addImageNote: (id: number, body: string, ts = 0) =>
    request<{ ok: boolean; note: ImageNote }>(`/api/images/${id}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body, ts }),
    }),
  deleteImageNote: (noteId: number) =>
    request<{ ok: boolean; removed: number }>(`/api/notes/${noteId}`, { method: 'DELETE' }),

  /* ------------------------------ 保存的筛选器 ------------------------------ */

  savedFilters: () => request<{ ok: boolean; filters: SavedFilter[] }>('/api/saved-filters'),
  createSavedFilter: (name: string, query: Record<string, unknown>, icon = '') =>
    request<{ ok: boolean; id: number; filters: SavedFilter[] }>('/api/saved-filters', {
      method: 'POST',
      body: JSON.stringify({ name, query, icon }),
    }),
  updateSavedFilter: (id: number, patch: { name?: string; query?: Record<string, unknown>; icon?: string }) =>
    request<{ ok: boolean; filters: SavedFilter[] }>(`/api/saved-filters/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteSavedFilter: (id: number) =>
    request<{ ok: boolean; removed: number; filters: SavedFilter[] }>(`/api/saved-filters/${id}`, {
      method: 'DELETE',
    }),
  reorderSavedFilters: (ids: number[]) =>
    request<{ ok: boolean; filters: SavedFilter[] }>('/api/saved-filters/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  /* -------------------------------- 使用统计 -------------------------------- */

  /** 记一次使用：kind = copy（复制）/ export（导出、下载） */
  bumpUsage: (kind: 'copy' | 'export', ids: number[]) =>
    request<{ ok: boolean; updated: number }>('/api/images/usage', {
      method: 'POST',
      body: JSON.stringify({ kind, ids }),
    }),
  usageStats: () =>
    request<{
      ok: boolean;
      items: { id: number; title: string; copyCount: number; exportCount: number; lastUsedAt: string; thumbUrl: string }[];
      totals: { copies: number | null; exports: number | null };
    }>('/api/usage/stats'),

  /* ---------------- 隐私空间：文件夹密码锁 ---------------- */

  /** 给文件夹加/改密码；已有密码时必须带 oldPassword */
  setFolderPassword: (id: number, password: string, oldPassword = '') =>
    request<{ ok: boolean; id: number; locked: boolean; unlocked: boolean; folders: FolderNode[] }>(
      `/api/folders/${id}/password`,
      { method: 'PUT', body: JSON.stringify({ password, oldPassword }) }
    ),

  /** 移除密码（需旧密码） */
  clearFolderPassword: (id: number, password: string) =>
    request<{ ok: boolean; folders: FolderNode[] }>(`/api/folders/${id}/password`, {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    }),

  /** 本次会话解锁（重启自动回到锁定态） */
  unlockFolder: (id: number, password: string) =>
    request<{ ok: boolean; id: number; locked: boolean; unlocked: boolean; folders: FolderNode[] }>(
      `/api/folders/${id}/unlock`,
      { method: 'POST', body: JSON.stringify({ password }) }
    ),

  /** 手动重新上锁（密码保留） */
  sealFolder: (id: number) =>
    request<{ ok: boolean; folders: FolderNode[] }>(`/api/folders/${id}/seal`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /** 标签别名 / 同义词 */
  tagAliases: () => request<{ aliases: { alias: string; tag: string }[] }>('/api/tags/aliases'),
  setTagAlias: (alias: string, tag: string) =>
    request<{ ok: boolean; aliases: { alias: string; tag: string }[] }>('/api/tags/alias', {
      method: 'PUT',
      body: JSON.stringify({ alias, tag }),
    }),
  deleteTagAlias: (alias: string) =>
    request<{ ok: boolean; aliases: { alias: string; tag: string }[] }>(
      `/api/tags/alias/${encodeURIComponent(alias)}`,
      { method: 'DELETE' }
    ),

  /** 批量移出文件夹（只解除归类，不删图） */
  removeFromFolder: (id: number, imageIds: number[]) =>
    request<{ ok: boolean; removed: number; folders: FolderNode[] }>(`/api/folders/${id}/images`, {
      method: 'DELETE',
      body: JSON.stringify({ imageIds }),
    }),
  /** 某张图归属的文件夹（大图详情展示与移出） */
  imageFolders: (id: number) =>
    request<{ folders: { id: number; name: string; parent_id: number | null; path: string }[] }>(
      `/api/images/${id}/folders`
    ),
  /** 自动检测图像焦点：给定比例（如 '4:3'）返回最该保留的归一化框 */
  imageFocus: (id: number, ratio: string) =>
    request<{
      ok: boolean;
      ratio: string;
      rect: { x: number; y: number; w: number; h: number };
      point: { x: number; y: number };
      aspect: number;
      skinRatio: number;
    }>(`/api/images/${id}/focus?ratio=${encodeURIComponent(ratio)}`),
  patch: (id: number, patch: Partial<Pick<ImageItem, 'favorite' | 'tags' | 'title' | 'rating' | 'note'>>) =>
    request<ImageItem>(`/api/images/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** 批量改元数据：一次事务 + 一条撤销记录；未传的字段表示「不修改」 */
  bulkMetadata: (body: {
    ids: number[];
    rating?: number;
    favorite?: boolean;
    tags?: string[];
    tagMode?: 'add' | 'remove' | 'set';
    note?: string;
    inbox?: boolean;
    colorLabel?: string;
  }) =>
    request<{ ok: boolean; updated: number; skipped: number; items: ImageItem[] }>('/api/images/bulk-metadata', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  similarTo: (id: number, minCos: number) =>
    request<{ minCos: number; count: number; items: ImageItem[] }>(
      `/api/images/${id}/similar?minCos=${minCos}`
    ),
};
