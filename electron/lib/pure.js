/**
 * 主进程里「值得单测」的纯函数集中在这里。
 *
 * 以前它们都写在 main.js 的 whenReady 闭包里：版本比较（决定会不会降级）、
 * 路径白名单、本机 URL 判定、origin 比对、HTML 转义 —— 全是安全关键逻辑，
 * 却只能靠手测。抽出来以后由 test/electron-pure.test.mjs 覆盖。
 *
 * 这里只允许依赖 node:path 这类无副作用模块，保证 node --test 能直接加载。
 */
import path from 'node:path';

/** 语义化版本比较：a 比 b 新返回 true（只看前三段，缺省按 0） */
export function isNewer(a, b) {
  // 容忍 "v1.2.3" 这种带前缀的写法：GitHub Release 的 tag_name 常常带 v
  const seg = (n) => parseInt(String(n).replace(/^[^\d]*/, ''), 10) || 0;
  const pa = String(a ?? '').split('.').map(seg);
  const pb = String(b ?? '').split('.').map(seg);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * target 是否等于 roots 之一或位于其下（路径白名单）。
 * rel 为空 = 就是根目录本身（「打开存储文件夹」按钮就是这么调的），必须放行。
 */
export function isPathInsideAny(target, roots) {
  if (typeof target !== 'string' || !target.trim()) return false;
  if (!Array.isArray(roots) || !roots.length) return false;
  const abs = path.resolve(target);
  return roots.filter(Boolean).some((root) => {
    const rel = path.relative(path.resolve(root), abs);
    if (rel === '') return true;
    return !(rel === '..' || rel.startsWith(`..${path.sep}`)) && !path.isAbsolute(rel);
  });
}

/**
 * URL 是否指向本机服务。
 * host 必须精确相等（不能用 includes —— 127.0.0.1.attacker.example 会命中）；
 * 传了 port 就必须同端口。
 */
export function isLocalApiUrl(raw, port) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
    if (!port) return true;
    return Number(u.port || 80) === Number(port);
  } catch {
    return false;
  }
}

/** target 的 origin 是否在允许集合里（精确比对，含端口） */
export function originAllowed(target, origins) {
  try {
    const origin = new URL(String(target)).origin;
    return origins instanceof Set ? origins.has(origin) : Array.isArray(origins) && origins.includes(origin);
  } catch {
    return false;
  }
}

/** HTML 转义（托盘提示窗是拼字符串渲染的，标题里带 < 就会破版） */
export function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * 服务子进程崩溃重启的退避策略：第 1/2/3 次分别等 500/1500/3000ms。
 * 抽出来是为了能单测「次数 → 延迟」的映射，不用真的把进程杀掉。
 */
export const RESTART_DELAYS = [500, 1500, 3000];

export function restartDelay(failCount) {
  const i = Math.max(0, Math.min(RESTART_DELAYS.length - 1, Number(failCount || 1) - 1));
  return RESTART_DELAYS[i];
}
