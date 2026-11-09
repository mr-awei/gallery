// @ts-check
/**
 * /api/v1 的 scope 纯逻辑（不碰 config / 请求对象，便于单测）。
 *
 * 三级权限：read 只读 / write 写（隐含 read + ingest）/ ingest 仅投送。
 * 主令牌（.api-token）恒等价于 write；额外令牌由 api-tokens.json 或
 * TUKU_API_SCOPE_TOKENS 配置，配置错误时宁可拒绝也不能悄悄放大权限。
 */
export const SCOPE_LIST = Object.freeze(['read', 'write', 'ingest']);

/** 只保留合法 scope，去重并小写 */
export function normalizeScopes(raw) {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [
    ...new Set(
      arr
        .map((s) => String(s ?? '').trim().toLowerCase())
        .filter((s) => SCOPE_LIST.includes(s))
    ),
  ];
}

/** write 隐含 read + ingest：写令牌本来就能读、也能投送 */
export function expandScopes(raw) {
  const set = new Set(normalizeScopes(raw));
  if (set.has('write')) {
    set.add('read');
    set.add('ingest');
  }
  return [...set];
}

/**
 * 解析「令牌 → scopes」配置，返回 Map。
 * 支持两种写法：
 *   { "tokenA": ["read"], "tokenB": "write" }
 *   [{ "token": "tokenA", "scopes": ["read"], "label": "只读脚本" }]
 * 非法条目整条丢弃（不能让格式错误变成「无 scope 但可用」）。
 */
export function parseTokenMap(raw) {
  const out = new Map();
  const put = (token, scopes) => {
    const t = String(token ?? '').trim();
    const s = expandScopes(scopes);
    if (t.length >= 8 && s.length) out.set(t, s);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) if (item && typeof item === 'object') put(item.token, item.scopes);
  } else if (raw && typeof raw === 'object') {
    for (const [token, scopes] of Object.entries(raw)) put(token, scopes);
  }
  return out;
}

/** 某次请求需要的最小 scope（按方法推断，路由仍可显式覆盖） */
export function scopeForMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'read' : 'write';
}

/** granted 是否覆盖 needed 里的每一项 */
export function hasScope(granted, needed) {
  const g = new Set(Array.isArray(granted) ? granted : []);
  const n = Array.isArray(needed) ? needed : [needed];
  return n.every((s) => g.has(s));
}
