#!/usr/bin/env node
/**
 * i18n 替换（v5 — 跳过正则表达式）
 *
 * v4 根因：正则里的 " < > 等字符被误判为 JS 字符串引号/JSX tag。
 *  从 L718 的 /[\\/:*?"<>|]+/g 里的 " 开始，CodeMod 把 14KB 代码当成字符串！
 *
 * v5 修复：在引号处理前，先检查是不是正则起始 /pattern/flags。
 *  判据：/ 前面不是标识符字符（排除除法），且不是 // 注释。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, join } from 'node:path';
import { createHash } from 'node:crypto';

const REPORT_PATH = 'scripts/i18n-replace-report.json';
function loadReport() {
  if (!existsSync(REPORT_PATH)) return [];
  try { return JSON.parse(readFileSync(REPORT_PATH, 'utf8')); } catch { return []; }
}
function saveReport(r) { writeFileSync(REPORT_PATH, JSON.stringify(r, null, 2), 'utf8'); }
function keyFor(zh) { return 'k' + createHash('md5').update(zh).digest('hex').slice(0, 8); }
function importPathFor(filePath) {
  let p = relative(dirname(filePath), 'web/src/i18n').replace(/\\/g, '/');
  if (!p.startsWith('.')) p = './' + p;
  return p;
}
function hasChinese(s) { return /[\u4e00-\u9fa5]/.test(s); }
function looksLikePath(s) {
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return true;
  if (/[A-Za-z]:[\\/]/.test(t)) return true;
  if (/\\\\/.test(t)) return true;
  if (/\b[\w-]+\.(png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|json|js|ts|tsx|css|html|md|txt|exe|zip|7z|heic|avif)\b/i.test(t)) return true;
  if (t.startsWith('/') && !/\s/.test(t)) return true;
  return false;
}
function looksLikeCodeFragment(s) {
  // 字符串里包含多行 + 长度超过 50，大概率是 CodeMod 把多个代码片段拼成了"字符串"
  if (!/\n/.test(s)) return false;
  if (s.length > 50) return true;
  // 短一点但包含明显代码结构也拒绝
  const codeWords = ['function', 'const ', 'let ', 'return', 'try {', 'catch', 'async ', 'await ', 'Record<', 'Promise<', '.then(', '.catch('];
  let hits = 0;
  for (const w of codeWords) if (s.includes(w)) hits++;
  return hits >= 2;
}

function looksLikeOpenTagStart(s, pos) {
  if (s[pos] !== '<') return false;
  const c = s[pos + 1];
  if (c === '/') return false;
  if (c === undefined || !/[A-Za-z]/.test(c)) return false;
  // 排除 TS 泛型：前面是标识符字符（useState<T>、Promise<T>）
  if (pos > 0 && /[A-Za-z0-9_$.]/.test(s[pos - 1])) return false;
  // v6：大写开头标识符，检查后面紧跟什么（区分 TS 类型 vs React 组件）
  if (/[A-Z]/.test(c)) {
    let j = pos + 1;
    while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
    const afterTag = s[j];
    // TS 类型后面：(、标识符、.、]、嵌套 < 或 >
    // JSX open tag 后面只能是：空格（属性）、>（立即关闭）、/（/> 自闭合）
    if (afterTag === '(' || /[A-Za-z0-9_$]/.test(afterTag) || afterTag === '.' || afterTag === ']' || afterTag === '<') {
      return false;
    }
  }
  return true;
}
function looksLikeCloseTagStart(s, pos) {
  return s[pos] === '<' && s[pos + 1] === '/';
}
function prevNonWhitespace(src, pos) {
  let j = pos - 1;
  while (j >= 0 && /[\s]/.test(src[j])) j--;
  return j >= 0 ? src[j] : null;
}

/**
 * 检查 pos 处的 / 是不是正则表达式起始（不是除法，也不是 JSX tag）。
 * 规则：
 *   1. 不是 // 注释
 *   2. 前一非空白字符不是标识符字符（不是 a-Z 0-9 _ $）
 *      （因为 a/b 是除法，return /regex/ 是正则）
 *   3. 也不是 `.` 后面（foo.bar/baz 是除法）
 *   4. 前一非空白字符不是 `<`（那是 JSX close tag </div> 或 self-close <br />）
 */
