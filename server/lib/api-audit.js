/**
 * /api/v1 的内存限流与审计环形缓冲。
 * 只记方法、路径、状态码、令牌标签（哈希前 8 位），绝不记令牌明文或请求体。
 * 进程重启即清空：这是本机服务的轻量保护，不是分布式审计系统。
 */
import crypto from 'node:crypto';

const buckets = new Map();
const entries = [];
const MAX_ENTRIES = 500;

/** 令牌标签：可关联同一令牌的调用，但泄露了也不能反推令牌 */
export function tokenTag(token) {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex').slice(0, 8);
}

/** 固定窗口限流。返回 true 表示放行 */
export function rateGuard(key, limit = 120, windowMs = 60_000) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.since >= windowMs) {
    b = { since: now, hits: 0 };
    buckets.set(key, b);
  }
  b.hits++;
  if (buckets.size > 1000) {
    // 防止匿名扫描把 Map 撑大：只在超量时清一次过期桶
    for (const [k, v] of buckets) if (now - v.since >= windowMs) buckets.delete(k);
  }
  return b.hits <= limit;
}

export function audit(entry) {
  entries.unshift({ at: new Date().toISOString(), ...entry });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

export function auditList(limit = 50) {
  return entries.slice(0, Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 50)));
}

/** 单测用：清掉全局状态 */
export function resetApiAudit() {
  buckets.clear();
  entries.length = 0;
}
