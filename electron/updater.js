/**
 * 应用内自动更新（electron-updater）。
 *
 * 以前「检查更新」只是拿 GitHub API 比版本号，然后 `shell.openExternal` 把用户丢到浏览器：
 * 用户下载完还得自己关应用、点安装包、再走一遍安装向导。CI 明明已经把
 * `latest.yml` / `*.blockmap` 传到 Release 了，却没有任何消费者。
 *
 * 这里补上真正的增量更新链路：检查 → 后台下载（带进度）→ 重启安装。
 * - 只在打包版启用（开发态没有 app-update.yml，也没有安装包可替换）
 * - 下载永不自动开始：用户在设置里点了才下，避免偷跑几百 MB 流量
 * - 更新源优先用设置里的 `updateRepo`（owner/repo，方便 fork 自建），
 *   否则交给 electron-builder 打进包的 app-update.yml
 */
import { app, BrowserWindow } from 'electron';

let autoUpdater = null;
let wired = false;

const state = {
  status: 'idle', // idle / checking / available / downloading / downloaded / error
  percent: 0,
  version: '',
  notes: '',
  error: '',
  supported: false,
};

function isSupported() {
  // 开发态没有 app-update.yml，electron-updater 会直接抛「未配置更新源」
  return app.isPackaged;
}

function snapshot() {
  return { ...state, supported: isSupported(), current: app.getVersion() };
}

function broadcast() {
  const payload = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('update-state', payload);
    } catch {
      /* 窗口正在销毁 */
    }
  }
}

function setState(patch) {
  Object.assign(state, patch);
  broadcast();
}

/** 惰性加载：开发态/未装依赖时不要让主进程启动就崩 */
async function loadUpdater() {
  if (autoUpdater) return autoUpdater;
  const mod = await import('electron-updater');
  autoUpdater = mod.autoUpdater || mod.default?.autoUpdater || null;
  if (!autoUpdater) throw new Error('electron-updater 不可用');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  return autoUpdater;
}

function wire(up) {
  if (wired) return;
  wired = true;
  up.on('checking-for-update', () => setState({ status: 'checking', error: '' }));
  up.on('update-available', (info) => {
    setState({
      status: 'available',
      version: String(info?.version || ''),
      notes: String(info?.releaseNotes || '').slice(0, 2000),
      percent: 0,
      error: '',
    });
  });
  up.on('update-not-available', () => setState({ status: 'idle', percent: 0, error: '' }));
  up.on('download-progress', (p) => {
    setState({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0))),
    });
  });
  up.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', percent: 100, version: String(info?.version || state.version) });
  });
  up.on('error', (err) => {
    setState({ status: 'error', error: String(err?.message || err).slice(0, 300) });
  });
}

/** 设置里的 owner/repo → 运行时覆盖更新源（没有就用打包时写入的 app-update.yml） */
function applyRepo(up, repo) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(repo || '').trim());
  if (!m) return false;
  try {
    up.setFeedURL({ provider: 'github', owner: m[1], repo: m[2] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查更新。
 * @param {{ repo?: string }} [opts]
 * @returns {Promise<{ok:boolean, supported:boolean, hasUpdate?:boolean, latest?:string, current:string, msg?:string}>}
 */
export async function checkForUpdates(opts = {}) {
  if (!isSupported()) {
    return { ok: false, supported: false, current: app.getVersion(), msg: '当前是开发模式，自动更新只在安装版可用' };
  }
  try {
    const up = await loadUpdater();
    wire(up);
    applyRepo(up, opts.repo);
    setState({ status: 'checking', error: '' });
    const r = await up.checkForUpdates();
    const latest = String(r?.updateInfo?.version || state.version || '');
    return {
      ok: true,
      supported: true,
      hasUpdate: !!r?.isUpdateAvailable,
      latest,
      current: app.getVersion(),
      notes: String(r?.updateInfo?.releaseNotes || '').slice(0, 2000),
    };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    setState({ status: 'error', error: msg });
    return { ok: false, supported: true, current: app.getVersion(), msg };
  }
}

/** 后台下载更新（带进度事件），返回立刻，进度走 update-state 广播 */
export async function downloadUpdate() {
  if (!isSupported()) return { ok: false, msg: '当前是开发模式，自动更新只在安装版可用' };
  if (state.status === 'downloading') return { ok: true, already: true };
  try {
    const up = await loadUpdater();
    wire(up);
    setState({ status: 'downloading', percent: 0, error: '' });
    // 不 await：downloadUpdate 的 promise 要到下载完才 resolve，会卡住 IPC
    up.downloadUpdate().catch((err) => {
      setState({ status: 'error', error: String(err?.message || err).slice(0, 300) });
    });
    return { ok: true };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    setState({ status: 'error', error: msg });
    return { ok: false, msg };
  }
}

/** 退出并安装（isSilent=false 会拉起安装向导，用户能看到进度） */
export async function installUpdate() {
  if (!isSupported()) return { ok: false, msg: '当前是开发模式，自动更新只在安装版可用' };
  if (state.status !== 'downloaded') return { ok: false, msg: '更新包还没下载完成' };
  const up = await loadUpdater();
  // 先让主进程走正常退出流程（停服务、存设置），再交给安装包
  setImmediate(() => {
    try {
      up.quitAndInstall(false, true);
    } catch (err) {
      setState({ status: 'error', error: String(err?.message || err).slice(0, 300) });
    }
  });
  return { ok: true };
}

/** 当前更新状态（设置页首次渲染时取一次，之后靠 update-state 事件） */
export function updateState() {
  return snapshot();
}
