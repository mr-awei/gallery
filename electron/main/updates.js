// @ts-check
/**
 * 自动更新：手动检查（含未打包时的发布页兜底）、应用内下载安装、启动时后台静默检查。
 * 安装前要先把服务停干净（NSIS 要覆盖的文件被子进程占着会装失败），装不上还要把服务拉回来。
 */
import { app } from 'electron';
import { isNewer } from '../lib/pure.js';
import { setSettingsCache, getSettingsSnapshot as getSettings } from '../settings-cache.js';
import {
  OFFICIAL_REPO,
  applyDeferral,
  checkForUpdates,
  deferUpdate,
  dismissUpdate,
  downloadUpdate,
  installUpdate,
  onBeforeInstall,
  onInstallFailed,
  onUpdateReady,
  resetUpdateFailures,
  startBackgroundUpdate,
  updateState,
} from '../updater.js';
import { ctx } from './context.js';
import { fetchJson, handleIpc } from './ipc-base.js';
import { broadcastServiceState, reloadAllAppWindows, stopServerOnce } from './service.js';
import { showMainWindow } from './windows.js';

/** 设置里的更新源（owner/repo）；没配就交给打包时写入的 app-update.yml */
async function updateRepoSetting() {
  try {
    const cfg = await fetchJson(`http://127.0.0.1:${ctx.serverPort}/api/settings`, { method: 'GET' }, 8000);
    const repo = String(cfg?.updateRepo || process.env.TUKU_UPDATE_REPO || '').trim();
    return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
  } catch {
    return '';
  }
}

/**
 * 检查更新（旧通道）：读 GitHub latest release 与本机版本比较，有新版就给出下载链接。
 * 安装版走 electron-updater（update-check），这里给「开发模式 / 浏览器预览」兜底：
 * 比对结果与发布页地址都要能拿到，否则设置里的「检查更新」在没打包时只会报错。
 */
async function checkForUpdatesViaGithub() {
  try {
    const cfg = await fetchJson(`http://127.0.0.1:${ctx.serverPort}/api/settings`, { method: 'GET' }, 8000);
    // 更新源只认官方仓库：设置里即使写了别的项目也不采信（与 updater.js 同一条规则）
    const configured = String(cfg?.updateRepo || process.env.TUKU_UPDATE_REPO || '')
      .trim()
      .toLowerCase();
    const repo = configured === OFFICIAL_REPO ? configured : OFFICIAL_REPO;
    const rel = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, { method: 'GET' }, 15000);
    const latest = String(rel?.tag_name || '').replace(/^v/i, '');
    const current = app.getVersion();
    return {
      ok: true,
      hasUpdate: isNewer(latest, current),
      latest,
      current,
      url: rel?.html_url || `https://github.com/${repo}/releases/latest`,
      repo,
    };
  } catch (err) {
    return { ok: false, msg: String(err?.message || err).slice(0, 160) };
  }
}

/** 更新相关的 IPC 通道（应用内更新状态机） */
export function registerUpdateIpc() {
  handleIpc('check-for-updates', () => checkForUpdatesViaGithub());

  handleIpc('update-check', async () => {
    const st = updateState();
    if (!st.supported) {
      // 开发态没有安装包可替换：明确告诉界面「去发布页下载」，别让按钮静默无反应
      return { ok: false, supported: false, msg: '开发模式不支持应用内更新，请用「检查更新」跳转发布页' };
    }
    // 用户主动点「检查更新」= 明确想再试一次：清掉连续失败计数，
    // 重新允许走强制流程（再失败仍会在第 2 次自动降级）
    resetUpdateFailures();
    return checkForUpdates({ repo: await updateRepoSetting() });
  });
  handleIpc('update-download', () => downloadUpdate());
  handleIpc('update-install', () => installUpdate());
  handleIpc('update-dismiss', () => dismissUpdate());
  /** 「下次打开时安装」：本次放行，下次启动必须先装完（不装就退出） */
  handleIpc('update-defer', () => deferUpdate());
  handleIpc('update-state', () => updateState());
  /** 设置页「清零安装失败计数」：用户修好环境后主动恢复强制更新策略 */
  handleIpc('update-reset-failures', () => {
    resetUpdateFailures();
    return { ok: true };
  });
}

/** 安装前后的窗口/服务联动：安装前停服、装不上把服务拉回来、包就绪时把窗口提上来 */
export function wireUpdateLifecycle() {
  // 安装前：放行窗口关闭，并先把服务停干净 —— 否则 NSIS 要覆盖的正是
  // 子进程还占着的文件，在 Windows 上会直接装失败
  onBeforeInstall(async () => {
    ctx.forceQuit = true;
    await stopServerOnce();
  });

  // 安装没能启动：服务刚被我们停掉，必须拉回来 —— 否则用户点「本次先继续用」
  // 拿到的是一堆接口全挂的页面，跟卡死没区别
  onInstallFailed(async () => {
    ctx.forceQuit = false;
    if (!ctx.serverHost || ctx.serverHost.running) return;
    try {
      ctx.serverStopped = false;
      ctx.serverHost.restarts = [];
      const info = await ctx.serverHost.start();
      ctx.serverPort = info.port;
      ctx.apiToken = info.token || ctx.apiToken;
      setSettingsCache(info.settings || {});
      broadcastServiceState({ restarting: false, port: ctx.serverPort });
      reloadAllAppWindows();
      console.info('[update] 安装失败后已恢复本地服务，端口', ctx.serverPort);
    } catch (err) {
      console.error('[update] 安装失败后恢复服务失败：', err?.message || err);
    }
  });
}

/** 安装包下载完才提示：这时候才需要把窗口提上来（--hidden 启动时看不到遮罩） */
export function wireUpdateReady() {
  onUpdateReady(() => {
    showMainWindow();
  });
}

/**
 * 后台静默检查更新：确认有新版就顺手下载，下载期间界面照常可用；
 * 只有包已经落到本地、能立刻安装时才会弹提示。
 */
export function startBackgroundUpdateCheck() {
  setTimeout(() => {
    void (async () => {
      // 上次选了「下次打开时安装」：这次启动必须先装完，设置里关掉自动检查也不作数
      // （用户已经答应过要装，不能用另一个开关把它无声跳过）
      const mustInstall = applyDeferral();
      // 用户关掉「启动时自动检查更新」就完全不发请求（隐私 / 内网离线部署会这么选）；
      // 手动检查不受这个开关影响，否则设置页里的按钮会变成摆设
      if (!mustInstall && getSettings().autoUpdateCheck === false) {
        console.info('[update] 已按设置跳过启动检查（设置 → 关于可手动检查）');
        return;
      }
      try {
        const r = await startBackgroundUpdate({ repo: await updateRepoSetting() });
        // 跳过（开发态 / 已跑过）时返回的是 { skipped: true }，得先用 in 收窄
        if (r && 'hasUpdate' in r && r.hasUpdate) console.info('[update] 后台下载新版本', r.latest);
      } catch (err) {
        console.warn('[update] 启动检查失败：', err?.message || err);
      }
    })();
  }, 3000);
}