function looksLikeRegexStart(s, pos) {
  if (s[pos] !== '/') return false;
  if (s[pos + 1] === '/') return false; // 单行注释
  if (s[pos + 1] === '>') return false; // JSX 自闭合 />
  const prev = prevNonWhitespace(s, pos);
  if (prev === null) return true; // 行首
  if (/[A-Za-z0-9_$.]/.test(prev)) return false; // a/b 除法或 foo.bar/baz
  if (/[)\]}]/.test(prev)) return false; // (x) / 1000 这类除法
  if (prev === '<') return false; // JSX </div> 或 <br />
  return true;
}

/** 跳过多行注释（/* ... *\/），返回下一个位置 */
function skipBlockComment(s, pos) {
  const end = s.indexOf('*/', pos + 2);
  return end === -1 ? s.length : end + 2;
}
/** 跳过单行注释，返回下一个位置 */
function skipLineComment(s, pos) {
  const nl = s.indexOf('\n', pos);
  return nl === -1 ? s.length : nl + 1;
}
/** 跳过正则表达式 /pattern/flags，返回正则结束后的位置 */
function skipRegex(s, pos) {
  let j = pos + 1; // 跳过起始 /
  let inCharClass = false; // [ ... ] 内部的 / 不是结束
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; } // 转义
    if (inCharClass) {
      if (s[j] === ']') inCharClass = false;
      j++; continue;
    }
    if (s[j] === '[') { inCharClass = true; j++; continue; }
    if (s[j] === '/') { j++; break; } // 正则结束
    j++;
  }
  // 跳过 flags（字母）
  while (j < s.length && /[a-z]/.test(s[j])) j++;
  return j;
}

/**
 * 只处理「代码里的字符串字面量」，不做 JSX 判定。
 * 专供模板插值 `${...}` 内部递归使用。
 */
function replaceStringsInCode(text, filePath, report) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '*') {
      const e = text.indexOf('*/', i + 2);
      const stop = e === -1 ? n : e + 2;
      out += text.slice(i, stop); i = stop; continue;
    }
    if (ch === '/' && next === '/') {
      const e = text.indexOf('\n', i);
      const stop = e === -1 ? n : e + 1;
      out += text.slice(i, stop); i = stop; continue;
    }
    if (ch === '/' && looksLikeRegexStart(text, i)) {
      const stop = skipRegex(text, i);
      out += text.slice(i, stop); i = stop; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch, start = i;
      i++; let raw = '';
      const inTpl = quote === '`';
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') { raw += text.slice(i, i + 2); i += 2; continue; }
        if (inTpl && text[i] === '$' && text[i + 1] === '{') {
          const innerStart = i + 2;
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            i++;
          }
          const innerExpr = text.slice(innerStart, Math.max(innerStart, i - 1));
          const innerRes = replaceStringsInCode(innerExpr, filePath, report);
          raw += '${' + innerRes.out + '}';
          continue;
        }
        raw += text[i]; i++;
      }
      i++;
      if (inTpl && /\$\{/.test(raw)) { out += '`' + raw + '`'; continue; }
      const unescaped = raw.replace(/\\(["'`nrt])/g, (_, p) => ({ '"': '"', "'": "'", '`': '`', 'n': '\n', 'r': '\r', 't': '\t' }[p] ?? p));
      if (!hasChinese(unescaped) || looksLikePath(unescaped) || unescaped.trim().length < 2 || looksLikeCodeFragment(unescaped)) {
        out += text.slice(start, i); continue;
      }
      const k = keyFor(unescaped.trim());
      report.push({ key: k, zh: unescaped.trim(), file: filePath });
      out += `i18n.t('${k}')`;
      continue;
    }
    out += ch; i++;
  }
  return { out };
}

/**
 * 把模板字面量源码（已处理过插值内部）拆成静态片段与插值表达式。
 * @param {string} raw
 * @returns {({ lit: string } | { expr: string })[]}
 */
function splitTemplate(raw) {
  const parts = [];
  let lit = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\\') { lit += raw.slice(i, i + 2); i += 2; continue; }
    if (raw[i] === '$' && raw[i + 1] === '{') {
      if (lit) { parts.push({ lit }); lit = ''; }
      let depth = 1;
      let j = i + 2;
      while (j < raw.length && depth > 0) {
        if (raw[j] === '{') depth++;
        else if (raw[j] === '}') depth--;
        j++;
      }
      parts.push({ expr: raw.slice(i + 2, j - 1) });
      i = j;
      continue;
    }
    lit += raw[i];
    i++;
  }
  if (lit) parts.push({ lit });
  return parts;
}

