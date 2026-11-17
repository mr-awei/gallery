// @ts-check
/**
 * 全网以图搜图：引擎清单 + 真上传通道 + 国际网络体检。
 *
 * 原则：**能真上传的才叫 upload**。拿不到匿名上传口的引擎如实标成 manual，
 * 由前端把图片放进剪贴板再打开识图页让用户粘贴，界面上也写清楚原因 ——
 * 不做「点了以为搜了、其实什么都没发生」的假入口。
 *
 * 2026-11 实测结论（scripts 里跑过的探针，结论写在这里免得下次重复踩）：
 * - Yandex   ：POST yandex.ru/images/search?rpt=imageview 收 upfile，返回 cbirId → 结果页 200 ✅
 * - SauceNAO ：POST saucenao.com/search.php 收 file，HTML 结果页可解析 ✅
 * - 百度识图 ：graph.baidu.com/upload 返回 {"status":1,"msg":"Reject"}（2026 起加签名）❌
 * - 搜狗识图 ：pic.sogou.com 上传接口 500，napi 版 500 ❌
 * - 360 识图 ：st.so.com/uploadimg 404、image.so.com/upload 404 ❌
 * - Bing     ：searchbyimage/upload 404（接口已下线），视觉搜索只剩付费 API ❌
 * - TinEye   ：网页端不允许跨站上传，只有付费 API ❌
 * - Lens     ：v3/upload 需要浏览器会话，服务端直传拿不到结果 ❌
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { httpFetch } from '../http.js';
import { parseSaucenao } from './external-search.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** 各引擎上传体积上限（SauceNAO 12MB 最严） */
const MAX_UPLOAD = 12 * 1024 * 1024;
/** 超限或非常规格式统一缩到长边 1800 再上传：搜图引擎认这个量级，太快超时反而更少 */
const UPLOAD_EDGE = 1800;
const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif']);

/**
 * @typedef {{
 *   id: string, name: string, region: 'cn' | 'global', mode: 'upload' | 'manual',
 *   desc: string, url?: string, why?: string
 * }} EngineDef
 */

/** @type {EngineDef[]} */
export const ENGINES = [
  {
    id: 'yandex',
    name: 'Yandex 识图',
    region: 'global',
    mode: 'upload',
    desc: '上传本图，在 Yandex 的全球索引里找相同图、相似图与原始出处',
  },
  {
    id: 'saucenao',
    name: 'SauceNAO',
    region: 'global',
    mode: 'upload',
    desc: '上传本图，查插画 / 同人 / 漫画 / 动画截图的出处',
  },
  {
    id: 'lens',
    name: 'Google Lens',
    region: 'global',
    mode: 'manual',
    url: 'https://lens.google.com/',
    desc: 'Google 的以图搜图，识别物体与文字最强',
    why: 'Google 没有可匿名调用的上传接口，只能打开 Lens 页面后粘贴图片',
  },
  {
    id: 'tineye',
    name: 'TinEye',
    region: 'global',
    mode: 'manual',
    url: 'https://tineye.com/',
    desc: '找相同图与更高清版本，适合查转载',
    why: 'TinEye 网页端不允许跨站上传，只有付费 API 能代传',
  },
  {
    id: 'baidu',
    name: '百度识图',
    region: 'cn',
    mode: 'manual',
    url: 'https://graph.baidu.com/pcpage/index?tpl_from=pc',
    desc: '国内的以图搜图，中文网页与商品命中较好',
    why: '百度 2026 起给上传接口加了签名校验（实测返回 Reject），只能打开页面粘贴',
  },
  {
    id: 'sogou',
    name: '搜狗识图',
    region: 'cn',
    mode: 'manual',
    url: 'https://pic.sogou.com/',
    desc: '国内识图，偏素材与商品',
    why: '搜狗上传接口实测 500（已关闭），只能打开页面粘贴',
  },
  {
    id: 'so360',
    name: '360 识图',
    region: 'cn',
    mode: 'manual',
    url: 'https://st.so.com/',
    desc: '国内识图，适合查网页转载',
    why: '360 上传接口已下线（404），只能打开页面粘贴',
  },
];

/** 国际网络体检的目标：只要这几个域名不通，国外引擎就必然失败 */
const GLOBAL_PROBE = [
  { engine: 'yandex', url: 'https://yandex.ru/images/' },
  { engine: 'saucenao', url: 'https://saucenao.com/' },
];

