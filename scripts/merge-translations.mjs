import { readFileSync, writeFileSync } from 'node:fs';

const enPath = 'web/src/locales/en-US.json';
const en = JSON.parse(readFileSync(enPath, 'utf8'));
const todo = JSON.parse(readFileSync('scripts/i18n-translate-todo.json', 'utf8'));

const merged = {};
for (let i = 1; i <= 4; i++) {
  const part = JSON.parse(readFileSync(`scripts/i18n-translated-${i}.json`, 'utf8'));
  Object.assign(merged, part);
}

const missing = [];
const chineseLeft = [];
const placeholderMismatch = [];

for (const { k, zh } of todo) {
  const v = merged[k];
  if (typeof v !== 'string' || v.trim() === '') { missing.push(k); continue; }
  if (/[\u4e00-\u9fa5]/.test(v) && !/[\u4e00-\u9fa5]/.test(zh) === false) {
    // 译文里残留中文（忽略原文本身就是中文的情况，这里要报出来）
    chineseLeft.push({ k, zh, en: v });
  }
  // 检查 ${...} 占位符数量一致
  const cnt = (s) => (s.match(/\$\{[^}]*\}|%s|\{[A-Za-z0-9_]+\}/g) || []).length;
  if (cnt(zh) !== cnt(v)) placeholderMismatch.push({ k, zh, en: v });
  en[k] = v;
}

writeFileSync(enPath, JSON.stringify(en, null, 2) + '\n', 'utf8');

console.log(`合并译文: ${Object.keys(merged).length}`);
console.log(`en-US 总 key: ${Object.keys(en).length}`);
console.log(`缺失: ${missing.length}`, missing.slice(0, 10));
console.log(`残留中文: ${chineseLeft.length}`);
chineseLeft.slice(0, 15).forEach((x) => console.log(`  ${x.k} | ${x.zh} -> ${x.en}`));
console.log(`占位符不一致: ${placeholderMismatch.length}`);
placeholderMismatch.slice(0, 15).forEach((x) => console.log(`  ${x.k} | ${x.zh} -> ${x.en}`));
