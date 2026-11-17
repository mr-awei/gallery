#!/usr/bin/env node
/**
 * 文档双语化工具：把静态 HTML 文档里的用户可见文案抽成待译清单，再按译文重建英文版。
 *
 *   node scripts/docs-bilingual.mjs extract docs/产品介绍.html docs/评测与路线图.html
 *   node scripts/docs-bilingual.mjs build   docs/产品介绍.html
 *
 * 约定：
 *   - 只处理「块级元素内部的纯内联文案」（p / h1-h4 / li / td / summary / title …），
 *     内联标签（b / code / span …）原样保留在 HTML 片段里，交给译者一起翻；
 *   - script / style / pre 内的内容与代码块一律跳过；
 *   - 译文清单输出到 scripts/docs-i18n-<name>.json，译文放 scripts/docs-i18n-<name>.out.json；
 *   - 重建时生成 <name>.en.html，并把语言切换条同时注入中英文两个文件。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

const BLOCK = new Set([
  'html', 'body', 'div', 'section', 'main', 'header', 'footer', 'nav', 'article', 'aside',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr',
  'td', 'th', 'dl', 'dt', 'dd', 'blockquote', 'figure', 'figcaption', 'details', 'summary',
  'fieldset', 'legend', 'title',
]);
const SKIP = new Set(['script', 'style', 'pre']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const hasCn = (s) => /[\u4e00-\u9fa5]/.test(s);

/** 扫描出标签 / 文本 token（不建树，保留源码偏移） */
function tokenize(src) {
  /** @type {{ type: string, name?: string, closing?: boolean, selfClose?: boolean, start: number, end: number }[]} */
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const end = next === -1 ? src.length : next;
      tokens.push({ type: 'text', start: i, end });
      i = end;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      const end = e === -1 ? src.length : e + 3;
      tokens.push({ type: 'comment', start: i, end });
      i = end;
      continue;
    }
    const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(src.slice(i, i + 40));
    if (!m) {
      i++;
      continue;
    }
    let j = i + 1;
    let quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; j++; continue; }
      if (c === '"' || c === "'") { quote = c; j++; continue; }
      if (c === '>') break;
      j++;
    }
    const end = Math.min(src.length, j + 1);
    const raw = src.slice(i, end);
    tokens.push({
      type: 'tag',
      name: m[1].toLowerCase(),
      closing: raw.startsWith('</'),
      selfClose: /\/\s*>$/.test(raw) || VOID.has(m[1].toLowerCase()),
      start: i,
      end,
    });
    i = end;
  }
  return tokens;
}

