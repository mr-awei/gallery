/**
 * 图库采集助手（Chrome MV3）
 * - 右键单图采集 / 右键批量采集（页面内所有图）
 * - 截图（可见区域）
 * 统一 POST 到本地服务 http://127.0.0.1:<port>/api/extension/ingest
 *
 * 端口不再写死：开发模式是 3001，桌面版由 Electron 选随机端口，
 * 所以这里先探测 /api/health，命中的端口缓存到 chrome.storage.local。
 */
const DEFAULT_PORT = 3001;
const PORT_SCAN = 12; // 3001..3012
const CACHE_TTL = 30_000;
const MENU_SINGLE = 'gem-pick-one';
const MENU_BATCH = 'gem-pick-all';
const MENU_FULLSHOT = 'gem-shot-full';
const ICON_FALLBACK =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let baseCache = null; // { base, at }

/* --------------------------- 本地服务端口发现 --------------------------- */

/** 命中 /api/health 且返回 {ok:true} 才认为是图库服务（避免误认占端口的其它程序） */
async function discoverBase(force = false) {
  if (!force && baseCache && Date.now() - baseCache.at < CACHE_TTL) return baseCache.base;
  const { gemPort } = await chrome.storage.local.get('gemPort');
  const candidates = [];
  if (gemPort) candidates.push(Number(gemPort));
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_SCAN; p++) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: 'no-store' });
      if (!res.ok) continue;
      const j = await res.json();
      if (!j || j.ok !== true) continue;
      baseCache = { base: `http://127.0.0.1:${port}`, at: Date.now() };
      await chrome.storage.local.set({ gemPort: port });
      return baseCache.base;
    } catch {
      /* 该端口没有服务，试下一个 */
    }
  }
  baseCache = null;
  return null;
}

/** POST /api/extension/ingest；端口失效（服务重启换端口）时强制重探一次 */
async function postIngest(payload) {
  let base = await discoverBase();
  if (!base) throw new Error('本地图库未启动（已扫描 3001-3012 端口）');
  let res = await fetch(`${base}/api/extension/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 401 || res.status === 404 || res.status === 502) {
    base = await discoverBase(true);
    if (!base) throw new Error('本地图库未启动（端口已变化且探测失败）');
    res = await fetch(`${base}/api/extension/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  if (!res.ok) throw new Error(`本地图库返回 HTTP ${res.status}`);
  return await res.json();
}

/* --------------------------- 浏览器侧取图 --------------------------- */

/** 单张浏览器侧下载上限：再大就别塞进消息里，交回服务端 */
const BROWSER_FETCH_MAX = 20 * 1024 * 1024;

/**
 * 用浏览器身份取图片字节（带站点 Cookie），失败返回 null。
 *
 * 为什么不能只靠服务端下载：登录态/防盗链站点上，服务端没有 Cookie、Referer 也不对，
 * 十有八九 401/403。Eagle 之所以「同一张图能存」，就是它以浏览器身份取字节。
 * host_permissions 里有 <all_urls>，这里的 fetch 不受 CORS 限制。
 */
async function fetchImageAsDataUrl(url) {
  if (!/^https?:/i.test(String(url || ''))) return null;
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    // 有些站点对图片接口返回 200 + text/html（登录页 / 防盗链提示），当失败处理
    if (type && !type.startsWith('image/')) return null;
    const blob = await res.blob();
    if (!blob.size || blob.size > BROWSER_FETCH_MAX) return null;
    return await blobToDataUrl(blob, type.split(';')[0] || 'image/png');
  } catch {
    return null;
  }
}

/**
 * 把 urls 里浏览器能取到的换成 dataURL，取不到的留给服务端带 Referer 再试。
 * dataUrls 服务端只收 10 条，多的继续走 URL 通道。
 */
async function prefetchUrls(urls, dataUrls) {
  const keep = [];
  const out = dataUrls.slice();
  for (const u of urls) {
    const d = out.length < 10 ? await fetchImageAsDataUrl(u) : null;
    if (d) out.push(d);
    else keep.push(u);
  }
  return { urls: keep, dataUrls: out };
}

