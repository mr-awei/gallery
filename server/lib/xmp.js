// @ts-check
/**
 * XMP sidecar 读写（Lightroom / digiKam / Bridge 通用）。
 *
 * 为什么需要：标签、评分、备注原本只存在 gallery.db 里，把照片拷去 Lightroom
 * 或拿别的管理器打开，元数据全丢 —— 素材库锁死在单一应用里。XMP sidecar 是
 * 这一行的通用交换格式：`photo.jpg` 旁边放一个 `photo.xmp`。
 *
 * 两条原则：
 * 1. **不吞别人的数据**：sidecar 已存在且不是本应用写的（别家写的），只在
 *    rdf:RDF 里追加我们这一段描述，不整份覆盖；本应用自己写的才整体重写。
 * 2. **不炸主流程**：写失败（只读目录、被杀软锁住）只记日志，绝不让「改个标签」
 *    因为写 sidecar 失败而报错。
 */
import fs from 'node:fs';
import path from 'node:path';

/** photo.jpg → photo.xmp（同目录同基名；Lightroom 读的就是这个位置） */
export function sidecarPath(absPath) {
  const p = String(absPath || '');
  if (!p) return '';
  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  return path.join(dir, `${base}.xmp`);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unesc(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** 一段 rdf:Description：TuKu 负责的字段（标题/备注/评分/标签） */
function descriptionBlock(meta) {
  const tags = Array.isArray(meta.tags) ? meta.tags.filter((t) => String(t).trim()) : [];
  const rating = Math.max(0, Math.min(5, Math.round(Number(meta.rating) || 0)));
  const title = String(meta.title || '').trim();
  const note = String(meta.note || '').trim();
  const parts = [
    '  <rdf:Description rdf:about=""',
    '    xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    `    xmp:Rating="${rating}">`,
  ];
  if (title) {
    parts.push(`   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>`);
  }
  if (note) {
    parts.push(
      `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(note)}</rdf:li></rdf:Alt></dc:description>`
    );
  }
  parts.push(
    '   <dc:subject><rdf:Bag>',
    ...tags.map((t) => `    <rdf:li>${esc(t)}</rdf:li>`),
    '   </rdf:Bag></dc:subject>',
    '  </rdf:Description>'
  );
  return parts.join('\n');
}

/** 完整 XMP 包（本应用首次写这个文件时用） */
export function buildXmp(meta) {
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="TuKu">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    descriptionBlock(meta),
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
    '',
  ].join('\n');
}

/**
 * 写 sidecar。
 * @param {string} absPath 原图绝对路径
 * @param {{title?:string, tags?:string[], rating?:number, note?:string}} meta
 * @returns {{ok:boolean, path:string, merged?:boolean, error?:string}}
 */
export function writeSidecar(absPath, meta) {
  const file = sidecarPath(absPath);
  if (!file) return { ok: false, path: '', error: '没有原始文件路径' };
  try {
    let out = buildXmp(meta);
    let merged = false;
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8');
      // 别家写的：保留原内容，只追加本应用这段（不整份覆盖别人的关键字/历史）
      if (!old.includes('x:xmptk="TuKu"')) {
        const at = old.indexOf('</rdf:RDF>');
        if (at > 0) {
          out = `${old.slice(0, at)}${descriptionBlock(meta)}\n${old.slice(at)}`;
          merged = true;
        }
      }
    }
    fs.writeFileSync(file, out, 'utf8');
    return { ok: true, path: file, merged };
  } catch (err) {
    return { ok: false, path: file, error: String(/** @type {any} */ (err)?.message || err) };
  }
}

/** 从一段 xml 里取第一个 <tag ...>text</tag> */
function firstTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? unesc(m[1].trim()) : '';
}

/** 取 <dc:subject><rdf:Bag><rdf:li>a</rdf:li>… 里的全部标签 */
function bagItems(xml) {
  const block = xml.match(/<dc:subject>([\s\S]*?)<\/dc:subject>/);
  if (!block) return [];
  return [...block[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) => unesc(m[1].trim())).filter(Boolean);
}

/**
 * 读 sidecar。没有文件返回 null；文件坏了也返回 null（不抛，导入流程不该因此中断）。
 * @param {string} absPath
 * @returns {{title:string, tags:string[], rating:number, note:string, path:string} | null}
 */
export function readSidecar(absPath) {
  const file = sidecarPath(absPath);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const xml = fs.readFileSync(file, 'utf8');
    const ratingRaw = xml.match(/xmp:Rating="(-?\d+)"/);
    const title = firstTag(xml.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1] || '', 'rdf:li');
    const note = firstTag(xml.match(/<dc:description>([\s\S]*?)<\/dc:description>/)?.[1] || '', 'rdf:li');
    return {
      title,
      note,
      tags: bagItems(xml),
      rating: ratingRaw ? Math.max(0, Math.min(5, Number(ratingRaw[1]) || 0)) : 0,
      path: file,
    };
  } catch {
    return null;
  }
}

/** 删 sidecar（只在确认是我们写的那份时删，别家文件不动） */
export function removeSidecar(absPath) {
  const file = sidecarPath(absPath);
  if (!file || !fs.existsSync(file)) return false;
  try {
    if (!fs.readFileSync(file, 'utf8').includes('x:xmptk="TuKu"')) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
