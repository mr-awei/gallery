import test from 'node:test';
import assert from 'node:assert/strict';
import { PROXY_MODES, normalizeNet, proxyRules } from '../server/proxy.js';

test('off / system 不生成固定代理规则（交给 Chromium 自己决定）', () => {
  assert.equal(proxyRules({ mode: 'off' }), '');
  assert.equal(proxyRules({ mode: 'system' }), '');
});

test('各协议生成 scheme://host:port', () => {
  assert.equal(proxyRules({ mode: 'http', host: '127.0.0.1', port: 7890 }), 'http://127.0.0.1:7890');
  assert.equal(proxyRules({ mode: 'socks5', host: '10.0.0.2', port: 1080 }), 'socks5://10.0.0.2:1080');
  assert.equal(proxyRules({ mode: 'https', host: 'proxy.local', port: 8443 }), 'https://proxy.local:8443');
});

test('缺字段时回落到安全默认值（不会拼出 http://undefined:NaN）', () => {
  const n = normalizeNet({});
  assert.equal(n.mode, 'off');
  assert.equal(n.port, 7890);
  assert.equal(n.bypass, '<local>');
  const rules = proxyRules({ mode: 'http', port: 'abc' });
  assert.equal(rules, 'http://127.0.0.1:7890');
});

test('端口字符串被转成数字，非法值回落', () => {
  assert.equal(normalizeNet({ port: '1080' }).port, 1080);
  assert.equal(normalizeNet({ port: 0 }).port, 7890);
  assert.equal(normalizeNet(null).mode, 'off');
});

test('未知 mode 仍按 scheme 拼接（由 Chromium 报错，不静默改配置）', () => {
  assert.equal(proxyRules({ mode: 'quic', host: 'h', port: 1 }), 'quic://h:1');
});

test('PROXY_MODES 覆盖全部合法模式且含中文说明', () => {
  const keys = PROXY_MODES.map((m) => m.key);
  assert.deepEqual(keys, ['off', 'system', 'http', 'https', 'socks5', 'socks4']);
  for (const m of PROXY_MODES) assert.ok(m.label.length > 0);
});
