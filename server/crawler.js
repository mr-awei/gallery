import { db, getSettings, getLibraryGeneration } from './db.js';
import { KEEP_REASONS } from './library.js';
import { bulkIngestBuffers } from './bulk-import.js';
import { httpFetch } from './http.js';
import { sanitizeResults } from './sanitize.js';

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
];

function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url, opts = {}) {
  const { timeout = 15000, retries = 2, headers = {}, maxBytes = null } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await httpFetch(url, {
        headers: {
          'User-Agent': pickUA(),
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!maxBytes) return Buffer.from(await res.arrayBuffer());
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`超过大小上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
        }
      }
      return Buffer.concat(chunks);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1) + Math.random() * 400);
    }
  }
  throw lastErr;
}

function decodeBaiduUrl(url) {
  if (!url) return null;
  const decoded = url
    .replace(/_z2C\$q/g, ':')
    .replace(/_z&e3B/g, '.')
    .replace(/AzdH3F/g, '/');
  if (!/^https?:\/\//i.test(decoded)) return null;
  if (decoded.includes('_z2C') || decoded.includes('AzdH3F')) return null;
  return decoded;
}

/** 百度图片链接带的 w/h 参数会把原图缩到很小，去掉后取原图 */
function upscaleBaiduUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('baidu.com')) {
      u.searchParams.delete('w');
      u.searchParams.delete('h');
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function searchBing(keyword, page) {
  const first = page * 35 + 1;
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(keyword)}&first=${first}&count=35&mkt=zh-CN&setlang=zh-CN`;
  const buf = await httpGet(url, { headers: { Referer: 'https://www.bing.com/' }, timeout: 15000 });
  const html = buf
    .toString('utf8')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'");
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/"(?:murl|mediaurl)":"([^"]+)"/g)) {
    const u = m[1];
    if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push({ url: u, referer: 'https://www.bing.com/', source: 'bing' });
  }
  if (!out.length) {
    for (const m of html.matchAll(/<img[^>]+class="mimg"[^>]+src="([^"]+)"/g)) {
      const u = m[1].replace(/&amp;/g, '&');
      if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
      seen.add(u);
      out.push({ url: u, referer: 'https://www.bing.com/', source: 'bing' });
    }
  }
  return sanitizeResults(out);
}

async function searchBaidu(keyword, page) {
  const url =
    'https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&is=&fp=result&fr=&' +
    `word=${encodeURIComponent(keyword)}&pn=${page * 30}&rn=30&gsm=1e&ie=utf-8&oe=utf-8`;
  const buf = await httpGet(url, { headers: { Referer: 'https://image.baidu.com/' }, timeout: 15000 });
  const json = parseJsonSafe(buf.toString('utf8'), '百度图片');
  const list = Array.isArray(json?.data) ? json.data : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const candidates = [decodeBaiduUrl(item.objURL), item.hoverURL, item.middleURL, item.thumbURL];
    for (const c of candidates) {
      if (!c || !/^https?:\/\//i.test(c) || seen.has(c)) continue;
      seen.add(c);
      out.push({ url: upscaleBaiduUrl(c), referer: 'https://image.baidu.com/', source: 'baidu' });
      break;
    }
  }
  return sanitizeResults(out);
}

async function searchSogou(keyword, page) {
  const url = `https://pic.sogou.com/pics?query=${encodeURIComponent(keyword)}&mode=1&start=${
    page * 48
  }&len=48`;
  const buf = await httpGet(url, { headers: { Referer: 'https://pic.sogou.com/' }, timeout: 15000 });
  // 页面内 JSON 使用 \u002F 转义斜杠，先还原
  const html = buf
    .toString('utf8')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');

  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/"(?:picUrl|oriPicUrl)":"([^"]+)"/g)) {
    const u = m[1];
    if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push({ url: u, referer: 'https://pic.sogou.com/', source: 'sogou' });
  }
  if (!out.length) {
    for (const m of html.matchAll(/"thumbUrl":"([^"]+)"/g)) {
      const u = m[1];
      if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
      seen.add(u);
      out.push({ url: u, referer: 'https://pic.sogou.com/', source: 'sogou' });
    }
  }
  return sanitizeResults(out);
}

