/**
 * 适配度 / 偏好 / 去背景 / 检索 / 标签
 * 由 api.ts 组合成单一的 `api` 对象对外暴露（调用点不需要改 import）。
 */
import { request } from './core';
import type { JobItem, OpLogItem } from './types';
import type { ImageItem, TrashItem } from '../types';

export const insightAPI = {
  // AI 壁纸闭环：适配度查询 / 补算 / 反馈
  wallpaperFit: (id: number, ai = false) =>
    request<{ ok: boolean; fit: { score: number; safe_area: string; reason: string; source: string } | null }>(
      `/api/wallpaper/fit/${id}?ai=${ai ? 1 : 0}`
    ),
  scanWallpaperFit: (limit = 120, ai = false) =>
    request<{ ok: boolean; done: number; remain: number }>('/api/wallpaper/scan-fit', {
      method: 'POST',
      body: JSON.stringify({ limit, ai }),
    }),
  wallpaperFeedback: (imageId: number, like: boolean) =>
    request<{ ok: boolean }>('/api/wallpaper/feedback', { method: 'POST', body: JSON.stringify({ imageId, like }) }),
  // 本地偏好模型（个性化推荐）
  prefStatus: () =>
    request<{
      trained: boolean;
      trainedAt: string | null;
      samples: number;
      pos: number;
      neg: number;
      featureCount: number;
      top: { feature: string; w: number }[];
    }>('/api/pref/status'),
  // AI 去背景
  mattingStatus: () =>
    request<{
      downloaded: boolean;
      downloading: boolean;
      progress: number;
      message: string;
      error: string;
      cancelled?: boolean;
      size: number;
      /** 当前实际生效的档位 */
      profile?: string;
      /** 正在下载的档位 */
      installing?: string;
      profiles?: { id: string; label: string; desc: string; size: number; sizeHint: number; installed: boolean; verified: boolean; active: boolean }[];
    }>('/api/ai/matting/status'),
  /** 后台下载：立刻返回，进度看 mattingStatus / 任务中心。profile: u2net | birefnet-lite */
  mattingInstall: (profile?: string) =>
    request<{ ok: boolean; started?: boolean; downloaded?: boolean }>('/api/ai/matting/install', {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }),
  mattingCancel: () => request<{ ok: boolean }>('/api/ai/matting/cancel', { method: 'POST' }),

  /* ---------------- 任务中心 / 操作撤销 ---------------- */
  jobs: (kind = '', limit = 20) =>
    request<JobItem[]>(`/api/jobs?kind=${encodeURIComponent(kind)}&limit=${limit}`),
  cancelJob: (id: number) => request<{ ok: boolean; message?: string }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  retryJob: (id: number) => request<{ ok: boolean }>(`/api/jobs/${id}/retry`, { method: 'POST' }),
  ops: (limit = 30) => request<OpLogItem[]>(`/api/ops?limit=${limit}`),
  undoOp: (id: number) =>
    request<{ ok: boolean; op: string; info: Record<string, number> | null }>(`/api/ops/${id}/undo`, { method: 'POST' }),
  undoLastOp: () =>
    request<{ ok: boolean; op: string; info: Record<string, number> | null }>('/api/ops/undo-last', { method: 'POST' }),
  // mode: 'ai'（人像/宠物分割，需要模型）| 'flat'（纯底图：白底/灰底等任意纯色，零模型）
  // warning: 人像模型对风景/物体常抠出废图、纯底图抠不干净时，后端会带一句人话提示
  removeBackground: (id: number, mode: 'ai' | 'flat' = 'ai') =>
    request<{ ok: boolean; mode?: string; reason?: string; id?: number; coverage?: number; warning?: string }>(
      `/api/images/${id}/remove-bg`,
      { method: 'POST', body: JSON.stringify({ mode }) }
    ),
  prefTrain: () =>
    request<{ ok: boolean; samples?: number; pos?: number; neg?: number; updated?: number; message?: string; top?: { feature: string; w: number }[] }>(
      '/api/pref/train',
      { method: 'POST' }
    ),

  // 回收站：带 limit 走服务端分页（返回 items + total），不带则维持一次性取全部
  trash: (params?: { limit?: number; offset?: number; q?: string }) => {
    if (!params?.limit) return request<TrashItem[]>('/api/trash');
    const qs = new URLSearchParams({ limit: String(params.limit) });
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.q) qs.set('q', params.q);
    return request<{ items: TrashItem[]; total: number }>(`/api/trash?${qs}`);
  },
  restoreTrash: (id: number) => request<ImageItem>(`/api/trash/${id}/restore`, { method: 'POST' }),
  deleteTrash: (id: number) =>
    request<{ ok: boolean; error?: string }>(`/api/trash/${id}`, { method: 'DELETE' }),
  emptyTrash: () =>
    request<{
      ok: boolean;
      removed: number;
      /** 文件没删掉、记录仍保留在回收站里的条目 */
      failed: Array<{ id: number; path: string; error: string }>;
    }>('/api/trash/empty', { method: 'POST' }),
  clearLibrary: () =>
    request<{
      ok: boolean;
      removed: number;
      /** 移动失败、仍保留在图库里的条目（文件被占用等） */
      failed?: Array<{ id: number; path: string; error: string }>;
    }>('/api/library', { method: 'DELETE' }),

  // 检索：颜色 / AI / 以图
  searchColor: (hex: string, tol = 48, limit = 120) =>
    request<{ hex: string; tolerance: number; total: number; items: ImageItem[] }>(
      `/api/search/color?hex=${encodeURIComponent(hex)}&tol=${tol}&limit=${limit}`
    ),
  /** 保存网页书签：抓标题/描述/封面，并存一份离线 HTML 快照 */
  saveBookmark: (payload: { url: string; tags?: string[]; note?: string }) =>
    request<{ ok: boolean; item: ImageItem }>('/api/bookmarks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // 自然语言搜图：engine=clip 才是真语义召回；降级时会带回 reason 和 keywords
  semanticSearch: (query: string, limit = 60) =>
    request<{
      total: number;
      items: (ImageItem & { cos?: number })[];
      engine?: 'clip' | 'llm' | 'keyword' | 'loading';
      degraded?: boolean;
      reason?: string;
      keywords?: string[];
      covered?: { indexed: number; total: number };
    }>('/api/search/semantic', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
  // 混合检索：关键词 + CLIP 两路 RRF 融合；sources 说明每条是被哪一路召回的
  hybridSearch: (query: string, limit = 60, vectorWeight = 1) =>
    request<{
      total: number;
      items: (ImageItem & { sources?: string[]; cos?: number })[];
      engine?: 'hybrid' | 'keyword' | 'loading';
      degraded?: boolean;
      reason?: string;
      covered?: { indexed: number; total: number };
    }>('/api/search/hybrid', {
      method: 'POST',
      body: JSON.stringify({ query, limit, vectorWeight }),
    }),
  // engine 是后端真实用的通道（llm 抽词 / 纯关键词），degraded=配了 AI 但解析失败
  aiSearch: (query: string, limit = 60) =>
    request<{
      query: string;
      total: number;
      items: ImageItem[];
      engine?: 'llm' | 'keyword';
      degraded?: boolean;
      reason?: string;
      keywords?: string[];
    }>('/api/search/ai', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
  // engine: clip = 深度特征；phash = 感知哈希（结果里带 hamming）
  searchByImage: (dataUrl: string, maxHamming = 10, limit = 24) =>
    request<{
      total: number;
      items: (ImageItem & { hamming?: number; cos?: number })[];
      engine?: 'clip' | 'phash';
    }>('/api/search/by-image', {
      method: 'POST',
      body: JSON.stringify({ image: dataUrl, maxHamming, limit }),
    }),

  // 标签管理
  renameTag: (oldName: string, newName: string) =>
    request<{ ok: boolean; affected: number; tags: { tag: string; count: number }[] }>('/api/tags/rename', {
      method: 'POST',
      body: JSON.stringify({ oldName, newName }),
    }),
  deleteTag: (name: string) =>
    request<{ ok: boolean; affected: number; tags: { tag: string; count: number }[] }>('/api/tags/delete', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  mergeTags: (from: string, to: string) =>
    request<{ ok: boolean; affected: number; tags: { tag: string; count: number }[] }>('/api/tags/merge', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
};
