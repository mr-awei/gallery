import assert from 'node:assert/strict';
import test from 'node:test';

import { createDownloadDedupe } from '../electron/lib/download-dedupe.js';

const A = 'http://127.0.0.1:1/api/export/stitch?ids=1,2,3&token=t';
const B = 'http://127.0.0.1:1/api/export/stitch?ids=4,5,6&token=t';

test('窗口期内同址第二次请求被拦掉（连点只弹一个保存框）', () => {
  const d = createDownloadDedupe(1500);
  assert.equal(d.accept(A, 1000), true);
  assert.equal(d.accept(A, 1001), false);
  assert.equal(d.accept(A, 2000), false);
});

test('过了窗口期就重新放行（取消后隔一会儿再点还能弹框）', () => {
  const d = createDownloadDedupe(1500);
  assert.equal(d.accept(A, 1000), true);
  assert.equal(d.accept(A, 2501), true, '10s 后应放行');
});

test('不同 URL 互不影响（连续下两张图都要出框）', () => {
  const d = createDownloadDedupe(1500);
  assert.equal(d.accept(A, 1000), true);
  assert.equal(d.accept(B, 1000), true);
  assert.equal(d.accept(A, 1000), false);
});

test('空 URL 不参与去重也不进表', () => {
  const d = createDownloadDedupe(1500);
  assert.equal(d.accept('', 1000), true);
  assert.equal(d.accept('', 1000), true);
  assert.equal(d.size, 0);
});

test('过期记录会被清掉，表不会随下载次数无限增长', () => {
  const d = createDownloadDedupe(1500);
  d.accept(A, 1000);
  d.accept(B, 1000);
  assert.equal(d.size, 2);
  d.accept(B, 5000); // 触发一次清理，两条都过期
  assert.equal(d.size, 1, '只留本次 B');
});