async function searchWallhaven(keyword, page, opts = {}) {
  const qs = new URLSearchParams({
    q: keyword,
    page: String(page + 1),
    sorting: 'relevance',
    order: 'desc',
    purity: '100',
  });
  if (opts.wallhavenApiKey) qs.set('apikey', opts.wallhavenApiKey);
  const url = `https://wallhaven.cc/api/v1/search?${qs.toString()}`;
  const buf = await httpGet(url, { headers: { Referer: 'https://wallhaven.cc/' }, timeout: 15000 });
  const json = parseJsonSafe(buf.toString('utf8'), 'Wallhaven');
  const list = Array.isArray(json?.data) ? json.data : [];
  return sanitizeResults(
    list.map((item) => ({ url: item.path, referer: 'https://wallhaven.cc/', source: 'wallhaven' }))
  );
}

/** 结果里已知尺寸时，按用户设置的最低分辨率先筛掉，省下无效下载 */
function tooSmall(width, height, minLongSide) {
  if (!minLongSide) return false;
  const long = Math.max(Number(width) || 0, Number(height) || 0);
  return long > 0 && long < minLongSide;
}

/** 360 图片：公开 JSON 接口。分页用的是 sn（起始条数），pn 无效 */
async function searchImage360(keyword, page, opts = {}) {
  const url = `https://image.so.com/j?q=${encodeURIComponent(keyword)}&src=srp&sn=${page * 30}&rn=30`;
  const buf = await httpGet(url, { headers: { Referer: 'https://image.so.com/' }, timeout: 15000 });
  const json = parseJsonSafe(buf.toString('utf8'), '360 图片');
  const list = Array.isArray(json?.list) ? json.list : [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    let u = it?.img;
    if (!u || !/^https?:\/\//i.test(u)) continue;
    // 去掉 360 CDN 的缩放指令（形如 xxx.jpg!/fh/300），带指令的地址常直接 404
    u = u.split('!')[0];
    if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
    if (tooSmall(it.width, it.height, opts.minResolution)) continue;
    seen.add(u);
    out.push({ url: u, referer: 'https://image.so.com/', source: 'image360' });
  }
  return sanitizeResults(out);
}

/** JSON.parse 守护：源返回风控 HTML / 空响应时给出带源名的可读错误，而不是裸解析栈 */
function parseJsonSafe(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} 返回的不是 JSON（可能触发风控或页面已改版）：${String(text).slice(0, 120)}`);
  }
}

/** 堆糖：公开 JSON 接口，photo.path 就是原图直链 */
async function searchDuitang(keyword, page, opts = {}) {
  const url = `https://www.duitang.com/napi/blog/list/by_search/?kw=${encodeURIComponent(keyword)}&start=${
    page * 24
  }&limit=24`;
  const buf = await httpGet(url, { headers: { Referer: 'https://www.duitang.com/' }, timeout: 15000 });
  const json = parseJsonSafe(buf.toString('utf8'), '堆糖');
  const list = Array.isArray(json?.data?.object_list) ? json.data.object_list : [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    const photo = it?.photo;
    const u = photo?.path;
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
    if (tooSmall(photo.width, photo.height, opts.minResolution)) continue;
    seen.add(u);
    out.push({ url: u, referer: 'https://www.duitang.com/', source: 'duitang' });
  }
  return sanitizeResults(out);
}

/**
 * 微博图片搜索（博主/超话里的原图）。
 * 微博已对未登录请求关闭接口（会返回 ok=-100 或 HTTP 432），
 * 所以需要用户提供登录后的 Cookie（见 设置 → 采集 → 微博 Cookie）。
 */
async function searchWeibo(keyword, page, opts = {}) {
  const cookie = String(opts.weiboCookie || '').trim();
  if (!cookie) {
    throw new Error('微博需要登录 Cookie：请到「设置 → 采集」填入微博 Cookie 后再采集');
  }
  // 微博风控把登录态与 User-Agent 绑定：必须用登录会话同一个 UA，否则返回 ok=-100
  const ua = String(opts.weiboUserAgent || '').trim() || pickUA();
  // type=1 综合搜索：返回的微博卡片里带原图（type=3 是用户搜索，搜到的是人不是图）
  const cid = `100103type%3D1%26q%3D${encodeURIComponent(keyword)}`;
  const url = `https://m.weibo.cn/api/container/getIndex?containerid=${cid}&page_type=searchall&page=${page + 1}`;
  const buf = await httpGet(url, {
    headers: {
      'User-Agent': ua,
      Referer: `https://m.weibo.cn/search?containerid=${cid}`,
      'X-Requested-With': 'XMLHttpRequest',
      'MWeibo-Pwa': '1',
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
    },
    timeout: 15000,
    retries: 2, // 超时/网络抖动值得重试；Cookie 失效（-100）会快速返回，重试成本可忽略
  });
  const json = parseJsonSafe(buf.toString('utf8'), '微博图片');
  if (json?.ok !== 1) {
    if (json?.ok === -100) throw new Error('微博 Cookie 无效或已过期，请重新获取');
    // 「这里还没有内容」= 该页无结果，属正常翻页到底，不算失败
    if (String(json?.msg || '').includes('还没有内容')) return [];
    throw new Error(`微博返回异常：${json?.msg || `ok=${json?.ok}`}`);
  }
  const cards = (json?.data?.cards || []).flatMap((c) => (Array.isArray(c?.card_group) ? c.card_group : [c]));
  const out = [];
  const seen = new Set();
  for (const c of cards) {
    for (const p of c?.mblog?.pics || []) {
      let u = p?.large?.url || p?.url || '';
      if (u.startsWith('//')) u = `https:${u}`;
      if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
      seen.add(u);
      out.push({ url: u, referer: 'https://m.weibo.cn/', source: 'weibo' });
    }
  }
  return sanitizeResults(out);
}

