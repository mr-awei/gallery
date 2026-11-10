#!/usr/bin/env node
/**
 * 把 verify 的实跑统计回写进 docs/项目现状与差距.html。
 *
 * 背景：文档里的「177 文件 / 345 单测 / 106 冒烟 / 15 基准」以前靠手抄，
 * 上一版直接抄成 175 / 322 / 105，与实测差了一轮 —— 台账的信用全靠数字对得上，
 * 所以这里改成：各环节跑完把数字写进 docs/.verify-stats.json，
 * 文档里只留 data-stat 占位符，verify 最后一步统一渲染。
 *
 * 单独执行：node scripts/doc-stats.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATS_PATH = path.join(ROOT, 'docs', '.verify-stats.json');
const DOC_PATH = path.join(ROOT, 'docs', '项目现状与差距.html');

export function readStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 某一环节跑完后登记自己的数字；同一轮里后跑的值会覆盖前一轮的旧值 */
export function writeStat(key, value) {
  const stats = readStats();
  stats[key] = Number(value) || 0;
  stats.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
}

function countTestFiles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).length;
  } catch {
    return 0;
  }
}

/** @param {Record<string, any>} [stats] */
export function renderStats(stats = readStats()) {
  const s = {
    lint: Number(stats.lint) || 0,
    unit: Number(stats.unit) || 0,
    smoke: Number(stats.smoke) || 0,
    bench: Number(stats.bench) || 0,
    testFiles: countTestFiles(),
  };
  const texts = {
    summary: `${s.lint} · ${s.unit} · ${s.smoke} · ${s.bench}`,
    lint: `${s.lint} 个文件 0 错误`,
    unit: `${s.unit} / ${s.unit}`,
    testFiles: String(s.testFiles),
    smoke: `${s.smoke} / ${s.smoke}`,
    bench: `${s.bench} / ${s.bench}`,
  };

  let html = fs.readFileSync(DOC_PATH, 'utf8');
  let changed = 0;
  for (const [key, text] of Object.entries(texts)) {
    // 只替换「带 data-stat 的标签」自身的文本，标签内的 <code> 等结构不动
    const re = new RegExp(`(<([a-z][a-z0-9]*)\\b[^>]*data-stat="${key}"[^>]*>)[^<]*(</\\2>)`, 'g');
    html = html.replace(re, (_m, open, _tag, close) => {
      changed += 1;
      return `${open}${text}${close}`;
    });
  }
  if (changed) fs.writeFileSync(DOC_PATH, html, 'utf8');
  return { ...s, summary: texts.summary, changed };
}

// 作为 CLI 运行时才渲染（被 lint/smoke/bench import 时只借用 writeStat）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = ['lint', 'unit', 'smoke', 'bench'].filter((k) => !readStats()[k]);
  if (missing.length) {
    console.error(`[doc] 缺少统计：${missing.join(' / ')}；请先跑一次 npm run verify`);
    process.exit(1);
  }
  const r = renderStats();
  console.log(`[doc] 已回写 ${r.changed} 处统计：${r.summary}（test 文件 ${r.testFiles} 个）`);
}
