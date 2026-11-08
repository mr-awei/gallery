import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_EXTS,
  extOf,
  isJunkFile,
  isMediaPath,
  kindOfPath,
  mimeOfPath,
} from '../server/lib/media-kind.js';

test('extOf 统一小写并去掉点', () => {
  assert.equal(extOf('a/b/C.MP4'), 'mp4');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf(''), '');
  assert.equal(extOf(null), '');
});

test('系统文件与下载残留判为垃圾', () => {
  const junk = [
    'Thumbs.db',
    'desktop.ini',
    '.DS_Store',
    '~$季度报告.docx',
    'movie.mp4.crdownload',
    'installer.part',
    '导出.csv',
    '说明.txt',
    'README.md',
    'settings.json',
    'server.log',
    '',
  ];
  for (const p of junk) assert.equal(isJunkFile(p), true, `${p} 应判为垃圾`);
});

test('正常素材不会被误判为垃圾', () => {
  const ok = ['cat.jpg', 'clip.MP4', 'song.flac', 'Aa.ttf', 'book.pdf', 'model.glb', '报告.docx', '表.xlsx'];
  for (const p of ok) assert.equal(isJunkFile(p), false, `${p} 不应判为垃圾`);
});

test('kindOfPath 按扩展名分类', () => {
  assert.equal(kindOfPath('a.jpg'), 'image');
  assert.equal(kindOfPath('a.HEIC'), 'image');
  assert.equal(kindOfPath('a.gif'), 'gif');
  assert.equal(kindOfPath('a.mp4'), 'video');
  assert.equal(kindOfPath('a.mkv'), 'video');
  assert.equal(kindOfPath('a.flac'), 'audio');
  assert.equal(kindOfPath('a.woff2'), 'font');
  assert.equal(kindOfPath('a.pdf'), 'pdf');
  assert.equal(kindOfPath('a.docx'), 'office');
  assert.equal(kindOfPath('a.blend'), 'model');
  // 垃圾文件、无扩展名、未知扩展名都归 other（不入库）
  assert.equal(kindOfPath('a.txt'), 'other');
  assert.equal(kindOfPath('LICENSE'), 'other');
  assert.equal(kindOfPath('a.unknownext'), 'other');
});

test('isMediaPath 只放行非图片素材', () => {
  assert.equal(isMediaPath('a.mp4'), true);
  assert.equal(isMediaPath('a.pdf'), true);
  assert.equal(isMediaPath('a.jpg'), false);
  assert.equal(isMediaPath('a.txt'), false);
});

test('mimeOfPath 给出可用于 <img>/<video> 的类型', () => {
  assert.equal(mimeOfPath('a.mp4'), 'video/mp4');
  assert.equal(mimeOfPath('a.webm'), 'video/webm');
  assert.equal(mimeOfPath('a.mp3'), 'audio/mpeg');
  assert.equal(mimeOfPath('a.jpg'), 'image/jpeg');
  assert.equal(mimeOfPath('a.jpeg'), 'image/jpeg');
  assert.equal(mimeOfPath('a.png'), 'image/png');
  assert.equal(mimeOfPath('a.svg'), 'image/svg+xml');
  assert.equal(mimeOfPath('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimeOfPath('a.xyz'), 'application/octet-stream');
});

test('MEDIA_EXTS 与 EXT_BY_KIND 保持一致，且不含图片/垃圾扩展名', () => {
  assert.ok(MEDIA_EXTS.has('mp4'));
  assert.ok(MEDIA_EXTS.has('docx'));
  assert.ok(!MEDIA_EXTS.has('jpg'));
  assert.ok(!MEDIA_EXTS.has('txt'));
  assert.ok(!MEDIA_EXTS.has('crdownload'));
});