export const SOURCES = {
  bing: { key: 'bing', label: '必应图片', search: searchBing },
  baidu: { key: 'baidu', label: '百度图片', search: searchBaidu },
  sogou: { key: 'sogou', label: '搜狗图片', search: searchSogou },
  image360: { key: 'image360', label: '360 图片', search: searchImage360 },
  duitang: { key: 'duitang', label: '堆糖', search: searchDuitang },
  weibo: { key: 'weibo', label: '微博图片', search: searchWeibo },
  wallhaven: { key: 'wallhaven', label: 'Wallhaven', search: searchWallhaven },
};

/* --------------------------------- 任务引擎 -------------------------------- */

let job = null;

function makeJob(config) {
  return {
    id: Date.now(),
    running: true,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    endedAt: null,
    phase: 'running',
    keywords: config.keywords,
    sources: config.sources,
    pages: config.pages,
    current: null, // { keyword, source, page }
    search: { total: config.keywords.length * config.sources.length * config.pages, done: 0, failed: 0 },
    download: { queued: 0, done: 0, active: 0, saved: 0, failed: 0 },
    stats: {
      candidates: 0,
      newCandidates: 0,
      downloaded: 0,
      saved: 0,
      failed: 0,
      skipped: 0,
      dropped: { lowres: 0, small: 0, format: 0, duplicate: 0, oversize: 0, aiFilter: 0 },
    },
    failures: [],
    failureCount: 0,
    logs: [],
    logSeq: 0,
  };
}

function log(jobRef, level, message) {
  jobRef.logs.push({ id: ++jobRef.logSeq, t: Date.now(), level, message });
  if (jobRef.logs.length > 600) jobRef.logs.splice(0, jobRef.logs.length - 600);
}

function addFailure(jobRef, entry) {
  jobRef.failureCount++;
  jobRef.failures.push({ id: jobRef.failureCount, t: Date.now(), ...entry });
  if (jobRef.failures.length > 300) jobRef.failures.splice(0, jobRef.failures.length - 300);
}

export function getJob() {
  return job;
}

export function getJobStatus() {
  if (!job) {
    return {
      running: false,
      phase: 'idle',
      keywords: [],
      sources: [],
      pages: 0,
      current: null,
      search: { total: 0, done: 0, failed: 0 },
      download: { queued: 0, done: 0, active: 0, saved: 0, failed: 0 },
      stats: null,
      failures: [],
      failureCount: 0,
      logs: [],
    };
  }
  return {
    id: job.id,
    running: job.running,
    phase: job.phase,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    keywords: job.keywords,
    sources: job.sources,
    pages: job.pages,
    current: job.current,
    search: job.search,
    download: job.download,
    stats: job.stats,
    failures: job.failures.slice(-100),
    failureCount: job.failureCount,
    logs: job.logs.slice(-300),
  };
}

