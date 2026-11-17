import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// 守住「回收站恢复不能丢列」：以前恢复只 INSERT 回收站表那 15 个字段，
// media_kind 回落到默认 image（视频恢复成图片）、fs_mtime=0（?v=0 缓存永不刷新）、
// rating / note / score 直接丢。这条测试把整行改成一个「视频」再删→恢复来锁住行为。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-trash-'));
const storage = path.join(tmp, 'storage');
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = storage;
process.env.TUKU_THUMB_WIDTH = '320';

const { importLocalImages } = await import('../server/importer.js');
const { db } = await import('../server/db.js');
const { removeImage, restoreFromTrash } = await import('../server/lib/trash.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

const dir = path.join(storage, '2601');
fs.mkdirSync(dir, { recursive: true });
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3366ff' } })
  .jpeg()
  .toFile(path.join(dir, 'clip.jpg'));

test('回收站恢复保住全部列：媒体类型/时长/评分/备注/指纹 都不丢', async () => {
  const r = await importLocalImages({ dirs: [storage] });
  assert.equal(r.errors, 0, `导入不应报错：${JSON.stringify(r)}`);
  assert.equal(r.saved, 1, JSON.stringify(r));

  const [row] = db.prepare('SELECT * FROM images').all();
  db.prepare(
    `UPDATE images SET media_kind = 'video', duration = 12.5, cover_ts = 3, rating = 5,
       note = '客户A', score = 42, score_reason = '测试', md5 = 'abc' WHERE id = ?`
  ).run(row.id);

  const removed = await removeImage(row.id, { reason: '测试' });
  assert.equal(removed.ok, true, `删除应成功：${JSON.stringify(removed)}`);

  const t = db.prepare('SELECT * FROM trash ORDER BY id DESC LIMIT 1').get();
  assert.ok(t, '回收站应有记录');
  assert.ok(t.snapshot, '删除时必须写入整行快照，否则恢复只能拿到回收站表的 15 个字段');

  const restored = await restoreFromTrash(t.id);
  const after = db.prepare('SELECT * FROM images WHERE id = ?').get(restored.id);
  assert.equal(after.media_kind, 'video', '视频恢复后不能变回 image');
  assert.equal(Number(after.duration), 12.5);
  assert.equal(Number(after.cover_ts), 3);
  assert.equal(Number(after.rating), 5);
  assert.equal(after.note, '客户A');
  assert.equal(Number(after.score), 42);
  assert.equal(after.md5, 'abc');
  assert.ok(Number(after.fs_mtime) > 0, 'fs_mtime 必须按恢复后的文件重算，否则 ?v=0 缓存永不刷新');
});
