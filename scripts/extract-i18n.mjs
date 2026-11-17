#!/usr/bin/env node
/**
 * 批量抽取脚本：扫 web/src 下所有 TypeScript 文件中的中文字面量，
 * 输出候选 key + 原文，供人工翻译/写入 locales 使用。
 *
 * 用法：
 *   node scripts/extract-i18n.mjs                # 扫一遍、输出 JSON
 *   node scripts/extract-i18n.mjs --report-only   # 只打印统计，不写文件
 *
 * 规则：
 *   - 跳过 .test.mjs 里的断言（测试里的中文预期值不进 locle）
 *   - 跳过纯注释行
 *   - 跳过 import / require 里的路径字符串
 *   - 同一字符串多次出现时合并（key 统一用原字符串 hash 化）
 *   - 跳过长度 < 2 或 > 200 的中文（太短多半是标点、太长多半是 HTML 注释或 JSON blob）
 *
 * 产出：scripts/i18n-candidates.json
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';

/** 遍历 dir 下所有 .ts / .tsx 文件 */
function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
      walk(full, acc);
    } else if (EXTS.includes(extname(e.name))) {
      acc.push(full.replace(/\\/g, '/'));
    }
  }
  return acc;
}

const EXTS = ['.ts', '.tsx'];
const DIRS = ['web/src'];
const REPORT_ONLY = process.argv.includes('--report-only');

const files = [];
for (const dir of DIRS) {
  walk(dir, files);
}
// 剔除测试文件
const srcFiles = files.filter((f) => !f.endsWith('.test.mjs'));

// 匹配 JS/TS 字符串字面量中的中文（单引号、双引号、反引号都算）
// 捕获组 1 = 引号类型（' " `），捕获组 2 = 字符串内容
const STRING_RE = /(['"`])((?:\\.|(?!\1)[^\\])*[\u4e00-\u9fa5][^\\]*?)\1/g;
// 单行注释（// …）和块注释（/* … */）里的内容要排除，
// 简单做法是先把整段注释替换成空格占位，不影响字符串坐标
const LINE_COMMENT_RE = /\/\/.*$/gm;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

const candidates = new Map(); // key(hash) -> { key, zh, files: [], contexts: [] }

for (const file of srcFiles) {
  const raw = readFileSync(file, 'utf8');
  // 注释打洞，避免把注释里的中文也算进来
  const masked = raw.replace(BLOCK_COMMENT_RE, (m) => ' '.repeat(m.length))
                     .replace(LINE_COMMENT_RE, (m) => ' '.repeat(m.length));
  // 路径字符串也跳过（粗略：包含 '/' 或 '\' 的直接跳过）
  let m;
  while ((m = STRING_RE.exec(masked)) !== null) {
    const lit = m[2].trim();
    if (lit.length < 2 || lit.length > 200) continue;
    if (lit.includes('/') || lit.includes('\\')) continue; // 跳过路径
    // 排除明显是 emoji-only / 纯数字标签
    if (!/[\u4e00-\u9fa5]/.test(lit)) continue;
    const key = 'k' + createHash('md5').update(lit).digest('hex').slice(0, 8);
    let entry = candidates.get(key);
    if (!entry) {
      entry = { key, zh: lit, files: [], contexts: [] };
      candidates.set(key, entry);
    }
    if (!entry.files.includes(file)) entry.files.push(file);
    // 上下文：取该行附近 30 字符
    const lineStart = masked.lastIndexOf('\n', m.index) + 1;
    const lineText = masked.slice(lineStart, masked.indexOf('\n', m.index) > 0
      ? masked.indexOf('\n', m.index)
      : masked.length).trim();
    if (!entry.contexts.includes(lineText) && entry.contexts.length < 3) {
      entry.contexts.push(lineText);
    }
  }
}

const sorted = [...candidates.values()].sort((a, b) =>
  (b.files.length + b.contexts.length) - (a.files.length + a.contexts.length)
);

const stats = {
  totalFilesScanned: srcFiles.length,
  totalCandidates: sorted.length,
  singleFile: sorted.filter((e) => e.files.length === 1).length,
  crossFile: sorted.filter((e) => e.files.length > 1).length,
};

console.log('[extract-i18n]', stats);

if (REPORT_ONLY) {
  // 只打印前 10 条看看
  console.log('\n--- top 10 candidates ---');
  for (const c of sorted.slice(0, 10)) {
    console.log(`  ${c.key}  "${c.zh}"  (in ${c.files.length} file(s))`);
  }
} else {
  const out = { stats, entries: sorted };
  const outPath = 'scripts/i18n-candidates.json';
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[extract-i18n] wrote ${outPath}`);
  // 同时输出一个可直接粘进 zh-CN.json 的片段
  const flat = {};
  for (const c of sorted) flat[c.key] = c.zh;
  const flatPath = 'scripts/i18n-zh-cn-flat.json';
  writeFileSync(flatPath, JSON.stringify(flat, null, 2), 'utf8');
  console.log(`[extract-i18n] wrote ${flatPath} (可粘进 locales/zh-CN.json)`);
}
