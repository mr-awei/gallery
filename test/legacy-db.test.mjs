import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';

// 升级自旧版时最惨的一种情况：素材目录里还躺着单库时代的 gallery.db，
// 新版本却读不到它 —— 用户看到「一张图都没有」。这里守住自动识别 + 合并。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-legacy-'));
const storage = path.join(tmp, 'storage');
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = storage;

const { db } = await import('../server/db.js');
const { autoMergeLegacy, inspectLegacyDb, findLegacyDb } = await import('../server/lib/legacy-db.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄未释放 */
  }
});

const photos = path.join(storage, '2601');
fs.mkdirSync(photos, { recursive: true });
const files = [];
for (const [i, color] of ['#111111', '#eeeeee'].entries()) {
  const p = path.join(photos, `legacy-${i}.jpg`);
  await sharp({ create: { width: 640, height: 480, channels: 3, background: color } }).jpeg().toFile(p);
  files.push(p);
}

/** 造一个「旧版单库」：只有 images / folders 两张核心表 */
function writeLegacyDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec(`
    CREATE TABLE images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, abs_path TEXT, thumb TEXT, source TEXT, keyword TEXT,
      width INTEGER DEFAULT 0, height INTEGER DEFAULT 0, size_bytes INTEGER DEFAULT 0,
      mime TEXT DEFAULT '', phash TEXT DEFAULT '', favorite INTEGER DEFAULT 0, tags TEXT DEFAULT '',
      created_at TEXT DEFAULT '', fs_mtime INTEGER DEFAULT 0
    );
    CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at TEXT DEFAULT '');
  `);
  const ins = conn.prepare(
    'INSERT INTO images(title, abs_path, thumb, width, height, size_bytes, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const [i, r] of rows.entries()) {
    ins.run(`旧图 ${i}`, r, '', 640, 480, 1234, '旧库标签', new Date().toISOString());
  }
  conn.prepare("INSERT INTO folders(name) VALUES ('2508李')").run();
  conn.close();
}

test('findLegacyDb / inspectLegacyDb：只认本素材目录下的旧库', () => {
  const legacy = path.join(storage, 'gallery.db');
  writeLegacyDb(legacy, files);
  assert.equal(findLegacyDb(storage), legacy);
  const info = inspectLegacyDb(legacy, storage);
  assert.ok(info, '应当被识别为旧图库');
  assert.equal(info.total, 2);

  // 路径根本不在这个素材目录下 → 不能当成自家数据吞掉
  const foreign = path.join(tmp, 'foreign', 'gallery.db');
  writeLegacyDb(foreign, ['D:/别处的图/a.jpg', 'D:/别处的图/b.jpg']);
  assert.equal(inspectLegacyDb(foreign, storage), null);
});

test('autoMergeLegacy：空库自动合并旧库，并按 abs_path 去重', () => {
  const r = autoMergeLegacy(storage, { backupParent: tmp });
  assert.ok(r?.ok, `合并应成功：${JSON.stringify(r)}`);
  assert.equal(r.images, 2);
  assert.ok(fs.existsSync(r.backup), '合并前必须先留一份旧库备份');

  const rows = db.prepare('SELECT abs_path, tags FROM images ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.abs_path).sort(), [...files].sort());
  // 标签要跟着过来（item_tags 由触发器派生）
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM item_tags WHERE tag = '旧库标签'").get().c), 2);

  // 旧库文件本身不能被搬走或删除
  assert.ok(fs.existsSync(path.join(storage, 'gallery.db')));
});

test('autoMergeLegacy：库里有数据时不再自动合并（避免混出重复记录）', () => {
  assert.equal(autoMergeLegacy(storage, { backupParent: tmp }), null);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM images').get().c), 2);
});