function extract(src) {
  const tokens = tokenize(src);
  /** @type {{ name: string, contentStart: number, contentEnd: number, blockChild: boolean, hasCn: boolean, skip: boolean, parentSkip: boolean }[]} */
  const stack = [];
  const frames = [];
  for (const t of tokens) {
    if (t.type === 'text') {
      const text = src.slice(t.start, t.end);
      if (!hasCn(text)) continue;
      for (const f of stack) if (!f.skip && !f.parentSkip) f.hasCn = true;
      continue;
    }
    if (t.type !== 'tag') continue;
    if (t.closing) {
      const idx = stack.map((f) => f.name).lastIndexOf(t.name);
      if (idx === -1) continue;
      const framesToClose = stack.splice(idx);
      for (const f of framesToClose) {
        f.contentEnd = t.start;
        frames.push(f);
      }
      continue;
    }
    if (t.selfClose) continue;
    const parent = stack[stack.length - 1];
    const frame = {
      name: t.name,
      contentStart: t.end,
      contentEnd: -1,
      blockChild: false,
      hasCn: false,
      skip: SKIP.has(t.name),
      parentSkip: Boolean(parent && (parent.skip || parent.parentSkip)),
      parent: parent || null,
      qualifies: false,
    };
    if (parent && BLOCK.has(t.name)) parent.blockChild = true;
    stack.push(frame);
  }
  for (const f of stack) {
    f.contentEnd = src.length;
    frames.push(f);
  }

  /** @type {{ id: string, tag: string, html: string, start: number, end: number }[]} */
  const segments = [];
  /** @type {{ id: string, tag: string, attr: string, value: string, start: number, end: number }[]} */
  const attrs = [];
  /**
   * 图表 / 内联代码原样保留：替换成 %%TOKENn%%，翻译完再还原，
   * 避免译者（或模型）动到 svg 的 path、代码里的标识符。
   */
  const protect = (html) => {
    const tokens = [];
    const masked = html.replace(/<(svg|code|kbd|samp|math)\b[\s\S]*?<\/\1>/gi, (m) => {
      tokens.push(m);
      return `%%TOKEN${tokens.length - 1}%%`;
    });
    return { masked, tokens };
  };

  for (const f of frames) {
    f.qualifies = f.hasCn && !f.blockChild && !f.skip && !f.parentSkip && f.contentEnd > f.contentStart;
  }
  /** 祖先已经整段命中时，子元素不再单独成段，避免替换区间重叠 */
  const coveredByAncestor = (f) => {
    let p = f.parent;
    while (p) {
      if (p.qualifies) return true;
      p = p.parent;
    }
    return false;
  };

  for (const f of frames) {
    if (!f.qualifies || coveredByAncestor(f)) continue;
    const html = src.slice(f.contentStart, f.contentEnd).trim();
    if (!html || !hasCn(html)) continue;
    const { masked, tokens } = protect(html);
    if (!hasCn(masked)) continue;
    const id = 'h' + createHash('md5').update(html).digest('hex').slice(0, 12);
    segments.push({ id, tag: f.name, html: masked, tokens, start: f.contentStart, end: f.contentEnd });
  }

  // 含中文的属性值（alt / title / aria-label / content / placeholder）
  const attrRe = /\b(alt|title|aria-label|content|placeholder|value)\s*=\s*"([^"]*[\u4e00-\u9fa5][^"]*)"/g;
  let m;
  while ((m = attrRe.exec(src))) {
    attrs.push({ id: `a${attrs.length}`, tag: 'attr', attr: m[1], value: m[2], start: m.index + m[0].indexOf(m[2]), end: m.index + m[0].indexOf(m[2]) + m[2].length });
  }
  return { segments, attrs };
}

const LANG_BAR = (active, zhHref, enHref) => {
  const on = 'padding:6px 11px;border-radius:999px;text-decoration:none;color:#fff;background:#4f46e5;font-weight:600';
  const off = 'padding:6px 11px;border-radius:999px;text-decoration:none;color:#475569';
  const zhLink = `<a href="${zhHref}" data-doc-lang="zh" style="${active === 'zh' ? on : off}">中文</a>`;
  const enLink = `<a href="${enHref}" data-doc-lang="en" style="${active === 'en' ? on : off}">English</a>`;
  return `
<div class="doc-lang-switch" style="position:fixed;right:18px;bottom:18px;z-index:9999;display:flex;gap:2px;padding:4px;border-radius:999px;background:rgba(255,255,255,.92);border:1px solid #e4e9f2;box-shadow:0 6px 18px -10px rgba(15,23,42,.45);font:12.5px/1 system-ui,-apple-system,'Segoe UI',sans-serif">
  ${zhLink}
  ${enLink}
</div>
<script>
(function(){
  var KEY='doc-scroll-y';
  function save(){ try{ sessionStorage.setItem(KEY, String(window.scrollY||0)); }catch(e){ /* storage disabled in private mode; ignore */ } }
  document.querySelectorAll('[data-doc-lang]').forEach(function(a){ a.addEventListener('click', save); });
  try{
    var y=sessionStorage.getItem(KEY);
    if(y!==null){ sessionStorage.removeItem(KEY);
      window.addEventListener('load', function(){ window.scrollTo(0, Number(y)||0); });
    }
  }catch(e){ /* storage disabled in private mode; ignore */ }
})();
</script>
`;
};

/** 去掉上一次注入的语言切换条（重建前先剥掉，保证与抽取时的偏移一致） */
function stripLangBar(html) {
  return html.replace(/\n?(?:<!--[^\n]*-->\s*)?<div class="doc-lang-switch"[\s\S]*?<\/script>\n?/i, '\n');
}

