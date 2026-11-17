import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandScopes, hasScope, normalizeScopes, parseTokenMap, scopeForMethod } from '../server/lib/api-scopes.js';
import { rateGuard, resetApiAudit, tokenTag } from '../server/lib/api-audit.js';

// config.js 在首次 import 时就会固化 token / scope 表，必须在动态 import 之前注入。
// 临时目录用 ASCII 名：Windows 中文路径下 node:sqlite 的句柄会让 rmSync 卡死。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-v1-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_API_SCOPE_TOKENS = JSON.stringify({
  'readonly-token-123456': ['read'],
  'ingest-token-1234567': 'ingest',
  'bad-token-123456789': ['admin', 'ROOT'],
});
const { API_TOKEN } = await import('../server/config.js');
const { hasValidToken, requireScope, resolveToken, v1Auth } = await import('../server/auth.js');

test.after(() => {
  delete process.env.TUKU_USER_DATA;
  delete process.env.TUKU_API_SCOPE_TOKENS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeReq(headers = {}, method = 'GET', pathname = '/api/v1/status') {
  return { headers, method, path: pathname, query: {} };
}
function fakeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.payload = b;
      return this;
    },
    on() {
      return this;
    },
  };
}

test('scope 归一化：非法值丢弃，write 隐含 read + ingest', () => {
  assert.deepEqual(normalizeScopes(['read', 'READ', 'nope', ' ingest ']), ['read', 'ingest']);
  assert.deepEqual(normalizeScopes('write,read'), ['write', 'read']);
  assert.deepEqual(expandScopes(['write']), ['write', 'read', 'ingest']);
  assert.deepEqual(expandScopes(['read']), ['read']);
  assert.equal(scopeForMethod('GET'), 'read');
  assert.equal(scopeForMethod('POST'), 'write');
  assert.ok(hasScope(['write', 'read', 'ingest'], ['write']));
  assert.ok(!hasScope(['read'], ['write']));
});

test('令牌表：数组/对象两种写法都支持，非法 scope 的令牌整条丢弃', () => {
  const a = parseTokenMap({ 'aaa-token-1234': ['read'], 'bbb-token-1234': 'write' });
  assert.deepEqual(a.get('aaa-token-1234'), ['read']);
  assert.deepEqual(a.get('bbb-token-1234'), ['write', 'read', 'ingest']);
  const b = parseTokenMap([{ token: 'ccc-token-1234', scopes: ['ingest'] }]);
  assert.deepEqual(b.get('ccc-token-1234'), ['ingest']);
  const c = parseTokenMap({ 'short': ['read'], 'bad-token-1234': ['admin'] });
  assert.equal(c.size, 0, '短令牌 / 全非法 scope 都不能进表');
  assert.equal(parseTokenMap(null).size, 0);
  assert.equal(parseTokenMap('nope').size, 0);
});

test('令牌解析：主令牌全权限，附加令牌只读/仅投送', () => {
  assert.deepEqual(resolveToken(fakeReq({ authorization: `Bearer ${API_TOKEN}` })).scopes, [
    'write',
    'read',
    'ingest',
  ]);
  assert.deepEqual(resolveToken(fakeReq({ 'x-api-token': 'readonly-token-123456' })).scopes, ['read']);
  assert.deepEqual(resolveToken(fakeReq({ 'x-api-token': 'ingest-token-1234567' })).scopes, ['ingest']);
  assert.equal(resolveToken(fakeReq({ 'x-api-token': 'bad-token-123456789' })).ok, false);
  assert.equal(resolveToken(fakeReq()).ok, false);
});

test('内部 /api/* 仍兼容 GET 的 ?token=，/api/v1 的 headerOnly 则拒绝', () => {
  const req = fakeReq({}, 'GET');
  req.query.token = API_TOKEN;
  assert.equal(hasValidToken(req), true);
  assert.equal(resolveToken(req, { headerOnly: true }).ok, false);
});

test('v1Auth：无令牌 401；write 令牌放行；同源豁免不生效', () => {
  resetApiAudit();
  const r1 = fakeRes();
  let next = false;
  v1Auth(fakeReq({ 'sec-fetch-site': 'same-origin' }), r1, () => {
    next = true;
  });
  assert.equal(r1.statusCode, 401);
  assert.equal(next, false, '同源不是 /api/v1 的通行证');

  const req = fakeReq({ authorization: `Bearer ${API_TOKEN}` });
  const r2 = fakeRes();
  v1Auth(req, r2, () => {
    next = true;
  });
  assert.equal(r2.statusCode, 200);
  assert.equal(next, true);
  assert.ok(req.apiScopes.includes('write'));
});

test('requireScope：只读令牌写接口 403（不是 401），ingest 令牌只能投送', () => {
  const readReq = fakeReq({ 'x-api-token': 'readonly-token-123456' }, 'POST');
  const r1 = fakeRes();
  let next = false;
  v1Auth(readReq, r1, () => {
    next = true;
  });
  assert.equal(next, true);
  const r2 = fakeRes();
  requireScope('write')(readReq, r2, () => assert.fail('只读令牌不该放行写操作'));
  assert.equal(r2.statusCode, 403);
  assert.equal(r2.payload.code, 'SCOPE_DENIED');

  const ingestReq = fakeReq({ 'x-api-token': 'ingest-token-1234567' }, 'POST');
  v1Auth(ingestReq, fakeRes(), () => {});
  let ok = false;
  requireScope('ingest')(ingestReq, fakeRes(), () => {
    ok = true;
  });
  assert.equal(ok, true);
  const r3 = fakeRes();
  requireScope('write')(ingestReq, r3, () => assert.fail('仅投送令牌不该能改标签'));
  assert.equal(r3.statusCode, 403);
});

test('限流：同一令牌每分钟 120 次后返回 429', () => {
  resetApiAudit();
  const key = tokenTag('rate-test-token');
  assert.equal(rateGuard(key, 3, 60_000), true);
  assert.equal(rateGuard(key, 3, 60_000), true);
  assert.equal(rateGuard(key, 3, 60_000), true);
  assert.equal(rateGuard(key, 3, 60_000), false);
  assert.equal(rateGuard(tokenTag('other'), 3, 60_000), true, '不同令牌互不影响');
  resetApiAudit();
});
