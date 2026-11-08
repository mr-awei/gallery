import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeResults } from '../server/sanitize.js';

test('空输入立即返回空数组', () => {
  assert.deepEqual(sanitizeResults([]), []);
  assert.deepEqual(sanitizeResults(null), []);
});

test('过滤非 http(s)、超长 URL', () => {
  const long = `https://a.com/${'x'.repeat(2100)}`;
  const out = sanitizeResults([
    { url: 'javascript:alert(1)' },
    { url: 'ftp://a.com/x.jpg' },
    { url: '' },
    { url: long },
    { url: 'https://ok.com/1.jpg', title: 'ok' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://ok.com/1.jpg');
  assert.equal(out[0].title, 'ok');
});

test('按 URL 去重且保留首次出现的附加字段', () => {
  const out = sanitizeResults([
    { url: 'https://a.com/1.jpg', title: 'first' },
    { url: 'https://a.com/1.jpg', title: 'second' },
    { url: 'HTTP://A.COM/2.jpg' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'first');
  // 大小写不同按不同 URL 处理（服务端不做规范化，避免误合并）
  assert.equal(out[1].url, 'HTTP://A.COM/2.jpg');
});

test('limit 封顶且按顺序截断', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ url: `https://a.com/${i}.jpg` }));
  const out = sanitizeResults(list, { limit: 3 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.url), [
    'https://a.com/0.jpg',
    'https://a.com/1.jpg',
    'https://a.com/2.jpg',
  ]);
});

test('默认 limit 为 240', () => {
  const list = Array.from({ length: 300 }, (_, i) => ({ url: `https://a.com/${i}.jpg` }));
  assert.equal(sanitizeResults(list).length, 240);
});

test('不改动原始数组与对象', () => {
  const item = { url: 'https://a.com/1.jpg' };
  const list = [item];
  const out = sanitizeResults(list);
  assert.equal(list.length, 1);
  assert.notEqual(out[0], item);
});
