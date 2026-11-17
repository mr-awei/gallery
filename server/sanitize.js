/**
 * 采集结果统一 schema 校验（纯函数，零依赖）。
 *
 * 以前只挡了「非 http(s) / 超长 / 重复 / 超上限」四类脏 URL，站点改版或风控页
 * 仍可能把空 source、坏 referer、超长字符串、嵌套对象直接带进下载队列与库里。
 * 现在做字段级校验：URL 必须真的能解析、来源必须在白名单、其它字段类型/长度受限。
 *
 * 被剔除的项挂在返回数组的非枚举属性 `rejected` 上（{url, reason}[]），
 * 调用方可以据此写失败清单，而返回值仍然是一个普通数组，不破坏既有调用。
 */
const SAFE_TYPES = new Set(['string', 'number', 'boolean', 'undefined']);
const MAX_FIELD_LEN = 2048;

/** @typedef {{ok:true, value:Record<string, unknown>}} ValidResult */
/** @typedef {{ok:false, reason:string, url:string}} InvalidResult */

/**
 * 校验单条采集结果。
 * @param {unknown} it 候选结果
 * @param {Set<string>|null} [allowedSources] 允许的来源 key；null 表示不校验来源
 * @returns {ValidResult|InvalidResult}
 */
export function validateResult(it, allowedSources = null) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) {
    return { ok: false, reason: '结果不是对象', url: '' };
  }
  const obj = /** @type {Record<string, unknown>} */ (it);
  const u = typeof obj.url === 'string' ? obj.url.trim() : '';
  if (!u || u.length > MAX_FIELD_LEN) return { ok: false, reason: 'URL 缺失或超长', url: u };
  if (/^https?:\/\//i.test(u) === false) return { ok: false, reason: 'URL 协议不是 http(s)', url: u };
  // 控制字符/空白可能让下游 fetch 拼出畸形请求
  if (/[\u0000-\u001f\u007f]/.test(u)) return { ok: false, reason: 'URL 含控制字符', url: u };
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return { ok: false, reason: 'URL 无法解析', url: u };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    return { ok: false, reason: 'URL 缺少主机名或协议非法', url: u };
  }

  const source = typeof obj.source === 'string' ? obj.source.trim() : '';
  if (allowedSources && (!source || !allowedSources.has(source))) {
    return { ok: false, reason: `来源「${source || '空'}」不在白名单`, url: u };
  }

  const referer = obj.referer == null ? '' : String(obj.referer);
  if (
    referer &&
    (!/^https?:\/\//i.test(referer) || referer.length > MAX_FIELD_LEN || /[\u0000-\u001f\u007f]/.test(referer))
  ) {
    return { ok: false, reason: 'referer 非法', url: u };
  }

  for (const [key, value] of Object.entries(obj)) {
    if (['url', 'source', 'referer'].includes(key)) continue;
    if (value === null || SAFE_TYPES.has(typeof value)) {
      if (typeof value === 'string' && value.length > MAX_FIELD_LEN) {
        return { ok: false, reason: `字段 ${key} 超长`, url: u };
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        return { ok: false, reason: `字段 ${key} 不是有限数`, url: u };
      }
      continue;
    }
    return { ok: false, reason: `字段 ${key} 类型不允许（${typeof value}）`, url: u };
  }

  return { ok: true, value: { ...obj, url: u } };
}

/**
 * 清洗一批采集结果：去重 + 封顶 + 字段级校验。
 * @param {unknown[]} list 原始结果
 * @param {{limit?:number, sources?:string[]}} [opts] sources 为允许来源白名单
 */
export function sanitizeResults(list, { limit = 240, sources = null } = {}) {
  const allowed = Array.isArray(sources) ? new Set(sources) : null;
  const seen = new Set();
  const rejected = [];
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    const v = validateResult(it, allowed);
    if (!v.ok) {
      const bad = /** @type {InvalidResult} */ (v);
      rejected.push({ url: bad.url, reason: bad.reason });
      continue;
    }
    const u = String(v.value.url);
    if (seen.has(u)) {
      rejected.push({ url: u, reason: '重复 URL' });
      continue;
    }
    seen.add(u);
    out.push(v.value);
    if (out.length >= limit) break;
  }
  // 非枚举：JSON 序列化 / 展开成队列时不会把拒绝原因一起带走
  Object.defineProperty(out, 'rejected', { value: rejected, enumerable: false });
  return out;
}
