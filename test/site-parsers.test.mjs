import test from 'node:test';
import assert from 'node:assert/strict';
import {
  upscaleDoubanUrl,
  parseCommonsSearch,
  extractDoubanImages,
  extractTiebaThreads,
  extractTiebaImages,
} from '../server/lib/site-parsers.js';

test('Wikimedia Commons：formatversion=2 数组与旧版对象都能解析', () => {
  const v2 = {
    query: {
      pages: [
        { title: 'File:A.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/a.jpg', width: 4000, height: 3000 }] },
        { title: 'File:B.png', imageinfo: [{ url: 'https://upload.wikimedia.org/b.png', width: 100, height: 80 }] },
        { title: 'File:Bad.jpg', imageinfo: [] },
      ],
    },
  };
  assert.deepEqual(parseCommonsSearch(v2).map((x) => x.url), [
    'https://upload.wikimedia.org/a.jpg',
    'https://upload.wikimedia.org/b.png',
  ]);
  assert.deepEqual(parseCommonsSearch(v2, { minLongSide: 800 }).map((x) => x.url), [
    'https://upload.wikimedia.org/a.jpg',
  ]);
  const legacy = { query: { pages: { '12': { imageinfo: [{ url: 'https://upload.wikimedia.org/c.jpg', width: 900, height: 900 }] } } } };
  assert.equal(parseCommonsSearch(legacy)[0].url, 'https://upload.wikimedia.org/c.jpg');
  assert.deepEqual(parseCommonsSearch({ error: { info: 'bad' } }), []);
  assert.deepEqual(parseCommonsSearch({ query: { pages: [{ imageinfo: [{ url: 'javascript:alert(1)' }] }] } }), []);
});

test('豆瓣：放大缩略图、去重、排除头像图标', () => {
  assert.equal(
    upscaleDoubanUrl('https://img9.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg'),
    'https://img9.doubanio.com/view/photo/l_ratio_poster/public/p123.jpg'
  );
  const html = `
    <img src="https:\\/\\/img9.doubanio.com\\/view\\/photo\\/s_ratio_poster\\/public\\/p123.jpg">
    <img data-src="https://img2.doubanio.com/view/photo/m_ratio_poster/public/p456.webp?x=1">
    <img src="https://img1.doubanio.com/favicon/avatar/u1.jpg">
    <img src="https://img9.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg">
  `;
  const out = extractDoubanImages(html);
  assert.ok(out.includes('https://img9.doubanio.com/view/photo/l_ratio_poster/public/p123.jpg'));
  assert.ok(out.some((u) => u.includes('p456.webp')));
  assert.equal(out.length, 2, '重复与头像都要被排掉');
});

test('贴吧：帖子 id 与图片 URL 提取', () => {
  const list = `<a href="/p/8123456789">A</a><a href="/p/8123456789">A</a><span>"tid": "7987654321"</span>`;
  assert.deepEqual(extractTiebaThreads(list), ['8123456789', '7987654321']);
  const post = `
    <img bpic="//imgsrc.baidu.com/forum/w%3D580/sign=abc/aaa.jpg">
    <img src="https://tiebapic.baidu.com/forum/pic/item/bbb.png">
    <img src="//imgsrc.baidu.com/static/common/icon.gif">
    <img src="//imgsrc.baidu.com/forum/w%3D580/sign=abc/aaa.jpg">
  `;
  const out = extractTiebaImages(post);
  assert.ok(out.includes('https://imgsrc.baidu.com/forum/w%3D580/sign=abc/aaa.jpg'));
  assert.ok(out.includes('https://tiebapic.baidu.com/forum/pic/item/bbb.png'));
  assert.equal(out.length, 2, '静态图标与重复图都要排掉');
});
