import { readFileSync, writeFileSync } from 'node:fs';
const zh = JSON.parse(readFileSync('web/src/locales/zh-CN.json', 'utf8'));
const en = JSON.parse(readFileSync('web/src/locales/en-US.json', 'utf8'));
const todo = Object.keys(zh)
  .filter((k) => k.startsWith('k'))
  .filter((k) => /[\u4e00-\u9fa5]/.test(String(en[k] ?? '')))
  .map((k) => ({ k, zh: zh[k] }));
writeFileSync('scripts/i18n-delta.json', JSON.stringify(todo, null, 2), 'utf8');
const N = 2;
const size = Math.ceil(todo.length / N);
for (let i = 0; i < N; i++) {
  const chunk = todo.slice(i * size, (i + 1) * size);
  writeFileSync(`scripts/i18n-delta-${i + 1}.json`, JSON.stringify(chunk, null, 2), 'utf8');
  console.log(`delta-${i + 1}: ${chunk.length}`);
}
console.log('待翻译总数:', todo.length);
