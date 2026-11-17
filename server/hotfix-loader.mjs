/**
 * 热更叠加层的 ESM 解析钩子（跑在 hooks 线程里，只允许依赖 node: 内置模块）。
 *
 * 要解决的就是一件事：server/ 被搬到 %APPDATA% 下的可写目录后，
 * `import 'express'` 会按「文件自身位置」往上找 node_modules —— 一路找到 C 盘根也没有。
 * 这里的规则：
 *   1. 裸模块名 → 一律从 **asar 的 node_modules** 解析（overlay 的优先，缺失再回落 asar）；
 *   2. overlay 里的相对路径找不到 → 回落到 asar 里的同名文件。
 * 于是热更包可以只带改动的那几个文件，其余全走内置版本（叠加层语义）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ROOT = process.env.TUKU_APP_ROOT || '';
const OVERLAY = process.env.TUKU_HOTFIX_ROOT || '';

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/** @returns {any} 包描述，读不到返回 null */
const readPkg = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

/** 从 exports 条件对象里挑一个能直接当文件路径的值 */
const pickCondition = (value) => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of ['import', 'node', 'module', 'default', 'require']) {
    const hit = pickCondition(value[key]);
    if (hit) return hit;
  }
  return '';
};

/**
 * 按 package.json 的 exports/module/main 找出包入口文件。
 * 不能直接 nextResolve('express')：那是相对 overlay 解析，找不到；
 * 也不能用 createRequire().resolve：纯 ESM 包（如 @huggingface/transformers）没有 require 条件。
 */
const packageEntry = (bases, specifier) => {
  const m = /^((?:@[^/]+\/)?[^/]+)(?:\/(.+))?$/.exec(specifier);
  if (!m) return '';
  const [, name, sub] = m;
  for (const base of bases) {
    const dir = path.join(base, 'node_modules', name);
    if (!exists(dir)) continue;
    const pj = readPkg(dir) || {};
    if (sub) {
      const exp = pj.exports && typeof pj.exports === 'object' ? pj.exports[`./${sub}`] : '';
      const direct = pickCondition(exp) || sub;
      for (const cand of [direct, `${direct}.js`, `${direct}/index.js`]) {
        const abs = path.join(dir, cand);
        if (exists(abs)) return pathToFileURL(abs).href;
      }
      continue;
    }
    const exp = pj.exports ?? '';
    const root = typeof exp === 'string' ? exp : exp['.'] ?? exp;
    const fromExports = pickCondition(root);
    const candidates = [fromExports, pj.module, pj.main, 'index.js'].filter(Boolean);
    for (const cand of candidates) {
      for (const rel of [cand, `${cand}.js`]) {
        const abs = path.join(dir, rel);
        if (exists(abs) && fs.statSync(abs).isFile()) return pathToFileURL(abs).href;
      }
    }
  }
  return '';
};

/** overlay 里缺失的相对导入 → asar 里的同名文件 */
const mapMissingToAsar = (specifier, parentURL) => {
  if (!APP_ROOT || !OVERLAY || !parentURL) return '';
  if (!/^\.{1,2}\//.test(specifier)) return '';
  try {
    const abs = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
    const rel = path.relative(OVERLAY, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    for (const cand of [rel, `${rel}.js`, `${rel}.mjs`, path.join(rel, 'index.js')]) {
      const target = path.join(APP_ROOT, cand);
      if (exists(target)) return pathToFileURL(target).href;
    }
  } catch {
    /* 解析失败让原始错误冒出去，别把真实原因盖掉 */
  }
  return '';
};

const BARE = /^(?:@[^/]+\/)?[^./\\][^:\\]*$/;

export async function resolve(specifier, context, nextResolve) {
  if (BARE.test(specifier)) {
    const hit = packageEntry([OVERLAY, APP_ROOT].filter(Boolean), specifier);
    if (hit) return nextResolve(hit, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const mapped = mapMissingToAsar(specifier, context.parentURL);
    if (!mapped) throw err;
    return nextResolve(mapped, context);
  }
}
