/**
 * 应用内更新（electron-updater）
 *
 * 流程（2026-11 调整）：
 *   启动 → 后台静默检查 → 有新版本就在后台静默下载 → **下载完成才提示用户**
 *
 * 用户不会在「检查中 / 下载中」被一块遮罩锁住——那段时间照常使用应用；
 * 下载失败也只是后台按退避重试，不打扰。只有更新包已经躺在本机磁盘上、
 * 可以立刻安装时，才弹出全屏提示（web 端 ForcedUpdateOverlay）并自动重启安装。
 *
 * 装不上时有出口：安装失败会关闭 autoInstallOnAppQuit（否则用户一退出就重装、
 * 又失败，形成死循环），并允许「本次先继续用，下次启动再试」。
 *
 * - 只在打包版启用（开发态没有 app-update.yml，也没有安装包可替换）
 * - 检查失败（断网 / 更新源 404）不锁界面：没确认有新版本就没理由把人挡在门外
 * - 更新源只认官方仓库（见 OFFICIAL_REPO），设置里的 updateRepo 不能指向别的项目
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

/** 唯一允许的更新源：写死，避免「设置被改 → 自动装上无关的安装包」 */
const OFFICIAL_REPO = 'mr-awei/gallery';

/**
 * 安装连续失败达到这个次数后，强制更新自动降级为非强制。
 * 否则每次启动都被同一份装不上的更新包挡在遮罩后面，用户只能手动改环境变量。
 */
const MAX_INSTALL_FAILURES = 2;

/** 失败计数存在 userData（跨启动保留），版本变了就说明升级成功、旧账作废 */
function failureFile() {
  return path.join(app.getPath('userData'), 'update-failures.json');
}

function readFailures() {
  try {
    const raw = JSON.parse(fs.readFileSync(failureFile(), 'utf8'));
    return { count: Math.max(0, Number(raw?.count) || 0), version: String(raw?.version || '') };
  } catch {
    return { count: 0, version: '' };
  }
}

function writeFailures(data) {
  try {
    fs.writeFileSync(failureFile(), JSON.stringify(data));
  } catch {
    /* userData 不可写时退化为「本次会话内降级」，不能因此拦住启动 */
  }
}

function bumpInstallFailure() {
  const prev = readFailures();
  const version = app.getVersion();
  const next = { count: (prev.version === version ? prev.count : 0) + 1, version };
  writeFailures(next);
  return next.count;
}

/** 用户主动点「检查更新」时清账：允许重新走一次强制流程 */
export function resetUpdateFailures() {
  writeFailures({ count: 0, version: app.getVersion() });
}

/** 后台失败重试的退避间隔（检查或下载失败时用） */
const RETRY_DELAYS = [60_000, 180_000, 600_000];

let autoUpdater = null;
let wired = false;

const state = {
  status: 'idle', // idle / checking / available / downloading / downloaded / error
  percent: 0,
  version: '',
  notes: '',
  error: '',
  supported: false,
  /** 安装包已下载到本地，可以安装：界面据此显示遮罩 */
  ready: false,
  /** 用户选择「本次先继续用」后置 true，本次会话不再遮挡 */
  dismissed: false,
  /** 连续装不上、强制更新已自动降级：界面据此给出正确文案 */
  degraded: false,
};

/** 强制更新模式（有新版就自动下载并重启安装） */
let forceMode = false;
/** 启动自动检查只跑一次（窗口重建 / 多窗口不会再触发） */
let kickedOff = false;
/** 已重试次数，防止网络一直不通时无限循环 */
let retries = 0;
let retryTimer = null;

export function snapshot() {
  return {
    ...state,
    current: app.getVersion(),
    force: forceMode,
    installFailures: readFailures().count,
  };
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

/** 更新包就绪时的回调（主进程用它把窗口提上来，免得 --hidden 启动看不到提示） */
let readyHandler = null;
export function onUpdateReady(fn) {
  readyHandler = fn;
}

/** 安装前必须做的事（主进程注入：置 forceQuit，否则窗口 close 会缩回托盘、装不上） */
let prepareQuit = () => {};
export function onBeforeInstall(fn) {
  prepareQuit = fn;
}

/**
 * 安装失败后必须做的事（主进程注入）。
 * prepareQuit 已经把本地服务停掉了（NSIS 要覆盖的文件被子进程占着）。
 * 安装一旦没能启动，用户点「本次先继续用」面对的就是一个接口全挂的空壳，
 * 所以这里必须把服务重新拉起来。
 */
let recoverAfterFailure = async () => {};
export function onInstallFailed(fn) {
  recoverAfterFailure = fn;
}

/** 防止同一时刻反复拉起安装程序（自动安装计时器 + 用户点「重试安装」可能撞车） */
let installing = false;
/** 安装程序迟迟没接手时（quitAndInstall 静默失败）的看门狗 */
let watchdog = null;

function clearWatchdog() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
}

