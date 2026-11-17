/**
 * 代理规则的纯逻辑 + Electron 会话应用。
 *
 * 从 network.js 拆出来是为了让**主进程**也能直接用：
 * 服务端拆到独立进程后，主进程不能再 import ./db.js（SQLite 只能有一个属主），
 * 而 network.js 顶层 import db 会把整条 SQLite 依赖链拉进主进程。
 * 这里只接受「网络配置对象」，不读库，所以两边都能用。
 */

export const PROXY_MODES = [
  { key: 'off', label: '关闭（直连）' },
  { key: 'system', label: '系统代理（自动）' },
  { key: 'http', label: 'HTTP' },
  { key: 'https', label: 'HTTPS' },
  { key: 'socks5', label: 'SOCKS5' },
  { key: 'socks4', label: 'SOCKS4' },
];

const DEFAULTS = { mode: 'off', host: '127.0.0.1', port: 7890, username: '', password: '', bypass: '<local>' };

/** 补齐缺省值；对 undefined/null 也返回可用对象 */
export function normalizeNet(net) {
  const s = net || {};
  return {
    mode: s.mode || DEFAULTS.mode,
    host: s.host || DEFAULTS.host,
    port: Number(s.port) || DEFAULTS.port,
    username: s.username || '',
    password: s.password || '',
    bypass: s.bypass || DEFAULTS.bypass,
  };
}

/** 生成 Chromium proxyRules；直连/系统代理返回空串 */
export function proxyRules(net) {
  const n = normalizeNet(net);
  if (n.mode === 'off' || n.mode === 'system') return '';
  return `${n.mode}://${n.host}:${n.port}`;
}

let sessionPromise = null;
function electronSession() {
  // 纯 Node 环境没有 electron 运行时：import 会触发 node_modules/electron 的二进制下载
  if (!process.versions.electron) return Promise.resolve(null);
  if (!sessionPromise) {
    sessionPromise = import('electron')
      .then((m) => (m && m.session ? m.session : null))
      .catch(() => null);
  }
  return sessionPromise;
}

/** 应用代理到 Chromium 默认会话（只在 Electron 主进程有效，其它环境返回 false） */
export async function applyProxyNet(net) {
  const ses = await electronSession();
  if (!ses) return false;
  const n = normalizeNet(net);
  try {
    if (n.mode === 'off') {
      await ses.defaultSession.setProxy({ mode: 'direct' });
    } else if (n.mode === 'system') {
      await ses.defaultSession.setProxy({ mode: 'system' });
    } else {
      await ses.defaultSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxyRules(n),
        proxyBypassRules: n.bypass || '<local>',
      });
    }
    return true;
  } catch (err) {
    console.error('[network] 应用代理失败', err.message);
    return false;
  }
}

/** 代理需要账号密码时由 Chromium 触发 login 事件；getNet 每次现取，改了设置立刻生效 */
export function registerProxyAuthFor(getNet) {
  if (!process.versions.electron) return;
  import('electron')
    .then((m) => {
      if (!m?.app) return;
      m.app.on('login', (event, _webContents, _details, authInfo, callback) => {
        if (!authInfo.isProxy) return;
        const n = normalizeNet(getNet());
        if (n.username || n.password) {
          event.preventDefault();
          callback(n.username, n.password);
        }
      });
    })
    .catch(() => {});
}