/** 去掉模板片段里的转义（\\n / \\t / \\` / \\\\ 等），认不出的转义原样保留 */
function unescapeLiteral(s) {
  return s.replace(/\\(.)/g, (m, p) => ({ '"': '"', "'": "'", '`': '`', n: '\n', r: '\r', t: '\t', '\\': '\\' }[p] ?? m));
}

/** 主转换函数。 */
function transform(src, filePath, report, opts = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  let brace = 0;
  let jsxDepth = 0;
  /** @type {{ tagBrace: number }[]} */
  const jsxTagCtx = [];
  let replaced = 0;

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // ====== 块注释 ======
    if (ch === '/' && next === '*') {
      const stop = skipBlockComment(src, i);
      out += src.slice(i, stop); i = stop; continue;
    }
    // ====== 单行注释 ======
    if (ch === '/' && next === '/') {
      const stop = skipLineComment(src, i);
      out += src.slice(i, stop); i = stop; continue;
    }
    // ====== 正则表达式 ======
    if (ch === '/' && looksLikeRegexStart(src, i)) {
      const stop = skipRegex(src, i);
      out += src.slice(i, stop); i = stop; continue;
    }

    // ====== 字符串（三种引号）======
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch, start = i;
      i++; let raw = '';
      const inTpl = quote === '`';
      if (process.env.I18N_DEBUG) {
        console.error(`[DBG] str start @${start} q=${quote} line=${src.slice(0, start).split('\n').length} preview=${JSON.stringify(src.slice(start, start + 40))}`);
      }

      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { raw += src.slice(i, i + 2); i += 2; continue; }
        if (inTpl && src[i] === '$' && src[i + 1] === '{') {
          const innerStart = i + 2;
          i += 2;
          let depth = 1;
          brace++;
          if (jsxTagCtx.length > 0) jsxTagCtx[jsxTagCtx.length - 1].tagBrace++;
          while (i < n && depth > 0) {
            if (src[i] === '{') {
              depth++; brace++;
              if (jsxTagCtx.length > 0) jsxTagCtx[jsxTagCtx.length - 1].tagBrace++;
            } else if (src[i] === '}') {
              depth--; brace--;
              if (jsxTagCtx.length > 0) jsxTagCtx[jsxTagCtx.length - 1].tagBrace--;
            }
            i++;
          }
          // 插值表达式里也可能有中文字符串，递归处理一遍
          const innerExpr = src.slice(innerStart, Math.max(innerStart, i - 1));
          const innerRes = replaceStringsInCode(innerExpr, filePath, report);
          raw += '${' + innerRes.out + '}';
          continue;
        }
        raw += src[i]; i++;
      }
      i++; // 跳过闭合引号
      if (process.env.I18N_DEBUG) {
        console.error(`[DBG] str end @${i} start=${start} len=${i - start} raw=${JSON.stringify(raw.slice(0, 60))}`);
      }

      // 反引号含插值：把静态文案抽成词条，插值变成 {{p0}} 命名占位符（i18next 插值）
      if (inTpl && /\$\{/.test(raw)) {
        const chunks = splitTemplate(raw);
        const hasCn = chunks.some((c) => c.lit !== undefined && hasChinese(unescapeLiteral(c.lit)));
        if (!hasCn) { out += '`' + raw + '`'; continue; }
        let norm = '';
        /** @type {string[]} */
        const vars = [];
        for (const c of chunks) {
          if (c.lit !== undefined) norm += unescapeLiteral(c.lit);
          else {
            norm += `{{p${vars.length}}}`;
            vars.push(c.expr.trim());
          }
        }
        let isJsxAttr = false;
        if (jsxTagCtx.length > 0 && jsxTagCtx[jsxTagCtx.length - 1].tagBrace === 0) {
          let j = start - 1;
          while (j >= 0 && /[\s]/.test(src[j])) j--;
          isJsxAttr = j >= 0 && src[j] === '=';
        }
        const k = keyFor(norm);
        report.push({ key: k, zh: norm, file: filePath });
        const args = vars.map((v, idx) => `p${idx}: ${v}`).join(', ');
        const call = vars.length ? `i18n.t('${k}', { ${args} })` : `i18n.t('${k}')`;
        out += isJsxAttr ? `{${call}}` : call;
        replaced++;
        continue;
      }

      const unescaped = raw.replace(/\\(["'`nrt])/g, (_, p) => ({ '"': '"', "'": "'", '`': '`', 'n': '\n', 'r': '\r', 't': '\t' }[p] ?? p));
      if (!hasChinese(unescaped)) { out += src.slice(start, i); continue; }
      if (!opts.content && looksLikePath(unescaped)) { out += src.slice(start, i); continue; }
      // 单字标签（红 / 中 / 无 …）也算 UI 文案；纯标点（、 · 等）不处理
      if (unescaped.trim().length === 0) { out += src.slice(start, i); continue; }
      if (/^[\p{P}\p{S}\s]+$/u.test(unescaped.trim())) { out += src.slice(start, i); continue; }
      // 教程语料是多段散文（整段 body），必须允许换行；其它文件仍按代码片段保护
      if (!opts.content && looksLikeCodeFragment(unescaped)) { out += src.slice(start, i); continue; }

      // 判定：是不是 JSX 属性值
      let isJsxAttr = false;
      if (jsxTagCtx.length > 0 && jsxTagCtx[jsxTagCtx.length - 1].tagBrace === 0) {
        let j = start - 1;
        while (j >= 0 && /[\s]/.test(src[j])) j--;
        isJsxAttr = j >= 0 && src[j] === '=';
      }

      const k = keyFor(unescaped.trim());
      report.push({ key: k, zh: unescaped.trim(), file: filePath });
      if (isJsxAttr) out += `{i18n.t('${k}')}`;
      else out += `i18n.t('${k}')`;
      replaced++;
      continue;
    }

    // ====== JSX open tag 开始 ======
    if (looksLikeOpenTagStart(src, i)) {
      jsxDepth++;
      jsxTagCtx.push({ tagBrace: 0 });
      out += ch; i++; continue;
    }
    // ====== JSX close tag 开始 ======
    if (looksLikeCloseTagStart(src, i)) {
      if (jsxTagCtx.length > 0) jsxTagCtx.pop();
      if (jsxDepth > 0) jsxDepth--;
      out += ch; i++; continue;
    }
    // ====== JSX tag opening > ======
    if (ch === '>' && jsxTagCtx.length > 0 && jsxTagCtx[jsxTagCtx.length - 1].tagBrace === 0) {
      const prev = prevNonWhitespace(src, i);
      jsxTagCtx.pop();
      if (prev === '/' && jsxDepth > 0) jsxDepth--;
      out += ch; i++; continue;
    }

    // ====== 全局花括号 ======
    if (ch === '{') {
      brace++;
      if (jsxTagCtx.length > 0) jsxTagCtx[jsxTagCtx.length - 1].tagBrace++;
      out += ch; i++; continue;
    }
    if (ch === '}' && brace > 0) {
      brace--;
      if (jsxTagCtx.length > 0) jsxTagCtx[jsxTagCtx.length - 1].tagBrace--;
      out += ch; i++; continue;
    }

    out += ch; i++;
  }
  return { out, replaced };
}

/**
 * 第二段：把 JSX 文本子节点里的中文换成 {i18n.t('k...')}。
 * 形如 <span>工具箱</span> → <span>{i18n.t('k...')}</span>
 * 保留首尾空白（JSX 会按原样渲染相邻空白）。
 */
function replaceJsxText(src, filePath, report) {
  // 先算出所有字符串字面量区间，避免误伤 '<p>中文</p>' 这类 JS 字符串
  const spans = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '"' && c !== "'" && c !== '`') continue;
    const start = i;
    i++;
    while (i < src.length && src[i] !== c) {
      if (src[i] === '\\') { i += 2; continue; }
      i++;
    }
    spans.push([start, Math.min(i + 1, src.length)]);
  }
  const inString = (pos) => spans.some(([a, b]) => pos >= a && pos < b);

  let count = 0;
  const out = src.replace(/>([^<>{}]*?[\u4e00-\u9fa5][^<>{}]*?)</g, (full, text, offset) => {
    if (inString(offset)) return full;
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    const core = text.trim();
    if (!core) return full;
    if (looksLikePath(core)) return full;
    // 跨注释/代码的假匹配：JSX 文本里不该出现注释符或代码片段
    if (core.includes('//') || core.includes('/*') || core.includes('*/')) return full;
    if (looksLikeCodeFragment(core)) return full;
    const k = keyFor(core);
    report.push({ key: k, zh: core, file: filePath });
    count++;
    return '>' + lead + `{i18n.t('${k}')}` + trail + '<';
  });
  return { out, count };
}

