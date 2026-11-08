import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// 守住「集合类」新增能力的核心不变量：
// 1) 堆叠：一张图只能属于一个堆叠；组主被移出时要自动提升下一张，否则整组指向一个空组。
// 2) 列表默认只显示组主（attachStackInfo 的 stackCount 必须按组统计）。
// 3) 文件夹外观：颜色只收 #rgb/#rrggbb，图标截到 4 个码点 —— 别把任意字符串写进 style。
// 4) 文件夹排序只在同一父级内生效（跨级拖动是移动，不是排序）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-stacks-'));
const storage = path.join(tmp, 'storage');
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = storage;
process.env.TUKU_THUMB_WIDTH = '320';

const { importLocalImages } = await import('../server/importer.js');
const {
  attachStackInfo,
  addToStack,
  createStack,
  listStacks,
  mergeStacks,
  removeFromStack,
  setStackPrimary,
  stackRows,
  ungroupStack,
} = await import('../server/lib/stacks.js');
const { createFoldersBatch, createVirtualFolder, listFolderTree, reorderFolders, setFolderAppearance } = await import(
  '../server/folders.js'
);
const { db } = await import('../server/db.js');
const lib = await import('../server/library.js');
const { listTagsPaged, setTagMeta } = await import('../server/lib/tags.js');
const { bumpUsage } = await import('../server/lib/usage.js');
const { toDTO } = lib;

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

const dir = path.join(storage, '2601');
fs.mkdirSync(dir, { recursive: true });
for (const [name, color] of [
  ['a.jpg', '#3366ff'],
  ['b.jpg', '#33aa66'],
  ['c.jpg', '#cc4444'],
]) {
  await sharp({ create: { width: 400, height: 300, channels: 3, background: color } })
    .jpeg()
    .toFile(path.join(dir, name));
}

test('导入三张图作为堆叠样本', async () => {
  const r = await importLocalImages({ dirs: [storage] });
  assert.equal(r.errors, 0, JSON.stringify(r));
  assert.equal(r.saved, 3, JSON.stringify(r));
});

test('图片堆叠：组主 = 评分最高，列表只显示组主，移出组主自动提升', () => {
  const [a, b, c] = db.prepare('SELECT id FROM images ORDER BY id').all().map((r) => r.id);
  db.prepare('UPDATE images SET rating = 5 WHERE id = ?').run(b);

  const r = createStack([a, b, c]);
  assert.equal(r.stackId, b, '评分最高的那张当组主');

  const dto = attachStackInfo(db.prepare('SELECT * FROM images ORDER BY id').all().map(toDTO));
  const primary = dto.find((x) => x.id === b);
  assert.equal(primary.stackPrimary, true);
  assert.equal(primary.stackCount, 3, '组内张数含组主');
  assert.equal(dto.find((x) => x.id === a).stackPrimary, false);

  // 从组主移出：下一张（id 最小）必须被提升为组主，否则剩下的成员指向空组
  const rm = removeFromStack(b);
  assert.equal(rm.stackId, a);
  const after = attachStackInfo(db.prepare('SELECT * FROM images ORDER BY id').all().map(toDTO));
  assert.equal(after.find((x) => x.id === a).stackPrimary, true);
  assert.equal(after.find((x) => x.id === a).stackCount, 2);

  // 追加成员进已有堆叠
  const add = addToStack(a, [c]);
  assert.equal(add.added, 1);
  assert.equal(stackRows(a).length, 2);

  // 指定封面：不能因为评分低就被 createStack 的挑法顶掉
  const swap = setStackPrimary(a, c);
  assert.equal(swap.stackId, c);
  const swapped = attachStackInfo(db.prepare('SELECT * FROM images ORDER BY id').all().map(toDTO));
  assert.equal(swapped.find((x) => x.id === c).stackPrimary, true);
  assert.equal(swapped.find((x) => x.id === a).stackPrimary, false);

  // 解散：所有成员恢复 stack_id = 0
  ungroupStack(c);
  const cleared = db.prepare('SELECT COUNT(*) AS n FROM images WHERE stack_id <> 0').get();
  assert.equal(Number(cleared.n), 0);
});