export function stopCrawl() {
  if (job && job.running) {
    job.stopRequested = true;
    log(job, 'warn', '收到停止指令：停止搜索与排队，已开始的下载会完成…');
  }
  return !!job;
}

export function startCrawl(config) {
  if (job && job.running) return { ok: false, message: '已有采集任务正在运行' };
  const settings = getSettings();
  const keywords = (config.keywords || []).filter(Boolean);
  if (!keywords.length) return { ok: false, message: '请至少选择一个关键词' };
  const sources = (config.sources || []).filter((s) => SOURCES[s]);
  if (!sources.length) return { ok: false, message: '请至少选择一个采集源' };
  const pages = Math.max(1, Math.min(20, Number(config.pages || settings.pagesPerKeyword)));

  job = makeJob({ keywords, sources, pages });
  const jobRef = job;
  log(
    jobRef,
    'info',
    `开始采集：${keywords.length} 个关键词 × ${sources.length} 个来源 × ${pages} 页（边搜边下载）`
  );

  runJob(jobRef, settings).catch((err) => {
    log(jobRef, 'error', `任务异常：${err.message}`);
    jobRef.running = false;
    jobRef.endedAt = new Date().toISOString();
  });

  return { ok: true, jobId: job.id };
}

async function runJob(jobRef, settings) {
  // 采集是跨 await 的长任务：中途切库后下载到的图会写进新库，记下代数以便中止
  const generation = getLibraryGeneration();
  const existingUrls = new Set(
    db
      .prepare('SELECT source_url FROM images')
      .all()
      .map((r) => r.source_url)
      .filter(Boolean)
  );
  const libraryCount = db.prepare('SELECT COUNT(*) AS c FROM images').get().c;
  log(jobRef, 'info', `图库已有 ${libraryCount} 张图片，已采集过的链接自动跳过（增量采集）`);

  const queue = [];
  const seen = new Set();
  let searchDone = false;
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(12, Number(settings.concurrency) || 5));
  // 下载与入库解耦：下载协程把 buffer 投进 ingestQueue，ingestLoop 攒批入库
  const ingestQueue = [];
  let ingestClosed = false;
  const ingestPromise = ingestLoop(jobRef, settings, generation, ingestQueue, () => ingestClosed);
  // 各采集源需要的凭据与过滤条件（wallhaven API Key、微博 Cookie、最低分辨率）
  const searchOpts = {
    wallhavenApiKey: settings.wallhavenApiKey || '',
    weiboCookie: settings.weiboCookie || '',
    weiboUserAgent: settings.weiboUserAgent || '',
    minResolution: Number(settings.minResolution) || 0,
  };

  // 下载 worker：与搜索并行，候选一出现就开始下载
  async function downloadWorker() {
    for (;;) {
      if (jobRef.stopRequested || generation !== getLibraryGeneration()) return;
      if (cursor >= queue.length) {
        if (searchDone || jobRef.stopRequested) return;
        await sleep(150);
        continue;
      }
      const item = queue[cursor++];
      jobRef.download.active++;
      try {
        await downloadOne(jobRef, item, settings, ingestQueue);
      } finally {
        jobRef.download.active--;
      }
    }
  }

  const workers = Promise.all(Array.from({ length: concurrency }, () => downloadWorker()));

  // 搜索循环
  outer: for (const keyword of jobRef.keywords) {
    for (const sourceKey of jobRef.sources) {
      for (let page = 0; page < jobRef.pages; page++) {
        if (jobRef.stopRequested) break outer;
        if (generation !== getLibraryGeneration()) {
          jobRef.stopRequested = true;
          log(jobRef, 'warn', '已切换资源库：采集中止（避免下载结果写进别的库）');
          break outer;
        }
        const source = SOURCES[sourceKey];
        jobRef.current = { keyword, source: source.label, page: page + 1 };
        try {
          const searchOne = () => source.search(keyword, page, searchOpts);
          let items = await searchOne();
          if (!items.length) {
            await sleep(1200); // 可能被反爬返回空页，重试一次
            items = await searchOne();
          }
          jobRef.search.done++;
          let fresh = 0;
          for (const item of items) {
            if (seen.has(item.url) || existingUrls.has(item.url)) continue;
            seen.add(item.url);
            fresh++;
            queue.push({ ...item, keyword });
            jobRef.download.queued = queue.length;
          }
          jobRef.stats.candidates += items.length;
          jobRef.stats.newCandidates += fresh;
          log(
            jobRef,
            'info',
            `[${source.label}] "${keyword}" 第 ${page + 1} 页：候选 ${items.length} 张，新增 ${fresh} 张（待下载 ${queue.length}）`
          );
        } catch (err) {
          jobRef.search.done++;
          jobRef.search.failed++;
          addFailure(jobRef, {
            source: source.label,
            keyword,
            url: '',
            reason: `搜索失败（${source.label} 第 ${page + 1} 页）`,
            message: err.message,
          });
          log(jobRef, 'error', `[${source.label}] "${keyword}" 第 ${page + 1} 页抓取失败：${err.message}`);
        }
        await sleep(300 + Math.random() * 500);
      }
    }
  }

  searchDone = true;
  await workers;
  ingestClosed = true; // 下载全部结束：等入库队列清空后再宣告完成
  await ingestPromise;
  finish(jobRef, jobRef.stopRequested ? '已手动停止' : '采集完成');
}

