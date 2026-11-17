import { readFileSync, writeFileSync } from 'node:fs';

const report = JSON.parse(readFileSync('scripts/i18n-replace-report.json', 'utf8'));
const zhExisting = JSON.parse(readFileSync('web/src/locales/zh-CN.json', 'utf8'));
const enExisting = JSON.parse(readFileSync('web/src/locales/en-US.json', 'utf8'));

// 收集 report 里所有 k 开头的扁平 key
const flat = new Map();
for (const e of report) {
  if (!e.key.startsWith('k')) continue;
  flat.set(e.key, e.zh);
}
const sortedKeys = [...flat.keys()].sort();

// zh-CN: 保留原命名空间 + 追加扁平词条
const zhOut = { ...zhExisting };
for (const k of sortedKeys) zhOut[k] = flat.get(k);

// en-US: 保留原命名空间，扁平词条先放中文占位（后续翻译覆盖）
const enOut = { ...enExisting };
for (const k of sortedKeys) if (!(k in enOut)) enOut[k] = flat.get(k);

writeFileSync('web/src/locales/zh-CN.json', JSON.stringify(zhOut, null, 2) + '\n', 'utf8');
writeFileSync('web/src/locales/en-US.json', JSON.stringify(enOut, null, 2) + '\n', 'utf8');

// 导出待翻译清单
const todo = sortedKeys.map((k) => ({ k, zh: flat.get(k) }));
writeFileSync('scripts/i18n-translate-todo.json', JSON.stringify(todo, null, 2), 'utf8');

console.log(`zh-CN: ${Object.keys(zhOut).length} keys`);
console.log(`en-US: ${Object.keys(enOut).length} keys`);
console.log(`待翻译: ${todo.length}`);
