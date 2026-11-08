/**
 * 服务进程托管器（Electron 主进程侧）。
 *
 * 为什么要有这一层：以前 Express 直接 import 进主进程跑，一次未捕获异常、
 * 一次 sharp 原生崩溃、一次同步大 SQL 都会把窗口消息循环一起卡死/带走。
 * 现在服务端跑在 utilityProcess 子进程里，这里负责：
 *   - 拉起 / 拿回 { port, token, settings }
 *   - 设置变更、动态壁纸等事件回传主进程
 *   - 崩溃自动重启（带退避与次数上限），端口尽量沿用，避免前端页面失联
 *   - 心跳检测：事件循环被卡死（进程还在但不响应）也要重启
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { restartDelay } from './lib/pure.js';
import { cleanupStaleService, writePidRecord, removePidRecord } from './lib/stale-process.js';

const READY_TIMEOUT = 30_000;
const PING_TIMEOUT = 8_000;
const PING_INTERVAL = 20_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW = 120_000;

export class ServerHost extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.entry  服务进程入口（server/standalone.js 绝对路径）
   * @param {boolean} [opts.desktop] 是否是桌面端（传给服务端 system/info）
   * @param {object} [opts.env] 额外环境变量
   */
  constructor({ entry, desktop = true, env = {} }) {
    super();
    this.entry = entry;
    this.desktop = desktop;
    this.env = env;
    this.child = null;
    this.port = 0;
    this.token = '';
    this.storageDir = '';
    this.settings = {};
    this.stopping = false;
    this.restarts = [];
    this.health = null;
    this.readyWaiters = [];
    this.pendingPing = null;
    /** 是否已经在 dead 前试过「换端口」兜底（每次崩溃窗口只试一次） */
    this._portFallbackTried = false;
  }

  /** 用户手动重启：清空崩溃计数与兜底标记，给一次干净的重启机会 */
  revive() {
    this.restarts = [];
    this._portFallbackTried = false;
  }

  get running() {
    return !!this.child && !this.stopping;
  }

  /**
   * 拉起子进程并等待 ready；失败抛出可读错误（不含堆栈刷屏）。
   * Promise 级互斥：崩溃重启、心跳超时、托盘手动重启可能交叉进入这个方法，
   * 以前会 fork 出两个服务进程抢同一个 SQLite（后者覆盖前者，前者成为孤儿）。
   */
  async start() {
    if (this.running) return this.info();
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _start() {
    if (this.running) return this.info();
    this.stopping = false;
    // 主进程被强杀时 will-quit 不会触发，服务进程会变成持有 gallery.db 的孤儿。
    // fork 之前先按 PID 记录 + 创建时间 + 命令行三重校验回收（见 lib/stale-process.js），
    // 放在这里才能覆盖初次启动、崩溃重启、托盘重启、换端口兜底全部启动路径。
    const userDataDir = process.env.TUKU_USER_DATA || '';
    await cleanupStaleService({
      userDataDir,
      entry: this.entry,
      selfPid: process.pid,
      log: (msg) => console.info(`[api] ${msg}`),
    });
    const { utilityProcess } = await import('electron');
    if (!utilityProcess) throw new Error('当前环境不支持 utilityProcess');

    const child = utilityProcess.fork(this.entry, [], {
      serviceName: 'tuku-api',
      stdio: 'pipe',
      env: {
        ...process.env,
        ...this.env,
        TUKU_DESKTOP: this.desktop ? '1' : '0',
        // 重启时沿用上次端口：前端页面还在这个 origin 上，换端口等于白屏
        TUKU_PORT: String(this.port || 0),
      },
    });
    this.child = child;
    writePidRecord(userDataDir, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      entry: this.entry,
      userDataDir,
    });

    // 必须走 console.*（而不是 process.stdout.write）：主进程的 logger 只挂了 console，
    // 直接写 stdout 在打包版（无控制台）等于把服务端日志全丢了
    const pipe = (level) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) console[level](`[api] ${line}`);
      }
    };
    child.stdout?.on('data', pipe('log'));
    child.stderr?.on('data', pipe('error'));

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`服务进程 ${READY_TIMEOUT / 1000}s 内未就绪`));
      }, READY_TIMEOUT);
      const onMessage = (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          cleanup();
          this._applyReady(msg);
          resolve(this.info());
        } else if (msg.type === 'fatal') {
          cleanup();
          reject(new Error(msg.error || '服务进程启动失败'));
        } else {
          this._handleMessage(msg);
        }
      };
      const onExit = (code) => {
        cleanup();
        reject(new Error(`服务进程启动即退出（code ${code}）`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.on('exit', onExit);
    });

    try {
      const info = await ready;
      // ready 之后的长期监听：退出、消息
      child.on('message', (msg) => this._handleMessage(msg));
      child.on('exit', (code) => this._handleExit(code));
      this._startHealthLoop();
      return info;
    } catch (err) {
      this._killChild();
      throw err;
    }
  }

  info() {
    return { port: this.port, token: this.token, storageDir: this.storageDir, settings: this.settings, pid: this.child?.pid || 0 };
  }

  _applyReady(msg) {
    this.port = Number(msg.port) || 0;
    this.token = String(msg.token || '');
    this.storageDir = String(msg.storageDir || '');
    this.settings = msg.settings || {};
    this.emit('ready', this.info());
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'settings') {
      this.settings = msg.settings || {};
      this.emit('settings', this.settings);
    } else if (msg.type === 'live') {
      this.emit('live', msg.cfg || {});
    } else if (msg.type === 'pong') {
      this._clearPing();
    } else if (msg.type === 'fatal') {
      console.error('[api] 子进程上报致命错误：', msg.error);
      this.emit('fatal', msg.error || '');
    }
  }

  _handleExit(code) {
    this._stopHealthLoop();
    const wasStopping = this.stopping;
    this.child = null;
    if (wasStopping) return;
    console.error(`[api] 服务进程意外退出（code ${code}），准备重启`);
    this._restart(`exit ${code}`);
  }

  /** 崩溃重启：退避 + 时间窗内次数上限；成功后广播新端口（可能变了） */
  _restart(reason) {
    // 串行化：exit 与心跳超时可能同时触发，重复走一遍会白白多杀一次进程
    if (this._restartChain) return this._restartChain;
    this._restartChain = this._doRestart(reason).finally(() => {
      this._restartChain = null;
    });
    return this._restartChain;
  }

  async _doRestart(reason) {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW);
    if (this.restarts.length >= MAX_RESTARTS) {
      // 进 dead 前再兜一次：换个端口重启。固定端口被残留进程 / 安全软件占住时，
      // 反复重启到同一个端口必然再失败，而换端口能绕开这类最常见的死因。
      if (!this._portFallbackTried) {
        this._portFallbackTried = true;
        const savedPort = this.port;
        console.error(`[api] 连续 ${MAX_RESTARTS} 次重启失败，尝试换端口兜底（${reason}）`);
        try {
          this.port = 0; // standalone 会挑一个空闲端口并通过 ready 回报
          const info = await this.start();
          this.restarts = [];
          this._portFallbackTried = false;
          console.info('[api] 换端口兜底成功，端口', info.port);
          this.emit('restarted', info);
          return;
        } catch (err) {
          this.port = savedPort;
          console.error('[api] 换端口兜底也失败：', err?.message || err);
        }
      }
      this.emit('dead', `服务进程连续异常（${reason}），自动重启与换端口兜底均已失败`);
      return;
    }
    this.restarts.push(now);
    const delay = restartDelay(this.restarts.length);
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopping) return;
    try {
      const info = await this.start();
      this.restarts = [];
      this._portFallbackTried = false;
      console.info('[api] 服务进程已重启，端口', info.port);
      this.emit('restarted', info);
    } catch (err) {
      console.error('[api] 重启失败：', err.message);
      this._restart(`restart failed: ${err.message}`);
    }
  }

  _startHealthLoop() {
    this._stopHealthLoop();
    this.health = setInterval(() => {
      if (!this.child || this.stopping || this.pendingPing) return;
      const child = this.child;
      this.pendingPing = setTimeout(() => {
        this.pendingPing = null;
        if (this.child !== child) return;
        console.error('[api] 心跳超时，服务进程疑似卡死，强制重启');
        this._killChild(); // 触发 exit → 自动重启
      }, PING_TIMEOUT);
      try {
        child.postMessage({ type: 'ping' });
      } catch {
        this._clearPing();
      }
    }, PING_INTERVAL);
    this.health.unref?.();
  }

  _stopHealthLoop() {
    if (this.health) clearInterval(this.health);
    this.health = null;
    this._clearPing();
  }

  _clearPing() {
    if (this.pendingPing) clearTimeout(this.pendingPing);
    this.pendingPing = null;
  }

  _killChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    // Windows 上 child.kill() 只杀这一个进程，它拉起的子孙进程会残留并继续持有
    // gallery.db —— 下次启动就撞锁（standalone 里「上次异常退出」的提示就是这个场景）。
    // Electron 未暴露 Job Object 绑定，这里用「taskkill /T 进程树 + 启动前残留清理」
    // 组合覆盖强杀主进程的场景（PID 记录见 lib/stale-process.js）。
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => {
          try {
            child.kill();
          } catch {
            /* 已退出 */
          }
        });
        return;
      } catch {
        /* 落到下面的普通 kill */
      }
    }
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }

  async stop() {
    this.stopping = true;
    // 正在 fork 的话等它落地，否则刚 start 出来的 child 没人收
    if (this._starting) await this._starting.catch(() => {});
    this._stopHealthLoop();
    const child = this.child;
    if (!child) return;
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      /* 通道已断 */
    }
    // 给它 3s 优雅收尾（关库/停服务），超时强杀
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._killChild();
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        this.child = null;
        // 只有确认进程真的退出了才删 PID 记录：超时强杀还留着它，
        // 下次启动才能继续回收（这正是主进程被强杀场景的兜底）
        removePidRecord(process.env.TUKU_USER_DATA || '');
        resolve();
      });
    });
  }
}
