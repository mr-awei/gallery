import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderGalleryHtml, safeFileName } from '../server/lib/gallery-html.js';

const items = [
  {
    id: 1,
    title: '春日 <b>海报</b>',
    tags: ['海报', '春天'],
    width: 800,
    height: 1200,
    sizeBytes: 204800,
    createdAt: '2026-03-01T10:00:00.000Z',
    sourceUrl: 'https://example.com/a?x=1&y=2',
    src: 'data:image/jpeg;base64,AAAA',
  },
  { id: 2, title: '', tags: [], width: 0, height: 0, thumb: '', src: '' },
];

test('escapeHtml 转义出可用的属性与文本', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("a&b'c"), 'a&amp;b&#39;c');
  assert.equal(escapeHtml(undefined), '');
});

test('safeFileName 去掉 Windows 非法字符与尾部点空格', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(safeFileName('  作品集. .  '), '作品集');
  assert.equal(safeFileName(''), '图库画廊');
  assert.equal(safeFileName('x'.repeat(100)).length, 60);
});

test('renderGalleryHtml 渲染卡片、标签与内嵌图', () => {
  const html = renderGalleryHtml(items, { title: '测试 <画廊>', columns: 3, theme: 'dark' });
  assert.match(html, /<title>测试 &lt;画廊&gt;<\/title>/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /2 张 · 导出于/);
  assert.match(html, /春日 &lt;b&gt;海报&lt;\/b&gt;/);
  assert.match(html, /<i>海报<\/i>/);
  assert.match(html, /data-search="春日 &lt;b&gt;海报&lt;\/b&gt; 海报 春天"/);
  assert.match(html, /data:image\/jpeg;base64,AAAA/);
  // 第二个没图没标题：走占位分支，不能出现 undefined
  assert.match(html, /无预览/);
  assert.match(html, /<b>未命名<\/b>/);
  assert.ok(!html.includes('undefined'));
});

test('renderGalleryHtml 空列表给空态而不是空网格', () => {
  const html = renderGalleryHtml([], { title: '' });
  assert.match(html, /这个范围里还没有素材/);
  assert.ok(!html.includes('id="grid"'));
  assert.match(html, /<title>图库画廊<\/title>/);
});

test('renderGalleryHtml 列数夹在 2..8', () => {
  assert.match(renderGalleryHtml([], { columns: 1 }), /repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(renderGalleryHtml([], { columns: 99 }), /repeat\(8,minmax\(0,1fr\)\)/);
});

test('renderGalleryHtml 来源链接转义 & 非法主题回落 auto', () => {
  const html = renderGalleryHtml([items[0]], { theme: 'neon' });
  assert.match(html, /data-theme="auto"/);
  assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
});