/**
 * 下载单个候选并投递到批量入库队列。
 * 下载与入库解耦：下载协程只管网络 IO（拿到 buffer 就走），入库由 ingestLoop
 * 攒批交给 bulkIngestBuffers（worker 池派生 + 批量事务），主线程不再逐张解码。
 */
async function downloadOne(jobRef, item, settings, ingestQueue) {
  try {
    const maxBytes = Number(settings.maxFileSize) * 1024 * 1024;
    let buffer;
    try {
      buffer = await httpGet(item.url, {
        headers: item.referer ? { Referer: item.referer } : {},
        timeout: 20000,
        retries: 1,
        maxBytes: maxBytes + 1024 * 1024,
      });
    } catch (err) {
      // 部分 CDN 带 Referer 反而拒绝（403/418/451），去掉防盗链头再试一次
      if (/HTTP 40[3]|HTTP 418|HTTP 451/.test(err.message) && item.referer) {
        buffer = await httpGet(item.url, { timeout: 20000, retries: 1, maxBytes: maxBytes + 1024 * 1024 });
      } else {
        throw err;
      }
    }
    jobRef.download.done++;
    jobRef.stats.downloaded++;
    ingestQueue.push({ item, buffer });
  } catch (err) {
    jobRef.download.done++;
    jobRef.download.failed++;
    jobRef.stats.failed++;
    const message = err?.message || String(err);
    addFailure(jobRef, {
      source: SOURCES[item.source]?.label || item.source,
      keyword: item.keyword,
      url: item.url,
      reason: '下载失败',
      message,
    });
    log(jobRef, 'error', `× 下载失败 ${item.url.slice(0, 70)} — ${message}`);
  }
}

const DROP_LABELS = {
  [KEEP_REASONS.tooSmall]: '分辨率不足',
  [KEEP_REASONS.tooLight]: '文件过小',
  [KEEP_REASONS.badFormat]: '格式不支持',
  [KEEP_REASONS.duplicate]: '重复图片',
  [KEEP_REASONS.tooLarge]: '文件过大',
  [KEEP_REASONS.failed]: '处理失败',
  [KEEP_REASONS.aiFilter]: '知识库判定低分',
};

/** 批量入库的逐条结果回调：把统计与日志更新到任务上（口径与旧逐条 ingest 完全一致） */
function applyIngestResult(jobRef, item, result) {
  if (result.ok) {
    jobRef.download.saved++;
    jobRef.stats.saved++;
    if (jobRef.stats.saved % 10 === 1 || jobRef.stats.saved <= 3) {
      log(
        jobRef,
        'success',
        `✓ 已保存 ${jobRef.stats.saved} 张（队列 ${jobRef.download.queued - jobRef.download.done}）最新：${result.image.width}×${result.image.height} · ${item.source} · ${item.keyword}`
      );
    }
  } else {
    const reason = DROP_LABELS[result.reason] || result.reason;
    jobRef.stats.dropped[result.reason] = (jobRef.stats.dropped[result.reason] || 0) + 1;
    log(jobRef, 'warn', `× 丢弃（${reason}）${item.source} · ${item.url.slice(0, 70)}`);
  }
}