/** 后端 reason → 人话，通知里才说得清为什么没入库 */
const REASON_TEXT = {
  format: '格式不支持',
  lowres: '分辨率太低',
  small: '文件太小',
  oversize: '超过体积上限',
  duplicate: '图库里已有同一张',
  failed: '下载失败',
  aiFilter: '被过滤规则跳过',
  cancelled: '中途切换了图库',
};

function describeFailure(r) {
  const why = REASON_TEXT[r?.reason] || '未知原因';
  const fmt = r?.format ? `（${r.format}）` : '';
  const err = r?.error ? `：${String(r.error).slice(0, 40)}` : '';
  return why + fmt + err;
}

/* --------------------------- 右键菜单 --------------------------- */
// 监听器必须在顶层注册：MV3 的 Service Worker 会被回收，
// 写在 onInstalled 回调里的话 SW 重启后监听器就不存在，右键菜单点了没反应也不报错。

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SINGLE, title: '采集这张图片到图库', contexts: ['image'] }, () => {
      void chrome.runtime.lastError; // 忽略「已存在」这类重复创建错误
    });
    chrome.contextMenus.create({ id: MENU_BATCH, title: '采集本页所有图片到图库', contexts: ['page'] }, () => {
      void chrome.runtime.lastError;
    });
    chrome.contextMenus.create({ id: MENU_FULLSHOT, title: '整页截图存图库', contexts: ['page'] }, () => {
      void chrome.runtime.lastError;
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_SINGLE) {
    // 先在浏览器里取字节（带 Cookie），取不到才交回服务端下载
    const dataUrl = await fetchImageAsDataUrl(info.srcUrl);
    await send({
      urls: dataUrl ? [] : [info.srcUrl],
      dataUrls: dataUrl ? [dataUrl] : [],
      pageUrl: info.pageUrl,
      keyword: '',
      tags: '',
      skipQuality: true,
    });
    return;
  }
  if (info.menuItemId === MENU_BATCH && tab?.id) {
    try {
      const urls = await collectImages(tab.id);
      await send({ urls, pageUrl: info.pageUrl, keyword: tab.title || '', tags: '' });
    } catch (err) {
      notify('采集本页图片失败：' + (err?.message || err));
    }
    return;
  }
  if (info.menuItemId === MENU_FULLSHOT && tab?.id) {
    notify('正在滚动截取整页，请先别切换标签页…');
    try {
      const shot = await captureFullPage(tab.id);
      const j = await postIngest({
        dataUrls: [shot.dataUrl],
        pageUrl: info.pageUrl,
        keyword: tab.title || '',
        tags: '整页截图',
      });
      notify(
        `整页截图已入库（${j.saved || 0} 张）${shot.truncated ? '；页面过长，只截了前一部分' : ''}`
      );
    } catch (err) {
      notify('整页截图失败：' + (err?.message || err));
    }
  }
});

/** 收集页面内所有图片地址（去重、过滤过小的图） */
async function collectImages(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const out = new Set();
      const push = (u) => {
        if (!u) return;
        if (u.startsWith('//')) u = location.protocol + u;
        if (/^https?:\/\//i.test(u)) out.add(u);
      };
      document.querySelectorAll('img').forEach((img) => {
        if (img.naturalWidth >= 400 && img.naturalHeight >= 400) {
          push(img.currentSrc || img.src);
        }
      });
      // 背景图
      document.querySelectorAll('*').forEach((el) => {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\("?(https?:[^")]+)/);
        if (m) push(m[1]);
      });
      return [...out].slice(0, 30);
    },
  });
  return result || [];
}

/** 截图（可见区域），返回 dataURL */
async function captureVisible(tabId) {
  return await chrome.tabs.captureVisibleTab(null, { format: 'png' });
}

