import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config/db 在首次 import 时固化用户目录，必须先注入隔离的 ASCII 临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-lan-'));
process.env.TUKU_USER_DATA = tmp;
const {
  buildLanApp, createShareToken, lanIpv4List, lanQrText, lanStatus, lanUrls, listShareTokens,
  normalizeShareScope, readOrCreateLanToken, resetLanTokenCache, revokeShareToken,
  revokeShareTokens, rotateLanToken, shareAllowsImage, shareUrls, startLanServer, stopLanServer,
} = await import('../server/lib/lan.js');

let server = null;
let base = '';
after(async () => {
  await stopLanServer();
  if (server) await new Promise((r) => server.close(r));
  // Windows 上 node:sqlite 的句柄释放有延迟：先显式关库，删不掉也不要把清理失败伪装成测试失败
  try {
    const { db } = await import('../server/db.js');
    db.close();
  } catch {
    /* 已关闭 */
  }
  delete process.env.TUKU_USER_DATA;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 交给系统清理临时目录 */
  }
});

test('投送令牌：持久化、可轮换、长度足够', () => {
  const a = readOrCreateLanToken();
  assert.ok(a.length >= 20);
  resetLanTokenCache();
  assert.equal(readOrCreateLanToken(), a, '重启（清缓存）后应读回同一个令牌');
  const b = rotateLanToken();
  assert.notEqual(b, a);
  assert.equal(fs.readFileSync(path.join(tmp, 'data', '.lan-token'), 'utf8').trim(), b);
});

test('局域网 IP 枚举：排除回环 / IPv6，格式合法', () => {
  const list = lanIpv4List();
  for (const ip of list) {
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!ip.startsWith('127.'));
  }
  assert.equal(new Set(list).size, list.length, '不能重复');
});

test('扫码 URL 含端口与令牌，且不含主 API 令牌', () => {
  const urls = lanUrls(45678, 'lan-token-abcdefgh');
  for (const u of urls) {
    assert.ok(u.startsWith('http://'));
    assert.ok(u.includes(':45678/'));
    assert.ok(u.includes(encodeURIComponent('lan-token-abcdefgh')));
  }
  assert.deepEqual(lanUrls(0, 'x'), [], '未启动时不能生成二维码内容');
});

test('投送开关：可启停、端口隔离、重复开启幂等', async () => {
  const a = await startLanServer('127.0.0.1');
  assert.equal(a.enabled, true);
  assert.ok(a.port > 0);
  const b = await startLanServer('127.0.0.1');
  assert.equal(b.port, a.port, '重复开启不能换端口，否则旧二维码失效');
  const hidden = await fetch(`http://127.0.0.1:${a.port}/api/settings`, {
    headers: { 'x-lan-token': a.token },
  });
  assert.equal(hidden.status, 404, '独立端口上不能出现主服务的普通接口');
  const page = await fetch(`http://127.0.0.1:${a.port}/?token=${encodeURIComponent(a.token)}`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('投送到图库'));

  // 轮换令牌不能重启服务：端口一换，刚生成/已收藏的二维码立刻指向没人监听的端口
  const fresh = rotateLanToken();
  assert.equal(lanStatus().port, a.port, '轮换令牌后端口必须保持不变');
  const stale = await fetch(`http://127.0.0.1:${a.port}/api/lan/info?token=${encodeURIComponent(a.token)}`);
  assert.equal(stale.status, 401, '旧令牌应立即失效');
  const valid = await fetch(`http://127.0.0.1:${a.port}/api/lan/info?token=${encodeURIComponent(fresh)}`);
  assert.equal(valid.status, 200, '新令牌应无需重启即可生效');

  const off = await stopLanServer();
  assert.equal(off.enabled, false);
  assert.equal(off.port, 0);
  assert.equal(off.qrText, '', '关闭后不能再生成二维码');
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${a.port}/api/lan/info`),
    '关闭后端口应真的不再监听'
  );
});

test('二维码内容：与当前端口一致，可指定网卡且不接受伪造 IP', async () => {
  const s = await startLanServer('127.0.0.1');
  const text = lanQrText();
  const ips = lanIpv4List();
  if (ips.length) {
    assert.ok(text.includes(`:${s.port}/?token=`), '二维码必须编码真实监听端口');
    assert.ok(lanQrText(ips[0]).startsWith(`http://${ips[0]}:${s.port}/`));
  } else {
    // CI runner 可能只有回环地址：此时不应编造一个扫不开的二维码
    assert.equal(text, '');
  }
  assert.ok(!lanQrText('evil.example.com').includes('evil.example.com'), '不能把任意字符串塞进二维码');
  await stopLanServer();
  assert.equal(lanQrText(), '', '关闭后不能再生成二维码内容');
});

