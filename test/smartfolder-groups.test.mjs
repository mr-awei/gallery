/**
 * 智能文件夹 AND/OR 嵌套回归：
 * - 单行判断（matchSmartFolder）与 SQL 生成（buildSmartFolderWhere）必须同语义
 * - 空分组不能参与 OR 组合，否则会命中全库
 * - 老规则（只有平坦字段、没有 groups）行为完全不变
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSmartFolder, buildSmartFolderWhere, hasSmartFolderCondition } from '../server/lib/smartfolders.js';

const row = (over = {}) => ({
  id: 1, title: '', tags: '', keyword: '', note: '', rating: 0, favorite: 0, score: 100, width: 1000, height: 800,
  ...over,
});

test('平坦条件仍按 AND 处理（老规则不变）', () => {
  const rules = { tagsInclude: ['UI', '图标'] };
  assert.equal(matchSmartFolder(row({ tags: ',UI,图标,' }), rules), true);
  assert.equal(matchSmartFolder(row({ tags: ',UI,' }), rules), false);
  const { sql } = buildSmartFolderWhere(rules);
  assert.match(sql, /AND/);
});

test('单个 or 组内部任一命中即通过', () => {
  const rules = { groups: [{ op: 'or', rules: { tagsInclude: ['UI', '图标'] } }] };
  assert.equal(matchSmartFolder(row({ tags: ',图标,' }), rules), true);
  assert.equal(matchSmartFolder(row({ tags: ',海报,' }), rules), false);
  const { sql } = buildSmartFolderWhere(rules);
  assert.match(sql, /OR/);
});

test('组间 AND：(UI 或 图标) 且 蓝色', () => {
  const rules = {
    tagsInclude: ['蓝色'],
    groups: [{ op: 'or', rules: { tagsInclude: ['UI', '图标'] } }],
    combine: 'and',
  };
  assert.equal(matchSmartFolder(row({ tags: ',蓝色,UI,' }), rules), true);
  assert.equal(matchSmartFolder(row({ tags: ',蓝色,图标,' }), rules), true);
  assert.equal(matchSmartFolder(row({ tags: ',蓝色,海报,' }), rules), false);
  assert.equal(matchSmartFolder(row({ tags: ',绿色,UI,' }), rules), false);
});

test('组间 OR：任一组满足即可', () => {
  const rules = {
    tagsInclude: ['蓝色'],
    groups: [{ op: 'and', rules: { tagsInclude: ['UI'] } }],
    combine: 'or',
  };
  assert.equal(matchSmartFolder(row({ tags: ',蓝色,' }), rules), true);
  assert.equal(matchSmartFolder(row({ tags: ',UI,' }), rules), true);
  assert.equal(matchSmartFolder(row({ tags: ',海报,' }), rules), false);
  const { sql } = buildSmartFolderWhere(rules);
  assert.match(sql, /OR/);
});

test('空分组被忽略：不会因为 OR 变成全库命中', () => {
  const rules = { tagsInclude: ['蓝色'], groups: [{ op: 'or', rules: { tagsInclude: [] } }], combine: 'or' };
  assert.equal(matchSmartFolder(row({ tags: ',蓝色,' }), rules), true);
  assert.equal(matchSmartFolder(row({ tags: ',绿色,' }), rules), false);
  // 只剩第一组生效，所以不该出现 OR（否则空组会把全库捞进来）
  const { sql, params } = buildSmartFolderWhere(rules);
  assert.equal(params.length, 1);
  assert.doesNotMatch(sql, /\bOR\b/);
});

test('无任何条件 → 一张都不命中（以前退化成整库，用户看到「没条件却收了 7541 张」）', () => {
  assert.equal(matchSmartFolder(row(), {}), false);
  assert.equal(buildSmartFolderWhere({}).sql, 'WHERE 0');
  assert.equal(buildSmartFolderWhere({ groups: [{ op: 'or', rules: { tagsInclude: [] } }] }).sql, 'WHERE 0');
  // 空白项不算条件
  assert.equal(hasSmartFolderCondition({ tagsInclude: ['   '] }), false);
  assert.equal(hasSmartFolderCondition({ tagsInclude: ['蓝色'] }), true);
  assert.equal(hasSmartFolderCondition({ favorite: 'yes' }), true);
  assert.equal(hasSmartFolderCondition({ groups: [{ op: 'and', rules: { minRating: 3 } }] }), true);
});
