/**
 * 设置变更事件总线。
 *
 * 用途只有一个：服务端跑在独立子进程里时，把「设置已改」这件事推给
 * Electron 主进程（主进程需要 storageDir / 代理 / 开机自启等本地能力）。
 *
 * 放在独立模块而不是 db.js 里，是为了避免 db.js ←→ 订阅方 的循环引用：
 * db.js 只负责 emit，standalone.js 负责转发。
 */
import { EventEmitter } from 'node:events';

export const settingsBus = new EventEmitter();
settingsBus.setMaxListeners(20);