function ensureImport(src, importPath) {
  if (/import\s+i18n\s+from\s*['"][^'"]*i18n[^'"]*['"]/.test(src)) return src;
  const lines = src.split('\n');
  let lastImport = -1, blank = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if (/^import\s/.test(l)) { lastImport = idx; }
    else if (blank === -1 && lastImport !== -1 && l.trim() === '') { blank = idx; }
  }
  const insertAt = blank !== -1 ? blank : (lastImport !== -1 ? lastImport + 1 : 0);
  lines.splice(insertAt, 0, `import i18n from '${importPath}';`);
  return lines.join('\n');
}

/** 参数既可以是文件，也可以是目录（目录会递归收集 .ts / .tsx） */
function collectFiles(p) {
  if (!existsSync(p)) return [];
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p).flatMap((name) => collectFiles(join(p, name)));
}

const files = process.argv
  .slice(2)
  .flatMap(collectFiles)
  .filter((p) => p.endsWith('.tsx') || p.endsWith('.ts'));
if (files.length === 0) { console.error('需要参数'); process.exit(1); }

// 教程语料（纯数据文件）：body 是整段多行散文，不按代码片段跳过，也没有 JSX 文本
const CONTENT_FILE_RE = /(?:^|[\\/])(?:tutorial-content\.ts|tutorial[\\/]extra-[^\\/]+\.ts)$/;

const report = loadReport();
let total = 0;
for (const file of files) {
  if (!existsSync(file)) { console.warn('找不到', file); continue; }
  const src = readFileSync(file, 'utf8');
  const content = CONTENT_FILE_RE.test(file);
  const { out, replaced } = transform(src, file, report, { content });
  const jsx = content ? { out, count: 0 } : replaceJsxText(out, file, report);
  const n = replaced + jsx.count;
  if (n === 0) { console.log(`[i18n] ${file} 无改动`); continue; }
  const final = ensureImport(jsx.out, importPathFor(file));
  writeFileSync(file, final, 'utf8');
  console.log(`[i18n] ${file} 替换 ${replaced} 处字符串 + ${jsx.count} 处 JSX 文本`);
  total += n;
}
saveReport(report);
console.log(`[i18n] 共替换 ${total} 处，report=${report.length} 条`);
