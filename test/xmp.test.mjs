import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSidecar, removeSidecar, sidecarPath, buildXmp, writeSidecar } from '../server/lib/xmp.js';

/** 临时目录用 ASCII 名：Windows 中文路径在 node 的某些 API 上会有句柄问题 */
function tmpPhoto() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-xmp-'));
  const file = path.join(dir, 'photo.jpg');
  fs.writeFileSync(file, Buffer.from('fake-jpeg'));
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('sidecar 路径与原图同目录同基名（Lightroom 就读这个位置）', () => {
  assert.equal(sidecarPath('E:/pics/a.jpg'), path.join('E:/pics', 'a.xmp').replace(/\//g, path.sep));
  assert.equal(sidecarPath('E:/pics/a'), path.join('E:/pics', 'a.xmp').replace(/\//g, path.sep));
  assert.equal(sidecarPath(''), '');
});

test('写进去的标题 / 标签 / 评分 / 备注能原样读回来', () => {
  const t = tmpPhoto();
  try {
    const meta = { title: '海边 <日落> & "云"', tags: ['旅行', 'a&b', '海边'], rating: 4, note: '备注 > 这里' };
    const w = writeSidecar(t.file, meta);
    assert.equal(w.ok, true, w.error);
    const back = readSidecar(t.file);
    assert.equal(back.title, meta.title);
    assert.equal(back.note, meta.note);
    assert.equal(back.rating, 4);
    assert.deepEqual(back.tags, meta.tags);
  } finally {
    t.cleanup();
  }
});

test('没有 sidecar 时返回 null（导入流程不该因此报错）', () => {
  const t = tmpPhoto();
  try {
    assert.equal(readSidecar(t.file), null);
    assert.equal(removeSidecar(t.file), false);
  } finally {
    t.cleanup();
  }
});

test('别人写的 sidecar 不被整份覆盖，只追加我们这段', () => {
  const t = tmpPhoto();
  try {
    const foreign = [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 6.0">',
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '  <rdf:Description rdf:about="" xmlns:lr="http://ns.adobe.com/lightroom/1.0/" lr:private="keep-me"/>',
      ' </rdf:RDF>',
      '</x:xmpmeta>',
    ].join('\n');
    fs.writeFileSync(sidecarPath(t.file), foreign, 'utf8');

    const w = writeSidecar(t.file, { tags: ['守门'], rating: 2 });
    assert.equal(w.ok, true, w.error);
    assert.equal(w.merged, true, '别家的 sidecar 应该走合并路径');

    const text = fs.readFileSync(sidecarPath(t.file), 'utf8');
    assert.ok(text.includes('lr:private="keep-me"'), '别家的私有字段必须保留');
    assert.ok(text.includes('守门'), '我们的标签也要写进去');
    assert.deepEqual(readSidecar(t.file).tags, ['守门']);
  } finally {
    t.cleanup();
  }
});

test('removeSidecar 只删本应用写的那份', () => {
  const t = tmpPhoto();
  try {
    writeSidecar(t.file, { tags: ['x'] });
    assert.equal(removeSidecar(t.file), true);
    assert.equal(fs.existsSync(sidecarPath(t.file)), false);

    fs.writeFileSync(sidecarPath(t.file), '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Other"/>', 'utf8');
    assert.equal(removeSidecar(t.file), false);
    assert.equal(fs.existsSync(sidecarPath(t.file)), true, '别家的 xmp 不能删');
  } finally {
    t.cleanup();
  }
});

test('空标签不写空 rdf:li', () => {
  const xml = buildXmp({ tags: ['', '  ', '有效'], rating: 9 });
  assert.equal((xml.match(/<rdf:li[^>]*>/g) || []).length, 1);
  assert.ok(xml.includes('xmp:Rating="5"'), '评分上限钳到 5');
});
