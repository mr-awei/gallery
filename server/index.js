/**
 * 独立运行入口（npm start / npm run dev / 浏览器直连）。
 *
 * 真正的启动逻辑在 standalone.js（同样被 Electron utilityProcess 用）：
 * 那里带未捕获异常兜底、SIGTERM 优雅关库、端口占用提示。
 * 这里只保留入口文件的位置，避免两套启动代码各改一半。
 */
process.env.GEM_DESKTOP = process.env.GEM_DESKTOP || '0';
await import('./standalone.js');