/**
 * 入库消费协程：攒批（BATCH 条）交给 bulkIngestBuffers。
 * 下载协程与消费协程共享队列；下载侧结束（closed）且队列清空后退出。
 */
const INGEST_BATCH = 24;

async function ingestLoop(jobRef, settings, generation, ingestQueue, isClosed) {
  for (;;) {
    if (jobRef.stopRequested || generation !== getLibraryGeneration()) {
      ingestQueue.length = 0; // 中止：未入库的下载结果直接丢弃
      return;
    }
    if (!ingestQueue.length) {
      if (isClosed()) return;
      await sleep(120);
      continue;
    }
    const batch = ingestQueue.splice(0, INGEST_BATCH);
    const items = batch.map((e) => ({
      buffer: e.buffer,
      source: e.item.source,
      keyword: e.item.keyword,
      sourceUrl: e.item.url,
      title: e.item.keyword,
    }));
    try {
      await bulkIngestBuffers(items, {
        libGeneration: generation,
        onEach: (i, r) => applyIngestResult(jobRef, batch[i].item, r),
      });
    } catch (err) {
      // 批量整体异常：逐条按失败统计（与下载失败同一出口）
      for (const e of batch) {
        jobRef.download.failed++;
        jobRef.stats.failed++;
        addFailure(jobRef, {
          source: SOURCES[e.item.source]?.label || e.item.source,
          keyword: e.item.keyword,
          url: e.item.url,
          reason: '入库失败',
          message: err?.message || String(err),
        });
      }
      log(jobRef, 'error', `× 一批 ${batch.length} 张入库失败：${err?.message || err}`);
    }
  }
}

function finish(jobRef, message) {
  jobRef.running = false;
  jobRef.phase = 'done';
  jobRef.endedAt = new Date().toISOString();
  const s = jobRef.stats;
  log(
    jobRef,
    'success',
    `${message}｜候选 ${s.candidates} · 待下载 ${jobRef.download.queued} · 已下载 ${s.downloaded} · 保存 ${s.saved} · 失败 ${s.failed} · 重复 ${s.dropped.duplicate} · 低质 ${
      s.dropped.lowres + s.dropped.small + s.dropped.format
    } · 知识库过滤 ${s.dropped.aiFilter}`
  );
}

/**
 * 下载并入库一组直链（用于初始素材）。批量走流水线（worker 派生 + 批量事务），
 * 下载间隔保留节流避免对源站过快。
 */
export async function ingestUrls(urls, { source = 'seed', keyword = '初始素材' } = {}) {
  const buffers = [];
  const okUrls = [];
  for (const url of urls) {
    try {
      const buffer = await httpGet(url, {
        timeout: 25000,
        retries: 3,
        maxBytes: 40 * 1024 * 1024,
        headers: { Referer: 'https://www.doubao.com/' },
      });
      buffers.push(buffer);
      okUrls.push(url);
    } catch (err) {
      buffers.push(null);
      okUrls.push(url);
    }
    await sleep(500);
  }
  const results = new Array(okUrls.length);
  const slots = [];
  for (let i = 0; i < okUrls.length; i++) {
    if (!buffers[i]) {
      results[i] = { url: okUrls[i], ok: false, reason: 'failed', error: '下载失败' };
      continue;
    }
    slots.push(i);
  }
  if (slots.length) {
    const perItem = new Array(slots.length);
    await bulkIngestBuffers(
      slots.map((i) => ({ buffer: buffers[i], source, keyword, sourceUrl: okUrls[i], title: keyword })),
      { onEach: (i, r) => (perItem[i] = r) }
    );
    slots.forEach((slot, i) => {
      const r = perItem[i];
      results[slot] = r
        ? { url: okUrls[slot], ok: r.ok, reason: r.reason, id: r.id, duplicateOf: r.duplicateOf }
        : { url: okUrls[slot], ok: false, reason: 'failed', error: '入库失败' };
    });
  }
  return results;
}
