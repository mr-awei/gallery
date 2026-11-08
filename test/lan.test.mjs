import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config/db 在首次 import 时固化用户目录，必须先注入隔离的 ASCII 临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-lan-'));
process.env.TUKU_USER_DATA = tmp;
const {
  buildLanApp, createShareToken, lanIpv4List, lanUrls, listShareTokens, readOrCreateLanToken,
  resetLanTokenCache, revokeShareTokens, rotateLanToken, shareUrls, startLanServer, stopLanServer,
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
  const off = await stopLanServer();
  assert.equal(off.enabled, false);
  assert.equal(off.port, 0);
  assert.equal(off.qrText, '', '关闭后不能再生成二维码');
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${a.port}/api/lan/info`),
    '关闭后端口应真的不再监听'
  );
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