test('堆叠边界：少于两张不成立，跨组拖动后旧组不会残留成员', () => {
  const [a, b, c] = db.prepare('SELECT id FROM images ORDER BY id').all().map((r) => r.id);
  assert.throws(() => createStack([a]), /至少选择两张/);

  createStack([a, b]);
  createStack([c, b]); // b 从 a 组拖到 c 组
  const rows = db.prepare('SELECT id, stack_id FROM images ORDER BY id').all();
  const byId = new Map(rows.map((r) => [r.id, Number(r.stack_id)]));
  assert.equal(byId.get(a), 0, 'a 组只剩空壳时必须被解散');
  assert.notEqual(byId.get(b), 0);
  assert.equal(byId.get(b), byId.get(c), 'b 与 c 同组');
  ungroupStack(c);
});

test('文件夹外观：颜色白名单 + 图标截断', () => {
  // createVirtualFolder 返回的是 id（数字），不是文件夹对象
  const f = createVirtualFolder('外观测试', null);
  const r1 = setFolderAppearance(f, { icon: '🎨🎨🎨🎨🎨', color: '#ABCDEF' });
  assert.equal(r1.color, '#abcdef', '颜色统一小写');
  assert.equal(Array.from(r1.icon).length, 4, '图标最多 4 个码点');

  const r2 = setFolderAppearance(f, { color: 'red; background:url(x)' });
  assert.equal(r2.color, '', '非 #hex 一律当清除，不能写进 style');

  const row = listFolderTree().find((x) => x.id === f);
  assert.equal(row.color, '');
});

test('文件夹排序：只在同一父级内生效，跨级 id 被忽略', () => {
  const root = createVirtualFolder('排序根', null);
  const x = createVirtualFolder('X', root);
  const y = createVirtualFolder('Y', root);
  const z = createVirtualFolder('Z', null);

  const r = reorderFolders(root, [y, x, z]);
  assert.equal(r.updated, 2, '根级的 z 不在这个父级下，应被跳过');
  const order = listFolderTree()
    .filter((f) => f.parent_id === root)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((f) => f.name);
  assert.deepEqual(order, ['Y', 'X']);
});

test('批量建夹：同一批内去重，已存在的同名夹跳过', () => {
  // 输入里重复的名字只建一次（.filter 去重），不算「跳过」
  const r = createFoldersBatch(['批量A', '批量B', '批量A'], null);
  assert.deepEqual(r.created, ['批量A', '批量B']);
  assert.deepEqual(r.skipped, []);
  // 第二次再建同名：全部跳过，不会出现两个一样的兄弟夹
  const again = createFoldersBatch('批量A\n批量B', null);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.skipped, ['批量A', '批量B']);
});

test('计数口径：文件夹张数 / 标签云 / 待整理 都不把堆叠成员算两份', () => {
  const ids = db.prepare('SELECT id FROM images ORDER BY id').all().map((r) => r.id);
  // 只挂在成员身上的标签，不应该出现在标签云里（点进去会是 0 张）
  lib.setTags(ids[2], '只在成员上');
  createStack([ids[0], ids[1], ids[2]]);

  const folder = listFolderTree().find((f) => f.name === '2601');
  assert.equal(folder.count, 1, '3 张同组素材在文件夹里算 1 条目');
  assert.equal(folder.total, 1);

  const tagNames = listTagsPaged({ limit: 200 }).items.map((t) => t.tag);
  assert.ok(!tagNames.includes('只在成员上'), '只挂在堆叠成员上的标签不能进标签云');

  // 批量建出来的空标签必须能出现在分页列表里（否则「批量创建」等于没建）
  setTagMeta({ tag: '空标签批次' });
  const paged = listTagsPaged({ limit: 200 });
  assert.ok(
    paged.items.some((t) => t.tag === '空标签批次' && t.count === 0),
    '空标签必须出现在列表第一页'
  );

  ungroupStack(ids[0]);
});

