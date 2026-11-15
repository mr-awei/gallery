// @ts-check
/**
 * 托盘图标：不打开主窗口也能换壁纸、收藏当前壁纸、重启本地服务。
 * 托盘菜单的结果统一走 trayNotify（提示窗 + 菜单里的「上次操作」）。
 */
import { Menu, Tray, app } from 'electron';
import { getSettingsSnapshot, setSettingsCache } from '../settings-cache.js';
import { APP_ICON, APP_NAME } from './constants.js';
import { ctx } from './context.js';
import { fetchJson } from './ipc-base.js';
import { restartLocalServer } from './service.js';
import { requestRegionShot } from './shot.js';
import { trayNotify } from './toast.js';
import { wallpaperAction } from './wallpaper.js';
import { showMainWindow } from './windows.js';

const getSettings = getSettingsSnapshot;

export function createTray() {
  if (ctx.tray) return;
  try {
    ctx.tray = new Tray(APP_ICON);
  } catch (err) {
    console.error('[tray] 托盘创建失败：', err?.message || err);
    return;
  }
  ctx.tray.setToolTip(`${APP_NAME} · 本地图片管理`);

  const refreshMenu = async () => {
    if (!ctx.tray || ctx.tray.isDestroyed()) return;
    // 端口还没就绪时去请求 http://127.0.0.1:0/... 只会刷一堆错误日志
    if (!ctx.serverPort) return;
    let cur = {};
    let auto = {};
    let live = {};
    // 托盘菜单三项状态：服务在重启的那几十毫秒里会失败，用默认值渲染即可，
    // 但失败要留一行日志，否则「菜单里壁纸一直是旧的」永远查不到原因
    try {
      cur = (await fetchJson(`http://127.0.0.1:${ctx.serverPort}/api/wallpaper/current`)) || {};
    } catch (e) {
      console.info('[tray] 当前壁纸读取失败:', e?.message || e);
    }
    try {
      auto = (await fetchJson(`http://127.0.0.1:${ctx.serverPort}/api/wallpaper/auto`))?.config || {};
    } catch (e) {
      console.info('[tray] 自动壁纸配置读取失败:', e?.message || e);
    }
    try {
      live = (await fetchJson(`http://127.0.0.1:${ctx.serverPort}/api/wallpaper/live`)) || {};
    } catch (e) {
      console.info('[tray] 动态壁纸配置读取失败:', e?.message || e);
    }
    const title = String(cur.title || '').slice(0, 16);
    // 显式标注：否则数组里混着 {label} 与 {type:'separator'} 时 type 会被推成 string，
    // 不满足 MenuItemConstructorOptions 的字面量联合类型
    /** @type {import('electron').MenuItemConstructorOptions[]} */
    const template = [
      // 条件展开必须显式断言：TS 无法把条件表达式的数组字面量上下文推断为
      // MenuItemConstructorOptions，会让整条模板的 type 退化成 string
      .../** @type {import('electron').MenuItemConstructorOptions[]} */ (
        ctx.lastTrayNotice
          ? [{ label: `上次操作：${ctx.lastTrayNotice}`, enabled: false }, { type: 'separator' }]
          : []
      ),
      { label: '打开主窗口', click: showMainWindow },
      {
        label: '框选截图…',
        click: () => {
          // 窗口隐藏 / 屏幕抓取被拦时这里会抛，不能静默吞掉
          void Promise.resolve(requestRegionShot())
            .catch((err) => trayNotify('截图没成功', err?.message || '屏幕抓取不可用，试试打开主窗口再截'))
            .finally(() => refreshMenu());
        },
      },
      {
        label: ctx.restartingServer ? '正在重启本地服务…' : '重启本地服务',
        enabled: !ctx.restartingServer,
        click: () => {
          void restartLocalServer().then((ok) => {
            if (ok) trayNotify('本地服务已重启', '现在可以继续换壁纸、收藏了');
            refreshMenu();
          });
        },
      },
      {
        label: '关闭窗口时最小化到托盘',
        type: 'checkbox',
        checked: getSettings().closeToTray !== false,
        click: async (item) => {
          const next = !!item.checked;
          // 先落本地快照：close 事件可能在这个请求返回前就触发，否则会「点一次不生效」
          setSettingsCache({ ...getSettingsSnapshot(), closeToTray: next });
          try {
            await fetchJson(
              `http://127.0.0.1:${ctx.serverPort}/api/settings`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ closeToTray: next }),
              },
              5000
            );
          } catch (err) {
            console.error('[tray] 保存托盘常驻设置失败：', err?.message || err);
            // 保存失败就回滚开关，别让界面显示的和实际行为不一致
            setSettingsCache({ ...getSettingsSnapshot(), closeToTray: !next });
            trayNotify('设置没保存', err?.message || '本地服务没响应');
            refreshMenu();
          }
        },
      },
      { type: 'separator' },
      { label: '换一张壁纸　Ctrl+Alt+W', click: () => wallpaperAction('now') },
      {
        label: title ? `收藏当前壁纸（${title}）` : '收藏当前壁纸',
        enabled: !!cur.imageId,
        click: () => wallpaperAction('favorite'),
      },
      {
        label: '不喜欢，换一张',
        enabled: !!cur.imageId,
        click: () => wallpaperAction('dislike'),
      },
      { type: 'separator' },
      {
        label: live.enabled ? '关闭动态壁纸' : '开启动态壁纸',
        click: async () => {
          const next = !live.enabled;
          try {
            // 只保存配置，真正的创建/销毁由 liveBus 广播触发（server → 主进程 → 窗口）
            await fetchJson(
              `http://127.0.0.1:${ctx.serverPort}/api/wallpaper/live`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
              }
            );
            trayNotify(
              next ? '动态壁纸已开启' : '动态壁纸已关闭',
              next ? '桌面会按当前壁纸动起来；想停就在托盘菜单再点一次' : ''
            );
          } catch (err) {
            console.error('[tray] 动态壁纸切换失败：', err?.message || err);
            trayNotify('动态壁纸没切换', err?.message || '本地服务没响应，试试「重启本地服务」');
          }
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: auto.enabled ? '暂停定时切换' : '启用定时切换',
        click: async () => {
          const next = !auto.enabled;
          try {
            const data = await fetchJson(
              `http://127.0.0.1:${ctx.serverPort}/api/wallpaper/auto`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
              }
            );
            if (!data || data.error) throw new Error(data?.error || '服务没有返回结果');
            const every = data?.config?.intervalMinutes || auto.intervalMinutes;
            trayNotify(
              next ? '定时切换已开启' : '定时切换已暂停',
              next && every ? `每 ${every} 分钟换一张` : ''
            );
          } catch (err) {
            console.error('[tray] 切换定时失败：', err?.message || err);
            trayNotify('定时切换没生效', err?.message || '本地服务没响应');
          }
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          ctx.forceQuit = true;
          app.quit();
        },
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    ctx.tray.setContextMenu(menu);
  };

  ctx.trayMenuRefresher = refreshMenu;
  ctx.tray.on('click', showMainWindow);
  refreshMenu();
  // 句柄要留着才能在退出时 clear：以前这个 interval 会活到进程结束
  if (ctx.trayTimer) clearInterval(ctx.trayTimer);
  ctx.trayTimer = setInterval(refreshMenu, 30000); // 让菜单里的「当前壁纸」保持最新
  console.info('[tray] 托盘已就绪（左键打开窗口 / 右键菜单）');
}

/** 退出前清掉托盘菜单的轮询定时器 */
export function stopTrayTimer() {
  if (ctx.trayTimer) {
    clearInterval(ctx.trayTimer);
    ctx.trayTimer = null;
  }
}
