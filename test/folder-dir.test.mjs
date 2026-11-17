// 打开「当前文件夹」靠反推公共父目录，算错就会打开到库根甚至别的盘，所以单独测
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { commonDirOf } from '../server/lib/paths.js';

/** 构造绝对路径（带盘符/根），避免测试里手写分隔符 */
const p = (...parts) => path.resolve(path.sep, ...parts);

test('同一个目录的图片 → 就是该目录', () => {
  assert.equal(commonDirOf([p('a', 'b', 'x.jpg'), p('a', 'b', 'y.jpg')]), p('a', 'b'));
});

test('父夹聚合子夹 → 回到父目录而不是更深的子目录', () => {
  const got = commonDirOf([p('a', 'b', 'c1'), p('a', 'b', 'c2'), p('a', 'b', 'c2', 'd')]);
  assert.equal(got, p('a', 'b'));
});

test('大小写不一致也认作同一目录', () => {
  const got = commonDirOf([p('a', 'B'), p('a', 'b', 'c')]);
  assert.equal(got.toLowerCase(), p('a', 'b').toLowerCase());
});

test('毫无公共部分 → 盘符根（调用方据此回落到库根）', () => {
  const root = path.resolve(path.sep);
  const got = commonDirOf([p('a', 'b'), path.join(root, 'zzz')]);
  assert.equal(got, root);
});

test('空输入 → 根目录，不抛异常', () => {
  assert.equal(commonDirOf([]), path.sep);
});
