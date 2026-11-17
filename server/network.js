import { getSettings, saveSettings } from './db.js';
import { PROXY_MODES, applyProxyNet, normalizeNet, proxyRules as rulesOf, registerProxyAuthFor } from './proxy.js';

/**
 * 网络 / 代理设置：代理规则通过 Chromium(session.setProxy) 生效，
 * 因此采集、AI、缩略图下载全部走同一出口。
 *
 * 只做「读库 + 转调」：规则纯逻辑与 Electron 会话应用在 ./proxy.js，
 * 主进程在服务端独立进程化后直接复用那一份（不 import 本文件，避免拉进 SQLite）。
 */

export { PROXY_MODES };

export function getNetwork() {
  return normalizeNet(getSettings().network);
}

export function proxyRules(net = getNetwork()) {
  return rulesOf(net);
}

/** 应用代理到 Chromium 会话（桌面端） */
export async function applyProxy() {
  return applyProxyNet(getNetwork());
}

/** 代理需要账号密码时，由 Chromium 触发 login 事件 */
export function registerProxyAuth() {
  registerProxyAuthFor(getNetwork);
}

export function saveNetwork(patch) {
  const current = getNetwork();
  const next = { ...current, ...(patch || {}) };
  next.port = Number(next.port) || 7890;
  saveSettings({ network: next });
  return getNetwork();
}

/** 通过当前代理测试连通性 */
export async function testNetwork() {
  const { httpFetch } = await import('./http.js');
  const net = getNetwork();
  const started = Date.now();
  const targets = ['https://www.bing.com/images/search?q=test', 'https://wallhaven.cc/api/v1/search?q=test'];
  const results = [];
  for (const url of targets) {
    const t0 = Date.now();
    try {
      const res = await httpFetch(url, { signal: AbortSignal.timeout(15000) });
      results.push({
        url,
        ok: res.ok,
        status: res.status,
        ms: Date.now() - t0,
      });
    } catch (err) {
      results.push({ url, ok: false, error: err.message, ms: Date.now() - t0 });
    }
  }
  const ok = results.some((r) => r.ok);
  return {
    ok,
    mode: net.mode,
    proxy: proxyRules(net) || '直连',
    elapsed: Date.now() - started,
    results,
  };
}