// 真的要退出了（quitAndInstall 生效会触发 before-quit）：看门狗作废
app.on('before-quit', clearWatchdog);

/** 安装没能启动：置错误态、放开重试、把服务救回来 */
function failInstall(msg) {
  clearWatchdog();
  installing = false;
  const text = String(msg || '安装程序未能启动').slice(0, 240);
  const failures = bumpInstallFailure();
  const degraded = failures >= MAX_INSTALL_FAILURES;
  setState({
    status: 'error',
    ready: true,
    degraded,
    error: degraded
      ? `启动安装程序失败：${text}。已连续 ${failures} 次装不上，强制更新已自动关闭：本次可正常使用，想再试请到「设置 → 检查更新」手动触发。`
      : `启动安装程序失败：${text}`,
  });
  Promise.resolve()
    .then(() => recoverAfterFailure(text))
    .catch((err) => console.warn('[update] 安装失败后恢复失败：', err?.message || err));
}

/** 是否启用强制更新。内网离线部署可用 TUKU_FORCE_UPDATE=off 关闭（正式包不要设）。 */
export function forceUpdateEnabled() {
  if (String(process.env.TUKU_FORCE_UPDATE ?? 'on').toLowerCase() === 'off') return false;
  const f = readFailures();
  const version = app.getVersion();
  if (f.version !== version) {
    // 版本号变了 = 上次升级真的成功了，清掉旧账恢复强制策略
    if (f.count) writeFailures({ count: 0, version });
    return true;
  }
  if (f.count >= MAX_INSTALL_FAILURES) {
    console.warn(`[update] 连续 ${f.count} 次安装失败，本次启动降级为非强制更新`);
    return false;
  }
  return true;
}

function isSupported() {
  // 开发态没有 app-update.yml，electron-updater 会直接抛「未配置更新源」
  return app.isPackaged;
}

/** 惰性加载：开发态/未装依赖时不要让主进程启动就崩 */
async function loadUpdater() {
  if (autoUpdater) return autoUpdater;
  const mod = await import('electron-updater');
  autoUpdater = mod.autoUpdater || mod.default?.autoUpdater || null;
  if (!autoUpdater) throw new Error('electron-updater 不可用');
  autoUpdater.autoDownload = false;
  // 默认不在退出时偷偷安装：强制路径由 installUpdate 显式触发，
  // 失败后必须能停下来（否则「退出→重装→再失败」是死循环）
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  // 事件必须挂上：不挂就没有 update-available / download-progress / update-downloaded，
  // 后台下载与「就绪才提示」整条链路都不会发生
  wire(autoUpdater);
  return autoUpdater;
}

function wire(up) {
  if (wired) return;
  wired = true;

  up.on('checking-for-update', () => setState({ status: 'checking', error: '' }));

  up.on('update-available', (info) => {
    const force = forceUpdateEnabled();
    if (force) forceMode = true;
    setState({
      status: 'available',
      version: String(info?.version || ''),
      notes: String(info?.releaseNotes || '').slice(0, 2000),
      percent: 0,
      error: '',
    });
    // 后台直接下：界面仍然可用，不遮挡、不提示「正在下载」
    if (forceMode) void downloadUpdate();
  });

  up.on('update-not-available', () => {
    retries = 0;
    setState({ status: 'idle', percent: 0, error: '' });
  });

  up.on('download-progress', (p) => {
    setState({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0))),
    });
  });

  up.on('update-downloaded', (info) => {
    retries = 0;
    setState({
      status: 'downloaded',
      percent: 100,
      version: String(info?.version || state.version),
      ready: true,
      dismissed: false,
      error: '',
    });
    try {
      readyHandler?.();
    } catch (err) {
      console.warn('[update] 就绪回调失败：', err?.message || err);
    }
    if (forceMode) {
      // 给界面 1.2s 把「正在重启安装」画出来
      setTimeout(() => {
        void installUpdate();
      }, 1200);
    }
  });

  up.on('error', (err) => {
    const wasDownloading = state.status === 'downloading';
    setState({ status: 'error', error: String(err?.message || err).slice(0, 300) });
    // 后台安静重试：用户此时还在正常用，不该看到任何东西
    scheduleRetry(() => (wasDownloading ? downloadUpdate() : checkForUpdates()));
  });
}

