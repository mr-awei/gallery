import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseEpub, readChapter } from '../server/lib/epub.js';

/** 1x1 PNG：只要字节合法，解析层不会去解码图片 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+EH4AAAAASUVORK5CYII=',
  'base64'
);

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title>
    <dc:creator>某作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="pic" href="images/a.png" media-type="image/png"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章 起风</title></head>
<body>
  <h1>第一章 起风</h1>
  <p>正文 &amp; 实体 &#65;</p>
  <p><img src="../images/a.png" alt="插图"/></p>
  <p>尾巴 &mdash; 结束</p>
</body></html>`;

const CH2 = `<html><head></head><body><h2>第二章 落雨</h2><p>第二章的正文。</p></body></html>`;

async function buildEpub({ withContainer = true } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  if (withContainer) zip.file('META-INF/container.xml', CONTAINER);
  zip.file('OEBPS/content.opf', OPF);
  zip.file('OEBPS/text/ch1.xhtml', CH1);
  zip.file('OEBPS/text/ch2.xhtml', CH2);
  zip.file('OEBPS/nav.xhtml', '<html><body><nav><ol><li><a href="text/ch1.xhtml">第一章 起风</a></li></ol></nav></body></html>');
  zip.file('OEBPS/images/cover.png', PNG);
  zip.file('OEBPS/images/a.png', PNG);
  zip.file('OEBPS/style.css', 'body { font-size: 16px }');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('EPUB：书名/作者/语言/封面与目录', async () => {
  const book = await parseEpub(await buildEpub());
  assert.equal(book.title, '测试之书');
  assert.equal(book.author, '某作者');
  assert.equal(book.language, 'zh-CN');
  assert.match(book.cover, /^data:image\/png;base64,/);
  // spine 顺序即章节顺序，nav.xhtml 不在 spine 里就不该出现
  assert.deepEqual(
    book.chapters.map((c) => c.label),
    ['第一章 起风', '第二章 落雨']
  );
});

test('EPUB：章节正文按顺序转文本块，插图内嵌成 data URL', async () => {
  const book = await parseEpub(await buildEpub());
  const ch = await readChapter(book, 0);
  assert.equal(ch.label, '第一章 起风');
  const shape = ch.blocks.map((b) => (b.type === 'text' ? b.text : 'IMG'));
  assert.deepEqual(shape, ['第一章 起风', '正文 & 实体 A', 'IMG', '尾巴 — 结束']);

  const img = ch.blocks.find((b) => b.type === 'image');
  assert.match(img.src, /^data:image\/png;base64,/);
  // 相对路径（../images/a.png）要能正确解回包内绝对路径
  assert.ok(img.src.length > PNG.toString('base64').length);
});

test('EPUB：越界章节返回 null，不是抛错', async () => {
  const book = await parseEpub(await buildEpub());
  assert.equal(await readChapter(book, 99), null);
  assert.equal(await readChapter(book, -1), null);
});

test('EPUB：不是电子书就给明确错误', async () => {
  const notEpub = new JSZip();
  notEpub.file('hello.txt', 'hi');
  const buf = await notEpub.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => parseEpub(buf), /container\.xml/);

  const noOpf = new JSZip();
  noOpf.file('META-INF/container.xml', CONTAINER);
  const buf2 = await noOpf.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => parseEpub(buf2), /OPF/);
});
