/**
 * 局域网 / 手机扫码投送。
 *
 * 安全设计（对应遗留总表 T-25 的验收）：
 * - 主服务永远只绑 127.0.0.1，普通接口、设置、凭据一个都不暴露给局域网；
 * - 开启时另起一个独立 Express 实例绑 0.0.0.0 的随机端口，这个实例只注册
 *   「投送页 / 上传 / info」三个路径，其余一律 404，不共享主 app 的路由与中间件；
 * - 独立投送令牌（data/.lan-token），只能访问上面那三个路径，拿不到完整 API_TOKEN；
 * - 默认关闭。关闭时外部设备扫不到任何端口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { DATA_DIR } from '../config.js';
import { db, getSettings } from '../db.js';
import * as lib from '../library.js';
import { ingestMedia, isMediaPath } from './media.js';
import { qrSvg } from './qr.js';
import { existingThumbPath } from '../thumbs.js';
import { hiddenImagesClause } from './privacy.js';

const TOKEN_FILE = path.join(DATA_DIR, '.lan-token');
const MAX_UPLOAD = 60 * 1024 * 1024;

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
      if (!it || (it.family !== 'IPv4' && it.family !== 4) || it.internal) continue;
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
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'"/>
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
</style></head><body><div class="wrap">
<h1>${readOnly ? '图库（只读）' : '投送到图库'}</h1>
<p id="sub">${readOnly ? '这是只读分享链接，可以浏览与搜索，不能上传。' : '与电脑连接同一个 Wi-Fi。上传会直接写入电脑上的当前资源库。'}</p>
<div class="tabs" id="tabs">
  <div class="tab${readOnly ? ' on' : ''}" data-tab="browse">浏览</div>
  <div class="tab${readOnly ? '' : ' on'}" data-tab="upload"${readOnly ? ' hidden' : ''}>投送</div>
</div>
<div id="pane-upload"${readOnly ? ' hidden' : ''}>
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
</div><script>
(function(){
  var token = new URLSearchParams(location.search).get('token') || ${JSON.stringify(token)};
  var readOnly = ${readOnly ? 'true' : 'false'};
  var list = document.getElementById('list');
  var grid = document.getElementById('grid');
  var page = 1, busy = false, ended = false, q = '';

  function add(name, text, good) {
    var row = document.createElement('div'); row.className = 'row';
    var a = document.createElement('span'); a.textContent = name;
    var b = document.createElement('span'); b.className = good ? 'ok' : 'err'; b.textContent = text;
    row.appendChild(a); row.appendChild(b); list.insertBefore(row, list.firstChild);
  }

  var files = document.getElementById('files');
  if (files) files.addEventListener('change', async function (e) {
    var picked = Array.from(e.target.files || []).slice(0, 20);
    for (var i = 0; i < picked.length; i++) {
      var f = picked[i]; add(f.name, '上传中…', true);
      try {
        var r = await fetch('/api/lan/upload?filename=' + encodeURIComponent(f.name), {
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

  function cell(item) {
    var d = document.createElement('div'); d.className = 'cell';
    var img = document.createElement('img');
    img.loading = 'lazy';
    // 缩略图走 query 令牌：img 标签发不了自定义头
    img.src = '/api/lan/thumb/' + item.id + '?token=' + encodeURIComponent(token);
    img.alt = item.title || '';
    var cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = item.title || ('#' + item.id);
    d.appendChild(img); d.appendChild(cap);
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
})();
</script></body></html>`;
}

/**
 * 只读分享令牌：只活在内存里，重启即失效——不做持久化，避免一条链接永久可访问。
 * 与投送令牌的区别只有权限：read 只能浏览 / 搜索，不能上传。
 */
const shareTokens = new Map();

export function createShareToken(minutes = 60) {
  const ttlMin = Math.max(1, Math.min(7 * 24 * 60, Number(minutes) || 60));
  const token = crypto.randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + ttlMin * 60000;
  shareTokens.set(token, { expiresAt, createdAt: Date.now() });
  return { token, expiresAt, minutes: ttlMin };
}

function pruneShares() {
  const now = Date.now();
  for (const [k, v] of shareTokens) if (v.expiresAt <= now) shareTokens.delete(k);
}

export function listShareTokens() {
  pruneShares();
  return [...shareTokens].map(([token, v]) => ({ token, expiresAt: v.expiresAt, createdAt: v.createdAt }));
}

