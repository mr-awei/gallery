/**
 * 对外集成：插件 / 局域网 / AI / 知识库 / 壁纸夹
 * 由 api.ts 组合成单一的 `api` 对象对外暴露（调用点不需要改 import）。
 */
import { request, withToken } from './core';
import type { CrawlConfig } from './types';
import type { AiPreset, AiProviderInfo, AiStatus, CrawlStatus, NetworkConfig, FeedbackItem, HardwareReport, ImageItem, KbRule, KbStats, Keyword, Settings, SystemInfo, WallpaperResult, PluginInfo, PluginInstallResult, PluginMarketView, PluginRunResult, LanSelfCheck, LanShare, LanShareInput, LanStatus } from '../types';

export const integrationsAPI = {
  // 插件 / 脚本宿主
  plugins: () => request<{ ok: boolean; plugins: PluginInfo[]; permissions: string[] }>('/api/plugins'),

  /** 启用 / 停用插件（不卸载；停用后执行会被明确拒绝） */
  setPluginEnabled: (id: string, enabled: boolean) =>
    request<{ ok: boolean; id: string; enabled: boolean }>(`/api/plugins/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  pluginMarket: () => request<PluginMarketView>('/api/plugins/market'),
  refreshPluginMarket: (url: string) =>
    request<PluginMarketView>('/api/plugins/market/refresh', { method: 'POST', body: JSON.stringify({ url }) }),
  resetPluginMarket: () => request<PluginMarketView>('/api/plugins/market/reset', { method: 'POST' }),
  installPlugin: (input: { id?: string; url?: string }) =>
    request<PluginInstallResult>('/api/plugins/install', { method: 'POST', body: JSON.stringify(input) }),
  uploadPluginPackage: (body: ArrayBuffer, filename: string) =>
    request<PluginInstallResult>(
      `/api/plugins/install/upload?filename=${encodeURIComponent(filename)}`,
      { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } }
    ),
  uninstallPlugin: (id: string) =>
    request<{ ok: boolean; id: string; restoredBuiltin: boolean }>(`/api/plugins/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  runPlugin: (
    id: string,
    payload: { action?: string; imageId?: number | null; args?: Record<string, unknown> }
  ) =>
    request<PluginRunResult>(`/api/plugins/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  openPluginDir: () => request<{ ok: boolean; dir: string }>('/api/plugins/open-folder', { method: 'POST' }),

  // 局域网 / 手机扫码投送
  lanStatus: () => request<LanStatus>('/api/lan/status'),
  lanSelfCheck: () => request<LanSelfCheck>('/api/lan/selfcheck'),
  setLanAccess: (enabled: boolean) =>
    request<LanStatus>('/api/lan/toggle', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  rotateLanToken: () => request<LanStatus>('/api/lan/rotate-token', { method: 'POST' }),
  createLanShare: (input: LanShareInput) =>
    request<LanShare>('/api/lan/share', { method: 'POST', body: JSON.stringify(input) }),
  lanShares: () => request<{ ok: boolean; shares: LanShare[] }>('/api/lan/shares'),
  revokeLanShares: () => request<{ ok: boolean; revoked: number }>('/api/lan/share', { method: 'DELETE' }),
  revokeLanShare: (token: string) =>
    request<{ ok: boolean; revoked: number }>(`/api/lan/share/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  lanShareQrUrl: async (token: string) =>
    `${await withToken('/api/lan/share-qrcode.svg')}&share=${encodeURIComponent(token)}`,

  settings: () => request<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  keywords: () => request<Keyword[]>('/api/keywords'),
  addKeyword: (text: string) =>
    request<{ ok: boolean; keywords: Keyword[] }>('/api/keywords', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  updateKeyword: (id: number, patch: Partial<Keyword>) =>
    request<{ ok: boolean; keywords: Keyword[] }>(`/api/keywords/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteKeyword: (id: number) =>
    request<{ ok: boolean; keywords: Keyword[] }>(`/api/keywords/${id}`, { method: 'DELETE' }),
  crawlStatus: () => request<CrawlStatus>('/api/crawl/status'),
  /** 采集源与采集参数（唯一事实来源在后端，前端不再硬编码源列表/并发上限） */
  crawlConfig: () => request<CrawlConfig>('/api/sources'),
  crawlStart: (payload: { keywords?: string[]; sources?: string[]; pages?: number }) =>
    request<{ ok: boolean; message?: string }>('/api/crawl/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  crawlStop: () => request<{ ok: boolean }>('/api/crawl/stop', { method: 'POST' }),
  network: () => request<NetworkConfig>('/api/network'),
  saveNetwork: (patch: Partial<NetworkConfig>) =>
    request<NetworkConfig>('/api/network', { method: 'PUT', body: JSON.stringify(patch) }),
  testNetwork: () =>
    request<{
      ok: boolean;
      mode: string;
      proxy: string;
      elapsed: number;
      results: { url: string; ok: boolean; status?: number; ms: number; error?: string }[];
    }>('/api/network/test', { method: 'POST' }),
  importLocal: () => request<{ ok: boolean }>('/api/import/local', { method: 'POST' }),
  nameTemplatePreview: (template: string) =>
    request<{
      ok: boolean;
      names: string[];
      sample: boolean;
      presets: { label: string; value: string }[];
      tokens: { token: string; desc: string }[];
    }>('/api/import/name-preview', { method: 'POST', body: JSON.stringify({ template }) }),
  importStatus: () =>
    request<{
      running: boolean;
      progress: number;
      message: string;
      /** 扫描整体失败时的原因（和「完成 0 张」是两回事） */
      error?: string;
      result?: {
        total?: number;
        saved?: number;
        duplicate?: number;
        dropped?: number;
        errors?: number;
        unchanged?: number;
        cancelled?: number;
        /** 超过深度上限没被扫描的目录（非空时界面要提示，不能假装导入完整） */
        depthSkippedDirs?: string[];
      };
    }>('/api/import/status'),
  systemInfo: () => request<SystemInfo>('/api/system/info'),
  /** 本机硬件 + 大模型功能的最低配置判定（refresh=true 强制重探，否则服务端 30s 缓存） */
  hardware: (refresh = false) => request<HardwareReport>(`/api/hardware${refresh ? '?refresh=1' : ''}`),
  /** 浏览器扩展：目录 / 版本 / 固定 ID（装不上时用来核对） */
  extensionInfo: () =>
    request<{ ok: boolean; dir: string; version: string; name: string; id: string; exists: boolean }>(
      '/api/extension/info'
    ),
  /** 资源管理器里打开扩展目录（Electron 里才有意义，网页端返回路径） */
  openExtensionDir: () => request<{ ok: boolean; dir: string }>('/api/extension/open', { method: 'POST' }),
  wallpaper: (id: number, style?: string) =>
    request<WallpaperResult>(`/api/images/${id}/wallpaper`, {
      method: 'POST',
      body: JSON.stringify({ style }),
    }),
  wallpaperPreviewUrl: (id: number, style?: string) =>
    `/api/images/${id}/wallpaper-preview${style ? `?style=${style}` : ''}`,

  // AI
  aiPresets: () => request<Record<string, AiPreset>>('/api/ai/presets'),
  aiStatus: () => request<AiStatus>('/api/ai/status'),

  /** 模型套件：多家供应商并存，activate 只改指针 */
  aiProviders: () =>
    request<{ ok: boolean; activeId: string; providers: AiProviderInfo[]; legacy: AiProviderInfo | null }>(
      '/api/ai/providers'
    ),
  saveAiProvider: (p: Partial<AiProviderInfo> & { apiKey?: string }) =>
    request<{ ok: boolean }>('/api/ai/providers', { method: 'POST', body: JSON.stringify(p) }),
  activateAiProvider: (id: string) =>
    request<{ ok: boolean; status: AiStatus }>(`/api/ai/providers/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: '{}',
    }),
  removeAiProvider: (id: string) =>
    request<{ ok: boolean }>(`/api/ai/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiTest: () =>
    request<{ ok: boolean; model?: string; models?: string[]; reply?: string }>('/api/ai/test', { method: 'POST' }),
  aiModels: () => request<{ ok: boolean; models: string[] }>('/api/ai/models', { method: 'POST' }),
  aiAnalyze: (id: number) =>
    request<{ ok: boolean; description: string; issues: string[]; quality: number }>('/api/ai/analyze', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  aiSummarize: () =>
    request<{ ok: boolean; added?: number; before?: number; after?: number; summary: string }>('/api/ai/summarize', {
      method: 'POST',
    }),
  aiSuggest: () => request<{ ok: boolean; text: string }>('/api/ai/suggest', { method: 'POST' }),

  // 知识库
  kbRules: () => request<KbRule[]>('/api/kb/rules'),
  kbRulesPaged: (opts: { limit?: number; offset?: number } = {}) =>
    request<{ items: KbRule[]; total: number; limit: number; offset: number }>(
      `/api/kb/rules?limit=${Number(opts.limit) || 100}&offset=${Number(opts.offset) || 0}`
    ),
  kbUpdateRule: (id: number, patch: Partial<KbRule>) =>
    request<{ ok: boolean; rules: KbRule[] }>(`/api/kb/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  kbDeleteRule: (id: number) =>
    request<{ ok: boolean; rules: KbRule[] }>(`/api/kb/rules/${id}`, { method: 'DELETE' }),
  kbFeedback: () => request<FeedbackItem[]>('/api/kb/feedback'),
  kbDeleteFeedback: (id: number) => request<{ ok: boolean }>(`/api/kb/feedback/${id}`, { method: 'DELETE' }),
  kbRescore: () => request<{ ok: boolean; updated: number; low: number }>('/api/kb/rescore', { method: 'POST' }),
  kbStats: () => request<KbStats>('/api/kb/stats'),

  // 壁纸库文件夹管理
  deleteWithReason: (id: number, payload: { reasons: string[]; note: string; aiAnalysis: string }) =>
    request<{ ok: boolean; feedbackId: number }>(`/api/images/${id}/delete-reason`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  renameImage: (id: number, title: string) =>
    request<ImageItem>(`/api/images/${id}/rename`, { method: 'POST', body: JSON.stringify({ title }) }),
};