test('使用统计：复制 / 导出分别累加，并记最后使用时间', () => {
  const id = db.prepare('SELECT id FROM images ORDER BY id LIMIT 1').get().id;
  const before = db.prepare('SELECT copy_count, export_count FROM images WHERE id = ?').get(id);
  const r = bumpUsage('copy', [id]);
  assert.equal(r, 1);
  bumpUsage('export', [id, id]); // 重复 id 也只 +1（Set 去重）
  const after = db.prepare('SELECT copy_count, export_count, last_used_at FROM images WHERE id = ?').get(id);
  assert.equal(Number(after.copy_count), Number(before.copy_count) + 1);
  assert.equal(Number(after.export_count), Number(before.export_count) + 1);
  assert.ok(after.last_used_at, '必须记下最后使用时间');
  // 非法 kind 直接报错（而不是默默写错列）
  assert.throws(() => bumpUsage('delete', [id]), /未知的使用统计类型/);
});

test('删素材时笔记跟着删（触发器），不在笔记表里留孤儿', () => {
  const [victim] = db.prepare('SELECT id FROM images ORDER BY id DESC LIMIT 1').all();
  db.prepare("INSERT INTO image_notes(image_id, body, ts, created_at) VALUES (?, '孤儿测试', 0, '')").run(victim.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_notes WHERE image_id = ?').get(victim.id).n, 1);
  db.prepare('DELETE FROM images WHERE id = ?').run(victim.id);
  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS n FROM image_notes WHERE image_id = ?').get(victim.id).n),
    0,
    '素材删除后笔记必须一起清掉'
  );
});

test('拖组主离开原堆叠：原组自动换主，不散架；两个堆叠可以互相合并', async () => {
  // 造第 4 张：原堆叠至少要剩 2 张，才能验证「换主」而不是「解散」
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#8844cc' } })
    .jpeg()
    .toFile(path.join(dir, 'd.jpg'));
  await importLocalImages({ dirs: [storage] });

  const ids = db.prepare('SELECT id FROM images ORDER BY id').all().map((r) => r.id);
  assert.ok(ids.length >= 4, `需要 4 张样图，实际 ${ids.length}`);
  const [a, b, c, d] = ids;
  db.prepare('UPDATE images SET rating = 5 WHERE id = ?').run(b);
  db.prepare('UPDATE images SET rating = 0 WHERE id <> ?').run(b);

  // 原组 [a,b,c]，b 是组主
  createStack([a, b, c]);
  assert.equal(Number(db.prepare('SELECT stack_id FROM images WHERE id = ?').get(a).stack_id), b);

  // b 被拖到 d 上（新组 [d,b]），原组应剩 [a,c] 并把 a 提升为组主
  createStack([d, b]);
  const groupOf = (id) => Number(db.prepare('SELECT stack_id FROM images WHERE id = ?').get(id).stack_id);
  assert.equal(groupOf(a), a, '原组剩下的最早一张接任组主');
  assert.equal(groupOf(c), a, '原组另一张跟新组主同组');
  assert.equal(groupOf(b), b, '被拖走的组主带着新图成组');
  assert.equal(groupOf(d), b);

  // 合并：[a,c] 并入 [b,d] → 4 张一组，源组消失
  const m = mergeStacks(a, b);
  assert.equal(m.stackId, b);
  const all = attachStackInfo(db.prepare('SELECT * FROM images ORDER BY id').all().map(toDTO));
  const primaries = all.filter((x) => x.stackPrimary);
  assert.equal(primaries.length, 1, '合并后只剩一个组主');
  assert.equal(primaries[0].id, b);
  assert.equal(primaries[0].stackCount, 4, '合并后共 4 张');

  // 堆叠列表能看到这一组
  const listed = listStacks();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].stackId, b);
  assert.equal(listed[0].count, 4);

  ungroupStack(b);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM images WHERE stack_id <> 0').get().n), 0);
});
