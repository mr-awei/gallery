import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 守住「写路径只能用 withTransaction（SAVEPOINT）」：
// 裸 db.exec('BEGIN') 一旦被外层事务包住就会抛
// "cannot start a transaction within a transaction"；更糟的是内层 ROLLBACK
// 会把外层已写入的内容一起回滚 —— 整批写入静默丢失。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-tx-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = path.join(tmp, 'storage');

const { db, withTransaction } = await import('../server/db.js');
const { markAllViewed } = await import('../server/lib/query.js');
const { applySmartFolderTags } = await import('../server/lib/smartfolders.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

const now = new Date().toISOString();
const insert = db.prepare('INSERT INTO images(title, abs_path, created_at) VALUES (?, ?, ?)');
insert.run('a.jpg', path.join(tmp, 'a.jpg'), now);
insert.run('b.jpg', path.join(tmp, 'b.jpg'), now);
const ids = db.prepare('SELECT id FROM images ORDER BY id').all().map((r) => r.id);

test('markAllViewed 可以在 withTransaction 内嵌套调用，且外层回滚会带走它', () => {
  assert.ok(ids.length >= 2);
  // 旧实现（裸 BEGIN）在这里会抛 cannot start a transaction within a transaction
  assert.throws(
    () =>
      withTransaction(() => {
        markAllViewed(ids);
        throw new Error('外层主动回滚');
      }),
    /外层主动回滚/
  );
  const rows = db.prepare('SELECT view_count FROM images ORDER BY id').all();
  for (const r of rows) assert.equal(Number(r.view_count), 0, '外层回滚后内层写入必须一起撤销');
});

test('markAllViewed 单独调用照常提交', () => {
  const n = markAllViewed(ids);
  assert.equal(n, ids.length);
  const rows = db.prepare('SELECT view_count FROM images ORDER BY id').all();
  for (const r of rows) assert.equal(Number(r.view_count), 1);
});

test('applySmartFolderTags 同样可在事务内嵌套，且不吞掉外层异常', () => {
  const f = db
    .prepare('INSERT INTO smart_folders(name, rules, auto_tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('测试夹', '{}', '红,蓝', now, now);
  const fid = Number(f.lastInsertRowid);
  assert.throws(
    () =>
      withTransaction(() => {
        applySmartFolderTags(fid);
        throw new Error('外层回滚');
      }),
    /外层回滚/
  );
  const tags = db.prepare('SELECT tags FROM images ORDER BY id').all();
  for (const r of tags) assert.equal(r.tags, '', '回滚后标签不应留下');
});