export function listEngines() {
  return ENGINES.map((e) => ({ ...e }));
}

/**
 * 把网络体检结果合进引擎清单：手动档只要求「页面打得开」，上传档才看国际网络。
 * 纯函数，路由与单测共用，免得两边各写一遍判定。
 * @param {{engines?: Record<string, {ok: boolean, ms?: number, error?: string}>} | null} network
 */
export function decorateEngines(network) {
  const probes = (network && network.engines) || {};
  return ENGINES.map((e) => {
    if (e.mode === 'manual') return { ...e, ready: true, reason: '' };
    const probe = probes[e.id];
    return {
      ...e,
      ready: probe ? probe.ok : true,
      reason: probe && !probe.ok ? `国际网络不通（${probe.error || '超时'}）` : '',
    };
  });
}

/** @type {{at: number, value: any} | null} */
let netCache = null;

/**
 * 国际网络是否畅通。按引擎分别探，前端据此提示「哪几个国外引擎这次用不了」。
 * 结果缓存 60s：一次搜图会连点好几个引擎，不该每次都重新体检。
 * @param {{force?: boolean}} [opts]
 */
export async function checkGlobalNetwork({ force = false } = {}) {
  if (!force && netCache && Date.now() - netCache.at < 60000) return netCache.value;
  const entries = await Promise.all(
    GLOBAL_PROBE.map(async ({ engine, url }) => {
      const t0 = Date.now();
      try {
        const resp = await httpFetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, timeout: 6000 });
        // 405 说明服务器在（只是不接 HEAD），照样算通
        const ok = resp.status > 0 && resp.status < 500;
        return [engine, { ok, ms: Date.now() - t0, error: ok ? '' : `HTTP ${resp.status}` }];
      } catch (err) {
        return [engine, { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) }];
      }
    })
  );
  const engines = Object.fromEntries(entries);
  const value = {
    ok: Object.values(engines).some((x) => x.ok),
    engines,
    checkedAt: Date.now(),
  };
  netCache = { at: Date.now(), value };
  return value;
}

/**
 * 把任意一张库内图片准备成可上传的 jpeg。
 * RAW / HEIC / 超大图都先转码：引擎那边只认常见的位图，直接甩 CR2 过去等于白跑。
 * @param {string} filePath
 */
export async function prepareUpload(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!RASTER.has(ext)) {
    throw new Error(`${ext || '这种'} 格式不能直接上传，先在「工具箱 → 格式转换」转成 JPG 再搜`);
  }
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('原文件已经不在磁盘上，无法上传搜图');

  if (stat.size <= MAX_UPLOAD && ext !== '.gif') {
    const buffer = await fs.promises.readFile(filePath);
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { buffer, mime, filename: `image${ext || '.jpg'}`, bytes: buffer.length };
  }
  const buffer = await sharp(filePath, { animated: false, failOn: 'none' })
    .rotate()
    .resize({ width: UPLOAD_EDGE, height: UPLOAD_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return { buffer, mime: 'image/jpeg', filename: 'image.jpg', bytes: buffer.length };
}

/**
 * @param {Record<string, string>} fields
 * @param {{field: string, filename: string, contentType: string, buffer: Buffer}} file
 */
function multipart(fields, file) {
  const boundary = `----TuKu${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  /** @type {Buffer[]} */
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

/** Yandex：上传拿 cbirId，再拼官方的以图搜图结果页 */
async function yandexUpload(upload) {
  const { body, contentType } = multipart({}, { field: 'upfile', filename: 'blob', contentType: upload.mime, buffer: upload.buffer });
  const request = encodeURIComponent(JSON.stringify({ blocks: [{ block: 'b-page_type_search-by-image__link' }] }));
  const resp = await httpFetch(`https://yandex.ru/images/search?format=json&request=${request}&rpt=imageview`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'User-Agent': UA,
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      Referer: 'https://yandex.ru/images/',
    },
    body,
    timeout: 30000,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Yandex 返回 ${resp.status}`);
  /** @type {any} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Yandex 返回的不是结果数据（多半触发了风控验证），过一会儿再试');
  }
  const params = data?.blocks?.[0]?.params;
  const cbirId = params?.cbirId || params?.cbir_id || '';
  if (!cbirId) throw new Error('Yandex 没有返回检索 id（多半触发了风控验证），过一会儿再试');
  return {
    ok: true,
    mode: 'upload',
    url: `https://yandex.ru/images/search?rpt=imageview&cbir_id=${encodeURIComponent(cbirId)}`,
    previewUrl: params?.originalImageUrl || params?.imageUrl || '',
    note: '已上传到 Yandex，在浏览器里打开结果页',
  };
}

