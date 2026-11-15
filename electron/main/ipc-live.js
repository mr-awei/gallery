// @ts-check
/**
 * 动态壁纸配置类 IPC：把渲染层传来的 patch 收敛（白名单 + 类型/长度/数值夹取）后落库。
 * 滑块的即时预览（live-params）不落库，直接推给已挂载的窗口。
 */
import path from 'node:path';
import { isSafeLiveUrl, normalizePauseApps } from '../lib/pure.js';
import { getSettingsSnapshot as getSettings } from '../settings-cache.js';
import { LIVE_MODES, LIVE_PARAM_KEYS, pushLiveParams } from './live.js';
import { ctx } from './context.js';
import { fetchJson, handleIpc } from './ipc-base.js';

/** 动态壁纸配置里允许经 IPC 下发的字段（白名单）：渲染层被注入也改不了别的键，更写不进 file:// 地址 */
const LIVE_PATCH_FIELDS = [
  'enabled', 'mode', 'webUrl', 'intervalSec', 'videoPath', 'mute', 'volume',
  'kenBurns', 'scope', 'playlistId', 'minScore', 'pauseOnBattery', 'pauseOnFullscreen',
  'params', 'shaderPreset', 'shaderSource', 'interactive', 'audioPath', 'audioSource',
  'pauseOnGpu', 'gpuThreshold', 'pauseApps', 'allowLocalUrl', 'trustedDir', 'clickThrough',
];

/** 收敛渲染层传来的配置：白名单 + 类型/长度/数值夹取，避免把任意对象写进设置 */
function safeLivePatch(patch) {
  const safe = {};
  for (const k of LIVE_PATCH_FIELDS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) safe[k] = patch[k];
  }
  if (safe.mode !== undefined && !LIVE_MODES.has(String(safe.mode))) return { error: '未知的壁纸类型' };
  for (const k of ['webUrl', 'videoPath', 'audioPath']) {
    if (safe[k] !== undefined) safe[k] = String(safe[k]).slice(0, 1000);
  }
  if (safe.shaderSource !== undefined) safe.shaderSource = String(safe.shaderSource).slice(0, 12000);
  if (safe.shaderPreset !== undefined) safe.shaderPreset = String(safe.shaderPreset).slice(0, 60);
  if (safe.params !== undefined) {
    const p = safe.params && typeof safe.params === 'object' ? safe.params : {};
    const clean = {};
    for (const k of LIVE_PARAM_KEYS) {
      const v = Number(p[k]);
      if (Number.isFinite(v)) clean[k] = Math.max(0, Math.min(300, Math.round(v)));
    }
    safe.params = clean;
  }
  if (safe.gpuThreshold !== undefined) {
    const n = Number(safe.gpuThreshold);
    safe.gpuThreshold = Math.max(1, Math.min(100, Math.round(Number.isFinite(n) ? n : 85)));
  }
  if (safe.pauseApps !== undefined) safe.pauseApps = normalizePauseApps(safe.pauseApps);
  if (safe.trustedDir !== undefined) {
    const raw = String(safe.trustedDir).slice(0, 500);
    safe.trustedDir = raw && path.isAbsolute(raw) ? raw : '';
  }
  for (const k of ['pauseOnGpu', 'allowLocalUrl', 'clickThrough']) {
    if (safe[k] !== undefined) safe[k] = safe[k] === true || safe[k] === 'true' || safe[k] === 1;
  }
  return { safe };
}

export function registerLiveIpc() {
  handleIpc('live-wallpaper-control', async (_e, patch) => {
    const { safe, error } = safeLivePatch(patch);
    if (error) return { ok: false, error };
    if (typeof safe.webUrl === 'string' && safe.webUrl) {
      const current = getSettings()?.liveWallpaper || {};
      const allowLocalUrl = safe.allowLocalUrl ?? current.allowLocalUrl ?? false;
      const trustedDir = String(safe.trustedDir ?? current.trustedDir ?? '');
      if (!isSafeLiveUrl(safe.webUrl, { allowLocalUrl, trustedDir })) {
        return {
          ok: false,
          error: allowLocalUrl
            ? '网页地址只允许公网 / 本机 / 内网 http(s)，或可信目录内的 file:// 页面'
            : '默认只允许公网 http(s)；要使用本地或内网页面，请先打开「允许本地 / 内网网页」',
        };
      }
    }
    // 失败也要如实回 ok:false：以前无论成功失败都返回 { ok: true }
    const r = await fetchJson(
      `http://127.0.0.1:${ctx.serverPort}/api/wallpaper/live`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(safe) },
      5000
    ).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    return r && r.ok === false ? { ok: false, error: r.error } : { ok: true };
  });

  /** 参数滑块即时预览：不落库，直接推给已挂载的桌面层窗口 / 屏保窗口 */
  handleIpc('live-params', async (_e, patch) => {
    const clean = {};
    for (const k of LIVE_PARAM_KEYS) {
      const v = Number(patch?.[k]);
      if (Number.isFinite(v)) clean[k] = Math.max(0, Math.min(300, Math.round(v)));
    }
    if (!Object.keys(clean).length) return { ok: false, error: '参数不合法' };
    pushLiveParams(clean);
    return { ok: true };
  });
}
