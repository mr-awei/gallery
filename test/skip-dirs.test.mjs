import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipDir, isSkippedPath } from '../server/lib/skip-dirs.js';

// 扫描（bulk-import）和监听（fs.watch）共用这一份排除表。
// 以前两份各写各的，加 .tuku 时漏掉了真正干活的那一份 —— 库数据默认就建在
// 素材文件夹里，漏了就变成「扫描把库自己的缩略图当新素材吸进来」。

test('库数据目录 .tuku 一律跳过', () => {
  assert.equal(shouldSkipDir('.tuku'), true);
  assert.equal(shouldSkipDir('.TuKu'), true, 'Windows 大小写不敏感');
  assert.equal(
    isSkippedPath('E:\\白底图\\.tuku\\lib_abc\\thumbs\\01\\12-pv.jpg'),
    true,
    'watch 给的绝对路径同样要挡住，否则每写一张缩略图就触发一轮回扫'
  );
});

test('Eagle 资产目录 .library 与 thumbs / trash 等内部目录同样跳过', () => {
  assert.equal(shouldSkipDir('图库.library'), true);
  assert.equal(isSkippedPath('/data/white.library/images/1.info/a.png'), true);
  assert.equal(shouldSkipDir('thumbs'), true);
  assert.equal(shouldSkipDir('Trash'), true);
});

test('正常素材目录不受影响', () => {
  assert.equal(shouldSkipDir('2509李'), false);
  assert.equal(shouldSkipDir(''), false, '空名字不算命中');
  assert.equal(isSkippedPath('E:\\白底图\\2509李\\001.jpg'), false);
  assert.equal(isSkippedPath(''), false);
});
