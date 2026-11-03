/**
 * API 鉴权中间件单测。
 * config.js 在模块求值时读取 API_TOKEN 环境变量，所以必须先设环境变量再动态 import。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.API_TOKEN = 'unit-test-token';
const { hasValidToken, apiAuth } = await import('../server/auth.js');

const req = (patch = {}) => ({
  path: '/api/images',
  method: 'GET',
  headers: {},
  query: {},
  ...patch,
});

/** 极简 res 桩：记录状态码与 body */
function makeRes() {
  const out = { status: 200, body: null };
  const res = {
    status(code) {
      out.status = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      return res;
    },
  };
  return { res, out };
}

test('Bearer 令牌被接受', () => {
  assert.equal(hasValidToken(req({ headers: { authorization: 'Bearer unit-test-token' } })), true);
});

test('错误令牌被拒绝', () => {
  assert.equal(hasValidToken(req({ headers: { authorization: 'Bearer nope' } })), false);
  assert.equal(hasValidToken(req({ headers: { authorization: 'Token unit-test-token' } })), false);
});

test('x-api-token 与 ?token= 同样有效', () => {
  assert.equal(hasValidToken(req({ headers: { 'x-api-token': 'unit-test-token' } })), true);
  assert.equal(hasValidToken(req({ query: { token: 'unit-test-token' } })), true);
  assert.equal(hasValidToken(req({ query: { token: 'bad' } })), false);
});

test('query 令牌只对只读请求生效（写操作必须用 header）', () => {
  const post = req({ method: 'POST', query: { token: 'unit-test-token' } });
  assert.equal(hasValidToken(post), false);
  assert.equal(hasValidToken(req({ method: 'DELETE', query: { token: 'unit-test-token' } })), false);
  assert.equal(hasValidToken(req({ method: 'HEAD', query: { token: 'unit-test-token' } })), true);
});

test('令牌前缀不匹配也能正确拒绝（长度不同不走 timingSafeEqual）', () => {
  assert.equal(hasValidToken(req({ headers: { 'x-api-token': 'unit-test-toke' } })), false);
  assert.equal(hasValidToken(req({ headers: { 'x-api-token': '' } })), false);
});

test('浏览器同源请求放行，跨站请求拒绝', () => {
  assert.equal(hasValidToken(req({ headers: { 'sec-fetch-site': 'same-origin' } })), false);
  const same = req({ headers: { 'sec-fetch-site': 'same-origin' } });
  const s1 = makeRes();
  let called = false;
  apiAuth(same, s1.res, () => {
    called = true;
  });
  assert.equal(called, true);

  const cross = req({ headers: { 'sec-fetch-site': 'cross-site' } });
  const s2 = makeRes();
  let called2 = false;
  apiAuth(cross, s2.res, () => {
    called2 = true;
  });
  assert.equal(called2, false);
  assert.equal(s2.out.status, 401);
});

test('非 /api 路径不做鉴权（静态页 / 下载直链）', () => {
  const s = makeRes();
  let called = false;
  apiAuth(req({ path: '/index.html', headers: { 'sec-fetch-site': 'cross-site' } }), s.res, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(s.out.status, 200);
});

test('OPTIONS 预检直接放行', () => {
  const s = makeRes();
  let called = false;
  apiAuth(req({ method: 'OPTIONS', headers: { 'sec-fetch-site': 'cross-site' } }), s.res, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('浏览器扩展采集端点只放行白名单里的扩展 ID', () => {
  const allowed = 'chrome-extension://olckdffcmfpciekkkdekckpgphacfnfl';
  const s = makeRes();
  let called = false;
  apiAuth(
    req({ path: '/api/extension/ingest', headers: { 'sec-fetch-site': 'cross-site', origin: allowed } }),
    s.res,
    () => {
      called = true;
    }
  );
  assert.equal(called, true);

  // 别的扩展（含同名但 ID 不同）与伪造 origin 都要被拒
  for (const origin of ['chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'https://evil.com', '']) {
    const bad = makeRes();
    let hit = false;
    apiAuth(
      req({ path: '/api/extension/ingest', headers: { 'sec-fetch-site': 'cross-site', origin } }),
      bad.res,
      () => {
        hit = true;
      }
    );
    assert.equal(hit, false, `origin=${origin} 不应放行`);
    assert.equal(bad.out.status, 401);
  }
});

test('普通跨站 POST 到 /api 被 401 拦下并带错误信息', () => {
  const s = makeRes();
  apiAuth(
    req({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' } }),
    s.res,
    () => {
      throw new Error('不应放行');
    }
  );
  assert.equal(s.out.status, 401);
  assert.match(String(s.out.body?.error || ''), /令牌/);
});
