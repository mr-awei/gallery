import { readFileSync, writeFileSync } from 'node:fs';
const todo = JSON.parse(readFileSync('scripts/i18n-translate-todo.json', 'utf8'));
const N = 4;
const size = Math.ceil(todo.length / N);
for (let i = 0; i < N; i++) {
  const chunk = todo.slice(i * size, (i + 1) * size);
  writeFileSync(`scripts/i18n-translate-chunk-${i + 1}.json`, JSON.stringify(chunk, null, 2), 'utf8');
  console.log(`chunk-${i + 1}: ${chunk.length} entries`);
}
