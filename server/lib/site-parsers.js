// @ts-check
/**
 * 三个新增采集源的解析纯函数。
 *
 * 抽出来是为了能离线单测：站点改版时先跑 test/site-parsers.test.mjs 就能看出
 * 是哪一步解析不出来了，不用真去撞反爬。所有函数都不做网络请求、不抛网络错。
 */
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)(?:\?|$)|\/view\/(?:photo|raw|album)/i;

/** 豆瓣缩略图放大：/view/photo/s_ratio_poster/ → /view/photo/l_ratio_poster/ */
export function upscaleDoubanUrl(raw) {
  const u = String(raw || '');
  return u.replace(/\/view\/photo\/(?:s|m|sq|thumb)_(ratio_[a-z0-9_]+)\//i, '/view/photo/l_$1/');
}

/** Wikimedia Commons 的 MediaWiki API 响应（formatversion=2 时 pages 是数组） */
export function parseCommonsSearch(json, options = {}) {
  const raw = json?.query?.pages;
  const pages = Array.isArray(raw) ? raw : Object.values(raw || {});
  const min = Number(options.minLongSide) || 0;
  const out = [];
  for (const p of pages) {
    const info = Array.isArray(p?.imageinfo) ? p.imageinfo[0] : null;
    if (!info || typeof info.url !== 'string' || !/^https?:\/\//i.test(info.url)) continue;
    const width = Number(info.width) || 0;
    const height = Number(info.height) || 0;
    const long = Math.max(width, height);
    if (min && long > 0 && long < min) continue;
    out.push({ url: info.url, width, height, title: String(p?.title || '') });
  }
  return out;
}

/** 豆瓣站内搜索页里的图片（影人剧照 / 海报 / 相册缩略图） */
export function extractDoubanImages(html, limit = 60) {
  const text = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(/https?:\/\/img\d*\.doubanio\.com\/[^"'\s<>\\]+/gi)) {
    let u = m[0].replace(/&quot;.*$/, '');
    if (!IMAGE_EXT.test(u) || /\/icon\/|favicon|avatar/i.test(u)) continue;
    u = upscaleDoubanUrl(u);
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

/** 贴吧搜索结果页里的帖子 id */
export function extractTiebaThreads(html, limit = 6) {
  const text = String(html || '');
  const out = [];
  for (const m of text.matchAll(/(?:\/p\/|"tid":\s*"?|thread_id=)(\d{8,})/g)) {
    const id = m[1];
    if (!out.includes(id)) out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

/** 贴吧帖子页里的图片（src / bpic / data-original，含协议相对 URL） */
export function extractTiebaImages(html, limit = 40) {
  const text = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const out = [];
  const seen = new Set();
  const re = /(?:https?:)?\/\/(?:imgsrc|img|tiebapic|hiphotos)\.baidu\.com\/[^"'\s<>\\]+/gi;
  for (const m of text.matchAll(re)) {
    let u = m[0].replace(/&quot;.*$/, '');
    if (u.startsWith('//')) u = `https:${u}`;
    if (!IMAGE_EXT.test(u) || /\/icon\/|favicon|avatar|\/static\//i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}
