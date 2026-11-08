import { importLocalImages } from '../importer.js';

const result = await importLocalImages({
  onProgress: (progress, file, r) => {
    if (progress % 10 === 0) console.log(`${progress}% · ${file} · 已保存 ${r.saved}`);
  },
});
console.log('导入完成', result);
process.exit(0);
