// 外部以图搜图 + 一键换大图
//
// 说清楚能力边界，避免「按钮点下去什么都没发生」：
// - 真正能上传本地文件做反向搜图的公开服务：SauceNAO（无需 API key，返回 HTML 结果页，
//   对插画/同人/漫画命中率高）。百度的 graph 上传接口已在 2026 年加了签名参数，无 key
//   直接返回 “Params illegal”，所以没有接入，不拿它当卖点。
// - Google Lens / TinEye / Yandex 只接受「可公开访问的图片 URL」。采集来的素材通常带
//   source_url，这时可以直接拼链接打开；本地导入的图没有公网地址，就明确显示不可用。
// - Pinterest 的视觉搜索依赖内部接口 + 登录态，这里只提供关键词外链，并标注为「关键词」，
//   不冒称以图搜图。
import path from 'node:path';
import { httpFetch } from '../http.js';

const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif']);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || ''));
}

function isRaster(p) {
  return RASTER.has(path.extname(String(p || '')).toLowerCase());
}

/** 有些站点的图床地址末尾带缩放参数，试着推一张更大的版本用于「换大图」 */
export function enlargeCandidates(srcUrl) {
  const out = [srcUrl];
  try {
    const u = new URL(srcUrl);
    // 常见 CDN 缩略参数：?w=400 / ?width=400 / &h=300 / _400x300 / /thumb/
    const params = ['w', 'width', 'h', 'height', 'q', 'quality', 'size', 'resize'];
    if (params.some((p) => u.searchParams.has(p))) {
      const clean = new URL(u.toString());
      for (const p of params) clean.searchParams.delete(p);
      out.push(clean.toString());
    }
    const m = u.pathname.match(/^(.*?)(?:[._-])(\d{2,4})x(\d{2,4})(\.[a-z0-9]+)$/i);
    if (m) out.push(`${u.origin}${m[1]}${m[4]}${u.search}`);
  } catch {
    /* 非法 URL 就只保留原值 */
  }
  return [...new Set(out.filter(isHttpUrl))];
}

