/* global FileReader */
/**
 * 拖拽采集（与 Eagle 浏览器插件一致的使用方式）
 *
 * 页面上开始拖任何图片 / 文件时，屏幕正中浮出圆形投放点（Eagle 的取法）；把图松手丢上去即可入库。
 * 支持这些来源（很多站点只给其中一两种，少支持一种就等于「拖了没反应」）：
 *   1. 网页里的 <img> —— http(s)、blob:、data: 都认；取不到字节时按当前像素重编码
 *   2. <canvas> 渲染出来的图（AI 出图站常用，图片根本不在 DOM 里）
 *   3. 带 background-image 的元素（图片在 CSS 里）
 *   4. 拖拽数据里的 text/uri-list / text/html / DownloadURL
 *   5. 从资源管理器拖进来的本地文件（Files，只收图片）
 * 失败时把后端返回的原因（格式不支持/分辨率太低/下载失败…）直接显示出来，不吞。
 *
 * 约定：
 * - 只在顶层文档注入，避免每个 iframe 都浮一个球
 * - 页面自己的拖放（上传区、编辑器）一律不拦：只有丢在投放点上才 preventDefault
 * - 样式全部走 element.style（CSSOM），不用 <style>：部分站点 CSP 会拦掉内联样式
 */
(() => {
  if (window.top !== window) return;
  if (window.__gemDragCollector) return;
  window.__gemDragCollector = true;

  const HIDE_AFTER_MS = 8000; // 拖拽中途静止太久就收起，避免球一直挂着
  const MAX_FILES = 8;
  const MAX_FILE_BYTES = 24 * 1024 * 1024; // 单文件上限：base64 后约 +33%，别撞服务端 50MB
  const MAX_TOTAL_BYTES = 36 * 1024 * 1024;

  let host = null;
  let ball = null;
  let tip = null;
  let sub = null;
  let toast = null;
  let busy = false;
  let over = false;
  let hideTimer = 0;
  let toastTimer = 0;
  // 本次拖拽的图片源：<img> / <canvas> / 带背景图的元素（站点常把 img 包在可拖动的 div 里）
  let srcEl = null;
  let lastProbe = 0;

  /** 后端 reason → 人话：没有这一层，界面永远只显示「没有入库」，等于没说 */
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

  /* ------------------------------- 浮层 ------------------------------- */

  function el(tag, style) {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    return node;
  }

  function ensureUI() {
    // 单页应用换路由时可能整块替换 body，旧节点脱落后重建一份
    if (host && !host.isConnected) {
      host = null;
      ball = null;
      tip = null;
      sub = null;
      toast = null;
    }
    if (host) return;

    // 整屏容器：只在拖拽期间出现，平时 display:none，不挡任何点击
    host = el('div', {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      display: 'none',
      font: '13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
    });

    // 半透明遮罩：把注意力收到屏幕正中，松手/取消即整层消失
    host.appendChild(
      el('div', {
        position: 'absolute',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        background: 'rgba(10,10,16,.32)',
        pointerEvents: 'none',
      })
    );

    const center = el('div', {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
    });

    // 正圆投放点：够大、够圆、够显眼；外圈光晕用 box-shadow 展开，不用额外节点
    ball = el('div', {
      position: 'relative',
      width: '196px',
      height: '196px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
      boxSizing: 'border-box',
      borderRadius: '50%',
      background: '#ff4d6d',
      color: '#fff',
      boxShadow: '0 0 0 14px rgba(255,77,109,.18), 0 24px 70px rgba(0,0,0,.5)',
      cursor: 'copy',
      userSelect: 'none',
      pointerEvents: 'auto',
      transition: 'transform .14s ease, background .14s ease, border-color .14s ease, box-shadow .14s ease',
      transform: 'scale(1)',
      border: '3px dashed rgba(255,255,255,.55)',
    });
    ball.setAttribute('role', 'button');
    ball.setAttribute('title', '把图片或文件拖到这里，松手存入图库');

    const icon = el('img', { width: '56px', height: '56px', borderRadius: '14px', pointerEvents: 'none' });
    icon.alt = '';
    try {
      icon.src = chrome.runtime.getURL('icon48.png');
    } catch {
      /* 扩展上下文失效时图标加载失败，不影响文字提示 */
    }
    ball.appendChild(icon);

    tip = el('span', {
      pointerEvents: 'none',
      fontSize: '15px',
      fontWeight: '600',
      whiteSpace: 'nowrap',
      textShadow: '0 1px 2px rgba(0,0,0,.25)',
    });
    tip.textContent = '松手存入图库';
    ball.appendChild(tip);

    sub = el('span', {
      pointerEvents: 'none',
      fontSize: '12px',
      opacity: '.85',
      lineHeight: '1.4',
      textAlign: 'center',
      padding: '0 20px',
      boxSizing: 'border-box',
    });
    sub.textContent = '网页图片 / 本地文件';
    ball.appendChild(sub);

    center.appendChild(ball);
    host.appendChild(center);

    // 提示条单独定位、单独显示：投放点在入库结束后要收起，提示还得留几秒
    toast = el('div', {
      position: 'fixed',
      left: '50%',
      bottom: '56px',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      maxWidth: '360px',
      padding: '10px 16px',
      borderRadius: '12px',
      background: 'rgba(20,20,26,.94)',
      color: '#fff',
      font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.35)',
      display: 'none',
      pointerEvents: 'none',
    });

    const root = document.body || document.documentElement;
    root.appendChild(host);
    root.appendChild(toast);
    bindDropTarget();
  }

  function paint() {
    if (!ball) return;
    ball.style.transform = over ? 'scale(1.06)' : 'scale(1)';
    ball.style.background = busy ? 'rgba(118,118,132,.96)' : over ? '#ff2e55' : '#ff4d6d';
    ball.style.cursor = busy ? 'progress' : 'copy';
    ball.style.borderColor = over ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.55)';
    ball.style.borderStyle = over ? 'solid' : 'dashed';
    ball.style.boxShadow = over
      ? '0 0 0 20px rgba(255,255,255,.18), 0 28px 80px rgba(0,0,0,.55)'
      : '0 0 0 14px rgba(255,77,109,.18), 0 24px 70px rgba(0,0,0,.5)';
    tip.textContent = busy ? '入库中…' : over ? '松手即可入库' : '松手存入图库';
    if (sub) sub.textContent = busy ? '正在写入图库…' : over ? '松开鼠标完成采集' : '网页图片 / 本地文件';
  }

  function show(hint) {
    ensureUI();
    host.style.display = 'block';
    if (hint) tip.textContent = hint;
    paint();
    clearTimeout(hideTimer);
    // 拖拽中静止（没 drop 也没 dragend）时自动收起，别留个球挡页面
    hideTimer = window.setTimeout(hide, HIDE_AFTER_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    over = false;
    if (busy) return; // 落库请求还在路上，别把进度提示收掉
    if (host) host.style.display = 'none';
  }

  function say(text, ms = 2600) {
    ensureUI();
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.style.display = 'none';
    }, ms);
    // 提示条自己会消失；球立即收掉（busy 时 hide 内部会跳过）
    hide();
  }

  /* --------------------------- 拖拽数据识别 --------------------------- */

  function typesOf(dt) {
    try {
      return Array.from(dt?.types || []);
    } catch {
      return [];
    }
  }

  /** 可能是图片的拖拽：文件、图片链接、或页面内图片本体 */
  function looksLikeImageDrag(dt) {
    const types = typesOf(dt);
    if (types.includes('Files')) return true;
    if (types.includes('text/uri-list') || types.includes('text/html')) return true;
    // text/plain 可能是任意文字：只有落点确实在图片上时才认
    return types.includes('text/plain') && !!srcEl;
  }

  /**
   * 从落点找出「这张图是什么元素」。三层兜底：
   * 自己就是 img/canvas → 往上找最近的 img/canvas → 往下看一眼（div 包 img 的拖动柄）
   * 最后才看 CSS 背景图。站点结构千奇百怪，只认 e.target 是 img 会漏掉一大半。
   */
  function pickSource(node) {
    let elNode = node;
    while (elNode && elNode.nodeType !== 1) elNode = elNode.parentElement;
    if (!elNode || elNode === host || (host && host.contains(elNode))) return null;
    if (elNode.tagName === 'IMG' || elNode.tagName === 'CANVAS') return elNode;
    const up = elNode.closest?.('img,canvas');
    if (up) return up;
    const down = elNode.querySelector?.('img,canvas');
    if (down) return down;
    // 背景图：只看自己 + 三层祖先，别把整条 DOM 链的 style 都算一遍（dragover 很频繁）
    let cur = elNode;
    for (let i = 0; i < 3 && cur && cur.nodeType === 1; i++) {
      const bg = getComputedStyle(cur).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url(')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /** 抓 background-image 里的地址（可能有多层） */
  function bgUrlsOf(elNode) {
    const out = [];
    let cur = elNode;
    for (let i = 0; i < 3 && cur && cur.nodeType === 1; i++) {
      const bg = getComputedStyle(cur).backgroundImage;
      if (bg && bg !== 'none') {
        for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) out.push(m[1]);
        if (out.length) break;
      }
      cur = cur.parentElement;
    }
    return out;
  }

  function isImageUrl(u) {
    if (/^data:image\//i.test(u)) return true;
    if (!/^https?:\/\//i.test(u)) return false;
    // 没有扩展名（CDN 动态地址）也放行：服务端会按内容判断，不是图就跳过
    return /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?|svg)(\?|#|$)/i.test(u) || !/\.\w{1,5}(\?|#|$)/.test(u);
  }

  function collectFromDataTransfer(dt) {
    const urls = new Set();
    const dataUrls = new Set();
    const blobUrls = new Set();
    const push = (raw) => {
      const u = String(raw || '').trim();
      if (!u || u.startsWith('#')) return;
      if (/^data:image\//i.test(u)) {
        dataUrls.add(u);
        return;
      }
      // blob:/filesystem: 只有页面自己读得到，交给 fetchAsDataUrl 转字节
      if (/^(blob|filesystem):/i.test(u)) {
        blobUrls.add(u);
        return;
      }
      if (isImageUrl(u)) urls.add(u);
    };

    try {
      for (const line of String(dt.getData('text/uri-list') || '').split(/\r?\n/)) push(line);
    } catch {
      /* 某些站点禁止读取，忽略 */
    }
    try {
      const plain = String(dt.getData('text/plain') || '').trim();
      if (plain && !plain.includes('\n')) push(plain);
    } catch {
      /* 同上 */
    }
    // text/html 里可能带 <img src> / srcset / 背景图：直接从图片上拖时通常就是这一路最准
    try {
      const html = String(dt.getData('text/html') || '');
      for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) push(m[1]);
      for (const m of html.matchAll(/srcset=["']([^"',]+)/gi)) push(m[1]);
      for (const m of html.matchAll(/background-image\s*:\s*url\(["']?([^"')]+)/gi)) push(m[1]);
    } catch {
      /* 同上 */
    }
    // Chrome 拖「带 download 的链接 / 图片」时会额外塞 DownloadURL：mime:文件名:网址
    try {
      for (const line of String(dt.getData('DownloadURL') || '').split(/\r?\n/)) {
        const parts = line.split(':');
        if (parts.length >= 3) push(parts.slice(2).join(':'));
      }
    } catch {
      /* 同上 */
    }
    return { urls, dataUrls, blobUrls };
  }

  /** 页面内图片按当前像素重编码：跨域被污染时 canvas 会抛 SecurityError，换成能看懂的话 */
  function imgToDataUrl(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('图片还没加载完');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvasToDataUrl(canvas);
  }

  const MAX_ENCODE_PX = 60e6; // 画布重编码上限：再大既慢又容易把消息撑爆

  function canvasToDataUrl(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) throw new Error('画布是空的，取不到图');
    if (w * h > MAX_ENCODE_PX) throw new Error(`画布太大（${w}×${h}），取不到图`);
    try {
      const png = canvas.toDataURL('image/png');
      if (png.length <= MAX_FILE_BYTES * 1.4) return png;
      // 照片型 PNG 会很大，转 JPEG 换成功（只有超过上限才用）
      return canvas.toDataURL('image/jpeg', 0.92);
    } catch {
      throw new Error('这张图受站点跨域保护，取不到像素，请改用右键采集');
    }
  }

  /** 在页面上下文按字节取图：blob:、同源图片、允许跨域的 CDN 都走这里（带 Cookie） */
  async function fetchAsDataUrl(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (blob.type && !/^image\//i.test(blob.type)) throw new Error(`不是图片（${blob.type}）`);
    if (!blob.size) throw new Error('空响应');
    if (blob.size > MAX_FILE_BYTES) throw new Error('图片超过大小上限');
    return await fileToDataUrl(blob);
  }

  /** 拖拽数据里没有可用地址时，直接从元素本身取图 */
  async function collectFromElement(node) {
    const out = { urls: [], dataUrls: [] };
    if (node.tagName === 'CANVAS') {
      out.dataUrls.push(canvasToDataUrl(node));
      return out;
    }
    if (node.tagName === 'IMG') {
      const src = node.currentSrc || node.src || '';
      if (/^data:image\//i.test(src)) out.dataUrls.push(src);
      else if (/^(blob|filesystem):/i.test(src)) out.dataUrls.push(await fetchAsDataUrl(src));
      else if (/^https?:/i.test(src)) {
        // 页面里能取到字节就先取（带 Cookie，登录态站点只有这条路通），
        // 取不到再交给后台/服务端下载
        try {
          out.dataUrls.push(await fetchAsDataUrl(src));
        } catch {
          out.urls.push(src);
        }
      } else {
        out.dataUrls.push(imgToDataUrl(node));
      }
      return out;
    }
    for (const u of bgUrlsOf(node)) {
      if (/^data:image\//i.test(u)) out.dataUrls.push(u);
      else if (/^(blob|filesystem):/i.test(u)) {
        try {
          out.dataUrls.push(await fetchAsDataUrl(u));
        } catch {
          /* 背景图取不到就放弃这一条 */
        }
      } else if (/^https?:/i.test(u)) out.urls.push(u);
    }
    return out;
  }

  /** 后端 reason → 「格式不支持（avif）」这种能直接读的话 */
  function describeFailure(r) {
    const why = REASON_TEXT[r?.reason] || '未知原因';
    const fmt = r?.format ? `（${r.format}）` : '';
    const err = r?.error ? `：${String(r.error).slice(0, 50)}` : '';
    return why + fmt + err;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  /* ------------------------------ 事件 ------------------------------ */

  function arm(dt) {
    if (busy || !looksLikeImageDrag(dt)) return;
    show();
  }

  document.addEventListener(
    'dragstart',
    (e) => {
      // 站点常把 img 包在 draggable 的 div 里，e.target 根本不是 img：上下都要找一层
      srcEl = pickSource(e.target);
      // 页面内拖动选中文字也会带 text/html，别为这种拖拽弹球挡视线；
      // 拖的是图片或本地文件才点亮（跨标签/跨进程的图片靠下面的 dragenter 兜）
      const types = typesOf(e.dataTransfer);
      if (srcEl || types.includes('Files')) show();
    },
    true
  );

  document.addEventListener(
    'dragenter',
    (e) => {
      // 从资源管理器 / 别的标签页拖进来时页面内没有 dragstart，只能靠这里点亮
      if (typesOf(e.dataTransfer).length) arm(e.dataTransfer);
    },
    true
  );

  document.addEventListener(
    'dragover',
    (e) => {
      if (!host || host.style.display !== 'block') return;
      // 一边拖一边记下光标下的图片元素：有些站点 dragstart 的 target 只是空白容器，
      // 靠这里的落点才能把图认出来（节流，dragover 触发得非常频繁）
      const now = Date.now();
      if (!over && now - lastProbe > 120) {
        lastProbe = now;
        const found = pickSource(document.elementFromPoint(e.clientX, e.clientY));
        if (found) srcEl = found;
      }
      // 拖拽仍在继续：把自动收起的时间往后推（不 preventDefault，页面自己的拖放不受影响）
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, HIDE_AFTER_MS);
    },
    true
  );

  document.addEventListener(
    'dragend',
    () => {
      srcEl = null;
      hide();
    },
    true
  );
  window.addEventListener('blur', hide);
  // 拖出浏览器窗口：relatedTarget 为 null 时是「离开文档」，收起
  document.addEventListener(
    'dragleave',
    (e) => {
      if (!e.relatedTarget) hide();
    },
    true
  );

  function bindDropTarget() {
    ball.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      over = true;
      paint();
    });
    ball.addEventListener(
      'dragover',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        over = true;
        paint();
      }
    );
    ball.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      over = false;
      paint();
    });
    ball.addEventListener('drop', onDrop);
  }

  async function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    over = false;
    if (busy) return;
    const dt = e.dataTransfer;
    const collected = dt
      ? collectFromDataTransfer(dt)
      : { urls: new Set(), dataUrls: new Set(), blobUrls: new Set() };
    const urls = collected.urls;
    const dataUrls = collected.dataUrls;
    const sourceEl = srcEl;
    srcEl = null;

    // 本地文件
    const files = Array.from(dt?.files || []).filter((f) => /^image\//i.test(f.type));
    let total = 0;
    for (const file of files.slice(0, MAX_FILES)) {
      if (file.size > MAX_FILE_BYTES) {
        say(`「${file.name}」超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB，已跳过`);
        continue;
      }
      total += file.size;
      if (total > MAX_TOTAL_BYTES) {
        say('文件总量过大，后面的已跳过');
        break;
      }
      try {
        dataUrls.add(await fileToDataUrl(file));
      } catch (err) {
        say(String(err?.message || err), 3200);
      }
    }

    // blob:/filesystem: 地址只有页面自己读得到（AI 出图、canvas 预览常见），先在页面里转成字节
    for (const bu of [...collected.blobUrls].slice(0, 6)) {
      try {
        dataUrls.add(await fetchAsDataUrl(bu));
      } catch {
        /* 读不出来就交给下面的元素兜底（画到 canvas 上重编码） */
      }
    }

    // 兜底：拖拽数据里没有可用地址时，从图片元素本身取（img / canvas / 背景图）
    if (!urls.size && !dataUrls.size && sourceEl) {
      try {
        const fromEl = await collectFromElement(sourceEl);
        for (const u of fromEl.urls) urls.add(u);
        for (const d of fromEl.dataUrls) dataUrls.add(d);
      } catch (err) {
        say(String(err?.message || err), 3600);
        hide();
        return;
      }
    }

    const urlList = [...urls].slice(0, 30);
    const dataList = [...dataUrls].slice(0, 10);
    if (!urlList.length && !dataList.length) {
      // 把「拖拽里到底带了什么类型」也说出来：站点没给图时一眼能看出来，
      // 否则用户只能看到一个没有信息的「没有入库」
      const kinds = (dt ? typesOf(dt).join('/') : '') || '空';
      say(`没识别到图片（拖拽数据：${kinds}）；可改用右键「采集这张图片到图库」`, 4200);
      return;
    }

    busy = true;
    paint();
    show('入库中…');
    try {
      const res = await sendToBackground({
        type: 'drag',
        urls: urlList,
        dataUrls: dataList,
        pageUrl: location.href,
        keyword: (document.title || '').slice(0, 80),
      });
      if (res && res.ok) {
        const saved = Number(res.saved) || 0;
        const fails = Array.isArray(res.results) ? res.results.filter((r) => !r.ok) : [];
        // 失败也要说清楚为什么：格式不支持（avif）/ 下载失败（HTTP 403）比「没有入库」有用得多
        if (!fails.length) say(`已入库 ${saved} 张`, 2800);
        else if (!saved) say(`没有入库：${describeFailure(fails[0])}`, 4600);
        else say(`已入库 ${saved} 张；${fails.length} 张失败：${describeFailure(fails[0])}`, 4600);
      } else {
        say('采集失败：' + String(res?.error || '未知错误'), 3600);
      }
    } catch (err) {
      say('采集失败：' + String(err?.message || err), 3600);
    } finally {
      busy = false;
      paint();
      hide();
    }
  }

  function sendToBackground(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(res);
        });
      } catch (err) {
        // 扩展被更新/重载后旧内容脚本的上下文会失效，只能提示用户刷新页面
        reject(new Error('扩展已更新，请刷新页面后重试'));
      }
    });
  }

  ensureUI();
})();
