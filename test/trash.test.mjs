import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 复核回收站彻底删除的「失败可见」行为（对应 /api/trash/:id 与 /api/trash/empty）：
 * 以前 rm 失败被 .catch(() => {}) 吞掉，记录还被整表 DELETE，文件永远卡在 trash 目录、
 * 界面上也再没有入口去清它。现在 deleteTrashItem 删不掉返回 {ok:false}，emptyTrash
 * 把删不掉的单独列进 failed 并保留记录。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-trash-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_CLIP = 'off';

const { db } = await import('../server/db.js');
const trash = await import('../server/lib/trash.js');

test.after(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄偶发占用 */
  }
});

const now = new Date().toISOString();
const insertTrash = (title, trashPath) =>
  Number(
    db
      .prepare('INSERT INTO trash (title, origin_path, trash_path, deleted_at) VALUES (?, ?, ?, ?)')
      .run(title, trashPath, trashPath, now).lastInsertRowid
  );
const countTrash = (id) => Number(db.prepare('SELECT COUNT(*) AS c FROM trash WHERE id = ?').get(id)?.c) || 0;

test('deleteTrashItem：记录不存在返回 ok:false 且不抛错', async () => {
  const r = await trash.deleteTrashItem(999999);
  assert.equal(r.ok, false, '缺失记录应报失败而不是返回 true');
  assert.ok(r.error, '应带失败原因');
});

test('deleteTrashItem：文件删不掉时返回 ok:false 且记录保留', async () => {
  // 用目录当 trash_path：fsp.rm 不带 recursive 会失败，模拟「被其它程序占用 / 权限不足」
  const dir = fs.mkdtempSync(path.join(tmp, 'noclear-'));
  const id = insertTrash('x', dir);
  const r = await trash.deleteTrashItem(id);
  assert.equal(r.ok, false, '删不掉应报失败');
  assert.equal(countTrash(id), 1, '记录应保留以便重试');
});

test('emptyTrash：返回 {removed,failed} 且删不掉的进入 failed 并保留', async () => {
  db.prepare('DELETE FROM trash').run(); // 隔离：清掉上个测试留下的失败记录
  const file = path.join(tmp, 'delme.txt');
  fs.writeFileSync(file, 'hi');
  const dir = fs.mkdtempSync(path.join(tmp, 'noclear2-'));
  const okId = insertTrash('f', file);
  const badId = insertTrash('d', dir);
  const r = await trash.emptyTrash();
  assert.equal(r.removed, 1, '能删的应计入 removed');
  assert.equal(r.failed.length, 1, '删不掉的应计入 failed');
  assert.equal(r.failed[0].id, badId, 'failed 里应是那个删不掉的');
  assert.equal(countTrash(badId), 1, '失败记录应保留');
  assert.equal(countTrash(okId), 0, '成功记录应被删除');
});
