// @ts-check
/**
 * 局域网 / 手机扫码投送。
 *
 * 安全设计（对应遗留总表 T-25 的验收）：
 * - 主服务永远只绑 127.0.0.1，普通接口、设置、凭据一个都不暴露给局域网；
 * - 开启时另起一个独立 Express 实例绑 0.0.0.0 的独立端口（优先固定），这个实例只注册
 *   「投送页 / 上传 / info」三个路径，其余一律 404，不共享主 app 的路由与中间件；
 * - 独立投送令牌（data/.lan-token），只能访问上面那三个路径，拿不到完整 API_TOKEN；
 * - 默认关闭。关闭时外部设备扫不到任何端口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
import { DATA_DIR } from '../config.js';
import { db, getSettings } from '../db.js';
import * as lib from '../library.js';
import { ingestMedia, isMediaPath } from './media.js';
import { qrSvg } from './qr.js';
import { lanIconPng } from './lan-icon.js';
import { existingPreviewPath, existingThumbPath, ensurePreview, mtimeOf } from '../thumbs.js';
import { hiddenImagesClause } from './privacy.js';
import { ensureFolderByRelDir, linkImageToFolder } from '../folders.js';
import * as nd from './nondestructive.js';

const TOKEN_FILE = path.join(DATA_DIR, '.lan-token');
const MAX_UPLOAD = 60 * 1024 * 1024;
/**
 * PWA 外壳资源必须免投送令牌：浏览器请求 manifest / service worker / 图标时
 * 无法带自定义头，也拿不到查询令牌。这几个资源里只有静态字节，没有任何库数据或令牌，
 * 放行不等于放开接口——下面所有 /api/** 仍要过鉴权。
 */
const PWA_PUBLIC_PATHS = new Set([
  '/manifest.webmanifest',
  '/sw.js',
  '/offline.html',
  '/icon-192.png',
  '/icon-512.png',
]);
/**
 * 固定优先端口。以前每次 listen(0) 都由系统随机分配，应用重启 / 关开一次投送
 * 端口就变，已经扫过或收藏的二维码全部失效（手机表现为「网站暂时无法打开」）。
 * 被别的程序占用时才退回随机端口；无论哪种情况都以 status.port / qrText 为准。
 */
const PREFERRED_LAN_PORT = 53317;

let lanServer = null;
let lanPort = 0;
let memoryToken = '';

function isPrivate(host) {
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/** 本机可用于投送的 IPv4（私有地址优先，回环排除） */
export function lanIpv4List() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const it of list || []) {
      if (!it || it.family !== 'IPv4' || it.internal) continue;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(it.address)) continue;
      if (!out.includes(it.address)) out.push(it.address);
    }
  }
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)) || a.localeCompare(b));
}

/** 读取（没有就创建）独立投送令牌；落盘失败时退回本次运行的内存令牌 */
export function readOrCreateLanToken() {
  if (memoryToken) return memoryToken;
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing.length >= 20) {
      memoryToken = existing;
      return existing;
    }
  } catch {
    /* 不存在，下面创建 */
  }
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    fs.writeFileSync(TOKEN_FILE, token, { flag: 'wx', mode: 0o600 });
  } catch {
    console.warn('[lan] 无法写入 .lan-token，本次运行使用内存令牌');
  }
  memoryToken = token;
  return token;
}

export function rotateLanToken() {
  memoryToken = '';
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  memoryToken = token;
  return token;
}

/** 手机扫码打开的地址（带投送令牌，页面脚本用它发 x-lan-token 头） */
export function lanUrls(port, token) {
  if (!port) return [];
  const q = encodeURIComponent(token);
  return lanIpv4List().map((ip) => `http://${ip}:${port}/?token=${q}`);
}

/**
 * 手机端页面：浏览 + 投送两个标签。
 * 只读分享链接打开时没有「投送」标签，页面上也不会出现上传入口。
 */
