// @ts-check

/**
 * EPUB 解析：只为「打开就能读」服务，不做完整排版引擎。
 *
 * 目标：给出书名/作者/封面/目录 + 每章的纯文本与插图（图片转 data URL）。
 * 不把书里的 HTML 直接交给前端渲染 —— 那是 XSS 与样式污染的口子；
 * 这里只产出 { type: 'text' } 与 { type: 'image' } 两种块，前端无 dangerouslySetInnerHTML。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

/** 单个章节最多返回多少字符（有的「一章」是整本书） */
const MAX_TEXT_CHARS = 160_000;
/** 单章最多带几张图 */
const MAX_IMAGES = 16;
/** 单张图最大字节（超出就跳过，避免一张 40MB 的扫描图拖死预览） */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 压缩包条目上限，防 zip 炸弹 */
const MAX_ENTRIES = 5000;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
};

/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? all;
  });
}

/** 从一段标签串里取属性（顺序无关、单双引号都认） @param {string} raw @param {string} name */
function attr(raw, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(raw);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : '';
}

/** 解析 OPF：manifest + spine + 元数据（正则足够，OPF 是扁平 XML） */
function parseOpf(xml) {
  const manifest = new Map();
  for (const m of xml.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (!id || !href) continue;
    manifest.set(id, {
      href,
      type: attr(tag, 'media-type'),
      properties: attr(tag, 'properties'),
    });
  }
  const spine = [];
  for (const m of xml.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(m[0], 'idref');
    if (idref) spine.push(idref);
  }
  const pick = (tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
    return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()) : '';
  };
  const coverId = (() => {
    for (const m of xml.matchAll(/<meta\b[^>]*>/gi)) {
      if (attr(m[0], 'name').toLowerCase() === 'cover') return attr(m[0], 'content');
    }
    for (const [id, item] of manifest) {
      if (/\bcover-image\b/.test(item.properties)) return id;
    }
    return '';
  })();
  return {
    manifest,
    spine,
    coverId,
    title: pick('dc:title'),
    creator: pick('dc:creator'),
    language: pick('dc:language'),
  };
}

/** XHTML → 纯文本块 + 图片引用（保持大致顺序，插图不会被甩到章末） */
function htmlToBlocks(html) {
  const blocks = [];
  let images = 0;
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      if (images >= MAX_IMAGES) return '\n';
      images += 1;
      const src = attr(tag, 'src') || attr(tag, 'xlink:href');
      if (!src) return '\n';
      return `\n\u0000IMG:${src}\u0000\n`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|figcaption|pre|dd|dt)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '');

  let used = 0;
  for (const rawLine of decodeEntities(stripped).split('\n')) {
    const line = rawLine.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!line) continue;
    const img = /^\u0000IMG:(.*)\u0000$/.exec(line);
    if (img) {
      blocks.push({ type: 'image', src: img[1] });
      continue;
    }
    if (used + line.length > MAX_TEXT_CHARS) {
      blocks.push({ type: 'text', text: line.slice(0, Math.max(0, MAX_TEXT_CHARS - used)) });
      break;
    }
    blocks.push({ type: 'text', text: line });
    used += line.length;
  }
  return blocks;
}

/** 章节标题：XHTML 里的 <title>/<h1>，取不到就用「第 N 节」 */
function chapterLabel(html, n) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const h1 = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html);
  for (const m of [title, h1]) {
    if (!m) continue;
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 80);
  }
  return `第 ${n} 节`;
}

/** zip 内路径归一化：相对当前文件目录，且不允许跳出包外 */
function resolveInZip(fromDir, href) {
  const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
  const joined = path.posix.normalize(path.posix.join(fromDir, clean));
  return joined.startsWith('..') ? '' : joined.replace(/^\/+/, '');
}

const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

/**
 * 解析一本 EPUB（传 Buffer，单测可直接用内存 zip）。
 * @param {Buffer} buffer
 */
export async function parseEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRIES) throw new Error('EPUB 条目过多，已拒绝解析');

  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  const opfPath = /full-path\s*=\s*"([^"]+)"/i.exec(container)?.[1] || '';
  if (!opfPath) throw new Error('不是有效的 EPUB：找不到 OPF 文件');
  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);

  const opf = await zip.file(opfPath)?.async('string');
  if (!opf) throw new Error('不是有效的 EPUB：OPF 文件读不出来');
  const meta = parseOpf(opf);

  /** 章节：spine 顺序优先，spine 为空时退化成「manifest 里的 xhtml 按文件名排」 */
  const spineIds = meta.spine.length
    ? meta.spine
    : [...meta.manifest.entries()].filter(([, v]) => /x?html/.test(v.type)).map(([k]) => k);

  const chapters = [];
  for (const id of spineIds) {
    const item = meta.manifest.get(id);
    if (!item) continue;
    const isHtml = /x?html/.test(item.type || '') || /\.x?html?$/i.test(item.href);
    if (!isHtml) continue;
    const filePath = resolveInZip(opfDir, item.href);
    const file = zip.file(filePath);
    if (!file) continue;
    const html = await file.async('string');
    chapters.push({
      label: chapterLabel(html, chapters.length + 1),
      filePath,
      /** 先留原文，按需再解析；避免一次请求把整本书都转成文本 */
      html,
    });
  }

  let cover = '';
  if (meta.coverId) {
    const item = meta.manifest.get(meta.coverId);
    if (item) {
      const file = zip.file(resolveInZip(opfDir, item.href));
      if (file) {
        const buf = await file.async('nodebuffer');
        if (buf.length <= MAX_IMAGE_BYTES * 2) {
          const mime = IMAGE_MIME[path.extname(item.href).toLowerCase()] || 'image/jpeg';
          cover = `data:${mime};base64,${buf.toString('base64')}`;
        }
      }
    }
  }

  return {
    zip,
    title: meta.title,
    author: meta.creator,
    language: meta.language,
    cover,
    chapters,
  };
}

/** @param {Awaited<ReturnType<typeof parseEpub>>} book @param {number} index */
export async function readChapter(book, index) {
  const ch = book.chapters[index];
  if (!ch) return null;
  const blocks = htmlToBlocks(ch.html);
  const dir = path.posix.dirname(ch.filePath) === '.' ? '' : path.posix.dirname(ch.filePath);
  const out = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      out.push(block);
      continue;
    }
    const file = book.zip.file(resolveInZip(dir, block.src));
    if (!file) continue;
    const buf = await file.async('nodebuffer');
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
    const mime = IMAGE_MIME[path.extname(block.src).toLowerCase()] || 'image/jpeg';
    out.push({ type: 'image', src: `data:${mime};base64,${buf.toString('base64')}` });
  }
  return { index, label: ch.label, blocks: out };
}

/** 打开磁盘上的 EPUB（路由用） @param {string} absPath */
export async function openEpubFile(absPath) {
  const buf = await fs.readFile(absPath);
  return parseEpub(buf);
}