function buildMultipart(fields, file) {
  const boundary = `----TuKu${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`
    )
  );
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析 SauceNAO 结果页（无 key 的 HTML 版） */
export function parseSaucenao(html) {
  const blocks = String(html || '').split('<div class="result">').slice(1);
  const results = [];
  for (const b of blocks.slice(0, 8)) {
    const sim = Number((b.match(/class="resultsimilarityinfo">([\d.]+)%/) || [])[1] || 0);
    const thumb = (b.match(/id="resImage\d+"[^>]*src="([^"]+)"/) || [])[1] || '';
    const title = stripTags((b.match(/class="resulttitle">([\s\S]*?)<\/div>/) || [])[1] || '');
    const detail = stripTags((b.match(/class="resultcontentcolumn">([\s\S]*?)<\/div>/) || [])[1] || '');
    const links = [...b.matchAll(/href="(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => !/saucenao\.com\/(search\.php|donate)/i.test(u) && !/img\d*\.saucenao\.com/i.test(u));
    results.push({ similarity: sim, title: title || detail.slice(0, 80) || '未命名结果', detail: detail.slice(0, 200), thumb, link: links[0] || '' });
  }
  return results.filter((r) => r.title || r.link);
}

/** 当前素材可用的搜图渠道（含不可用原因，前端直接展示） */
export function listProviders(row) {
  const hasUrl = isHttpUrl(row.source_url);
  const raster = isRaster(row.abs_path);
  const kw = [row.title, row.tags].filter(Boolean).join(' ').trim();
  return [
    {
      id: 'saucenao',
      name: 'SauceNAO',
      kind: 'upload',
      desc: '上传本图，检索插画 / 同人 / 漫画出处（无需密钥）',
      ready: raster,
      reason: raster ? '' : '只有位图能上传检索',
    },
    {
      id: 'lens',
      name: 'Google Lens',
      kind: 'url',
      desc: '用原图公网地址做反向搜图',
      ready: hasUrl,
      reason: hasUrl ? '' : '本地导入的图没有公网地址，Lens 无法访问；采集来的素材才有',
    },
    {
      id: 'tineye',
      name: 'TinEye',
      kind: 'url',
      desc: '用原图公网地址找相同图 / 更高清版本',
      ready: hasUrl,
      reason: hasUrl ? '' : '需要可公开访问的图片地址',
    },
    {
      id: 'pinterest',
      name: 'Pinterest（关键词）',
      kind: 'keyword',
      desc: '按标题/标签在 Pinterest 找相似风格',
      ready: Boolean(kw),
      reason: kw ? '' : '没有标题或标签可供检索',
      url: kw ? `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(kw)}` : '',
    },
  ];
}

/** 执行反向搜图：upload 类真正上传，url 类拼链接，keyword 类给外链 */
export async function reverseSearch(row, engine) {
  const providers = listProviders(row);
  const p = providers.find((x) => x.id === engine);
  if (!p) throw new Error('未知的搜图渠道');
  if (!p.ready) throw new Error(p.reason || '这个渠道当前不可用');

  if (p.kind === 'keyword' || p.kind === 'url') {
    if (p.kind === 'url') {
      const target =
        engine === 'lens'
          ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(row.source_url)}`
          : `https://tineye.com/search?url=${encodeURIComponent(row.source_url)}`;
      return { ok: true, engine, mode: 'url', url: target, note: '已用原图公网地址打开搜图结果' };
    }
    return { ok: true, engine, mode: 'keyword', url: p.url, note: '关键词检索，不是以图搜图' };
  }

  // SauceNAO：无 key 上传，返回 HTML 结果页，服务端解析成结构化结果
  const fs = await import('node:fs');
  const buf = await fs.promises.readFile(row.abs_path);
  if (buf.length > 12 * 1024 * 1024) throw new Error('图片超过 12MB，搜图服务不接受这么大的上传');
  const ext = path.extname(row.abs_path).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  const { body, contentType } = buildMultipart({ db: '999', output_type: '0', hide: '0' }, {
    field: 'file',
    filename: `image${ext || '.jpg'}`,
    contentType: mime,
    buffer: buf,
  });
  const resp = await httpFetch('https://saucenao.com/search.php', {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'User-Agent': UA, Accept: 'text/html' },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`SauceNAO 返回 ${resp.status}，请稍后再试`);
  const results = parseSaucenao(text);
  if (!results.length) {
    return { ok: true, engine, mode: 'upload', results: [], note: '没有找到匹配结果（这类图可能在 SauceNAO 的索引之外）' };
  }
  return { ok: true, engine, mode: 'upload', results, note: `找到 ${results.length} 条候选` };
}

/** 探测一个远程图片是否比本地更大；返回 {url,width,height,area,buffer} */
export async function probeCandidate(url, referer = '') {
  const resp = await httpFetch(url, {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
  });
  if (!resp.ok) return null;
  const type = String(resp.headers.get('content-type') || '');
  if (!/^image\//i.test(type)) return null;
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length || buf.length > 80 * 1024 * 1024) return null;
  const sharp = (await import('sharp')).default;
  const meta = await sharp(buf, { failOn: 'none' }).metadata().catch(() => null);
  if (!meta?.width || !meta?.height) return null;
  return { url, width: meta.width, height: meta.height, area: meta.width * meta.height, buffer: buf, format: meta.format };
}

/** 对一张图尝试换更大版本：优先原地址，再试去掉缩放参数的变体 */
export async function findLargerSource(row, { minGain = 1.1 } = {}) {
  if (!isHttpUrl(row.source_url)) {
    throw new Error('这张图没有记录原始来源地址（本地导入的图无法自动换大图）');
  }
  const base = Number(row.width || 0) * Number(row.height || 0);
  const tried = [];
  for (const url of enlargeCandidates(row.source_url)) {
    let probe;
    try {
      // images 表没有 page_url 列（历史上也没写入过），referer 一律留空：
      // 以前读 row.page_url 永远是 undefined，等于给源站递了个空 Referer，纯属噪音
      probe = await probeCandidate(url, '');
    } catch (err) {
      tried.push({ url, error: err.message });
      continue;
    }
    if (!probe) {
      tried.push({ url, error: '不是可下载的图片' });
      continue;
    }
    if (!base || probe.area >= base * minGain) {
      return { found: true, ...probe, before: { width: row.width, height: row.height }, tried };
    }
    tried.push({ url, width: probe.width, height: probe.height, error: '尺寸没有更大' });
  }
  return { found: false, before: { width: row.width, height: row.height }, tried };
}
