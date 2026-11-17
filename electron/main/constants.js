// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 应用根目录（electron/ 的上一级） */
export const APP_ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * 开机自启写入的登录项参数里带了 --hidden，但以前没有任何代码消费它：
 * 开机自启 = 一登录就把主窗口糊到用户脸上。这里统一判定，启动时只留托盘。
 */
export const START_HIDDEN = process.argv.includes('--hidden');

export const APP_NAME = '图库';
// 磁盘上的目录名一律 ASCII：安装目录、AppData 数据目录都会跟着它走。
// 中文目录还有实打实的坑——node:sqlite 在中文路径下关闭后句柄不释放，
// 删库目录会卡住（见 server/libraries.js 里库目录也用 ASCII 名）。
export const APP_DIR_NAME = 'TuKu';
export const APP_ICON = path.join(APP_ROOT_DIR, 'build', 'icon.ico');

/** 开发用：让桌面窗口加载 Vite 开发服务器（前端热更新），API 走 npm run dev 起的 3001。
 *  打包版一律忽略：--dev-url / TUKU_DEV_URL 可加载任意远程页面且携带完整桥接，绝不能在生产生效。 */
export function devServerUrl() {
  if (app.isPackaged) return '';
  const arg = process.argv.find((a) => a.startsWith('--dev-url='));
  return arg ? arg.slice('--dev-url='.length) : process.env.TUKU_DEV_URL || '';
}
