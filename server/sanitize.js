/**
 * 采集结果统一轻量 schema 校验（纯函数，零依赖）：
 * URL 必须 http(s)、限长、去重、封顶。
 * 防止改版页/风控页把脏数据（跟踪链接、html 片段、超长串）直接带进下载队列。
 */
export function sanitizeResults(list, { limit = 240 } = {}) {
  const seen = new Set();
  const out = [];
  for (const it of list || []) {
    const u = String(it?.url || '');
    if (!/^https?:\/\//i.test(u) || u.length > 2048 || seen.has(u)) continue;
    seen.add(u);
    out.push({ ...it, url: u });
    if (out.length >= limit) break;
  }
  return out;
}