function mobilePage(token, readOnly = false) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'none'; base-uri 'none'"/>
<meta name="theme-color" content="#ff4d8d"/>
<meta name="color-scheme" content="dark"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<meta name="apple-mobile-web-app-title" content="图库"/>
<link rel="manifest" href="/manifest.webmanifest${readOnly ? '?mode=read' : ''}"/>
<link rel="icon" href="/icon-192.png"/>
<link rel="apple-touch-icon" href="/icon-192.png"/>
<title>${readOnly ? '浏览图库' : '投送到图库'}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; background:#11131a; color:#f4f4f8; font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; padding:20px 16px 40px; }
.wrap { max-width:560px; margin:0 auto; }
h1 { font-size:21px; margin:6px 0 4px; }
p { color:#9a9cb0; font-size:13px; margin:0 0 16px; }
.tabs { display:flex; gap:8px; margin:0 0 16px; }
.tab { flex:1; padding:9px; text-align:center; border-radius:10px; background:#1b1e2a; color:#9a9cb0; font-size:14px; border:1px solid #262a3a; }
.tab.on { background:#243052; color:#fff; border-color:#3b5b9c; }
.drop { display:block; border:2px dashed #3a3d52; border-radius:18px; padding:38px 18px; text-align:center; background:#1b1e2a; }
.drop b { display:block; font-size:17px; margin-bottom:6px; }
.drop span { color:#9a9cb0; font-size:12.5px; }
input[type=file] { display:none; }
button.act { width:100%; margin-top:16px; padding:13px; border:0; border-radius:12px; background:#ff4d8d; color:#fff; font-size:15px; font-weight:600; }
#list { margin-top:18px; }
.row { padding:10px 12px; border-radius:10px; background:#1b1e2a; margin-bottom:8px; font-size:13px; display:flex; justify-content:space-between; gap:10px; }
.ok { color:#6ee7a8; } .err { color:#ff849e; }
.grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
.cell { position:relative; aspect-ratio:1; border-radius:8px; overflow:hidden; background:#1b1e2a; }
.cell img { width:100%; height:100%; object-fit:cover; display:block; }
.cell .cap { position:absolute; left:0; right:0; bottom:0; padding:2px 5px; font-size:10.5px; color:#dfe3ee; background:linear-gradient(transparent,rgba(0,0,0,.72)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.more { margin-top:14px; }
[hidden] { display:none !important; }
.pwa { display:flex; gap:8px; align-items:center; margin:0 0 14px; padding:9px 11px; border-radius:10px; background:#1c2540; border:1px solid #2c3a63; font-size:12px; color:#c7d2ef; }
.pwa span { flex:1; line-height:1.5; }
.pwa button { flex:0 0 auto; border:0; border-radius:8px; padding:6px 10px; background:#ff4d8d; color:#fff; font-size:12px; }
.pwa button.ghost { background:#2a3350; color:#c7d2ef; }
.meta { margin:-8px 0 14px; font-size:12px; color:#8b95b2; }
.viewer { position:fixed; inset:0; background:rgba(8,9,13,.96); display:flex; flex-direction:column; z-index:50; }
.viewer[hidden] { display:none !important; }
.viewer .vhead { display:flex; align-items:center; gap:10px; padding:14px 16px; }
.viewer .vtitle { flex:1; min-width:0; font-size:13px; color:#dfe3ee; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.viewer .vclose { flex:none; border:0; border-radius:8px; padding:7px 12px; background:#2a3350; color:#dfe3ee; font-size:13px; }
.viewer .vbody { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; padding:0 10px; }
.viewer .vbody img { max-width:100%; max-height:100%; object-fit:contain; }
.viewer .vfoot { padding:14px 16px calc(18px + env(safe-area-inset-bottom)); display:flex; gap:10px; }
.viewer .vfoot a, .viewer .vfoot span { flex:1; text-align:center; padding:11px; border-radius:10px; background:#1b1e2a; color:#c7d2ef; font-size:13px; text-decoration:none; }
.viewer .vfoot a.dl { background:#ff4d8d; color:#fff; font-weight:600; }
</style></head><body><div class="wrap">
<div class="pwa" id="pwa"><span id="pwa-txt">用浏览器菜单「添加到主屏幕」，下次打开无需再扫码。离线浏览需要 HTTPS 访问。</span><button id="pwa-install" hidden>安装到桌面</button><button class="ghost" id="pwa-close">知道了</button></div>
<h1>${readOnly ? '图库（只读）' : '投送到图库'}</h1>
<p id="sub">${readOnly ? '这是只读分享链接，可以浏览与搜索，不能上传。' : '与电脑连接同一个 Wi-Fi。上传会直接写入电脑上的当前资源库。'}</p>
<div class="meta" id="meta" hidden></div>
<div class="tabs" id="tabs">
  <div class="tab${readOnly ? ' on' : ''}" data-tab="browse">浏览</div>
  <div class="tab${readOnly ? '' : ' on'}" data-tab="upload"${readOnly ? ' hidden' : ''}>投送</div>
</div>
<div id="pane-upload"${readOnly ? ' hidden' : ''}>
  <div style="margin-bottom:10px">
    <div style="font-size:12px;color:#8b95b2;margin-bottom:4px">存到哪个文件夹</div>
    <select id="target" style="width:100%;padding:10px;border-radius:10px;border:1px solid #262a3a;background:#1b1e2a;color:#f4f4f8;font-size:14px">
      <option value="">库根目录（不归类）</option>
    </select>
  </div>
  <label class="drop" for="files"><b>点这里选择文件</b><span>可多选，单文件不超过设置里的大小上限</span></label>
  <input id="files" type="file" multiple accept="image/*,video/*,audio/*,.pdf,.psd,.heic"/>
  <div id="list"></div>
</div>
<div id="pane-browse">
  <div class="field" style="margin-bottom:10px">
    <input id="q" placeholder="搜标题 / 标签" style="width:100%;padding:10px;border-radius:10px;border:1px solid #262a3a;background:#1b1e2a;color:#f4f4f8;font-size:14px"/>
  </div>
  <div class="grid" id="grid"></div>
  <button class="act more" id="more">加载更多</button>
</div>
</div>
<div class="viewer" id="viewer" hidden role="dialog" aria-modal="true">
  <div class="vhead"><div class="vtitle" id="vt"></div><button class="vclose" id="vclose">关闭</button></div>
  <div class="vbody"><img id="vimg" alt=""/></div>
  <div class="vfoot" id="vfoot"></div>
</div>
<script>
(function(){
  // 按模式分别记住令牌：只读链接添加到主屏幕后，不能被上一次的投送令牌顶掉。
  // 只读页面不内联完整投送令牌，token 只能来自分享链接本身。
  var storeKey = ${readOnly ? "'tuku_lan_token_read'" : "'tuku_lan_token_full'"};
  var token = new URLSearchParams(location.search).get('token');
  try {
    if (token) localStorage.setItem(storeKey, token);
    else token = localStorage.getItem(storeKey) || '';
  } catch (e) { token = token || ${JSON.stringify(token)}; }
  token = token || ${JSON.stringify(token)};
  var readOnly = ${readOnly ? 'true' : 'false'};

  var pwa = document.getElementById('pwa');
  try { if (localStorage.getItem('tuku_pwa_hint') === '1') pwa.hidden = true; } catch (e) {}
  document.getElementById('pwa-close').addEventListener('click', function () {
    pwa.hidden = true;
    try { localStorage.setItem('tuku_pwa_hint', '1'); } catch (e) {}
  });
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    document.getElementById('pwa-install').hidden = false;
  });
  document.getElementById('pwa-install').addEventListener('click', function () {
    if (!deferred) return;
    deferred.prompt(); deferred = null;
    document.getElementById('pwa-install').hidden = true;
  });
  // 局域网 http://192.168.x.x 不是安全上下文，SW 不会注册；HTTPS 反代下才启用离线外壳
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  var list = document.getElementById('list');
  var grid = document.getElementById('grid');
  var page = 1, busy = false, ended = false, q = '';

  function add(name, text, good) {
    var row = document.createElement('div'); row.className = 'row';
    var a = document.createElement('span'); a.textContent = name;
    var b = document.createElement('span'); b.className = good ? 'ok' : 'err'; b.textContent = text;
    row.appendChild(a); row.appendChild(b); list.insertBefore(row, list.firstChild);
  }

  // 目标文件夹：后端按 id 挂载（纯虚拟夹没有磁盘路径，按路径挂不进去）
  var target = document.getElementById('target');
  if (target) {
    try {
      var savedFolder = localStorage.getItem('tuku_lan_folder');
      fetch('/api/lan/folders', { headers: { 'x-lan-token': token } })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
        (j.folders || []).forEach(function (f) {
          var o = document.createElement('option');
          o.value = String(f.id); o.textContent = f.label;
          target.appendChild(o);
        });
        if (savedFolder && target.querySelector('option[value="' + savedFolder + '"]')) target.value = savedFolder;
      }).catch(function () {
        var hint = document.createElement('div');
        hint.className = 'row';
        hint.textContent = '文件夹列表读取失败，本次只能传到库根目录';
        target.parentNode.appendChild(hint);
      });
      target.addEventListener('change', function () {
        try { localStorage.setItem('tuku_lan_folder', target.value); } catch (e) {}
      });
    } catch (e) {}
  }

  var files = document.getElementById('files');
  if (files) files.addEventListener('change', async function (e) {
    var picked = Array.from(e.target.files || []).slice(0, 20);
    var folderId = target ? target.value : '';
    for (var i = 0; i < picked.length; i++) {
      var f = picked[i]; add(f.name, '上传中…', true);
      try {
        var r = await fetch('/api/lan/upload?filename=' + encodeURIComponent(f.name) + (folderId ? '&folderId=' + encodeURIComponent(folderId) : ''), {
          method: 'POST', headers: { 'x-lan-token': token, 'Content-Type': 'application/octet-stream' }, body: f
        });
        var j = await r.json();
        add(f.name, r.ok && j.ok ? '已入库' : ('失败：' + (j.error || r.status)), !!(r.ok && j.ok));
      } catch (err) { add(f.name, '网络错误', false); }
    }
    e.target.value = '';
  });

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('on', x === t); });
      document.getElementById('pane-upload').hidden = t.dataset.tab !== 'upload';
      document.getElementById('pane-browse').hidden = t.dataset.tab !== 'browse';
    });
  });
  if (readOnly) {
    document.getElementById('pane-upload').hidden = true;
    document.getElementById('pane-browse').hidden = false;
  }

  // 只读链接的「能不能存原图」由分享者决定；页面据此显示/隐藏保存按钮
  var allowDownload = true;

  function openViewer(item) {
    document.getElementById('vt').textContent = item.title || ('#' + item.id);
    var im = document.getElementById('vimg');
    im.src = '/api/lan/preview/' + item.id + '?token=' + encodeURIComponent(token);
    im.alt = item.title || '';
    var foot = document.getElementById('vfoot');
    foot.innerHTML = '';
    if (allowDownload) {
      var a = document.createElement('a');
      a.className = 'dl';
      a.textContent = '保存原图';
      a.href = '/api/lan/file/' + item.id + '?token=' + encodeURIComponent(token);
      a.setAttribute('download', item.title || ('tuku_' + item.id));
      foot.appendChild(a);
    } else {
      var s = document.createElement('span');
      s.textContent = '此链接不提供原图下载';
      foot.appendChild(s);
    }
    document.getElementById('viewer').hidden = false;
  }

  document.getElementById('vclose').addEventListener('click', function () {
    document.getElementById('viewer').hidden = true;
    document.getElementById('vimg').src = '';
  });

  async function loadInfo() {
    try {
      var r = await fetch('/api/lan/info', { headers: { 'x-lan-token': token } });
      if (!r.ok) return;
      var j = await r.json();
      allowDownload = j.allowDownload !== false;
      var el = document.getElementById('meta');
      var bits = [];
      if (j.expiresAt) {
        var d = new Date(j.expiresAt);
        var hh = ('0' + d.getHours()).slice(-2);
        var mm = ('0' + d.getMinutes()).slice(-2);
        bits.push('有效期至 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + hh + ':' + mm);
      }
      if (j.hasPassword) bits.push('已设访问密码');
      if (!j.allowDownload) bits.push('禁止下载原图');
      if (bits.length) { el.textContent = bits.join(' · '); el.hidden = false; }
    } catch (e) { /* 顶部提示失败不影响浏览 */ }
  }

  function cell(item) {
    var d = document.createElement('div'); d.className = 'cell';
    var img = document.createElement('img');
    img.loading = 'lazy';
    // 缩略图走 query 令牌：img 标签发不了自定义头
    img.src = '/api/lan/thumb/' + item.id + '?token=' + encodeURIComponent(token);
    img.alt = item.title || '';
    var cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = item.title || ('#' + item.id);
    d.appendChild(img); d.appendChild(cap);
    d.onclick = function () { openViewer(item); };
    d.style.cursor = 'zoom-in';
    return d;
  }

  async function load() {
    if (busy || ended) return;
    busy = true;
    try {
      var url = '/api/lan/images?page=' + page + '&pageSize=48' + (q ? '&q=' + encodeURIComponent(q) : '');
      var r = await fetch(url, { headers: { 'x-lan-token': token } });
      var j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      var items = j.items || [];
      items.forEach(function (it) { grid.appendChild(cell(it)); });
      ended = items.length < 48 || page * 48 >= (j.total || 0);
      document.getElementById('more').textContent = ended ? '没有更多了' : '加载更多';
      document.getElementById('more').disabled = ended;
      page += 1;
    } catch (err) {
      document.getElementById('more').textContent = '加载失败，点我重试';
      document.getElementById('more').disabled = false;
    } finally {
      busy = false;
    }
  }

  document.getElementById('more').addEventListener('click', function () {
    if (ended) return;
    load();
  });
  var timer = 0;
  document.getElementById('q').addEventListener('input', function (e) {
    var v = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(function () {
      q = v; page = 1; ended = false; grid.innerHTML = '';
      document.getElementById('more').disabled = false;
      load();
    }, 300);
  });
  load();
  if (readOnly) loadInfo();
})();
</script></body></html>`;
}

/**
 * 只读分享令牌：只活在内存里，重启即失效——不做持久化，避免一条链接永久可访问。
 * 与投送令牌的区别除了「不能上传」，还有可见范围：整库 / 指定素材 / 单个文件夹。
 */
const shareTokens = new Map();
const SHARE_SCOPES = new Set(['library', 'selection', 'folder']);

/**
 * 归一化分享范围；非法参数直接拒绝，绝不能悄悄退化成「整库可见」
 * @param {{scope?:string, ids?:number[], folderId?:number|string, title?:string,
 *          password?:string, allowDownload?:boolean}} [opts]
 */
export function normalizeShareScope({ scope, ids, folderId, title, password, allowDownload } = {}) {
  const kind = SHARE_SCOPES.has(String(scope)) ? String(scope) : 'library';
  const cleanIds = Array.isArray(ids)
    ? [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000)
    : [];
  if (kind === 'selection' && !cleanIds.length) throw new Error('按选区分享需要至少一张素材');
  const fId = Number(folderId);
  if (kind === 'folder' && !(Number.isInteger(fId) && fId > 0)) throw new Error('按文件夹分享需要有效的文件夹 id');
  // 访问密码：4~64 位。短于 4 位等于没设，直接拒绝而不是悄悄忽略（用户以为设了密码最危险）
  const pw = String(password == null ? '' : password);
  if (pw && (pw.length < 4 || pw.length > 64)) throw new Error('访问密码需为 4~64 个字符');
  return {
    scope: kind,
    ids: kind === 'selection' ? cleanIds : [],
    folderId: kind === 'folder' ? fId : 0,
    title: String(title || '').replace(/[<>]/g, '').slice(0, 60),
    password: pw,
    // 默认允许下载（与历史行为一致）；显式传 false 才禁
    allowDownload: allowDownload !== false,
  };
}

/** scrypt 摘要：同一密码 + 同一 salt 结果稳定，用来做常量时间比对 */
function passwordDigest(salt, password) {
  return crypto.scryptSync(String(password), String(salt), 32).toString('hex');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 请求是否已解锁该分享（HttpOnly cookie，或接口调用方可带 x-lan-password 头） */
function shareUnlocked(req, share) {
  if (!share?.passHash) return true;
  const cookie = parseCookies(req.headers.cookie)['tuku_lan_pw'];
  if (cookie && tokenMatches(cookie, share.cookieKey || '')) return true;
  const got = String(req.headers['x-lan-password'] || '');
  return !!got && tokenMatches(passwordDigest(share.salt, got), share.passHash);
}

/** 设了密码的分享链接：打开时先给这张页，解锁后才下发真正的浏览页 */
function passwordPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#ff4d8d"/>
<meta name="robots" content="noindex"/>
<title>需要访问密码</title>
<style>
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
  background:#11131a; color:#f4f4f8; font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
.box { width:100%; max-width:360px; }
h1 { font-size:19px; margin:0 0 6px; }
p { margin:0 0 18px; color:#9a9cb0; font-size:13px; }
input { width:100%; padding:12px 13px; border-radius:10px; border:1px solid #262a3a; background:#1b1e2a; color:#f4f4f8; font-size:16px; }
button { width:100%; margin-top:12px; padding:12px; border:0; border-radius:10px; background:#ff4d8d; color:#fff; font-size:15px; font-weight:600; }
button:disabled { opacity:.6; }
.err { margin-top:10px; color:#ff849e; font-size:12.5px; min-height:18px; }
</style></head><body><div class="box">
<h1>这个链接需要密码</h1>
<p>请输入分享者设置的访问密码。密码只在本机校验，不会上传。</p>
<input id="pw" type="password" inputmode="text" autocomplete="current-password" placeholder="访问密码" autofocus/>
<button id="go">进入图库</button>
<div class="err" id="err"></div>
</div><script>
(function(){
  var token = new URLSearchParams(location.search).get('token') || localStorage.getItem('tuku_lan_token_read') || '';
  var pw = document.getElementById('pw');
  var btn = document.getElementById('go');
  var err = document.getElementById('err');
  async function submit(){
    var v = pw.value;
    if (!v) { err.textContent = '请输入密码'; return; }
    btn.disabled = true; err.textContent = '';
    try {
      var r = await fetch('/api/lan/unlock', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-lan-token': token },
        body: JSON.stringify({ password: v })
      });
      if (r.ok) { location.replace('/?token=' + encodeURIComponent(token) + '&mode=read'); return; }
      var j = await r.json().catch(function(){ return {}; });
      err.textContent = j.error || '密码不正确';
    } catch(e) { err.textContent = '连接失败，请确认和电脑在同一 Wi-Fi'; }
    btn.disabled = false;
  }
  btn.addEventListener('click', submit);
  pw.addEventListener('keydown', function(e){ if (e.key === 'Enter') submit(); });
})();
</script></body></html>`;
}

/**
 * @param {number} minutes
 * @param {{ scope?: string, ids?: number[], folderId?: number, title?: string, ttlMs?: number, password?: string, allowDownload?: boolean }} [opts]
 * ttlMs 只用于单测验证「过期即失效」，HTTP 路由不会传它。
 */
export function createShareToken(minutes = 60, opts = {}) {
  const ttlMin = Math.max(1, Math.min(7 * 24 * 60, Number(minutes) || 60));
  const { password, ...scope } = normalizeShareScope(opts);
  const ttlMs = Number.isFinite(Number(opts.ttlMs)) && Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : ttlMin * 60000;
  const token = crypto.randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + ttlMs;
  // 密码只存 scrypt 摘要（明文不出内存）；cookieKey 是解锁后的 HttpOnly 凭据，只与本次令牌绑定
  const salt = crypto.randomBytes(12).toString('hex');
  const passHash = password ? passwordDigest(salt, password) : '';
  const cookieKey = password ? crypto.randomBytes(18).toString('hex') : '';
  shareTokens.set(token, {
    expiresAt,
    createdAt: Date.now(),
    ...scope,
    salt,
    passHash,
    cookieKey,
  });
  // 返回值刻意不含 salt/passHash/cookieKey：前端与日志都不该碰到凭据材料
  return { token, expiresAt, minutes: ttlMin, ...scope, hasPassword: !!passHash };
}

function pruneShares() {
  const now = Date.now();
  for (const [k, v] of shareTokens) if (v.expiresAt <= now) shareTokens.delete(k);
}

export function listShareTokens() {
  pruneShares();
  return [...shareTokens].map(([token, v]) => ({
    token,
    expiresAt: v.expiresAt,
    createdAt: v.createdAt,
    scope: v.scope,
    ids: v.ids || [],
    folderId: v.folderId || 0,
    title: v.title || '',
    // 凭据本体绝不外泄，只回「有没有设密码 / 允不允许下载」
    hasPassword: !!v.passHash,
    allowDownload: v.allowDownload !== false,
  }));
}

export function revokeShareTokens() {
  const n = shareTokens.size;
  shareTokens.clear();
  return n;
}

/** 单条撤销：分享链接要能按条管理，不能只能「全部撤销」 */
export function revokeShareToken(token) {
  pruneShares();
  return shareTokens.delete(String(token || ''));
}

/** 只读令牌能否看到这张图。列表与缩略图都必须过这道闸，否则换个 id 就能越权 */
export function shareAllowsImage(share, id) {
  if (!share) return true; // 完整投送令牌
  if (share.scope === 'library') return true;
  if (share.scope === 'selection') return (share.ids || []).includes(Number(id));
  if (share.scope === 'folder') {
    const row = db
      .prepare('SELECT 1 AS ok FROM image_folders WHERE image_id = ? AND folder_id = ? LIMIT 1')
      .get(Number(id), Number(share.folderId));
    return !!row;
  }
  return false;
}

/** 把分享范围拼进图片列表的 WHERE；全用参数化占位符，不拼用户输入 */
function shareClause(share) {
  if (!share || share.scope === 'library') return { sql: '', params: [] };
  if (share.scope === 'selection') {
    const ids = share.ids || [];
    return { sql: ` AND id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  return {
    sql: ' AND id IN (SELECT image_id FROM image_folders WHERE folder_id = ?)',
    params: [Number(share.folderId)],
  };
}

/** 分享链接（只读，带过期时间）；同样按可用局域网 IP 生成多条 */
export function shareUrls(port, token) {
  if (!port) return [];
  const q = encodeURIComponent(token);
  return lanIpv4List().map((ip) => `http://${ip}:${port}/?token=${q}&mode=read`);
}

/** Service Worker：只缓存 PWA 外壳。数据接口一律不缓存——令牌会轮换、链接会过期 */
const SW_SCRIPT = `const CACHE='tuku-lan-shell-v1';
const SHELL=['/offline.html','/icon-192.png','/icon-512.png','/manifest.webmanifest'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',function(e){
  var u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==self.location.origin)return;
  if(u.pathname.indexOf('/api/')===0)return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(function(){return caches.match('/offline.html');}));
    return;
  }
  if(SHELL.indexOf(u.pathname)>=0){
    e.respondWith(caches.match(e.request).then(function(hit){return hit||fetch(e.request);}));
  }
});`;

const OFFLINE_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>暂时离线</title>
<style>body{margin:0;padding:40px 22px;background:#11131a;color:#f4f4f8;font:15px/1.7 -apple-system,"PingFang SC",sans-serif;text-align:center}
h1{font-size:20px}p{color:#9a9cb0;font-size:13px}a{color:#ff4d8d}</style></head>
<body><h1>暂时连不上图库</h1><p>请确认手机和电脑在同一 Wi-Fi、图库仍在运行，然后点下方重试。<br/>如果链接已过期，请重新扫电脑上的二维码。</p>
<p><a href="/">重新连接</a></p></body></html>`;

const ICON_CACHE = new Map();
function pwaIcon(size) {
  if (!ICON_CACHE.has(size)) ICON_CACHE.set(size, lanIconPng(size));
  return ICON_CACHE.get(size);
}

function tokenMatches(got, expected) {
  if (!got || !expected) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 独立的小 Express 实例：只注册投送 / 浏览相关路径，绝不复用主 app 的路由 */
export function buildLanApp(tokenOrGetter) {
  // 生产传 getter：轮换令牌时正在跑的服务立刻用新令牌，不必重启（重启会换端口、让二维码失效）。
  // 单测仍可直接传固定字符串。
  const currentToken = typeof tokenOrGetter === 'function' ? tokenOrGetter : () => tokenOrGetter;
  const app = express();
  app.disable('x-powered-by');
  // 只有很小的 JSON body（解锁密码）；上传走 express.raw，content-type 不匹配不会被这里吃掉
  app.use(express.json({ limit: '8kb' }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'");
    // PWA 外壳是纯静态字节：manifest / SW / 图标 / 离线页不含任何库数据或令牌，
    // 浏览器请求它们时也无法带自定义头，因此只放行这五个路径的 GET。
    if (PWA_PUBLIC_PATHS.has(req.path) && req.method === 'GET') return next();
    const got = String(req.headers['x-lan-token'] || req.query?.token || '');
    if (tokenMatches(got, currentToken())) {
      req.lanScope = 'full';
      req.lanShare = null;
      return next();
    }
    const share = shareTokens.get(got);
    if (!share || share.expiresAt <= Date.now()) {
      if (share) shareTokens.delete(got);
      return res.status(401).json({ error: '链接已失效或令牌无效' });
    }
    // 解锁必须排在密码门之前，否则永远打不开密码门
    if (req.method === 'POST' && req.path === '/api/lan/unlock') {
      if (!share.passHash) return res.json({ ok: true });
      const pw = String(req.body?.password ?? '');
      if (!tokenMatches(passwordDigest(share.salt, pw), share.passHash)) {
        return res.status(401).json({ error: '密码不正确' });
      }
      const maxAge = Math.max(1, Math.floor((share.expiresAt - Date.now()) / 1000));
      // HttpOnly：页面脚本读不到，XSS 也偷不走；只与本次令牌绑定
      res.set('Set-Cookie', `tuku_lan_pw=${share.cookieKey}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
      return res.json({ ok: true });
    }
    if (!shareUnlocked(req, share)) {
      // 直接打开页面 → 给密码框；接口 → 401，由页面自己提示
      if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
        return res.status(401).type('html').send(passwordPage());
      }
      return res.status(401).json({ error: '需要访问密码', needPassword: true });
    }
    req.lanScope = 'read';
    req.lanShare = share;
    return next();
  });

  app.get('/manifest.webmanifest', (req, res) => {
    const readOnly = req.query?.mode === 'read';
    res.set('Content-Type', 'application/manifest+json; charset=utf-8');
    res.send(
      JSON.stringify({
        id: readOnly ? '/?mode=read' : '/',
        name: readOnly ? '图库 · 只读浏览' : '图库 · 手机投送',
        short_name: '图库',
        description: '浏览电脑上的图库，或把照片投送到电脑',
        start_url: readOnly ? '/?mode=read' : '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#11131a',
        theme_color: '#ff4d8d',
        icons: [192, 512].map((n) => ({
          src: `/icon-${n}.png`,
          sizes: `${n}x${n}`,
          type: 'image/png',
          purpose: 'any maskable',
        })),
      })
    );
  });
  app.get('/sw.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Service-Worker-Allowed', '/');
    res.send(SW_SCRIPT);
  });
  app.get('/offline.html', (_req, res) => res.type('html').send(OFFLINE_PAGE));
  for (const size of [192, 512]) {
    app.get(`/icon-${size}.png`, (_req, res) => {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(pwaIcon(size));
    });
  }

  app.get('/', (req, res) => {
    const readOnly = req.lanScope === 'read' || req.query?.mode === 'read';
    // 只读页面绝不内联完整投送令牌，否则只读访客扫码就能拿到上传权限
    res.type('html').send(mobilePage(readOnly ? '' : currentToken(), readOnly));
  });
  app.get('/api/lan/info', (req, res) =>
    res.json({
      ok: true,
      name: req.lanShare?.title || (req.lanScope === 'read' ? '图库 · 只读浏览' : '图库 · 手机投送'),
      version: 3,
      mode: req.lanScope === 'read' ? 'read' : 'full',
      scope: req.lanShare?.scope || 'library',
      title: req.lanShare?.title || '',
      expiresAt: req.lanShare?.expiresAt || 0,
      // 只读页据此决定是「点击看大图」还是「长按能另存原图」
      hasPassword: !!req.lanShare?.passHash,
      allowDownload: req.lanShare ? req.lanShare.allowDownload !== false : true,
    })
  );

  // 只读浏览：分页列表 + 缩略图。两边都套隐私锁与堆叠口径，和桌面端一致。
  app.get('/api/lan/images', (req, res) => {
    try {
      const pageNo = Math.max(1, Number(req.query?.page) || 1);
      const pageSize = Math.min(60, Math.max(12, Number(req.query?.pageSize) || 48));
      const q = String(req.query?.q || '').trim().slice(0, 80);
      const where = ['(stack_id = 0 OR stack_id = id)'];
      const params = [];
      const hidden = hiddenImagesClause();
      if (hidden) {
        where.push(hidden.sql);
        params.push(...hidden.params);
      }
      if (q) {
        where.push('(title LIKE ? OR tags LIKE ? OR keyword LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      const scope = shareClause(req.lanShare);
      const sqlWhere = where.join(' AND ') + scope.sql;
      const scoped = [...params, ...scope.params];
      const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM images WHERE ${sqlWhere}`).get(...scoped)?.c || 0);
      const items = db
        .prepare(
          `SELECT id, title, width, height, media_kind, tags, favorite
             FROM images WHERE ${sqlWhere}
            ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...scoped, pageSize, (pageNo - 1) * pageSize);
      res.json({ ok: true, total, page: pageNo, pageSize, items });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err).slice(0, 200) });
    }
  });

  app.get('/api/lan/thumb/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '素材 id 无效' });
    // 只读链接不能靠猜 id 拿到范围外的缩略图：列表和单图必须用同一道闸
    if (!shareAllowsImage(req.lanShare, id)) return res.status(403).json({ error: '该素材不在此分享链接范围内' });
    const row = lib.getImage(id);
    if (!row) return res.status(404).json({ error: '素材不存在' });
    // 有非破坏操作链：分享出去也要看到成品构图，不能给原图缩略图
    if (Number(row.edit_ops_count) > 0) {
      const ndThumb = await nd.ensureDerived(row, 'thumb');
      if (ndThumb && fs.existsSync(ndThumb)) {
        res.set('Cache-Control', 'private, max-age=120');
        res.set('Content-Type', 'image/jpeg');
        return res.sendFile(path.resolve(ndThumb), { dotfiles: 'allow' });
      }
    }
    const cache = existingThumbPath(id, mtimeOf(row.abs_path));
    // 库里数据在 .tuku 点目录下：sendFile 默认把点开头路径当隐藏文件回 404，必须显式放行
    if (cache && fs.existsSync(cache)) {
      res.set('Cache-Control', 'private, max-age=120');
      return res.sendFile(path.resolve(cache), { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: '缩略图读取失败' });
      });
    }
    // 没有缩略图缓存时绝不回原图：禁下载的分享里，那样等于把原图递出去。
    // 现做一张 640 的临时图（只在内存里），够看清网格即可。
    if (req.lanShare && req.lanShare.allowDownload === false) {
      try {
        const buf = await sharp(row.abs_path, { failOn: 'none' })
          .rotate()
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 78 })
          .toBuffer();
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'no-store');
        return res.send(buf);
      } catch {
        return res.status(404).json({ error: '没有可用的缩略图' });
      }
    }
    if (!fs.existsSync(row.abs_path)) return res.status(404).json({ error: '没有可用的缩略图' });
    res.set('Cache-Control', 'private, max-age=120');
    return res.sendFile(path.resolve(row.abs_path), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: '缩略图读取失败' });
    });
  });

  /**
   * 只读浏览的大图：长边 1920 的预览图，禁下载的分享也能看——
   * 「不给原图」不等于「只能看 200px 的小图」。
   */
  app.get('/api/lan/preview/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '素材 id 无效' });
    if (!shareAllowsImage(req.lanShare, id)) return res.status(403).json({ error: '该素材不在此分享链接范围内' });
    const row = lib.getImage(id);
    if (!row || !fs.existsSync(row.abs_path)) return res.status(404).json({ error: '素材不存在' });
    if (Number(row.edit_ops_count) > 0) {
      const ndPreview = await nd.ensureDerived(row, 'preview');
      if (ndPreview && fs.existsSync(ndPreview)) {
        res.set('Cache-Control', 'private, max-age=3600');
        res.set('Content-Type', 'image/jpeg');
        return res.sendFile(path.resolve(ndPreview), { dotfiles: 'allow' });
      }
    }
    const hit = existingPreviewPath(id, mtimeOf(row.abs_path));
    const file = hit || (await ensurePreview(id, row.abs_path));
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: '预览生成失败' });
    res.set('Cache-Control', 'private, max-age=3600');
    return res.sendFile(path.resolve(file), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: '预览读取失败' });
    });
  });

  /** 下载原图：只有 allowDownload !== false 的链接才给 */
  app.get('/api/lan/file/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '素材 id 无效' });
    if (!shareAllowsImage(req.lanShare, id)) return res.status(403).json({ error: '该素材不在此分享链接范围内' });
    if (req.lanShare && req.lanShare.allowDownload === false) {
      return res.status(403).json({ error: '这个分享链接不允许下载原图' });
    }
    const row = lib.getImage(id);
    if (!row || !fs.existsSync(row.abs_path)) return res.status(404).json({ error: '素材不存在' });
    const src =
      Number(row.edit_ops_count) > 0 ? (await nd.ensureDerived(row, 'full')) || row.abs_path : row.abs_path;
    const ext = path.extname(src) || '.jpg';
    res.set('Content-Disposition', `inline; filename="tuku_${row.id}${ext}"`);
    res.set('Cache-Control', 'private, max-age=600');
    return res.sendFile(path.resolve(src), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: '原图读取失败' });
    });
  });

  /**
   * 手机端可选的目标文件夹：只回 id + 展示路径（不含磁盘绝对路径）。
   * 上限 800 个，够用且不至于让手机上拉一个几 MB 的 JSON。
   */
  app.get('/api/lan/folders', (_req, res) => {
    try {
      const rows = db.prepare('SELECT id, name, parent_id FROM folders ORDER BY name').all();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const labelOf = (r) => {
        const parts = [];
        let cur = r;
        for (let guard = 0; cur && guard < 16; guard++) {
          parts.unshift(String(cur.name || ''));
          cur = cur.parent_id == null ? null : byId.get(cur.parent_id);
        }
        return parts.filter(Boolean).join(' / ');
      };
      res.json({ folders: rows.slice(0, 800).map((r) => ({ id: r.id, label: labelOf(r) })) });
    } catch (err) {
      res.status(500).json({ error: `读取文件夹失败：${err.message}` });
    }
  });

  app.post(
    '/api/lan/upload',
    express.raw({ type: '*/*', limit: MAX_UPLOAD }),
    async (req, res) => {
      if (req.lanScope === 'read') return res.status(403).json({ error: '只读分享链接不能上传' });
      const filename = String(req.query?.filename || '').trim().slice(0, 200);
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!filename || !buf.length) return res.status(400).json({ error: '缺少文件名或文件内容为空' });
      const settings = getSettings();
      const limit = Math.max(1, Number(settings.maxFileSize) || 50) * 1024 * 1024;
      if (buf.length > limit) return res.status(413).json({ error: '文件超过大小上限' });
      try {
        const base = { buffer: buf, title: filename, source: 'lan', keyword: '手机投送', tags: '手机投送', copyToStorage: true };
        // 与拖拽入库同一条管线：多媒体格式走 ingestMedia，其余走 lib.ingest
        const r = isMediaPath(filename) ? await ingestMedia(base) : await lib.ingest(base, settings);
        if (!r.ok) return res.status(400).json({ error: '该格式暂不支持或内容重复' });
        // 手机上可以直接指定落到哪个文件夹（支持 a/b 这种多级路径）：
        // 以前只能进「手机投送」来源、再回桌面手动归位，等于「能传不能整理」。
        const folderPath = String(req.query?.folder || '')
          .replace(/\\/g, '/')
          .replace(/^\/+|\/+$/g, '')
          .slice(0, 120);
        // 手机页直接选的是「已有文件夹」，按 id 挂更精确：
        // 路径方式只对物化到磁盘的夹有效，纯虚拟夹没有相对目录，按 id 才能落进去。
        const wantId = Number(req.query?.folderId) || 0;
        let folderId = null;
        // 归类失败不能只 warn：图已经入库了，手机页如果只看 folderId 会以为「传进去并归到指定夹了」，
        // 实际只在库里裸着。这里把失败带回响应，手机页能提示「文件夹归类失败，请在桌面端手动整理」。
        let folderWarning = null;
        try {
          if (wantId && db.prepare('SELECT 1 AS x FROM folders WHERE id = ?').get(wantId)) {
            linkImageToFolder(r.id, wantId);
            folderId = wantId;
          } else if (folderPath) {
            folderId = ensureFolderByRelDir(folderPath);
            if (folderId) linkImageToFolder(r.id, folderId);
          }
        } catch (err) {
          folderWarning = `归类到文件夹失败：${err?.message || err}`;
          console.warn('[lan] 手机投送归类失败', folderWarning);
        }
        return res.json({
          ok: true,
          id: r.id,
          folder: folderPath || null,
          folderId,
          folderWarning,
          image: lib.toDTO(lib.getImage(r.id)),
        });
      } catch (err) {
        return res.status(400).json({ error: String(err?.message || err).slice(0, 200) });
      }
    }
  );

  app.use((_req, res) => res.status(404).json({ error: '接口不存在' }));
  return app;
}

