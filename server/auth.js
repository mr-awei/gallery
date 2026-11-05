/**
 * 本地 API 鉴权中间件。
 *
 * 威胁模型：服务监听 127.0.0.1，但"只监听回环"不等于安全——
 * 用户浏览器里打开的任意网页都可以向 http://127.0.0.1:3001 发起跨站请求
 * （CSRF、no-cors 探测、DNS rebinding），读取图库内容甚至改写设置/凭据。
 *
 * 放行规则（满足其一）：
 * 1. 携带有效令牌：`Authorization: Bearer <token>` / `x-api-token`
 *    只对 GET/HEAD 额外接受 `?token=`（EventSource、下载直链、图片 src 无法自定义 header）。
 *    写操作必须走 header：URL 会进浏览器历史、服务日志与第三方 Referer，
 *    一旦用 query 令牌发过 POST，泄露的就不只是"看一眼"的权限。
 * 2. 浏览器同源请求：`Sec-Fetch-Site` 为 same-origin / same-site / none。
 *    该头由浏览器（含 Electron）自动附加，页面 JS 无法伪造，覆盖本应用
 *    主窗口、动态壁纸 /live 页、Vite dev 代理等全部正常使用方式。
 * 3. 浏览器扩展采集端点：Origin 命中扩展 ID 白名单（见 config.EXTENSION_ORIGINS）。
 *    之前是任意 `chrome-extension://` 都放行，等于把图库开放给本机所有扩展。
 * 4. 健康检查 /api/health：只返回 {ok,time}，无任何图库数据。桌面版监听随机端口，
 *    扩展必须先探测出端口才能调用，因此这里不能要求令牌。
 *
 * 其余调用方（MCP server、调试脚本）从 TUKU_API_TOKEN 环境变量或
 * .api-token 文件读取令牌后以 Bearer 头调用。
 *
 * 令牌比较一律用 timingSafeEqual：`===` 会在第一个不同的字节处提前返回，
 * 本机进程可以通过响应时间逐字节猜出令牌。
 */
import crypto from 'node:crypto';
import { API_TOKEN, EXTENSION_ORIGINS } from './config.js';

/** 恒定时间字符串比较（长度不同直接 false，长度本身不是秘密） */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 允许把令牌放在 query 里的方法：只读请求。写操作必须用 header */
const QUERY_TOKEN_METHODS = new Set(['GET', 'HEAD']);

/** 请求是否携带有效令牌（API_TOKEN 为空时视为未启用，仅靠回环监听兜底） */
export function hasValidToken(req) {
  if (!API_TOKEN) return true;
  const auth = String(req.headers['authorization'] || '');
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), API_TOKEN)) return true;
  if (safeEqual(req.headers['x-api-token'], API_TOKEN)) return true;
  const method = String(req.method || 'GET').toUpperCase();
  if (QUERY_TOKEN_METHODS.has(method) && safeEqual(req.query?.token, API_TOKEN)) return true;
  return false;
}

/** 是否浏览器视角的同源请求（Sec-Fetch-Site 由浏览器设置，页面 JS 不可伪造） */
function isSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  return site === 'same-origin' || site === 'same-site' || site === 'none';
}

/** 挂在全局，内部只拦 /api/*：静态页面与 /live 渲染页本身不含敏感数据 */
export function apiAuth(req, res, next) {
  if (!req.path.startsWith('/api/') && req.path !== '/api') return next();
  if (req.method === 'OPTIONS') return next();
  if (hasValidToken(req)) return next();
  if (isSameOrigin(req)) return next();
  // 端口探测用：无敏感信息，允许匿名
  if (req.path === '/api/health') return next();
  if (req.path === '/api/extension/ingest') {
    const origin = String(req.headers['origin'] || '').toLowerCase();
    if (EXTENSION_ORIGINS.includes(origin)) return next();
  }
  return res.status(401).json({ error: '未授权：缺少或无效的 API 令牌' });
}