test('独立投送 app：只暴露投送路径，且必须带独立令牌', async () => {
  const token = readOrCreateLanToken();
  const app = buildLanApp(token);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const noToken = await fetch(`${base}/`);
  assert.equal(noToken.status, 401, '没有投送令牌不能打开页面');
  const wrong = await fetch(`${base}/api/lan/info`, { headers: { 'x-lan-token': 'wrong' } });
  assert.equal(wrong.status, 401);

  const page = await fetch(`${base}/`, { headers: { 'x-lan-token': token } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('投送到图库'));
  assert.ok(html.includes('Content-Security-Policy'), '手机页必须自带 CSP');
  assert.ok(html.includes("form-action 'none'"));

  const info = await fetch(`${base}/api/lan/info?token=${encodeURIComponent(token)}`);
  assert.equal(info.status, 200);
  assert.equal((await info.json()).ok, true);

  const hidden = await fetch(`${base}/api/settings`, { headers: { 'x-lan-token': token } });
  assert.equal(hidden.status, 404, '主服务的普通接口绝不能出现在投送端口上');
  const stats = await fetch(`${base}/api/stats`, { headers: { 'x-lan-token': token } });
  assert.equal(stats.status, 404);

  const badUpload = await fetch(`${base}/api/lan/upload`, {
    method: 'POST',
    headers: { 'x-lan-token': token },
    body: Buffer.alloc(0),
  });
  assert.equal(badUpload.status, 400, '空上传要说明原因，不能静默成功');
});

test('只读分享令牌：能浏览、不能上传、可撤销、带过期时间', async () => {
  const share = createShareToken(5);
  assert.ok(share.token.length >= 20);
  assert.ok(share.expiresAt > Date.now());
  assert.equal(listShareTokens().length, 1);
  // 分享链接带 mode=read，扫码进来直接落在浏览标签
  const urls = shareUrls(server.address().port, share.token);
  for (const u of urls) assert.ok(u.includes('mode=read'));

  // 页面：只读令牌打开后不出现上传入口
  const page = await fetch(`${base}/?token=${encodeURIComponent(share.token)}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('只读'), '只读链接的页面要明说不能上传');

  // 浏览接口可用（空库也应是 200 + 空列表，而不是 403）
  const list = await fetch(`${base}/api/lan/images?token=${encodeURIComponent(share.token)}`);
  assert.equal(list.status, 200);
  const listJson = await list.json();
  assert.equal(listJson.ok, true);
  assert.ok(Array.isArray(listJson.items));

  // 上传必须被拒绝
  const up = await fetch(`${base}/api/lan/upload?filename=x.jpg&token=${encodeURIComponent(share.token)}`, {
    method: 'POST',
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(up.status, 403, '只读令牌不能上传');

  // 撤销后立即失效
  assert.equal(revokeShareTokens(), 1);
  const gone = await fetch(`${base}/api/lan/images?token=${encodeURIComponent(share.token)}`);
  assert.equal(gone.status, 401);
});

test('移动端只读 PWA：外壳免令牌可用、可安装、不缓存数据接口', async () => {
  const token = readOrCreateLanToken();
  const manifestRes = await fetch(`${base}/manifest.webmanifest?mode=read`);
  assert.equal(manifestRes.status, 200, 'manifest 请求无法带自定义头，必须免令牌');
  const manifest = await manifestRes.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/?mode=read');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
  assert.ok(!JSON.stringify(manifest).includes(token), 'manifest 不能泄露投送令牌');

  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  const swText = await sw.text();
  assert.ok(swText.includes("indexOf('/api/')===0"), 'SW 绝不能缓存数据接口');
  assert.ok(!swText.includes(token));
  assert.equal((await fetch(`${base}/offline.html`)).status, 200);

  for (const n of [192, 512]) {
    const icon = await fetch(`${base}/icon-${n}.png`);
    assert.equal(icon.status, 200);
    const buf = Buffer.from(await icon.arrayBuffer());
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '必须是合法 PNG');
    assert.equal(buf.readUInt32BE(16), n, `图标宽度应为 ${n}`);
    assert.equal(buf.readUInt32BE(20), n);
  }

  const html = await (await fetch(`${base}/`, { headers: { 'x-lan-token': token } })).text();
  assert.ok(html.includes('rel="manifest"'));
  assert.ok(html.includes('apple-mobile-web-app-capable'));
  assert.ok(html.includes('theme-color'));
  assert.ok(html.includes("worker-src 'self'"), 'CSP 要允许同源 SW');
  assert.ok(html.includes("form-action 'none'"), '原有 CSP 约束不能丢');

  // 静态外壳放行不等于接口放行
  assert.equal((await fetch(`${base}/api/lan/info`)).status, 401);
});

test('分享链接产品化：范围校验、越权拦截、过期与单条撤销', async () => {
  const { db } = await import('../server/db.js');
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO images (id, title, abs_path, created_at) VALUES (?, ?, ?, ?)');
  for (const id of [91001, 91002, 91003]) ins.run(id, `分享测试 ${id}`, path.join(tmp, `share-${id}.jpg`), now);
  db.prepare('INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES (?, ?)').run(91001, 77001);

  assert.throws(() => normalizeShareScope({ scope: 'selection' }), '空选区不能悄悄退化成整库');
  assert.throws(() => normalizeShareScope({ scope: 'folder' }), '文件夹分享必须给有效 id');
  assert.equal(shareAllowsImage({ scope: 'library' }, 123), true);
  assert.equal(shareAllowsImage({ scope: 'selection', ids: [1] }, 1), true);
  assert.equal(shareAllowsImage({ scope: 'selection', ids: [1] }, 2), false);

  const sel = createShareToken(60, { scope: 'selection', ids: [91001, 91002], title: '两张精选' });
  const listRes = await fetch(`${base}/api/lan/images?token=${encodeURIComponent(sel.token)}`);
  assert.equal(listRes.status, 200);
  const listed = await listRes.json();
  assert.deepEqual(listed.items.map((x) => x.id).sort((a, b) => a - b), [91001, 91002]);
  assert.equal(listed.total, 2, '列表总数也必须按范围算，不能泄露库内其它素材数量');

  // 换个 id 拿缩略图必须被拦；范围内的 id 允许继续走（文件不存在则返回 404）
  assert.equal((await fetch(`${base}/api/lan/thumb/91003?token=${encodeURIComponent(sel.token)}`)).status, 403);
  assert.equal((await fetch(`${base}/api/lan/thumb/91001?token=${encodeURIComponent(sel.token)}`)).status, 404);

  const folder = createShareToken(60, { scope: 'folder', folderId: 77001 });
  const folderJson = await (await fetch(`${base}/api/lan/images?token=${encodeURIComponent(folder.token)}`)).json();
  assert.deepEqual(folderJson.items.map((x) => x.id), [91001]);

  // 过期即刻失效（ttlMs 只用于测试，HTTP 路由拿不到）
  const expiring = createShareToken(60, { ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal((await fetch(`${base}/api/lan/images?token=${encodeURIComponent(expiring.token)}`)).status, 401);

  assert.equal(revokeShareToken(sel.token), true);
  assert.equal((await fetch(`${base}/api/lan/images?token=${encodeURIComponent(sel.token)}`)).status, 401);
  assert.equal(revokeShareToken(folder.token), true);
  revokeShareTokens();

  db.prepare('DELETE FROM image_folders WHERE folder_id = 77001').run();
  db.prepare('DELETE FROM images WHERE id IN (91001, 91002, 91003)').run();
});

test('只读页面不内联完整投送令牌', async () => {
  const token = readOrCreateLanToken();
  const share = createShareToken(60, { scope: 'library', title: '只读页测试' });
  const res = await fetch(`${base}/?token=${encodeURIComponent(share.token)}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('只读'), '只读页要明说权限');
  assert.ok(!html.includes(token), '只读访客不能从源码里拿到上传令牌');
  assert.ok(html.includes('manifest.webmanifest?mode=read'));
  revokeShareToken(share.token);
});
