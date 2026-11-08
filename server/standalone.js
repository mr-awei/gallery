/**
 * 独立服务进程入口。
 *
 * 桌面端不再把 Express 起在 Electron 主进程里，而是 utilityProcess 拉起
 * 这个文件：SQLite / sharp / 采集 / AI 全在这一侧，主进程只做窗口与系统集成。
 * 好处是「服务端卡住或崩掉」不会再拖死窗口消息循环，主进程也能单独重启它。
 *
 * 与父进程的约定（parentPort 或 child_process IPC）：
 *   → { type: 'ready', port, token, storageDir, settings, pid }
 *   → { type: 'settings', settings }        设置变了（主进程要跟着改代理/目录/自启）
 *   → { type: 'live', cfg }                 动态壁纸配置变了
 *   → { type: 'fatal', error }              启动失败，父进程据此提示/重试
 *   ← { type: 'shutdown' }                  父进程要求优雅退出
 *   ← { type: 'ping' }                      → { type:'pong' }
 */
import { settingsBus } from './lib/settings-bus.js';
import { liveBus } from './live-bus.js';

const isDesktop = process.env.TUKU_DESKTOP === '1';

/** 统一的父进程通道：Electron utilityProcess 用 parentPort，node fork 用 process.send */
const channel = (() => {
  if (process.parentPort?.postMessage) {
    return {
      send: (msg) => {
        try {
          process.parentPort.postMessage(msg);
        } catch {
          /* 父进程没了，忽略 */
        }
      },
      onMessage: (fn) => process.parentPort.on('message', (e) => fn(e?.data ?? e)),
    };
  }
  if (typeof process.send === 'function') {
    return {
      send: (msg) => {
        try {
          process.send(msg);
        } catch {
          /* 同上 */
        }
      },
      onMessage: (fn) => process.on('message', fn),
    };
  }
  return { send: () => {}, onMessage: () => {} };
})();

let serverRef = null;
let shuttingDown = false;

/**
 * 崩溃兜底：服务端出错必须把栈写进日志并让父进程重启自己，
 * 而不是安静地留在半死状态（监听还在、请求全挂）。
 */
function fatal(kind, err) {
  const detail = err instanceof Error ? `${err.stack || err.message}` : String(err);
  console.error(`[server] ${kind}`, detail);
  channel.send({ type: 'fatal', error: `${kind}: ${detail}`.slice(0, 4000) });
  // 给 IPC 一点时间把消息送出去再退出，父进程会重新拉起一个干净进程
  setTimeout(() => process.exit(1), 100);
}

process.on('uncaughtException', (err) => fatal('uncaughtException', err));
process.on('unhandledRejection', (err) => fatal('unhandledRejection', err));

async function main() {
  const [{ startServer }, { API_TOKEN, STORAGE_DIR, PORT }, { getSettings }] = await Promise.all([
    import('./app.js'),
    import('./config.js'),
    import('./db.js'),
  ]);

  // 桌面端用随机端口（避免多实例/残留进程抢 3001）；独立运行（npm start / dev）沿用配置端口，
  // 否则 Vite 代理与文档里的 http://localhost:3001 就对不上了
  const wantPort = Number(process.env.TUKU_PORT) || (isDesktop ? 0 : PORT);
  let started;
  try {
    started = await startServer(wantPort, { desktop: isDesktop });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      // 桌面端：端口被别的程序抢走时不能让整个服务退出（主进程重试几次就会进 dead，
      // 表现是「界面开着但所有接口 404」）。直接回退到系统分配的随机端口，
      // 把新端口放在 ready 消息里回传，主进程据此重载窗口。
      if (isDesktop) {
        console.warn(`[server] 端口 ${wantPort} 已被占用，改用系统分配的随机端口`);
        try {
          started = await startServer(0, { desktop: isDesktop });
        } catch (err2) {
          fatal('listen', err2);
          return;
        }
      } else {
        console.error(
          `\n  端口 ${wantPort} 已被占用：可能已有一个图库实例在运行（或上次异常退出留下的残留进程）。\n` +
            '  处理办法：结束已运行的 node 进程后重试；或换端口启动：\n' +
            '    PowerShell:  $env:PORT=3002; npm start\n' +
            '    CMD:         set PORT=3002&& npm start\n'
        );
        process.exit(1);
      }
    } else {
      throw err;
    }
  }
  const { server, port } = started;
  serverRef = server;
  console.log(`[server] 独立进程就绪 http://127.0.0.1:${port} (pid ${process.pid})`);
  if (!isDesktop) {
    // 浏览器直连需要带令牌（前端会自己保存到 localStorage，之后可省）
    console.log(`\n  本地图库服务  →  http://localhost:${port}/${API_TOKEN ? `?token=${API_TOKEN}` : ''}\n`);
  }

  const snapshot = () => {
    try {
      return getSettings();
    } catch (err) {
      console.error('[server] 读取设置快照失败', err.message);
      return {};
    }
  };

  channel.send({
    type: 'ready',
    port,
    token: API_TOKEN,
    storageDir: STORAGE_DIR,
    settings: snapshot(),
    pid: process.pid,
  });

  // 首次升级：按磁盘目录为库中已有图片回填文件夹树（幂等，很快）
  // 以前这一步写在 index.js 里，入口统一到 standalone 后必须在这里做，否则老库文件夹树是空的
  try {
    const { backfillFolders } = await import('./folders.js');
    backfillFolders();
  } catch (err) {
    console.error('[server] 回填文件夹树失败', err.message);
  }

  // 上次退出前开着局域网投送：启动即恢复，不让用户每次重开应用都要再点一次
  const { syncLanSetting } = await import('./lib/lan.js');
  await syncLanSetting(snapshot()).catch((err) => console.error('[lan] 恢复投送开关失败', err?.message || err));

  // 主进程需要「设置 / 动态壁纸」这两类本地能力才能跟上服务端状态
  settingsBus.on('changed', (settings) => {
    channel.send({ type: 'settings', settings });
    // toggle 路由也会调一次，syncLanSetting 是幂等的
    syncLanSetting(settings).catch((err) => console.error('[lan] 同步投送开关失败', err?.message || err));
  });
  liveBus.on('changed', (cfg) => channel.send({ type: 'live', cfg }));

  channel.onMessage((msg) => {
    if (msg?.type === 'shutdown') return shutdown('parent-request');
    if (msg?.type === 'ping') channel.send({ type: 'pong' });
  });

  return server;
}

/** 优雅退出：先停止接新连接，再关库，最后退出（避免 SQLite 半写事务） */
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到退出信号（${reason}），正在收尾…`);
  const done = () => process.exit(0);
  const timer = setTimeout(done, 4000);
  timer.unref?.();
  try {
    // 独立端口的投送服务必须一起关，否则进程退出了端口还挂着（下次启动换端口，二维码全失效）
    try {
      const { stopLanServer } = await import('./lib/lan.js');
      await stopLanServer();
    } catch (err) {
      console.error('[lan] 关闭投送服务失败', err?.message || err);
    }
    if (serverRef) await new Promise((resolve) => serverRef.close(resolve));
    const { db } = await import('./db.js');
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  } catch (err) {
    console.error('[server] 收尾失败', err.message);
  }
  clearTimeout(timer);
  done();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => fatal('startup', err));
