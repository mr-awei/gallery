import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 复核「markViewed 乱序」：服务端时间是权威，但快速切图 / 批量标记交错时，
// 旧请求不能把已更新的 viewed_at 覆盖回更早的时间；view_count 仍要照实累加。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-viewed-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_CLIP = 'off';

const { db } = await import('../server/db.js');
const { markViewed } = await import('../server/library.js');
const { markAllViewed } = await import('../server/lib/query.js');

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

const ins = db.prepare(
  "INSERT INTO images(abs_path, created_at, viewed_at, view_count) VALUES (?, ?, '', 0)"
);
for (let i = 1; i <= 3; i++) ins.run(path.join(tmp, `v-${i}.jpg`), new Date().toISOString());
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

const viewedAt = (id) => db.prepare('SELECT viewed_at, view_count FROM images WHERE id = ?').get(id);

test('单张标记：未来时间不被更早的请求覆盖，计数照常累加', () => {
  db.prepare('UPDATE images SET viewed_at = ? WHERE id = 1').run(FUTURE);
  markViewed(1);
  assert.equal(viewedAt(1).viewed_at, FUTURE);
  assert.equal(viewedAt(1).view_count, 1);
});

test('批量标记：与单张交错也不会倒退', () => {
  markAllViewed([1, 1]);
  const row = viewedAt(1);
  assert.equal(row.viewed_at, FUTURE);
  assert.equal(row.view_count, 3);
});

test('过去时间会被推进到当前，且不会写入非法值', () => {
  db.prepare("UPDATE images SET viewed_at = '2020-01-01T00:00:00.000Z' WHERE id = 2").run();
  markViewed(2);
  const row = viewedAt(2);
  assert.ok(row.viewed_at > '2020-01-01T00:00:00.000Z');
  assert.equal(row.view_count, 1);
  assert.ok(!Number.isNaN(Date.parse(row.viewed_at)));
});
