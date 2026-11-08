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
import { API_SCOPE_TOKENS, API_TOKEN, EXTENSION_ORIGINS } from './config.js';
import { expandScopes, parseTokenMap } from './lib/api-scopes.js';
import { audit, rateGuard, tokenTag } from './lib/api-audit.js';

/** 恒定时间字符串比较（长度不同直接 false，长度本身不是秘密） */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 允许把令牌放在 query 里的方法：只读请求。写操作必须用 header */
const QUERY_TOKEN_METHODS = new Set(['GET', 'HEAD']);

/**
 * 请求是否携带有效令牌。
 * 令牌为空时一律返回 false（而不是放行）——空令牌只可能来自配置异常，
 * 那种情况下「静默全站开放」是最糟的默认值。config.js 已保证会退回内存令牌。
 */
let scopedTokens = null;
function getScopedTokens() {
  if (!scopedTokens) scopedTokens = parseTokenMap(API_SCOPE_TOKENS);
  return scopedTokens;
}

/** 从请求头取令牌（写操作只认这个渠道） */
function headerToken(req) {
  const auth = String(req.headers['authorization'] || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-api-token'] || '').trim();
}

/**
 * 解析本次请求携带的令牌及其权限。
 * - 主令牌恒等于 write（展开成 read+write+ingest）
 * - 附加令牌按 api-tokens.json 声明的 scope
 * - headerOnly=true 时拒绝 ?token=：/api/v1 的写操作不允许令牌出现在 URL 里
 * 所有比较都走 timingSafeEqual，避免本机进程按响应时间逐字节猜令牌。
 */
export function resolveToken(req, { headerOnly = false } = {}) {
  if (!API_TOKEN) return { ok: false, scopes: [], kind: 'none' };
  const candidates = [];
  const h = headerToken(req);
  if (h) candidates.push(h);
  const method = String(req.method || 'GET').toUpperCase();
  if (!headerOnly && QUERY_TOKEN_METHODS.has(method) && req.query?.token) {
    candidates.push(String(req.query.token));
  }
  for (const c of candidates) {
    if (safeEqual(c, API_TOKEN)) return { ok: true, scopes: expandScopes(['write']), kind: 'primary', tag: tokenTag(c) };
    for (const [token, scopes] of getScopedTokens()) {
      if (safeEqual(c, token)) return { ok: true, scopes, kind: 'scoped', tag: tokenTag(c) };
    }
  }
  return { ok: false, scopes: [], kind: 'none' };
}

export function hasValidToken(req) {
  return resolveToken(req).ok;
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
  const token = resolveToken(req);
  if (token.ok) {
    // 附加令牌的 scope 必须对主 /api/* 也生效。以前只认「令牌有效」就放行，
    // 于是只声明 read 的令牌可以绕过 /api/v1 的 403，直接 PUT /api/settings 等写接口 ——
    // 「只读令牌」实际并不只读。主令牌与浏览器同源请求不受影响。
    const isWrite = !QUERY_TOKEN_METHODS.has(String(req.method || 'GET').toUpperCase());
    if (token.kind === 'scoped' && isWrite && !token.scopes.includes('write')) {
      return res.status(403).json({ error: '该令牌只有只读权限，不能调用写接口', code: 'SCOPE_DENIED' });
    }
    return next();
  }
  if (isSameOrigin(req)) return next();
  // 端口探测用：无敏感信息，允许匿名
  if (req.path === '/api/health') return next();
  if (req.path === '/api/extension/ingest') {
    const origin = String(req.headers['origin'] || '').toLowerCase();
    if (EXTENSION_ORIGINS.includes(origin)) return next();
  }
  return res.status(401).json({ error: '未授权：缺少或无效的 API 令牌' });
}

/**
 * /api/v1 专用鉴权：外部契约不享受浏览器同源豁免，也不接受写操作的 ?token=。
 * 全局 apiAuth 已先跑过一遍（同源会放行），这里必须再独立校验一次令牌，
 * 否则「本机任意网页」就能借同源绕过 scope，v1 的权限分级形同虚设。
 */
export function v1Auth(req, res, next) {
  const r = resolveToken(req, { headerOnly: true });
  if (!r.ok) {
    return res.status(401).json({ error: '/api/v1 需要 Authorization: Bearer 令牌', code: 'TOKEN_REQUIRED' });
  }
  if (!rateGuard(r.tag || r.kind, 120, 60_000)) {
    return res.status(429).json({ error: '调用过于频繁，请稍后再试（每分钟 120 次）', code: 'RATE_LIMITED' });
  }
  req.apiScopes = r.scopes;
  req.apiTokenKind = r.kind;
  const started = Date.now();
  res.on('finish', () => {
    audit({
      token: r.tag,
      kind: r.kind,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  return next();
}

/** 声明某条 v1 路由需要的 scope；不满足返回 403（与 401「没带令牌」区分开） */
export function requireScope(...needed) {
  return (req, res, next) => {
    const granted = Array.isArray(req.apiScopes) ? req.apiScopes : [];
    if (!needed.length || needed.every((s) => granted.includes(s))) return next();
    return res.status(403).json({
      error: `令牌缺少 ${needed.join('、')} 权限`,
      code: 'SCOPE_DENIED',
      required: needed,
      granted,
    });
  };
}
