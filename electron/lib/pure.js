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

/**
 * 视频片段导出（渲染进程编码出的 data URL）校验。
 *
 * 渲染层可能被注入，所以这里按「内容类型 + 文件名 + 文件头 + 大小」四道闸验证，
 * 拒绝任何把它变成「往任意路径写任意文件」的企图。WebM 的 Blob 常带 ;codecs=vp9，
 * 必须允许这个参数，否则正常导出会被自己的正则挡掉。
 */
export function parseExportPayload(dataUrl, filename, options = {}) {
  const maxBytes = Number(options.maxBytes) || 96 * 1024 * 1024;
  const bad = (error) => ({ ok: false, error });
  if (typeof dataUrl !== 'string' || typeof filename !== 'string') return bad('导出数据不完整');
  const m = /^data:(image\/gif|video\/webm(?:;codecs=[a-z0-9,]+)?);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m) return bad('导出数据不是受支持的 GIF / WebM');
  // \p{L} 允许中文标题；排除路径分隔符与 Windows 保留字符
  if (filename.length > 120 || !/^[\p{L}\p{N}._()（）\- ]+\.(gif|webm)$/iu.test(filename)) {
    return bad('导出文件名不合法');
  }
  const isGif = m[1].toLowerCase() === 'image/gif';
  const ext = isGif ? 'gif' : 'webm';
  if (!filename.toLowerCase().endsWith(`.${ext}`)) return bad('扩展名与内容类型不符');
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > maxBytes) return bad('导出文件超过大小上限');
  const head = buffer.subarray(0, 6);
  const headerOk = isGif
    ? /^GIF8[79]a/.test(head.toString('latin1'))
    : head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  if (!headerOk) return bad('导出内容的文件头不正确');
  return { ok: true, buffer, ext, isGif, filename };
}

/** 本机 / 内网主机名（网页壁纸默认一律拒绝，避免把应用变成任意页面容器） */
export function isLocalOrPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h === '0.0.0.0' || /^127\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^fc|^fd/i.test(h) || h === 'fe80::1') return true;
  return false;
}

/**
 * 网页壁纸地址校验。
 * 默认只放公网 http(s)；显式打开 allowLocalUrl 后才放行本机/内网 http(s) 与
 * 可信目录内的 file://。file:// 仍按路径段比较，绝不接受任意本地文件。
 */
export function isSafeLiveUrl(raw, options = {}) {
  const { allowLocalUrl = false, trustedDir = '' } = options || {};
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.protocol === 'file:') {
    if (!allowLocalUrl || !trustedDir) return false;
    if (u.host && u.host.toLowerCase() !== 'localhost') return false; // UNC 路径一律拒绝
    let p;
    try {
      p = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]):/, '$1:');
    } catch {
      return false;
    }
    return isPathInsideAny(p, [trustedDir]);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const local = isLocalOrPrivateHost(u.hostname);
  if (!local) return true;
  return !!allowLocalUrl;
}

/** 把用户填的「指定 App」归一成 basename / 简单 glob 列表 */
export function normalizePauseApps(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,，\n;；]/);
  const out = [];
  for (const raw of parts) {
    const origin = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
    // 超长、含路径遍历的输入直接丢弃，不静默截断成另一个合法进程名
    if (!origin || origin.length > 80 || origin.includes('..')) continue;
    const v = origin.replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (!v || !/^[\w.*?+\-()[\] ]+$/.test(v)) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

/** 前台进程名是否命中列表（大小写无关，支持 chrome* / *player 这类简单通配） */
export function matchForeground(processName, apps) {
  const name = String(processName || '').toLowerCase().replace(/\\/g, '/').split('/').pop();
  if (!name) return false;
  return normalizePauseApps(apps).some((pattern) => {
    if (pattern === name) return true;
    if (!pattern.includes('*') && !pattern.includes('?')) return false;
    const re = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );
    return re.test(name);
  });
}

/** 暂停策略统一决策：返回命中原因，便于日志/UI 说清「为什么停了」 */
export function shouldPauseLive(cfg, signals = {}) {
  const c = cfg || {};
  const s = signals || {};
  const reasons = [];
  if (c.pauseOnBattery && s.onBattery) reasons.push('battery');
  if (c.pauseOnFullscreen && s.fullscreen) reasons.push('fullscreen');
  const gpu = Number(s.gpu);
  const threshold = Number(c.gpuThreshold);
  if (c.pauseOnGpu && threshold > 0 && Number.isFinite(gpu) && gpu >= 0 && gpu >= threshold) reasons.push('gpu');
  if (s.locked) reasons.push('locked');
  if (s.foreground && matchForeground(s.foreground, c.pauseApps)) reasons.push('app');
  return { paused: reasons.length > 0, reasons };
}

/** 父窗口已被 Chromium / 资源管理器重新认领时，需要重新挂到 WorkerW */
export function liveMountBroken(snapshot) {
  const parent = Number(snapshot?.parent) || 0;
  const workerw = Number(snapshot?.workerw) || 0;
  if (!workerw) return false; // 探测不到 WorkerW 时不下结论，避免误重挂
  return parent !== workerw;
}
