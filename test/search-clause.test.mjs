import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchClause } from '../server/lib/query.js';

/**
 * 口径：搜索必须认「路径」与「夹名」。
 * 用户实报过「文件夹里有 43388 这个夹，搜 43388 却是 0 张」——夹名不在 title/tags 里，
 * 只匹配 FTS 就永远搜不到。这里用纯函数把这条钉住（参数个数也要对得上，否则 SQL 绑定会炸）。
 */

const countPlaceholders = (sql) => (sql.match(/\?/g) || []).length;

test('关键词子句包含 abs_path（物理目录名可搜）', () => {
  const params = [];
  const clause = buildSearchClause('43388', params);
  assert.ok(clause.includes('abs_path LIKE ?'), '缺 abs_path 匹配');
  assert.ok(params.includes('%43388%'));
});

test('关键词子句包含虚拟夹名匹配（手动归档的夹也能搜）', () => {
  const params = [];
  const clause = buildSearchClause('43388', params);
  assert.match(clause, /FROM folders WHERE name LIKE \?/);
});

test('占位符个数必须等于参数个数（每个分支都要对）', () => {
  for (const kw of ['43388', 'ab', '界面', 'a b c', 'x"y(z)*', '图片 2026']) {
    const params = [];
    const clause = buildSearchClause(kw, params);
    assert.equal(countPlaceholders(clause), params.length, `关键词「${kw}」参数对不上：${clause}`);
  }
});

test('长短关键词都走同一套「正文 + 路径 + 夹名」口径', () => {
  // 1-2 字走 LIKE 分支（trigram 命中为空），3 字以上走 FTS，两条分支都必须带路径与夹名
  for (const kw of ['图', '照片', '43388']) {
    const params = [];
    const clause = buildSearchClause(kw, params);
    assert.ok(clause.startsWith('(') && clause.endsWith(')'), '子句必须整体加括号，别破坏外层 AND/OR');
    assert.ok(clause.includes('abs_path LIKE ?'), `「${kw}」漏了 abs_path`);
    assert.ok(clause.includes('folders WHERE name LIKE ?'), `「${kw}」漏了夹名`);
  }
});

test('空关键词返回空串，不污染 WHERE', () => {
  const params = [];
  assert.equal(buildSearchClause('   ', params), '');
  assert.equal(params.length, 0);
});
