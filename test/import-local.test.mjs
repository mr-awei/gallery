import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// 端到端守住「目录扫描」这条主链路：
// 之前 bulk-import 里调了一个从未导入的 mapLimit，任何扫描都在第一个分片就抛
// ReferenceError，新库永远 0 张 —— 界面看着像「图片全丢了」，而单测全绿。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-import-'));
const storage = path.join(tmp, 'storage');
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = storage;
process.env.TUKU_THUMB_WIDTH = '320';

const { importLocalImages } = await import('../server/importer.js');
const { db } = await import('../server/db.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

const dir = path.join(storage, '2601');
fs.mkdirSync(dir, { recursive: true });

for (const [i, color] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
  await sharp({ create: { width: 800, height: 600, channels: 3, background: color } })
    .jpeg()
    .toFile(path.join(dir, `shot-${i}.jpg`));
}

test('本地目录导入：全部入库、写回 thumb、缩略图真的落盘', async () => {
  const r = await importLocalImages({ dirs: [storage] });
  assert.equal(r.errors, 0, `扫描不应报错：${JSON.stringify(r)}`);
  assert.equal(r.total, 3);
  assert.equal(r.saved, 3);

  const rows = db.prepare('SELECT id, thumb, width, height, fs_mtime FROM images ORDER BY id').all();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row.thumb, `#${row.id} 必须写回 thumb`);
    assert.ok(fs.existsSync(row.thumb), `#${row.id} 缩略图文件必须存在：${row.thumb}`);
    assert.equal(row.width, 800);
    assert.equal(row.height, 600);
    assert.ok(row.fs_mtime > 0, 'fs_mtime 是前端 URL 版本号的来源');
  }
});

test('已登记但缺缩略图的行：再扫一次会补出来（旧库合并后的典型状态）', async () => {
  const [row] = db.prepare('SELECT id, thumb FROM images ORDER BY id LIMIT 1').all();
  fs.rmSync(row.thumb, { force: true });
  db.prepare("UPDATE images SET thumb = '' WHERE id = ?").run(row.id);

  const r = await importLocalImages({ dirs: [storage] });
  assert.equal(r.cancelled, 0);
  const after = db.prepare('SELECT thumb FROM images WHERE id = ?').get(row.id);
  assert.ok(after.thumb && fs.existsSync(after.thumb), '扫描要把缺失的缩略图补齐并写回');
});

test('重复扫描不产生重复记录', async () => {
  const r = await importLocalImages({ dirs: [storage] });
  assert.equal(r.saved, 0);
  assert.equal(r.unchanged, 3);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM images').get().c), 3);
});