function injectLangBar(html, active, zhHref, enHref) {
  const base = stripLangBar(html);
  return base.replace(/<\/body>/i, `${LANG_BAR(active, zhHref, enHref)}\n</body>`);
}

function listKey(file) {
  return basename(file).replace(/\.html?$/i, '');
}

function cmdExtract(files) {
  for (const file of files) {
    const src = stripLangBar(readFileSync(file, 'utf8'));
    const { segments, attrs } = extract(src);
    const key = listKey(file);
    writeFileSync(`scripts/docs-i18n-${key}.json`, JSON.stringify({ file, segments, attrs }, null, 2), 'utf8');
    const chars = [...segments.map((s) => s.html), ...attrs.map((a) => a.value)].reduce((n, s) => n + s.length, 0);
    console.log(`${file}: ${segments.length} blocks, ${attrs.length} attrs, ${chars} chars`);
  }
}

function cmdBuild(file) {
  const key = listKey(file);
  const zh = stripLangBar(readFileSync(file, 'utf8'));
  const data = JSON.parse(readFileSync(`scripts/docs-i18n-${key}.json`, 'utf8'));
  const outPath = `scripts/docs-i18n-${key}.out.json`;
  if (!existsSync(outPath)) throw new Error(`缺少译文文件：${outPath}`);
  const out = JSON.parse(readFileSync(outPath, 'utf8'));

  const replacements = [];
  for (const seg of data.segments) {
    const en = out[seg.id];
    if (typeof en !== 'string' || !en.trim()) throw new Error(`缺译文：${seg.id}`);
    // 还原被保护的 svg / 内联代码
    const restored = en.replace(/%%TOKEN(\d+)%%/g, (m, n) => seg.tokens?.[Number(n)] ?? m);
    const raw = zh.slice(seg.start, seg.end);
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw) || [raw, '', raw, ''];
    replacements.push({ start: seg.start, end: seg.end, text: `${m[1]}${restored.trim()}${m[3]}` });
  }
  for (const a of data.attrs) {
    const en = out[a.id];
    if (typeof en !== 'string' || !en.trim()) throw new Error(`缺译文：${a.id}`);
    replacements.push({ start: a.start, end: a.end, text: en });
  }
  replacements.sort((a, b) => b.start - a.start);
  let enHtml = zh;
  for (const r of replacements) enHtml = enHtml.slice(0, r.start) + r.text + enHtml.slice(r.end);

  // 中英两版互链：英文版里的站内文档链接指向对应 .en.html
  enHtml = enHtml.replace(/href="\.\/([^"].+?)\.html"/g, 'href="./$1.en.html"');

  // 语言与标题：<html lang> 换 en，标题用译好的 title 段落（若存在）
  enHtml = enHtml.replace(/<html\s+lang="[^"]*"/i, '<html lang="en"');
  const enName = file.replace(/\.html$/i, '.en.html');
  enHtml = injectLangBar(enHtml, 'en', basename(file), basename(enName));
  const zhWithBar = injectLangBar(zh, 'zh', basename(file), basename(enName));
  writeFileSync(file, zhWithBar, 'utf8');
  writeFileSync(enName, enHtml, 'utf8');
  console.log(`written ${enName}  (${replacements.length} replacements)`);
}

function cmdMissing(file) {
  const key = listKey(file);
  const data = JSON.parse(readFileSync(`scripts/docs-i18n-${key}.json`, 'utf8'));
  const outPath = `scripts/docs-i18n-${key}.out.json`;
  const out = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
  const missing = data.segments.filter((s) => !out[s.id]).map((s) => ({ id: s.id, tag: s.tag, html: s.html }));
  writeFileSync(`scripts/docs-i18n-${key}.missing.json`, JSON.stringify(missing, null, 2), 'utf8');
  console.log(`${file}: ${missing.length} missing blocks, ${missing.reduce((n, s) => n + s.html.length, 0)} chars`);
}

const [mode, ...files] = process.argv.slice(2);
if (mode === 'extract') cmdExtract(files);
else if (mode === 'missing') files.forEach((f) => cmdMissing(f));
else if (mode === 'build') files.forEach((f) => cmdBuild(f));
else {
  console.error('用法：node scripts/docs-bilingual.mjs extract|build <file...>');
  process.exit(1);
}
