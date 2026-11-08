import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KNOWN_SHA256, pinnedSha, isPinned } from '../server/model-fetch.js';
import { validateResult, sanitizeResults } from '../server/sanitize.js';

const pins = JSON.parse(fs.readFileSync(new URL('../server/model-pins.json', import.meta.url), 'utf8'));

test('随包可信哈希清单不再是空的，且条目格式合法', () => {
  assert.ok(Object.keys(pins.models).length > 0, '清单仍为空，等于没有外部校验参照');
  for (const [key, hex] of Object.entries(pins.models)) {
    assert.match(hex, /^[0-9a-f]{64}$/i, `${key} 不是合法 sha256`);
    assert.equal(KNOWN_SHA256[key], hex.toLowerCase());
    assert.ok(isPinned(key));
  }
});

test('下载时传相对 repoPath 也能命中清单（不能被 sidecar 悄悄接管）', () => {
  const [key, hex] = Object.entries(pins.models)[0];
  const short = key.split('/').slice(-2).join('/');
  assert.equal(pinnedSha(key), hex.toLowerCase());
  assert.equal(pinnedSha(short), hex.toLowerCase());
  assert.equal(pinnedSha('onnx/unknown-model.onnx'), '');
});

test('爬虫 7 源结果走字段级 schema 校验，拒绝项可追溯且不污染返回数组', () => {
  const allowed = new Set(['bing']);
  const good = { url: 'https://example.com/a.jpg', source: 'bing', referer: 'https://example.com/p' };
  assert.equal(validateResult(good, allowed).ok, true);
  for (const bad of [
    { url: 'javascript:alert(1)', source: 'bing' },
    { url: 'https://example.com/a\n.jpg', source: 'bing' },
    { url: 'https://example.com/b.jpg', source: 'evil' },
    { url: 'https://example.com/c.jpg', source: 'bing', extra: { nested: 1 } },
    { url: 'https://example.com/d.jpg', source: 'bing', width: Number.POSITIVE_INFINITY },
    { url: 'https://example.com/e.jpg', source: 'bing', title: 'x'.repeat(3000) },
  ]) {
    assert.equal(validateResult(bad, allowed).ok, false, `应拒绝：${JSON.stringify(bad).slice(0, 80)}`);
  }

  const out = sanitizeResults([good, { url: 'ftp://x/y.jpg', source: 'bing' }, { ...good }], {
    limit: 10,
    sources: ['bing'],
  });
  assert.equal(out.length, 1);
  assert.equal(out.rejected.length, 2);
  assert.deepEqual(Object.keys(out), ['0']);
  assert.equal(JSON.stringify(out).includes('rejected'), false, '拒绝清单必须是非枚举的');
});
