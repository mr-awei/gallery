import { readFileSync, writeFileSync } from 'node:fs';

const enPath = 'web/src/locales/en-US.json';
const en = JSON.parse(readFileSync(enPath, 'utf8'));
const delta = JSON.parse(readFileSync('scripts/i18n-delta.json', 'utf8'));

const merged = {};
for (const f of ['scripts/i18n-delta-out-1.json', 'scripts/i18n-delta-out-2.json']) {
  Object.assign(merged, JSON.parse(readFileSync(f, 'utf8')));
}

const missing = [];
const bad = [];
const cnt = (s) => (s.match(/\$\{[^}]*\}|%s|\{[A-Za-z0-9_]+\}/g) || []).length;
for (const { k, zh } of delta) {
  const v = merged[k];
  if (typeof v !== 'string' || !v.trim()) { missing.push(k); continue; }
  if (/[\u4e00-\u9fa5]/.test(v)) bad.push({ k, zh, v, why: '中文残留' });
  if (cnt(zh) !== cnt(v)) bad.push({ k, zh, v, why: '占位符不一致' });
  en[k] = v;
}
writeFileSync(enPath, JSON.stringify(en, null, 2) + '\n', 'utf8');

const left = Object.keys(en).filter((k) => k.startsWith('k') && /[\u4e00-\u9fa5]/.test(String(en[k] ?? '')));
console.log('delta 合并:', Object.keys(merged).length);
console.log('缺失:', missing.length, missing.slice(0, 5));
console.log('问题:', bad.length);
bad.slice(0, 10).forEach((x) => console.log(`  ${x.k} ${x.why} | ${x.zh} -> ${x.v}`));
console.log('en-US 仍含中文的 key:', left.length, left.slice(0, 5));
