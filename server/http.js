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

/**
 * Electron 的 net.fetch 在 redirect:'manual' 下遇到「响应是重定向」时会直接取消请求并抛
 * `Redirect was cancelled`（Chromium 不会把 3xx 交给调用方）。这不是网络问题。
 */
const REDIRECT_CANCEL = /redirect was cancelled/i;

/** 与 fetch 一致的取消错误（DOMException 不在 eslint 全局里，手工构造） */
function abortError() {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

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
 * 用 net.request 走完重定向链，返回最终地址，每一跳都过 assertSafeUrl。
 *
 * 只给 Electron 兜底：那里 manual 拿不到 3xx（直接抛 Redirect was cancelled），follow 的
 * Response.url 又是空串（落地地址不可知）—— 两条路都做不到逐跳校验。
 *
 * 关键约束：不能在 'redirect' 事件里 await 再 followRedirect()，Chromium 不会等异步校验，
 * 请求会以「Redirect was cancelled」收场。所以每一跳单独发一次、拿到 Location 就 abort，
 * 校验完再顺着新地址发下一跳；body 由调用方对最终地址另发一次请求读取。
 *
 * @param {string} startUrl
 * @param {{allowPrivate: boolean, maxRedirects: number, signal?: AbortSignal, headers?: Record<string,string>}} opts
 * @returns {Promise<string>} 最终地址；无法解析时返回空串
 */
async function resolveRedirectTarget(startUrl, { allowPrivate, maxRedirects, signal, headers }) {
  const net = await electronNet();
  if (!net || typeof net.request !== 'function') return '';

  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const step = await requestHop(net, url, headers, signal);
    if (!step.next) return step.final;
    // 每一跳都重新校验：这是防「公网 -> 内网」跳转的关键
    await assertSafeUrl(step.next, { allowPrivate });
    url = step.next;
  }
  throw new Error('重定向次数过多，已中止');
}

/**
 * 只发一跳、只要响应头：拿到重定向地址或确认到达终点就断开。
 * @param {any} net Electron net 模块
 * @param {string} url
 * @param {Record<string,string> | undefined} headers
 * @param {AbortSignal} [signal]
 * @returns {Promise<{next?: string, final?: string}>}
 */
function requestHop(net, url, headers, signal) {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'manual' });
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      try {
        req.abort();
      } catch {
        // 已经结束，无需处理
      }
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => finish(abortError());

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    for (const [key, value] of Object.entries(headers || {})) {
      // Referer 在 Chromium 里是禁用头，net.request 设了会整条请求失败
      if (!value || /^(referer|host|content-length)$/i.test(key)) continue;
      try {
        req.setHeader(key, value);
      } catch {
        // 个别非法头直接忽略，不影响链路解析
      }
    }

    req.on('redirect', (_status, _method, redirectUrl) => finish(null, { next: redirectUrl }));
    req.on('response', (res) => {
      // 只要地址，不要 body
      res.on('data', () => {});
      res.on('error', () => {});
      finish(null, { final: url });
    });
    req.on('error', (err) => finish(err));
    req.end();
  });
}

/**
 * @param {string} input
 * @param {RequestInit & {timeout?: number, retries?: number}} [init]
 *   timeout：单次请求超时毫秒（0 = 不限）；retries：网络级失败的重试次数。
 *   这两个字段以前被直接透传给 fetch（Node 不认，超时与重试等于没生效），现在由本函数消费。
 * @param {{allowPrivate?: boolean, maxRedirects?: number}} [opts]
 *   allowPrivate：允许访问本机/内网（只给本地模型、自建增强服务用）
 */
export async function httpFetch(input, init = {}, opts = {}) {
  const { allowPrivate = false, maxRedirects = MAX_REDIRECTS } = opts;
  const { timeout = 0, retries = 0, ...rest } = init;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestOnce(input, rest, { allowPrivate, maxRedirects, timeout });
    } catch (err) {
      lastErr = err;
      // 最后一跳仍失败才抛出；中间失败（网络抖动 / 超时）按 retries 再试
    }
  }
  throw lastErr;
}

/**
 * 发一次请求（含逐跳重定向校验）。timeout 只作用于单次 fetch。
 * @param {string} input
 * @param {RequestInit} init
 * @param {{allowPrivate: boolean, maxRedirects: number, timeout: number}} opts
 */
async function requestOnce(input, init, { allowPrivate, maxRedirects, timeout }) {
  const headers = { ...(init.headers || {}) };
  const referer = extractReferer(headers);
  const signal = timeout > 0 && !init.signal ? AbortSignal.timeout(timeout) : init.signal;

  let url = String(input);
  await assertSafeUrl(url, { allowPrivate });

  let chainResolved = false;
  for (let hop = 0; ; hop += 1) {
    let res;
    try {
      res = await rawFetch(url, { ...init, signal, redirect: 'manual' }, headers, referer);
    } catch (err) {
      const cancelled = REDIRECT_CANCEL.test(String(err?.message || ''));
      if (!cancelled || chainResolved) throw err;
      // 带 body 的请求无法在解析完链路后重放，只能退回自动跟随（首跳已校验）
      if (init.body) {
        console.warn('[http] 带 body 的请求遇到重定向，退回自动跟随（逐跳校验失效）：', url);
        return rawFetch(url, { ...init, signal, redirect: 'follow' }, headers, referer);
      }
      const target = await resolveRedirectTarget(url, { allowPrivate, maxRedirects, signal, headers });
      if (!target || target === url) throw err;
      chainResolved = true;
      url = target;
      continue;
    }
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