/**
 * 启动（幂等）。返回 { enabled, port, urls }。
 * host 可注入是为了单测能绑 127.0.0.1（不惊动 Windows 防火墙）；生产默认 0.0.0.0。
 */
function listenOn(app, port, host) {
  return new Promise((resolve, reject) => {
    // Node 25 + Express 5 的坑：失败时 listen 回调也会先跑一次且 address() 为 null。
    // 这里只认真正的 'listening' 事件，并且只在 address() 有值时才算启动成功。
    const server = app.listen(port, host);
    const onListening = () => {
      const addr = server.address();
      if (!addr) return;
      server.removeListener('error', onError);
      resolve(server);
    };
    const onError = (err) => {
      server.removeListener('listening', onListening);
      try {
        server.close();
      } catch {
        /* 还没真正监听 */
      }
      reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

export async function startLanServer(host = '0.0.0.0') {
  if (lanServer) return lanStatus();
  readOrCreateLanToken();
  const app = buildLanApp(readOrCreateLanToken);
  let server;
  try {
    server = await listenOn(app, PREFERRED_LAN_PORT, host);
  } catch (err) {
    if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') throw err;
    // 端口被别的程序占了才退回系统分配，并在界面上如实显示实际端口
    console.info('[lan] 优先端口被占用（' + err.code + '），改用系统分配端口');
    server = await listenOn(app, 0, host);
  }
  lanServer = server;
  lanPort = server.address().port;
  console.info('[lan] 投送服务已开启，端口', lanPort);
  return lanStatus();
}

export async function stopLanServer() {
  const server = lanServer;
  lanServer = null;
  lanPort = 0;
  if (!server) return lanStatus();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    timer.unref?.();
    try {
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
    // 已建立的 keep-alive 连接会拖住 close，主动断开
    server.closeAllConnections?.();
  });
  console.info('[lan] 投送服务已关闭');
  return lanStatus();
}

/** 二维码内容；ip 必须是本机枚举出的地址，防止把任意字符串塞进二维码 */
export function lanQrText(ip = '') {
  if (!lanPort) return '';
  const ips = lanIpv4List();
  const host = ips.includes(ip) ? ip : ips[0];
  return host ? `http://${host}:${lanPort}/?token=${encodeURIComponent(readOrCreateLanToken())}` : '';
}

export function lanStatus() {
  const enabled = !!lanServer;
  return {
    ok: true,
    enabled,
    port: enabled ? lanPort : 0,
    ips: lanIpv4List(),
    urls: enabled ? lanUrls(lanPort, readOrCreateLanToken()) : [],
    qrText: enabled ? lanQrText() : '',
    // 桌面端设置页要显示，方便用户输入到没有相机的设备；主接口仍要求正常鉴权
    token: readOrCreateLanToken(),
    note: enabled ? '' : '局域网投送未开启：主服务仍只监听 127.0.0.1',
  };
}

/**
 * 本机连通性自检：从电脑上逐个请求自己的局域网 IP，能抓出「服务没起来 / 网卡选错」。
 * 注意：本机访问不受 Windows 防火墙入站规则限制，自检通过不等于手机一定能连，
 * 防火墙与「同一 Wi-Fi」仍需在手机上确认。
 */
export async function lanSelfCheck() {
  if (!lanServer) return { ok: false, port: 0, results: [] };
  const token = readOrCreateLanToken();
  const results = await Promise.all(
    lanIpv4List().map(async (ip) => {
      const url = `http://${ip}:${lanPort}/api/lan/info?token=${encodeURIComponent(token)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const res = await fetch(url, { signal: controller.signal });
        return { ip, ok: res.ok, status: res.status };
      } catch (err) {
        return { ip, ok: false, error: String(err?.message || err).slice(0, 120) };
      } finally {
        clearTimeout(timer);
      }
    })
  );
  return { ok: results.some((r) => r.ok), port: lanPort, results };
}

/** 跟随设置变化启停（幂等，设置总线与 toggle 路由会各调一次也无妨） */
export async function syncLanSetting(settings) {
  const want = settings?.lanAccess === true;
  if (want === !!lanServer) return lanStatus();
  return want ? startLanServer() : stopLanServer();
}

/** 二维码 SVG；未开启时返回 null，让路由给 409 而不是画一张扫不出来的图 */
export function lanQrcodeSvg(ip = '') {
  const text = lanQrText(ip);
  return text ? qrSvg(text) : null;
}

/** 仅测试用：清掉内存令牌缓存 */
export function resetLanTokenCache() {
  memoryToken = '';
}
