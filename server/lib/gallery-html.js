/**
 * HTML 网页画廊的纯渲染层：只吃普通对象，不碰 DB / sharp / 文件系统。
 * 拆出来是为了能单测（import 本文件不会初始化数据库）。
 */

export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/** 导出文件名：去掉 Windows 非法字符与结尾的点，空标题有兜底 */
export function safeFileName(name, fallback = '图库画廊') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60);
  return cleaned || fallback;
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 给 items 生成完整 html */
export function renderGalleryHtml(items, opts = {}) {
  const title = String(opts.title || '').trim() || '图库画廊';
  const columns = Math.min(8, Math.max(2, Math.round(Number(opts.columns) || 4)));
  const theme = ['light', 'dark', 'auto'].includes(opts.theme) ? opts.theme : 'auto';
  const count = items.length;
  const now = formatDate(new Date().toISOString());

  const cards = items
    .map((it) => {
      const tags = Array.isArray(it.tags) ? it.tags : [];
      const search = [it.title, ...tags].join(' ').toLowerCase();
      const src = it.src || it.thumb || '';
      const dims = it.width && it.height ? `${it.width}×${it.height}` : '';
      const meta = [dims, it.sizeBytes ? formatSize(it.sizeBytes) : '', it.createdAt ? formatDate(it.createdAt) : '']
        .filter(Boolean)
        .join(' · ');
      const link = it.sourceUrl
        ? `<a class="src" href="${escapeHtml(it.sourceUrl)}" target="_blank" rel="noreferrer noopener">来源</a>`
        : '';
      return `      <figure class="card" data-search="${escapeHtml(search)}" data-full="${escapeHtml(src)}" data-title="${escapeHtml(it.title || '未命名')}">
        <div class="shot">${
          src
            ? `<img src="${src}" alt="${escapeHtml(it.title || '')}" loading="lazy" decoding="async">`
            : '<span class="noimg">无预览</span>'
        }</div>
        <figcaption>
          <b>${escapeHtml(it.title || '未命名')}</b>
          ${
            tags.length
              ? `<span class="tags">${tags.map((t) => `<i>${escapeHtml(t)}</i>`).join('')}</span>`
              : ''
          }
          <span class="meta">${escapeHtml(meta)}${link}</span>
        </figcaption>
      </figure>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="图库 TuKu">
<title>${escapeHtml(title)}</title>
<style>
  :root{
    color-scheme: light dark;
    --bg:#f6f7f9; --fg:#1b1d22; --muted:#6b7280; --card:#ffffff; --line:#e5e7eb;
    --accent:#ff4d8d; --shadow:0 2px 10px rgba(16,24,40,.07);
  }
  html[data-theme="dark"]{
    --bg:#14161a; --fg:#e8eaee; --muted:#9aa3af; --card:#1c2026; --line:#2a2f37;
    --shadow:0 2px 14px rgba(0,0,0,.42);
  }
  @media (prefers-color-scheme: dark){
    html[data-theme="auto"]{
      --bg:#14161a; --fg:#e8eaee; --muted:#9aa3af; --card:#1c2026; --line:#2a2f37;
      --shadow:0 2px 14px rgba(0,0,0,.42);
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;z-index:10;backdrop-filter:blur(10px);
    background:color-mix(in srgb, var(--bg) 82%, transparent);border-bottom:1px solid var(--line)}
  .head{max-width:1600px;margin:0 auto;padding:16px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  h1{margin:0;font-size:19px;letter-spacing:.2px}
  .sub{color:var(--muted);font-size:12px}
  .spacer{flex:1}
  input[type=search]{width:min(280px,42vw);padding:8px 12px;border-radius:9px;
    border:1px solid var(--line);background:var(--card);color:var(--fg);outline:none}
  input[type=search]:focus{border-color:var(--accent)}
  main{max-width:1600px;margin:0 auto;padding:22px}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(${columns},minmax(0,1fr))}
  @media (max-width:1200px){.grid{grid-template-columns:repeat(min(${columns},3),minmax(0,1fr))}}
  @media (max-width:820px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:520px){.grid{grid-template-columns:1fr}}
  .card{margin:0;background:var(--card);border:1px solid var(--line);border-radius:14px;
    overflow:hidden;box-shadow:var(--shadow);transition:transform .16s ease, box-shadow .16s ease}
  .card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(16,24,40,.14)}
  .card.hide{display:none}
  .shot{aspect-ratio:4/3;background:linear-gradient(135deg,#eceff3,#f7f8fa);display:flex;align-items:center;justify-content:center;cursor:zoom-in}
  html[data-theme="dark"] .shot{background:linear-gradient(135deg,#20242a,#191d22)}
  .shot img{width:100%;height:100%;object-fit:cover;display:block}
  .noimg{color:var(--muted);font-size:12px}
  figcaption{padding:10px 12px 12px;display:flex;flex-direction:column;gap:5px}
  figcaption b{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tags{display:flex;gap:5px;flex-wrap:wrap}
  .tags i{font-style:normal;font-size:11px;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);
    border-radius:999px;padding:1px 7px}
  .meta{font-size:11.5px;color:var(--muted);display:flex;gap:8px;align-items:center}
  .src{color:var(--muted);text-decoration:none;border-bottom:1px dashed var(--line)}
  .empty{padding:80px 20px;text-align:center;color:var(--muted)}
  #lb{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;
    background:rgba(8,10,14,.9);padding:32px}
  #lb.on{display:flex}
  #lb img{max-width:100%;max-height:calc(100vh - 96px);object-fit:contain;border-radius:8px}
  #lb .cap{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:#c9ced6;font-size:13px}
  #lb button{position:absolute;top:16px;right:20px;background:none;border:0;color:#fff;font-size:28px;cursor:pointer;line-height:1}
  footer{max-width:1600px;margin:0 auto;padding:8px 22px 40px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<header>
  <div class="head">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="sub">${count} 张 · 导出于 ${now} · 图库 TuKu</div>
    </div>
    <div class="spacer"></div>
    <input id="q" type="search" placeholder="搜索标题或标签…" aria-label="搜索">
  </div>
</header>
<main>
${count ? `<div class="grid" id="grid">\n${cards}\n</div>` : '<div class="empty">这个范围里还没有素材</div>'}
</main>
<footer>单文件离线画廊：图片已内嵌，不依赖原图或客户端。</footer>
<div id="lb"><button type="button" aria-label="关闭">×</button><img alt=""><div class="cap"></div></div>
<script>
(function(){
  var q = document.getElementById('q');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  if (q) q.addEventListener('input', function(){
    var kw = q.value.trim().toLowerCase();
    cards.forEach(function(c){
      c.classList.toggle('hide', !!kw && c.dataset.search.indexOf(kw) < 0);
    });
  });
  var lb = document.getElementById('lb');
  var lbImg = lb.querySelector('img');
  var cap = lb.querySelector('.cap');
  cards.forEach(function(c){
    c.querySelector('.shot').addEventListener('click', function(){
      if (!c.dataset.full) return;
      lbImg.src = c.dataset.full;
      cap.textContent = c.dataset.title;
      lb.classList.add('on');
    });
  });
  lb.addEventListener('click', function(){ lb.classList.remove('on'); lbImg.src = ''; });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') lb.click(); });
})();
</script>
</body>
</html>`;
}
