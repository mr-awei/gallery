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

test('导入进度：单调不回退，且不会停在 0%', async () => {
  // 老实现的进度只在「整块 400 张派生完」后推一次，并且分母用「派生完成数 / 已发现数」，
  // 被跳过的未变文件完全不计入 —— 增量扫描时会一直 0% 然后突然 99%，看着像卡死。
  const seen = [];
  await importLocalImages({ dirs: [storage], onProgress: (p) => seen.push(p) });
  assert.ok(seen.length >= 1, '至少要推一次进度，否则界面永远显示扫描中');
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `进度不能回退：${seen.join(' → ')}`);
  }
  assert.ok(seen[seen.length - 1] > 0, `未变文件也要计入进度：${seen.join(' → ')}`);
  // 100% 只在真正结束时推一次：过程中就报 100 会让人以为「卡在最后一格」
  assert.equal(seen[seen.length - 1], 100);
  for (const p of seen.slice(0, -1)) assert.ok(p <= 99, `过程中的进度不能到 100：${seen.join(' → ')}`);
});

test('按模板导入：复制进素材库、重名自动加后缀、结果与原图并存', async () => {
  const src = path.join(storage, '2801');
  fs.mkdirSync(src, { recursive: true });
  for (const [i, color] of ['#101010', '#202020'].entries()) {
    await sharp({ create: { width: 300, height: 200, channels: 3, background: color } })
      .jpeg()
      .toFile(path.join(src, `raw-${i}.jpg`));
  }
  const { saveSettings } = await import('../server/db/settings.js');
  // 模板故意不带 {index}：两张同名，只有去重逻辑对了才不会互相覆盖
  saveSettings({ importNameTemplate: '{keyword}{ext}', importNameTemplateForLocal: true });
  try {
    const r = await importLocalImages({ dirs: [src], keyword: '测试模板' });
    assert.equal(r.errors, 0, `按模板复制不应失败：${JSON.stringify(r)}`);
    assert.equal(r.saved, 2);

    const rows = db.prepare('SELECT abs_path FROM images WHERE abs_path LIKE ? ORDER BY id').all(`%2801%`);
    assert.equal(rows.length, 2, '两张都应登记为复制出来的那一份');
    const names = rows.map((x) => path.basename(x.abs_path)).sort();
    assert.deepEqual(names, ['测试模板-1.jpg', '测试模板.jpg']);
    for (const row of rows) {
      assert.ok(fs.existsSync(row.abs_path), `模板副本必须真的落盘：${row.abs_path}`);
      assert.ok(row.abs_path.startsWith(storage), '副本要落在素材库目录内');
    }
    // 原图绝不能被改名或移动
    assert.ok(fs.existsSync(path.join(src, 'raw-0.jpg')));
    assert.ok(fs.existsSync(path.join(src, 'raw-1.jpg')));
  } finally {
    saveSettings({ importNameTemplate: '', importNameTemplateForLocal: false });
  }
});
