/**
 * 网页书签：把「一个网址」变成库里的一个素材。
 *
 * 存三样东西：
 *  1. 标题 / 描述（og:title、og:description）
 *  2. 封面（og:image，失败就找页面里第一张图）
 *  3. 一份离线 HTML 快照（网页改版/删掉之后还能翻回去看）
 *
 * 刻意不做整页截图：那需要 headless 浏览器，桌面端靠 Electron 还能凑合，
 * 浏览器模式就没有了。og:image + 快照已经覆盖「收集灵感页」的实际需求。
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { db, getThumbDir } from './db.js';
import { getImage, setCustomThumb, setNote, setTags, toDTO } from './library.js';
import { httpFetch } from './http.js';
import { readBodyLimited } from './lib/safe-url.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请输入网页地址');
  // 用户通常直接粘「www.xxx.com/a」，补协议
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try {
    u = new URL(withProto);
  } catch {
    throw new Error('地址格式不对，检查一下有没有多余的空格');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http / https 地址');
  return u.toString();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const code = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** 抓所有 <meta>：属性顺序不固定（content 可能在 property 前面），一条正则硬匹配会漏 */
function readMetaTags(html) {
  const out = new Map();
  const re = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (key && content != null) out.set(key.toLowerCase(), decodeEntities(content));
  }
  return out;
}

export function parsePageMeta(html, baseUrl) {
  const metas = readMetaTags(html);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  const title = decodeEntities(metas.get('og:title') || titleTag || '')
    .replace(/\s+/g, ' ')
    .trim();
  const description = decodeEntities(
    metas.get('og:description') || metas.get('description') || metas.get('twitter:description') || ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  const site = decodeEntities(metas.get('og:site_name') || '').trim();
  const imageRaw =
    metas.get('og:image') ||
    metas.get('og:image:url') ||
    metas.get('twitter:image') ||
    metas.get('twitter:image:src') ||
    '';

  let image = '';
  if (imageRaw) {
    try {
      image = new URL(imageRaw, baseUrl).toString();
    } catch {
      image = '';
    }
  }
  // 没有 og:image：退而求其次拿页面里第一张 <img>
  if (!image) {
    for (const im of [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].slice(0, 12)) {
      try {
        image = new URL(decodeEntities(im[1]), baseUrl).toString();
        break;
      } catch {
        /* 相对路径解析失败就试下一张 */
      }
    }
  }
  return { title, description, image, site };
}

/**
 * @param {{url?: string, tags?: string[], note?: string, keyword?: string}} [opts]
 * @returns {Promise<ReturnType<typeof toDTO>>} 入库后的素材 DTO
 */
export async function saveBookmark({ url, tags = [], note = '', keyword = '' } = {}) {
  const target = normalizeUrl(url);

  let res;
  try {
    // 走统一出口：拒本机/内网地址，且重定向逐跳校验（书签 URL 完全由用户输入）
    res = await httpFetch(target, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    throw new Error(`抓取失败：${err?.message || '网络错误'}`, { cause: err });
  }
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('html')) throw new Error(`这个地址返回的不是网页（${ctype || '未知类型'}）`);

  const html = await res.text();
  const finalUrl = res.url || target;
  const meta = parsePageMeta(html, finalUrl);

  // 快照：超过 8MB 截断（有些页面把整个 SVG/base64 塞在 HTML 里）
  const snapshot = html.length > 8 * 1024 * 1024 ? html.slice(0, 8 * 1024 * 1024) : html;
  const snapDir = path.join(path.dirname(getThumbDir()), 'bookmarks');
  await fsp.mkdir(snapDir, { recursive: true });
  const key = crypto.createHash('sha1').update(finalUrl).digest('hex').slice(0, 16);
  const snapPath = path.join(snapDir, `${key}.html`);
  await fsp.writeFile(snapPath, snapshot, 'utf8');
  const stat = fs.statSync(snapPath);

  // 封面：失败不影响书签本身（卡片会退回到图标）
  let cover = null;
  if (meta.image) {
    try {
      const r = await httpFetch(meta.image, {
        headers: { 'user-agent': UA, referer: finalUrl },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        // 边读边限流：先 arrayBuffer() 再判断大小，等于让远端决定我们吃多少内存
        const buf = await readBodyLimited(r, 15 * 1024 * 1024);
        if (buf.length) {
          cover = await sharp(buf, { failOn: 'none' })
            .rotate()
            .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 84 })
            .toBuffer({ resolveWithObject: true });
        }
      }
    } catch {
      /* 封面拿不到就算了 */
    }
  }

  const width = cover?.info.width || 1200;
  const height = cover?.info.height || 630;

  const info = db
    .prepare(
      `INSERT INTO images (title, abs_path, thumb, source, keyword, source_url, width, height,
        size_bytes, mime, phash, favorite, tags, created_at, fs_mtime, md5, media_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      meta.title || finalUrl,
      snapPath,
      null,
      'bookmark',
      keyword,
      finalUrl,
      width,
      height,
      stat.size,
      'text/html',
      '',
      '',
      new Date().toISOString(),
      Math.round(stat.mtimeMs / 1000),
      '',
      'bookmark'
    );

  const id = Number(info.lastInsertRowid);
  if (cover) await setCustomThumb(id, cover.data);
  if (Array.isArray(tags) && tags.length) setTags(id, tags);
  // 描述塞进备注：灯箱能看到，搜索也能命中
  const noteText = [note, meta.description].filter(Boolean).join('\n\n');
  if (noteText) setNote(id, noteText);

  return toDTO(getImage(id));
}