/** SauceNAO：上传后服务端直接解析出候选，省得用户再去翻结果页 */
async function saucenaoUpload(upload) {
  const { body, contentType } = multipart(
    { db: '999', output_type: '0', hide: '0' },
    { field: 'file', filename: upload.filename, contentType: upload.mime, buffer: upload.buffer }
  );
  const resp = await httpFetch('https://saucenao.com/search.php', {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'User-Agent': UA, Accept: 'text/html' },
    body,
    timeout: 30000,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`SauceNAO 返回 ${resp.status}`);
  const results = parseSaucenao(text);
  return {
    ok: true,
    mode: 'upload',
    results,
    url: 'https://saucenao.com/search.php',
    note: results.length ? `找到 ${results.length} 条候选` : '没有找到匹配结果（这类图可能在索引之外）',
  };
}

/** 采集来的图如果带着原始网页地址，Lens / TinEye 就能直接「按地址搜」，比传剪贴板省事 */
const URL_SEARCH = {
  lens: (u) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(u)}`,
  tineye: (u) => `https://tineye.com/search?url=${encodeURIComponent(u)}`,
};

/** @param {unknown} u */
function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

/**
 * 跑单个引擎。
 * @param {string} engineId
 * @param {{buffer: Buffer, mime: string, filename: string} | null} upload
 * @param {{sourceUrl?: string}} [opts] sourceUrl 是这张图采集时的原始网页直链
 */
export async function runEngine(engineId, upload, opts = {}) {
  const def = ENGINES.find((e) => e.id === engineId);
  if (!def) throw new Error('未知的搜图引擎');
  if (def.mode === 'manual') {
    const byUrl = URL_SEARCH[/** @type {'lens'|'tineye'} */ (def.id)];
    if (byUrl && isHttpUrl(opts.sourceUrl)) {
      // 有公网地址就不必让用户粘贴：直接把地址交给站点自己去取图
      return { ok: true, mode: 'url', url: byUrl(String(opts.sourceUrl).trim()), note: '已用原图公网地址打开结果页（无需上传）' };
    }
    // 服务端只给地址，前端负责「复制图片 + 打开页面」，界面上说明必须手动粘贴
    return { ok: true, mode: 'manual', url: def.url || '', note: def.why || '打开页面后粘贴图片', needsClipboard: true };
  }
  if (!upload) throw new Error('没有可上传的图片数据');
  if (def.id === 'yandex') return yandexUpload(upload);
  if (def.id === 'saucenao') return saucenaoUpload(upload);
  throw new Error('这个引擎还没有实现');
}

/**
 * 多引擎并发搜图。单个引擎失败不影响其它，失败原因原样带回。
 * 只点了「打开识图页」类的引擎时不做上传准备：否则一张 CR2 会连带把整次请求拦下来，
 * 明明这些引擎根本不需要文件字节。
 * @param {string} filePath
 * @param {string[]} engineIds
 * @param {{sourceUrl?: string}} [opts]
 */
export async function searchAll(filePath, engineIds, opts = {}) {
  const ids = engineIds.length ? engineIds : ENGINES.map((e) => e.id);
  const needUpload = ids.some((id) => ENGINES.find((e) => e.id === id)?.mode === 'upload');
  const upload = needUpload ? await prepareUpload(filePath) : null;
  const results = await Promise.all(
    ids.map(async (id) => {
      const def = ENGINES.find((e) => e.id === id);
      if (!def) return { engine: id, ok: false, error: '未知的搜图引擎' };
      try {
        const r = await runEngine(id, upload, opts);
        return { engine: id, name: def.name, region: def.region, mode: def.mode, ...r };
      } catch (err) {
        return { engine: id, name: def.name, region: def.region, mode: def.mode, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
  return { bytes: upload ? upload.bytes : 0, results };
}
