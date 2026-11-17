// @ts-check
/**
 * 出站地址校验。
 *
 * 为什么需要：书签、网页采集、远程增强、外部搜图都让「用户或用户打开的页面」
 * 提供一个 URL，然后服务端亲自去取。不加约束时，本地 API 就成了内网探测器：
 * - 打本机回环（127.0.0.1:其它端口，含本应用自己的 API）
 * - 打内网段（10/8、192.168、172.16/12）
 * - 打云元数据地址（169.254.169.254）
 * - 用「公网地址 302 到 127.0.0.1」绕过首跳校验
 *
 * 策略：
 * 1. 只允许 http/https，且地址里不能带 user:pass（避免 http://user:pass@host 混淆）。
 * 2. 主机名是 IP 字面量 → 直接判断；是域名 → DNS 解析后判断**所有**A/AAAA 记录。
 * 3. 重定向必须逐跳重新校验（由 http.js 手动跟随完成）。
 *
 * allowPrivate：本地大模型（Ollama 等）与用户自建的增强服务就跑在 127.0.0.1 / 局域网，
 * 这些通道显式放行；默认一律拒绝。
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/** 是否本机 / 内网 / 保留地址 */
export function isPrivateIp(ip) {
  const version = net.isIP(String(ip || ''));
  if (version === 4) {
    const p = String(ip).split('.').map((n) => Number(n));
    if (p.some((n) => Number.isNaN(n))) return true; // 解析不了就按不安全处理
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local / 云元数据
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return true;
    if (p[0] >= 224) return true; // 组播 / 保留
    return false;
  }
  if (version === 6) {
    const s = String(ip).toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    // IPv4-mapped：::ffff:127.0.0.1
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

/**
 * 校验地址是否允许出站，返回解析后的 URL。
 * @param {string} raw
 * @param {{allowPrivate?: boolean, allowProtocols?: string[]}} [opts]
 */
export async function assertSafeUrl(raw, opts = {}) {
  const { allowPrivate = false, allowProtocols = ['http:', 'https:'] } = opts;

  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('地址格式不正确');
  }
  if (!allowProtocols.includes(url.protocol)) {
    throw new Error(`只支持 http/https 地址（收到 ${url.protocol}）`);
  }
  if (url.username || url.password) {
    throw new Error('地址里不能包含账号密码');
  }
  if (allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('地址缺少主机名');
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error('不允许访问本机或内网地址');

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问本机或内网地址');
    return url;
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`域名解析失败：${host}`);
  }
  if (!addrs.length) throw new Error(`域名解析失败：${host}`);
  for (const item of addrs) {
    if (isPrivateIp(item.address)) {
      throw new Error('该域名解析到本机或内网地址，已拒绝访问');
    }
  }
  return url;
}

/**
 * 读取响应体并限制大小。
 * 直接 res.arrayBuffer() 会先把整个响应读进内存再判断大小 —— 一个超大文件就能打爆进程。
 */
export async function readBodyLimited(res, maxBytes) {
  const limit = Number(maxBytes) || 0;
  if (!res) return Buffer.alloc(0);
  const declared = Number(res.headers?.get?.('content-length') || 0);
  if (limit && declared && declared > limit) {
    throw new Error(`响应过大（${Math.round(declared / 1024 / 1024)}MB），已中止`);
  }
  if (!limit || !res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (limit && buf.length > limit) throw new Error('响应过大，已中止');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        /* 取消失败也要抛错，不能把超限数据当成正常结果 */
      }
      throw new Error(`响应过大（超过 ${Math.round(limit / 1024 / 1024)}MB），已中止`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
