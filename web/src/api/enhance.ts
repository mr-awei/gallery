/**
 * 画质增强 / 清单 / 定时与动态壁纸
 * 由 api.ts 组合成单一的 `api` 对象对外暴露（调用点不需要改 import）。
 */
import { WatermarkParams, GeoProvince, WatermarkOptions, postBlobWithNote, request } from './core';
import type { ThemePackBrief, ThemePackFile } from './types';
import type { AdjustParams, EditJobStatus, EditOpsInfo, EditResult, EditSaveOptions, AiUpscaleStatus, AutoWallpaperConfig, EnhanceAiModel, EnhanceCandidates, EnhanceConfig, EnhanceJobStatus, EnhanceModel, EnhanceRemoteService, EnhanceStandard, AutoWallpaperStatus, Playlist, WallpaperLogItem, ImageItem, WallpaperMonitors, LiveWallpaperConfig } from '../types';
import type { ThemePackTheme } from '../lib/theme-pack-vars';

export const enhanceAPI = {
  // 画质增强
  enhanceStandards: () =>
    request<{ standards: EnhanceStandard[]; config: EnhanceConfig }>('/api/enhance/standards'),
  enhanceCandidates: (standard?: string) =>
    request<EnhanceCandidates>(
      `/api/enhance/candidates${standard ? `?standard=${encodeURIComponent(standard)}` : ''}`,
      { cache: 'no-store' } // 增强后尺寸会变，必须绕开浏览器缓存拿最新列表
    ),
  enhanceModels: () =>
    request<{
      builtin: EnhanceModel[];
      remote: EnhanceRemoteService[];
      ai: EnhanceAiModel[];
      aiInstalled: boolean;
    }>('/api/enhance/models'),
  enhanceRemoteTest: (service: EnhanceRemoteService) =>
    request<{ ok: boolean; elapsed: number; bytes?: number; width?: number; height?: number; message: string }>(
      '/api/enhance/remote/test',
      { method: 'POST', body: JSON.stringify({ service }) }
    ),
  enhanceJob: () => request<EnhanceJobStatus>('/api/enhance/job'),
  enhanceJobStart: (ids: number[], model: string, standard?: string) =>
    request<{ ok: boolean } & EnhanceJobStatus>('/api/enhance/job/start', {
      method: 'POST',
      body: JSON.stringify({ ids, model, standard }),
    }),
  enhanceJobCancel: () => request<{ ok: boolean } & EnhanceJobStatus>('/api/enhance/job/cancel', { method: 'POST' }),
  aiUpscaleStatus: () => request<AiUpscaleStatus>('/api/ai/upscale/status'),
  aiUpscaleInstall: () => request<{ ok: boolean } & AiUpscaleStatus>('/api/ai/upscale/install', { method: 'POST' }),
  // 两个安装接口都是后台任务：立刻返回当前状态，进度/结果靠订阅 job 事件的 aiUp 帧
  aiUpscaleInstallModel: (id: string) =>
    request<{ ok: boolean } & AiUpscaleStatus>('/api/ai/upscale/install-model', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  aiUpscaleInstallCugan: () =>
    request<{ ok: boolean; busy?: boolean } & AiUpscaleStatus>('/api/ai/upscale/install-cugan', {
      method: 'POST',
    }),
  aiSrStatus: () =>
    request<{
      loading: string;
      progress: number;
      message: string;
      error: string;
      models: { id: string; repo: string; label: string; desc: string; scale: number; downloaded: boolean; loaded: boolean }[];
    }>('/api/ai/sr/status'),
  // 后台加载：立刻返回当前状态（含 loading/error），进度/结果走 job 心跳
  aiSrLoad: (id: string) =>
    request<{ ok: boolean; busy?: boolean } & {
      loading: string;
      progress: number;
      message: string;
      error: string;
      models: { id: string; repo: string; label: string; desc: string; scale: number; downloaded: boolean; loaded: boolean }[];
    }>('/api/ai/sr/load', { method: 'POST', body: JSON.stringify({ id }) }),
  aiUpscaleSelfTest: () =>
    request<{ ok: boolean; gpu: string | null; error: string }>('/api/ai/upscale/selftest', { method: 'POST' }),
  enhanceImage: (id: number, model: string, standard?: string) =>
    // noop=true 表示已达标、文件没被改动，前端不能再报「已增强至 W×H」
    request<{ ok: boolean; noop?: boolean; message?: string; item: ImageItem }>('/api/enhance/' + id, {
      method: 'POST',
      body: JSON.stringify({ model, standard }),
    }),
  enhanceBatch: (ids: number[], model: string, standard?: string) =>
    request<{
      ok: boolean;
      success: number;
      skipped: number;
      total: number;
      results: { id: number; ok: boolean; noop?: boolean; error?: string }[];
    }>(
      '/api/enhance/batch',
      { method: 'POST', body: JSON.stringify({ ids, model, standard }) }
    ),
  rotateImage: (id: number, dir: 'cw' | 'ccw') =>
    request<{ ok: boolean; item: ImageItem; nonDestructive?: boolean; editOps?: number }>(
      `/api/images/${id}/rotate`,
      { method: 'POST', body: JSON.stringify({ dir }) }
    ),
  /** 非破坏编辑：已记录的操作链（原图未改动），以及应用到底片 / 全部还原 */
  editOps: (id: number) => request<EditOpsInfo>(`/api/images/${id}/edits`),
  applyEditOps: (id: number) =>
    request<{ ok: boolean; item: ImageItem; baked: boolean; ops: number }>(`/api/images/${id}/edits/apply`, {
      method: 'POST',
    }),
  clearEditOps: (id: number) =>
    request<{ ok: boolean; cleared: number; item: ImageItem }>(`/api/images/${id}/edits/clear`, {
      method: 'POST',
    }),
  // 裁切：ratio 预设（'1:1'/'16:9'…）会先做焦点检测再裁；'free'/'orig' 需带归一化框 rect
  // 追加 saveMode:'copy' + targetDir 则另存副本到该目录，原图不动（addToLibrary 可把副本登记入库）
  // outWidth/outHeight：裁完重采样到指定像素（批量裁切台的「宽/高」，与单张裁切共用）
  // 返回 focus: 'detected' = 按检测到的焦点裁；'center' = 没检测到主体，退回居中裁
  cropImage: (
    id: number,
    opts: {
      ratio: string;
      rect?: { x: number; y: number; w: number; h: number };
      outWidth?: number;
      outHeight?: number;
    } & EditSaveOptions
  ) =>
    request<EditResult & { focus?: 'detected' | 'center' }>(`/api/images/${id}/crop`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  // Camera Raw 调色：色温/色调/曝光/对比度/饱和度/锐化，全 0 时原样返回（另存模式除外）
  adjustImage: (id: number, params: Partial<AdjustParams> & EditSaveOptions) =>
    request<EditResult>(`/api/images/${id}/adjust`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  /** 擦除修复：mask 为画笔导出的 PNG data URL（白色 = 擦掉），走与调色相同的撤销链路 */
  inpaintImage: (id: number, opts: { mask: string; strength?: number } & EditSaveOptions) =>
    request<EditResult & { coverage: number }>(`/api/images/${id}/inpaint`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /* ------------------------ 水印 / 相框 ------------------------ */
  /** 23 款水印 + 20 款相框 + 可选信息项 + 品牌清单 + 本机字体（服务端是唯一来源） */
  watermarkOptions: () => request<WatermarkOptions>('/api/watermark/options'),
  /** 重新扫描本机字体（用户刚装完字体时点「刷新字体」） */
  watermarkFonts: () =>
    request<{ fonts: { key: string; name: string; group: string }[] }>('/api/watermark/fonts?refresh=1'),
  /** 拍摄地点三级选择器数据（省/市/区），55KB，前端取一次就够 */
  geoRegions: () => request<{ provinces: GeoProvince[] }>('/api/geo/regions'),
  /** 预览：返回 JPEG 二进制，长边压到 1400，调参时高频刷新也不重。
      同时带回服务端说明：没有可显示信息时仍出原图，用 note 解释原因 */
  watermarkPreview: (id: number, params: WatermarkParams) =>
    postBlobWithNote(`/api/images/${id}/watermark/preview`, params),
  /** 单张应用：默认覆盖原图（有撤销备份），saveMode='copy' 时另存 */
  watermarkImage: (id: number, params: WatermarkParams & EditSaveOptions) =>
    request<EditResult & { width: number; height: number }>(`/api/images/${id}/watermark`, {
      method: 'POST',
      body: JSON.stringify(params),
      timeoutMs: 120000,
    }),
  // 批量编辑（异步任务）：op='crop' 用 {ratio, rect?}，op='adjust' 用调色参数
  batchEdit: (ids: number[], op: 'crop' | 'adjust' | 'watermark', params: Record<string, unknown>) =>
    request<{ ok: boolean; job: EditJobStatus }>('/api/images/batch/edit', {
      method: 'POST',
      body: JSON.stringify({ ids, op, params }),
    }),
  /** 可见区预览预热：把屏幕上真正看得见的几张挪到服务端预取队首（只排队不生成） */
  warmPreviews: (ids: number[]) =>
    request<{ ok: boolean; moved: number; added: number }>('/api/images/previews/warm', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  editJob: () => request<EditJobStatus>('/api/edit/job'),
  cancelEditJob: () => request<EditJobStatus>('/api/edit/job/cancel', { method: 'POST' }),
  scanFolder: () =>
    request<{
      ok: boolean;
      total?: number;
      saved?: number;
      duplicate?: number;
      dropped?: number;
      errors?: number;
      message?: string;
    }>('/api/library/scan', {
      method: 'POST',
    }),
  missingFiles: () => request<{ count: number; ids: number[] }>('/api/library/missing'),
  purgeMissing: () => request<{ ok: boolean; removed: number }>('/api/library/purge-missing', { method: 'POST' }),
  relocateMissing: () =>
    request<{ ok: boolean; relocated: number; remaining: number; unreadable: number }>(
      '/api/library/relocate-missing',
      {
        method: 'POST',
      }
    ),

  // 清单
  playlists: () => request<Playlist[]>('/api/playlists'),
  createPlaylist: (name: string, description = '') =>
    request<{ ok: boolean; playlists: Playlist[] }>('/api/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  updatePlaylist: (id: number, patch: Partial<Playlist>) =>
    request<{ ok: boolean; playlists: Playlist[] }>(`/api/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deletePlaylist: (id: number) =>
    request<{ ok: boolean; playlists: Playlist[] }>(`/api/playlists/${id}`, { method: 'DELETE' }),
  playlistImages: (id: number) => request<ImageItem[]>(`/api/playlists/${id}/images`),
  addToPlaylist: (id: number, ids: number[]) =>
    request<{ ok: boolean; added: number; playlists: Playlist[] }>(`/api/playlists/${id}/images`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  removeFromPlaylist: (id: number, imageId: number) =>
    request<{ ok: boolean; playlists: Playlist[] }>(`/api/playlists/${id}/images/${imageId}`, {
      method: 'DELETE',
    }),

  // 定时切换壁纸
  autoWallpaper: () => request<AutoWallpaperStatus>('/api/wallpaper/auto'),
  wallpaperMonitors: () => request<WallpaperMonitors>('/api/wallpaper/monitors'),
  currentWallpaper: () =>
    request<{ imageId?: number; title?: string; favorite?: boolean }>('/api/wallpaper/current'),
  favoriteCurrentWallpaper: () =>
    request<{ ok: boolean; imageId: number; title: string }>('/api/wallpaper/current/favorite', {
      method: 'POST',
    }),
  dislikeCurrentWallpaper: () =>
    request<{ ok: boolean; skipped: number | null; learned?: string[] }>('/api/wallpaper/current/dislike', {
      method: 'POST',
    }),
  // 动态壁纸
  platform: () =>
    request<{
      ok: boolean;
      platform: string;
      family: string;
      liveWallpaper: boolean;
      desktopLayer: boolean;
      staticWallpaper: boolean;
      screensaver: boolean;
      gpuMeter: boolean;
      foregroundApp: boolean;
      summary: string;
      notes: string[];
    }>('/api/platform'),

  /* ------------------------------ 多端同步 ------------------------------ */
  syncStatus: () =>
    request<{
      ok: boolean;
      enabled: boolean;
      syncDir: string;
      deviceId: string;
      localRevision: number;
      remoteRevision: number;
      remoteDevice: string;
      publishedAt: string;
      libraryName: string;
      dirty: boolean;
      manifestError: string;
      note: string;
    }>('/api/sync/status'),
  syncConfigure: (syncDir: string) =>
    request<{ ok: boolean; enabled: boolean; syncDir?: string; note?: string }>('/api/sync/configure', {
      method: 'POST',
      body: JSON.stringify({ syncDir }),
    }),
  syncPublish: (force?: boolean) =>
    request<{ ok: boolean; unchanged: boolean; revision: number; bytes?: number; note: string }>('/api/sync/publish', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  syncPull: (force?: boolean) =>
    request<{
      ok: boolean;
      skipped: boolean;
      revision: number;
      reason?: string;
      libraryId?: number;
      libraryName?: string;
      remapped?: number;
      missing?: number;
      note?: string;
    }>('/api/sync/pull', { method: 'POST', body: JSON.stringify({ force }) }),

  /* --------------------------- 创意工坊 / 主题包 --------------------------- */
  workshopPacks: () =>
    request<{ ok: boolean; items: ThemePackBrief[]; dir: string }>('/api/workshop/packs'),
  workshopExport: (body: {
    name: string;
    author?: string;
    theme: ThemePackTheme;
    includeSettings?: boolean;
    assets?: { name: string; dataUrl: string }[];
  }) =>
    request<{ ok: boolean; pack: ThemePackFile; file: string; skipped: string[] }>('/api/workshop/export', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  workshopImport: (data: string) =>
    request<{
      ok: boolean;
      pack: ThemePackBrief;
      theme: ThemePackTheme;
      file: string;
      assetPaths: string[];
      appliedSettings: string[];
      skipped: string[];
    }>('/api/workshop/import', { method: 'POST', body: JSON.stringify({ data }) }),
  workshopApply: (id: string) =>
    request<{ ok: boolean; theme: ThemePackTheme; appliedSettings: string[]; skipped: string[] }>(
      '/api/workshop/apply',
      { method: 'POST', body: JSON.stringify({ id }) }
    ),
  workshopDelete: (id: string) => request<{ ok: boolean }>(`/api/workshop/packs/${id}`, { method: 'DELETE' }),
  workshopDownload: (id: string) => `/api/workshop/packs/${id}/file`,
  liveWallpaper: () => request<LiveWallpaperConfig>('/api/wallpaper/live'),
  saveLiveWallpaper: (patch: Partial<LiveWallpaperConfig>) =>
    request<LiveWallpaperConfig>('/api/wallpaper/live', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  saveAutoWallpaper: (patch: Partial<AutoWallpaperConfig>) =>
    request<AutoWallpaperStatus>('/api/wallpaper/auto', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  switchWallpaperNow: (scope?: string, playlistId?: number | null) =>
    request<{ ok: boolean; imageId: number; title: string; generated: boolean }>(
      '/api/wallpaper/now',
      { method: 'POST', body: JSON.stringify({ scope, playlistId }) }
    ),
  wallpaperHistory: () => request<WallpaperLogItem[]>('/api/wallpaper/history'),
};
