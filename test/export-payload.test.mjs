import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExportPayload } from '../electron/lib/pure.js';

const gif = Buffer.from('GIF89a' + '\x01\x00\x01\x00\xf7\x00\x00' + '\x00'.repeat(20), 'latin1');
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const url = (buf, mime = 'image/gif') => `data:${mime};base64,${buf.toString('base64')}`;

test('GIF 导出：真实文件头 + 中文标题可通过', () => {
  const r = parseExportPayload(url(gif), '邓紫棋-片段-1.5-4.5.gif');
  assert.equal(r.ok, true);
  assert.equal(r.ext, 'gif');
  assert.equal(r.isGif, true);
  assert.deepEqual(r.buffer, gif);
});

test('WebM 导出：Blob 自带的 ;codecs=vp9 不能被误判', () => {
  const r = parseExportPayload(url(webm, 'video/webm;codecs=vp9'), 'clip 1.5-4.5.webm');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.ext, 'webm');
  assert.equal(r.isGif, false);
  assert.deepEqual(r.buffer, webm);
});

test('文件名：路径穿越 / Windows 保留字符 / 扩展名不符全部拒绝', () => {
  const cases = [
    ['../evil.gif', /文件名不合法/],
    ['..\\evil.gif', /文件名不合法/],
    ['C:\\Users\\me\\evil.gif', /文件名不合法/],
    ['a/b.gif', /文件名不合法/],
    ['a:b.gif', /文件名不合法/],
    ['clip.gif.webm', /扩展名与内容类型不符/],
    ['clip.webm', /扩展名与内容类型不符/],
    ['x'.repeat(130) + '.gif', /文件名不合法/],
  ];
  for (const [name, re] of cases) {
    const r = parseExportPayload(url(gif), name);
    assert.equal(r.ok, false, `本该拒绝：${name}`);
    assert.match(r.error, re);
  }
});

test('内容：非 data URL、伪造文件头、超大小都要明确拒绝', () => {
  assert.match(parseExportPayload('https://evil/x.gif', 'a.gif').error, /不是受支持/);
  assert.match(parseExportPayload('data:text/html;base64,PGI+', 'a.gif').error, /不是受支持/);
  assert.match(parseExportPayload(url(Buffer.from('not a gif')), 'a.gif').error, /文件头不正确/);
  assert.match(parseExportPayload(url(Buffer.from('xxxxxxxx'), 'video/webm'), 'a.webm').error, /文件头不正确/);
  assert.match(parseExportPayload(url(gif), 'a.gif', { maxBytes: 4 }).error, /大小上限/);
  assert.match(parseExportPayload(undefined, 'a.gif').error, /不完整/);
});