const FULL_MAX_SHOTS = 24; // 最多滚 24 屏，防止超长瀑布流把内存吃光
const FULL_MAX_H = 16000; // 画布上限（CSS px），再高就截断并明确告知
const FULL_MAX_PIXELS = 40e6; // 画布像素上限：Chrome 单画布约 2.68 亿，留足余量给 2x 屏
const FULL_MAX_BYTES = 22 * 1024 * 1024; // PNG 超出就改 JPEG，别撞服务端 50MB 请求体上限

/**
 * 整页截图：逐屏滚动 → captureVisibleTab → 在 Service Worker 里用 OffscreenCanvas 拼起来。
 * 为什么不用 chrome.debugger 的 captureBeyondViewport：那会弹出「正在调试此浏览器」黄条，
 * 对只想存一张长图的用户太打扰；代价是固定定位的导航条会在每屏重复出现。
 */
async function captureFullPage(tabId) {
  const [{ result: m }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollH: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      viewH: window.innerHeight,
      viewW: document.documentElement.clientWidth,
      y: window.scrollY,
      dpr: window.devicePixelRatio || 1,
    }),
  });
  const viewH = Math.max(200, Math.floor(m.viewH));
  const viewW = Math.max(200, Math.floor(m.viewW));
  const srcDpr = m.dpr || 1;
  const pageH = Math.min(m.scrollH, FULL_MAX_H);

  // 输出倍率：不超过 2x，且保证画布像素数在安全范围内（超长页面自动降采样而不是直接失败）
  let scale = Math.min(2, srcDpr);
  scale = Math.min(scale, Math.sqrt(FULL_MAX_PIXELS / (viewW * pageH)));
  scale = Math.max(0.35, scale);

  // smooth scroll 会让 scrollTo 变成动画，260ms 后可能还在路上，拼出来就会错位
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => {
        const s = document.createElement('style');
        s.id = '__gem_fullshot';
        s.textContent = 'html{scroll-behavior:auto!important}';
        document.documentElement.appendChild(s);
      },
    })
    .catch(() => {});

  const shots = [];
  let y = 0;
  try {
    while (y < pageH && shots.length < FULL_MAX_SHOTS) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (top) => window.scrollTo({ top, behavior: 'instant' }),
        args: [y],
      });
      const realY = await waitScroll(tabId, y);
      // 已经到底或被夹住（滚动不动）：再截就是同一屏，直接收工
      if (shots.length && Math.abs(realY - shots[shots.length - 1].y) <= 1) break;
      await sleep(160); // 给懒加载图片与重绘留一点时间
      shots.push({ y: realY, dataUrl: await chrome.tabs.captureVisibleTab(null, { format: 'png' }) });
      y = realY + viewH;
    }
  } finally {
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: (top) => {
          document.getElementById('__gem_fullshot')?.remove();
          window.scrollTo({ top, behavior: 'instant' });
        },
        args: [m.y],
      })
      .catch(() => {});
  }
  if (!shots.length) throw new Error('没有截到内容（页面可能禁止脚本注入）');

  const last = shots[shots.length - 1];
  const totalH = Math.min(m.scrollH, last.y + viewH);
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(viewW * scale)),
    Math.max(1, Math.round(totalH * scale))
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const s of shots) {
    const blob = await (await fetch(s.dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    // 截图是 srcDpr 倍物理像素，换算回 CSS px 再乘输出倍率，保证长图不被压扁
    const h = Math.min((bmp.height / srcDpr) * scale, canvas.height - s.y * scale);
    if (h > 0) ctx.drawImage(bmp, 0, s.y * scale, canvas.width, h);
    bmp.close();
  }
  let out = await canvas.convertToBlob({ type: 'image/png' });
  let mime = 'image/png';
  if (out.size > FULL_MAX_BYTES) {
    // 照片型长页 PNG 动辄几十 MB，会被本地服务的 50MB 请求体上限挡掉；转 JPEG 换成功
    out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    mime = 'image/jpeg';
  }
  return {
    dataUrl: await blobToDataUrl(out, mime),
    // 最后一屏没盖到页面底部 → 确实截断了（而不是「刚好截到」也报截断）
    truncated: m.scrollH > pageH || last.y + viewH < m.scrollH - 2,
  };
}

/** 等滚动真正到位：返回页面当前 scrollY；最多等 900ms，超时就按当前值继续 */
async function waitScroll(tabId, target) {
  let realY = target;
  for (let i = 0; i < 18; i++) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Math.round(window.scrollY),
    });
    realY = Number(result) || 0;
    if (Math.abs(realY - target) <= 1) return realY;
    await sleep(50);
  }
  return realY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function blobToDataUrl(blob, mime = 'image/png') {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000; // 分块扔给 fromCharCode，避免超长参数列表栈溢出
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,` + btoa(bin);
}

async function send(payload) {
  try {
    const j = await postIngest(payload);
    const fails = Array.isArray(j.results) ? j.results.filter((r) => !r.ok) : [];
    if (!fails.length) notify(`已入库 ${j.saved || 0} 张（共 ${j.total || 0}）`);
    else if (!j.saved) notify(`没有入库：${describeFailure(fails[0])}`);
    else notify(`已入库 ${j.saved} 张；${fails.length} 张失败：${describeFailure(fails[0])}`);
  } catch (err) {
    notify('采集中转失败：' + (err?.message || err));
  }
}

function notify(text) {
  const message = String(text).slice(0, 120);
  try {
    chrome.notifications.create(
      { type: 'basic', iconUrl: chrome.runtime.getURL('icon48.png'), title: '图库采集助手', message },
      () => {
        // 图标/权限缺失时退回内置 1x1 图标，至少把结果说出来
        if (chrome.runtime.lastError) {
          chrome.notifications.create({ type: 'basic', iconUrl: ICON_FALLBACK, title: '图库采集助手', message }, () => {
            void chrome.runtime.lastError;
          });
        }
      }
    );
  } catch {
    /* 通知不可用时静默，不影响采集结果 */
  }
}

// 供 popup 调用
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'batch') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const urls = await collectImages(tab.id);
        const j = await postIngest({
          urls,
          pageUrl: tab.url,
          keyword: msg.keyword || tab.title || '',
          tags: msg.tags || '',
        });
        sendResponse({ ok: true, saved: j.saved || 0, total: j.total || 0 });
      } else if (msg?.type === 'shot') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const dataUrl = await captureVisible(tab.id);
        const j = await postIngest({
          dataUrls: [dataUrl],
          pageUrl: tab.url,
          keyword: msg.keyword || tab.title || '',
          tags: msg.tags || '',
        });
        sendResponse({ ok: true, saved: j.saved || 0, total: j.total || 0 });
      } else if (msg?.type === 'drag') {
        // 页面上的拖拽投放点（content.js）：本地文件 / canvas 已是 data URL，
        // 网络图片先在浏览器里取字节（带 Cookie），取不到再让服务端带 Referer 下
        const pre = await prefetchUrls(
          Array.isArray(msg.urls) ? msg.urls.slice(0, 30) : [],
          Array.isArray(msg.dataUrls) ? msg.dataUrls.slice(0, 10) : []
        );
        const j = await postIngest({
          urls: pre.urls,
          dataUrls: pre.dataUrls,
          pageUrl: msg.pageUrl || '',
          keyword: msg.keyword || '拖拽采集',
          tags: '',
          // 用户自己挑的图不该被采集器的质量门槛（30KB / 800px）拦下来
          skipQuality: true,
        });
        // results 要带回去：前端才能显示「格式不支持（avif）」这类具体原因
        sendResponse({ ok: true, saved: j.saved || 0, total: j.total || 0, results: j.results || [] });
      } else if (msg?.type === 'fullshot') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const shot = await captureFullPage(tab.id);
        const j = await postIngest({
          dataUrls: [shot.dataUrl],
          pageUrl: tab.url,
          keyword: msg.keyword || tab.title || '',
          tags: msg.tags ? `${msg.tags},整页截图` : '整页截图',
        });
        sendResponse({
          ok: true,
          saved: j.saved || 0,
          total: j.total || 0,
          truncated: shot.truncated,
        });
      } else {
        sendResponse({ ok: false, error: '未知操作' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // 异步响应
});