export function revokeShareTokens() {
  const n = shareTokens.size;
  shareTokens.clear();
  return n;
}

/** 分享链接（只读，带过期时间）；同样按可用局域网 IP 生成多条 */
export function shareUrls(port, token) {
  if (!port) return [];
  const q = encodeURIComponent(token);
  return lanIpv4List().map((ip) => `http://${ip}:${port}/?token=${q}&mode=read`);
}

function tokenMatches(got, expected) {
  if (!got || !expected) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 独立的小 Express 实例：只注册投送 / 浏览相关路径，绝不复用主 app 的路由 */
export function buildLanApp(token) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'");
    const got = String(req.headers['x-lan-token'] || req.query?.token || '');
    if (tokenMatches(got, token)) {
      req.lanScope = 'full';
      return next();
    }
    const share = shareTokens.get(got);
    if (share && share.expiresAt > Date.now()) {
      req.lanScope = 'read';
      return next();
    }
    if (share) shareTokens.delete(got);
    return res.status(401).json({ error: '链接已失效或令牌无效' });
  });

  app.get('/', (req, res) =>
    res.type('html').send(mobilePage(token, req.lanScope === 'read' || req.query?.mode === 'read'))
  );
  app.get('/api/lan/info', (_req, res) => res.json({ ok: true, name: '图库 TuKu 投送', version: 2 }));

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
      const sqlWhere = where.join(' AND ');
      const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM images WHERE ${sqlWhere}`).get(...params)?.c || 0);
      const items = db
        .prepare(
          `SELECT id, title, width, height, media_kind, tags, favorite
             FROM images WHERE ${sqlWhere}
            ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...params, pageSize, (pageNo - 1) * pageSize);
      res.json({ ok: true, total, page: pageNo, pageSize, items });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err).slice(0, 200) });
    }
  });

  app.get('/api/lan/thumb/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '素材 id 无效' });
    const row = lib.getImage(id);
    if (!row) return res.status(404).json({ error: '素材不存在' });
    const cache = existingThumbPath(id, 0);
    // 库里数据在 .tuku 点目录下：sendFile 默认把点开头路径当隐藏文件回 404，必须显式放行
    const file = cache || row.abs_path;
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: '没有可用的缩略图' });
    res.set('Cache-Control', 'private, max-age=120');
    return res.sendFile(path.resolve(file), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: '缩略图读取失败' });
    });
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
        return res.json({ ok: true, id: r.id, image: lib.toDTO(lib.getImage(r.id)) });
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
export async function startLanServer(host = '0.0.0.0') {
  if (lanServer) return lanStatus();
  const token = readOrCreateLanToken();
  const app = buildLanApp(token);
  await new Promise((resolve, reject) => {
    // Node 25 + Express 5 的坑：失败时 listen 回调也会先跑一次且 address() 为 null。
    // 这里只认真正的 'listening' 事件，并且只在 address() 有值时才算启动成功。
    const server = app.listen(0, host);
    const onListening = () => {
      const addr = server.address();
      if (!addr) return;
      server.removeListener('error', onError);
      lanServer = server;
      lanPort = addr.port;
      resolve();
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

export function lanQrText() {
  return lanUrls(lanPort, readOrCreateLanToken())[0] || '';
}

export function lanStatus() {
  const enabled = !!lanServer;
  return {
    ok: true,
    enabled,
    port: enabled ? lanPort : 0,
    urls: enabled ? lanUrls(lanPort, readOrCreateLanToken()) : [],
    qrText: enabled ? lanQrText() : '',
    // 桌面端设置页要显示，方便用户输入到没有相机的设备；主接口仍要求正常鉴权
    token: readOrCreateLanToken(),
    note: enabled ? '' : '局域网投送未开启：主服务仍只监听 127.0.0.1',
  };
}

/** 跟随设置变化启停（幂等，设置总线与 toggle 路由会各调一次也无妨） */
export async function syncLanSetting(settings) {
  const want = settings?.lanAccess === true;
  if (want === !!lanServer) return lanStatus();
  return want ? startLanServer() : stopLanServer();
}

/** 二维码 SVG；未开启时返回 null，让路由给 409 而不是画一张扫不出来的图 */
export function lanQrcodeSvg() {
  const text = lanQrText();
  return text ? qrSvg(text) : null;
}

/** 仅测试用：清掉内存令牌缓存 */
export function resetLanTokenCache() {
  memoryToken = '';
}
