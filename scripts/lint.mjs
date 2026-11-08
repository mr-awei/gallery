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
  // verify-* / bench-* 是报告输出脚本（verify 的校验报告、性能基准的 p50/p95 表格），
  // console.log 就是它的产出，不按调试残留告警
  const isReportScript =
    /^scripts[\\/](manual[\\/])?verify-[^\\/]*\.mjs$/.test(rel) || /^scripts[\\/]bench[^\\/]*\.mjs$/.test(rel);
  // electron/ 严格为 0：生命周期日志统一走 console.info（logger 已接管，会落盘），
  // console.log 只可能是临时调试残留。server/ 与 scripts/ 放宽到 8，
  // 它们跑在子进程里，stdout 会被主进程按行转发，console.log 是正常输出手段。
  const strict = /^electron[\\/]/.test(rel);
  const limit = strict ? 0 : 8;
  if (debug > limit && !isReportScript) {
    if (strict) {
      failed++;
      console.error(`[lint] ${rel}: ${debug} 处 console.log（electron 里请改用 console.info）`);
    } else {
      warned++;
      console.warn(`[lint] ${rel}: ${debug} 处 console.log（调试残留？）`);
    }
  }
}

console.log(`[lint] 检查 ${files.length} 个文件：${failed} 个语法错误，${warned} 个告警`);
if (failed > 0) process.exit(1);
