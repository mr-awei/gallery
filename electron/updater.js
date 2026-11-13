// @ts-check
/**
 * 应用内更新（electron-updater）
 *
 * 流程（2026-11 再调整）：
 *   启动 → 后台静默检查 → 有新版本就在后台静默下载 → **下载完成才提示用户**
 *
 * 用户不会在「检查中 / 下载中」被一块遮罩锁住——那段时间照常使用应用；
 * 下载失败也只是后台按退避重试，不打扰。只有更新包已经躺在本机磁盘上时，
 * 才弹出全屏提示（web 端 ForcedUpdateOverlay），并且**由用户二选一**：
 *   · 现在安装 → 立刻重启装（原来的强制行为）
 *   · 下次打开时安装 → 本次照常用，把版本记到 update-deferred.json
 *
 * 「下次打开时安装」是有约束的延后：下次启动**必须先把这个版本装掉**，
 * 不装就退出（遮罩只给「安装」和「退出应用」，没有「继续用」）。
 * 只有装不上的极端情况才回到旧的出口（连续失败 → 降级成非强制），
 * 否则一份装不上的包会把人永久锁在门外。
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
import { deferralVerdict } from './lib/update-policy.js';

/** 唯一允许的更新源：写死，避免「设置被改 → 自动装上无关的安装包」 */
export const OFFICIAL_REPO = 'mr-awei/gallery';

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

/* --------------------------- 「下次打开时安装」记账 --------------------------- */

/** 用户选了「下次打开时安装」后要记住的目标版本（跨启动） */
function deferFile() {
  return path.join(app.getPath('userData'), 'update-deferred.json');
}

function readDeferral() {
  try {
    const raw = JSON.parse(fs.readFileSync(deferFile(), 'utf8'));
    return { version: String(raw?.version || ''), at: String(raw?.at || '') };
  } catch {
    return { version: '', at: '' };
  }
}

function writeDeferral(version) {
  try {
    fs.writeFileSync(deferFile(), JSON.stringify({ version, at: new Date().toISOString() }));
  } catch {
    /* userData 不可写时退化为「本次会话内记住」，不能因此拦住启动 */
  }
}

function clearDeferral() {
  try {
    fs.unlinkSync(deferFile());
  } catch {
    /* 文件本来就不存在 */
  }
}

/**
 * 启动时套用上次的「下次打开时安装」。
 * 返回 true = 本次启动必须先装完更新（调用方据此不做「关掉自动检查」的跳过）。
 */
export function applyDeferral() {
  if (!isSupported()) return false;
  const d = readDeferral();
  const verdict = deferralVerdict(d.version, app.getVersion());
  if (verdict === 'none') return false;
  if (verdict === 'done') {
    // 上次其实装成了（或已被手动升级到更高版本）：旧账作废
    clearDeferral();
    return false;
  }
  if (forceUpdateEnabled() === false) {
    // 强制更新被关掉（内网离线部署 / 连续装不上已降级）：不许用一个开关把人锁死
    console.warn('[update] 有待安装的延后更新，但强制更新已关闭，本次不强制');
    setState({ deferred: true, deferredVersion: d.version, mandatory: false });
    return false;
  }
  console.info(`[update] 上次选择了「下次打开时安装」：本次启动必须先装上 v${d.version}`);
  setState({ deferred: true, deferredVersion: d.version, mandatory: true });
  return true;
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
  /** 用户选过「下次打开时安装」（本次会话已放行，下次启动要装） */
  deferred: false,
  /** 本次启动处于「必须先装完」状态：遮罩只给「安装 / 退出」，没有继续用 */
  mandatory: false,
  /** 延后安装的目标版本 */
  deferredVersion: '',
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
/** @type {(text: string) => Promise<void>} 安装失败后的恢复回调（由主进程注册：拉回服务、清降级遮罩） */
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
  // 降级 = 承认这台机器装不上：连同「下次打开时安装」的记账一起清掉，
  // 否则下次启动又会被同一份装不上的包挡住（死循环）
  if (degraded) clearDeferral();
  setState({
    status: 'error',
    ready: true,
    degraded,
    mandatory: degraded ? false : state.mandatory,
    deferred: degraded ? false : state.deferred,
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
    if (forceMode || state.mandatory) void downloadUpdate();
  });

  up.on('update-not-available', () => {
    retries = 0;
    // 服务器上已经没有比当前更新的版本了（或延后要装的那个被撤了）：
    // 没有任何东西可装，就不能拿「必须安装」把人锁死，清账放行
    if (state.mandatory) {
      console.warn('[update] 本次必须先安装，但更新源已没有可用版本，解除强制');
      clearDeferral();
    }
    setState({ status: 'idle', percent: 0, error: '', mandatory: false, deferred: false, deferredVersion: '' });
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
    // 只有「上次选了下次打开时安装」这一种情况才不再问、直接装：
    // 用户上次已经明确授权过，本次启动就是来履行承诺的。
    // 普通流程（刚下载完）一律等用户在遮罩上二选一，不强制重启。
    if (state.mandatory) {
      console.info('[update] 延后安装到期：本次启动直接安装');
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

/**
 * 「下次打开时安装」：本次照常用，记下要装的版本。
 * 下次启动 applyDeferral() 会把 mandatory 打开——不装就退出。
 */
export function deferUpdate() {
  if (!state.ready) return { ok: false, msg: '更新包还没下载完成' };
  const version = state.version || '';
  if (!version) return { ok: false, msg: '不知道要安装哪个版本' };
  writeDeferral(version);
  clearWatchdog();
  installing = false;
  setState({ deferred: true, deferredVersion: version, mandatory: false, dismissed: true });
  console.info(`[update] 已安排下次启动安装 v${version}`);
  return { ok: true, version };
}

/**
 * 「本次先继续用」：不让遮罩挡住这一轮，下次启动仍会重新检查。
 * 处于「必须先装完」的启动里不生效——那种情况下只有安装和退出两条路。
 */
export function dismissUpdate() {
  if (!state.ready) return { ok: false, msg: '没有待安装的更新' };
  if (state.mandatory) {
    return { ok: false, msg: '上次选择了「下次打开时安装」，这次必须先完成更新（也可以直接退出应用）' };
  }
  clearWatchdog();
  installing = false;
  setState({ dismissed: true });
  return { ok: true };
}

export function updateState() {
  return snapshot();
}