function scheduleRetry(again) {
  if (retries >= RETRY_DELAYS.length) return;
  const delay = RETRY_DELAYS[retries];
  retries += 1;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void again();
  }, delay);
}

/** 设置里的 owner/repo → 运行时覆盖更新源；只接受官方仓库 */
function applyRepo(up, repo) {
  const want = String(repo || '')
    .trim()
    .toLowerCase();
  if (!want) return false;
  if (want !== OFFICIAL_REPO) {
    console.warn('[update] 已忽略非官方更新源：', want);
    return false;
  }
  const [owner, name] = want.split('/');
  try {
    up.setFeedURL({ provider: 'github', owner, repo: name });
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
    return {
      ok: false,
      supported: false,
      current: app.getVersion(),
      msg: '开发模式没有更新源，自动更新只在安装版可用',
    };
  }
  try {
    const up = await loadUpdater();
    applyRepo(up, opts.repo);
    setState({ supported: true, error: '' });
    const r = await up.checkForUpdates();
    const latest = String(r?.updateInfo?.version || '');
    const hasUpdate = !!latest && latest !== app.getVersion();
    if (hasUpdate) setState({ version: latest });
    // 服务端确认「已是最新版」：此前的安装失败账目可以清掉了
    else writeFailures({ count: 0, version: app.getVersion() });
    return { ok: true, supported: true, hasUpdate, latest, current: app.getVersion() };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    // 检查这一步失败（断网 / 更新源不可达）说明不了「有新版本」，不锁界面
    setState({ status: 'error', error: msg });
    scheduleRetry(() => checkForUpdates(opts));
    return { ok: false, supported: true, current: app.getVersion(), msg };
  }
}

/**
 * 启动时的后台更新检查：确认有新版就静默下载，下载完成才提示并重启安装。
 * 只跑一次；开发态直接跳过。
 * @param {{ repo?: string }} [opts]
 */
export async function startBackgroundUpdate(opts = {}) {
  if (kickedOff) return { skipped: true };
  kickedOff = true;
  if (!isSupported()) return { skipped: true };
  return checkForUpdates(opts);
}

/** 后台下载更新（带进度事件），返回立刻，进度走 update-state 广播 */
export async function downloadUpdate() {
  if (!isSupported()) return { ok: false, msg: '当前是开发模式，自动更新只在安装版可用' };
  if (state.status === 'downloading') return { ok: true, already: true };
  try {
    const up = await loadUpdater();
    setState({ status: 'downloading', error: '' });
    await up.downloadUpdate();
    return { ok: true };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    setState({ status: 'error', error: msg });
    scheduleRetry(() => downloadUpdate());
    return { ok: false, msg };
  }
}

/** 退出并安装（isSilent=false 会拉起安装向导，用户能看到进度） */
export async function installUpdate() {
  if (!isSupported()) return { ok: false, msg: '当前是开发模式，自动更新只在安装版可用' };
  if (!state.ready) return { ok: false, msg: '更新包还没下载完成' };
  if (installing) return { ok: true, already: true };
  installing = true;
  let up;
  try {
    up = await loadUpdater();
  } catch (err) {
    // 模块没加载成功也要放开重试，否则按钮从此永远「正在启动…」
    installing = false;
    return { ok: false, msg: String(err?.message || err).slice(0, 240) };
  }
  // 装不上时不能留 autoInstallOnAppQuit=true，否则用户退出会被反复重装
  up.autoInstallOnAppQuit = false;
  setImmediate(async () => {
    try {
      // prepareQuit 会先停服务（释放安装包要覆盖的文件），再拉起安装程序
      await prepareQuit?.();
      up.quitAndInstall(false, true);
      // quitAndInstall 可能既不抛错也不真的启动安装程序（签名/权限/被安全软件拦下）。
      // 那种情况下应用会一直停在这里：看门狗超时后按失败处理，用户不至于被锁死。
      clearWatchdog();
      watchdog = setTimeout(() => {
        watchdog = null;
        if (installing) failInstall('安装程序没有响应，可能被杀毒软件拦截');
      }, 30_000);
      watchdog.unref?.();
    } catch (err) {
      failInstall(String(err?.message || err));
    }
  });
  return { ok: true };
}

/** 「本次先继续用」：不让遮罩挡住这一轮，下次启动仍会重新检查 */
export function dismissUpdate() {
  if (!state.ready) return { ok: false, msg: '没有待安装的更新' };
  clearWatchdog();
  installing = false;
  setState({ dismissed: true });
  return { ok: true };
}

export function updateState() {
  return snapshot();
}
