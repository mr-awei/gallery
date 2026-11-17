import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// 守住「补缩略图不能被一批坏图堵死」：
// 旧实现每轮 SQL 都取 `ORDER BY id DESC LIMIT 120` 再在内存里 filter(attempted)。
// 一批「记录在、文件不在」的行补不出来、thumb 仍为空，会永久占住最新的 120 个窗口，
// 下一轮过滤后为空直接 break —— 后面的好图永远补不到，任务还报 done。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-thumbrebuild-'));
const storage = path.join(tmp, 'storage');
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = storage;
process.env.TUKU_THUMB_WIDTH = '320';

const { importLocalImages } = await import('../server/importer.js');
const { db } = await import('../server/db.js');
const { startThumbRebuild, thumbRebuildStatus } = await import('../server/lib/thumb-rebuild.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

const dir = path.join(storage, '2601');
fs.mkdirSync(dir, { recursive: true });
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#22aa66' } })
  .jpeg()
  .toFile(path.join(dir, 'good.jpg'));

test('补缩略图：坏行之后的图也要被补到（游标必须往前推）', async () => {
  const r = await importLocalImages({ dirs: [storage] });
  assert.equal(r.errors, 0, `导入不应报错：${JSON.stringify(r)}`);

  const [good] = db.prepare('SELECT id, thumb FROM images').all();
  fs.rmSync(good.thumb, { force: true });
  db.prepare("UPDATE images SET thumb = '' WHERE id = ?").run(good.id);

  // 130 条「记录在、文件不在」的坏行，id 全部大于好图：旧实现会一直卡在它们身上
  const ins = db.prepare(
    `INSERT INTO images(title, abs_path, thumb, source, keyword, mime, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < 130; i++) {
    ins.run(
      `bad-${i}.jpg`,
      path.join(storage, `missing-${i}.jpg`),
      '',
      'local',
      'test',
      'image/jpeg',
      new Date().toISOString()
    );
  }

  const started = startThumbRebuild({});
  assert.equal(started.started, true, `补图任务应能启动：${JSON.stringify(started)}`);
  assert.ok(started.total >= 131, `缺失数应覆盖好图与坏行：${started.total}`);

  const deadline = Date.now() + 30000;
  while (thumbRebuildStatus().running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(thumbRebuildStatus().running, false, '补图任务应在超时前结束');

  const after = db.prepare('SELECT thumb FROM images WHERE id = ?').get(good.id);
  assert.ok(after.thumb && fs.existsSync(after.thumb), '坏行之后的图也必须被补到（旧实现会在这里失败）');
});
