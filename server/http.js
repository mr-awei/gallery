/**
 * 统一的网络出口：
 * - 桌面端（Electron）：走 Chromium 网络栈 net.fetch，自动跟随「网络设置」里的代理
 *   （HTTP / HTTPS / SOCKS5 / SOCKS4 / 系统代理），采集、AI、下载全部生效
 * - 网页模式：退回 Node 原生 fetch
 *
 * 安全：所有出站请求先过 assertSafeUrl（拒本机/内网/云元数据地址），
 * 并且**手动逐跳跟随重定向**——否则「公网地址 302 到 127.0.0.1」就能绕过首跳校验。
 * 本地大模型（Ollama）与自建增强服务跑在回环/局域网，这些通道显式传 allowPrivate。
 *
 * 注意：Electron 的 net.fetch 会把 headers 里的 Referer 当作禁用头直接拦截
 * （net::ERR_BLOCKED_BY_CLIENT），因此统一改用标准的 `referrer` 选项。
 */
import { assertSafeUrl } from './lib/safe-url.js';

const MAX_REDIRECTS = 3;

let netPromise = null;

async function electronNet() {
  // 纯 Node（网页模式 / 冒烟 / CI）里没有 electron 运行时：此时 import('electron') 会落到
  // node_modules/electron/index.js，二进制不存在就去下载 100MB+，CI 上白等几分钟还可能报错。
  if (!process.versions.electron) return null;
  if (!netPromise) {
    netPromise = import('electron')
      .then((m) => (m && m.net && typeof m.net.fetch === 'function' ? m.net : null))
      .catch(() => null);
  }
  return netPromise;
}

function extractReferer(headers) {
  const value = headers?.Referer || headers?.referer;
  if (value) {
    delete headers.Referer;
    delete headers.referer;
  }
  return value;
}

async function rawFetch(url, init, headers, referer) {
  const net = await electronNet();
  if (net) {
    return net.fetch(url, {
      ...init,
      headers,
      ...(referer ? { referrer: referer } : {}),
    });
  }
  // Node 原生 fetch：Referer 作为普通头即可
  return fetch(url, {
    ...init,
    headers: referer ? { ...headers, Referer: referer } : headers,
  });
}

/**
 * @param {string} input
 * @param {RequestInit} [init]
 * @param {{allowPrivate?: boolean, maxRedirects?: number}} [opts]
 *   allowPrivate：允许访问本机/内网（只给本地模型、自建增强服务用）
 */
export async function httpFetch(input, init = {}, opts = {}) {
  const { allowPrivate = false, maxRedirects = MAX_REDIRECTS } = opts;
  const headers = { ...(init.headers || {}) };
  const referer = extractReferer(headers);

  let url = String(input);
  await assertSafeUrl(url, { allowPrivate });

  for (let hop = 0; ; hop += 1) {
    const res = await rawFetch(url, { ...init, redirect: 'manual' }, headers, referer);
    const isRedirect = res.status >= 300 && res.status < 400;
    if (!isRedirect) return res;

    const location = res.headers?.get?.('location');
    if (!location) {
      // 部分实现（浏览器语义）在 manual 模式下返回 opaqueredirect，读不到 Location。
      // 这时只能退回自动跟随，至少保证首跳地址已经校验过，并记一条日志便于排查。
      if (res.type === 'opaqueredirect') {
        console.warn('[http] 目标实现不支持手动重定向，退回自动跟随：', url);
        return rawFetch(url, { ...init, redirect: 'follow' }, headers, referer);
      }
      return res;
    }
    if (hop >= maxRedirects) throw new Error('重定向次数过多，已中止');

    const next = new URL(location, url).toString();
    // 每一跳都重新校验：这是防「公网 -> 内网」跳转的关键
    await assertSafeUrl(next, { allowPrivate });
    url = next;
  }
}
