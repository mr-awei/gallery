#!/usr/bin/env node
/**
 * node --test 的包装器：原样流式输出测试结果，正常退出时把「通过数」登记到
 * docs/.verify-stats.json，供 scripts/doc-stats.mjs 回写文档。
 * 失败时绝不登记（文档不能出现一轮失败的数字）。
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeStat } from './doc-stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = [
  '--import',
  './test/support/ts-ext.mjs',
  '--test',
  '--test-concurrency=1',
  'test/**/*.test.mjs',
];

const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => {
  process.stdout.write(d);
  out += String(d);
});
child.stderr.on('data', (d) => process.stderr.write(d));

child.on('close', (code) => {
  if (code === 0) {
    // spec reporter: "ℹ pass 345"；tap reporter: "# pass 345"
    const m = out.match(/(?:ℹ|#)\s*pass\s+(\d+)/);
    if (m) writeStat('unit', Number(m[1]));
    else console.error('[unit] 没解析到通过数，文档统计不会更新');
  }
  process.exit(code ?? 1);
});
