import { startServer } from './app.js';
import { PORT, API_TOKEN } from './config.js';
import { watchStorageDir } from './importer.js';
import { backfillFolders } from './folders.js';

let port;
try {
  ({ port } = await startServer(PORT));
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用：可能已有一个图库实例在运行，或端口被其他程序占用。\n  处理办法：先结束已运行的实例，或用 PORT=xxxx npm start 换端口。\n`);
    process.exit(1);
  }
  throw err;
}
// API 已开启鉴权：浏览器访问请用带令牌的地址（前端会自动保存，之后不带 token 也能访问）
const suffix = API_TOKEN ? `?token=${API_TOKEN}` : '';
console.log(`\n  邓紫棋照片采集器  →  http://localhost:${port}/${suffix}\n`);
watchStorageDir();
// 首次升级：为库中已有图片按磁盘目录回填文件夹树（幂等）
backfillFolders();
