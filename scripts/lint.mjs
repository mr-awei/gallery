#!/usr/bin/env node
/**
 * 零依赖 lint：对 server / electron / scripts 全部 JS 做 node --check 语法校验，
 * 并给出明显坏味道（调试残留）告警。
 * exitCode != 0 即存在语法错误。CI 与本地 npm run lint 共用。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPES = ['server', 'electron', 'scripts'];
const EXT = /\.(c|m)?js$/;
const SKIP = /node_modules|dist|release-build|\.codebuddy|_tmp/;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (!SKIP.test(p)) walk(p, out);
    } else if (EXT.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = SCOPES.flatMap((s) => walk(path.join(ROOT, s)));
let failed = 0;
let warned = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`[lint] 语法错误 ${rel}`);
    console.error(String(err.stderr || err.message).slice(0, 800));
    continue;
  }
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const debug = lines.filter((l) => /^\s*console\.log\(/.test(l)).length;
  // verify-* 是 npm run verify 的报告输出脚本，console.log 是本职，不按调试残留告警
  const isReportScript = /^scripts[\\/]verify-[^\\/]*\.mjs$/.test(rel);
  if (debug > 8 && !isReportScript) {
    warned++;
    console.warn(`[lint] ${rel}: ${debug} 处 console.log（调试残留？）`);
  }
}

console.log(`[lint] 检查 ${files.length} 个文件：${failed} 个语法错误，${warned} 个告警`);
if (failed > 0) process.exit(1);
