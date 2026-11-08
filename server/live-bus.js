// 轻量事件总线：服务端保存动态壁纸配置后通知主进程（与 Electron 主进程同进程，
// 用事件解耦，避免 server/app.js 与 electron/main.js 互相 import 造成循环依赖）。
import { EventEmitter } from 'node:events';

export const liveBus = new EventEmitter();
liveBus.setMaxListeners(20);
