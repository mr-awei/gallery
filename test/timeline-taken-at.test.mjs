import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { resolveTakenAt, exifStamp, fileStamp, mtimeStamp, monthOf } = await import(
  '../server/lib/taken-at.js'
);
const { repairTakenAt, countPending } = await import('../server/lib/timeline-repair.js');

/* ── 口径：照片自己的时间，绝不用入库时间 ───────────────────────── */

test('EXIF 拍摄时间优先于文件时间', () => {
  const mtime = Math.floor(new Date(2026, 10, 2, 14, 33, 5).getTime() / 1000);
  assert.equal(
    resolveTakenAt({ exifTakenAt: '2019:05:01 08:00:00', fsMtime: mtime, fsBirthtime: mtime }),
    '2019-05-01T08:00:00'
  );
});

test('EXIF 脏值（相机重置的 2000 年）不吞掉真实文件时间', () => {
  const mtime = Math.floor(new Date(2019, 4, 1, 8, 0, 0).getTime() / 1000);
  assert.equal(exifStamp('1900:01:01 00:00:00'), '');
  assert.equal(resolveTakenAt({ exifTakenAt: '1900:01:01 00:00:00', fsMtime: mtime }), '2019-05-01T08:00:00');
});

test('没有 EXIF 时用文件修改 / 创建时间里较早的那个', () => {
  const birth = Math.floor(new Date(2019, 4, 1, 8, 0, 0).getTime() / 1000);
  const mtime = Math.floor(new Date(2026, 0, 5, 9, 0, 0).getTime() / 1000);
  // 改过原图：mtime 变新，创建时间仍是拍照那天
  assert.equal(fileStamp({ fsMtime: mtime, fsBirthtime: birth }), '2019-05-01T08:00:00');
  // 复制来的图：mtime 被保留、创建时间被重置成复制时刻
  assert.equal(fileStamp({ fsMtime: birth, fsBirthtime: mtime }), '2019-05-01T08:00:00');
  // 只有一边有值也能用
  assert.equal(fileStamp({ fsMtime: 0, fsBirthtime: birth }), '2019-05-01T08:00:00');
});

test('取不到任何时间就返回空串 —— 不再拿「现在」冒充拍摄时间', () => {
  assert.equal(resolveTakenAt({}), '');
  assert.equal(resolveTakenAt({ exifTakenAt: '', fsMtime: 0, fsBirthtime: 0 }), '');
});

test('时间串能直接切年月', () => {
  assert.equal(monthOf('2026-11-10T09:00:00'), '2026-11');
  assert.equal(monthOf(''), '');
});

/* ── 老库修复：入库时间兜底的行改回文件时间 ─────────────────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-timeline-'));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄未释放 */
  }
});

/** 造一个只有 images 的最小库；行数据按「老版本写完是什么样」给 */
function makeDb(rows) {
  const file = path.join(tmp, `lib-${Math.random().toString(36).slice(2)}.db`);
  const conn = new DatabaseSync(file);
  conn.exec(`
    CREATE TABLE images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      abs_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      taken_at TEXT NOT NULL DEFAULT '',
      fs_mtime INTEGER NOT NULL DEFAULT 0
    );
  `);
  const ins = conn.prepare('INSERT INTO images (abs_path, created_at, taken_at, fs_mtime) VALUES (?,?,?,?)');
  for (const r of rows) ins.run(r.abs_path, r.created_at, r.taken_at, r.fs_mtime ?? 0);
  return conn;
}

const importedAt = '2026-11-10T02:00:00.000Z'; // 入库（UTC）
/**
 * 旧兜底逻辑写的是「本地时钟」串：让 SQLite 自己算出来，测试里绝不假设运行时时区。
 * CI 跑在 UTC（此时本地串 == UTC 串），开发机在 UTC+8（差 8 小时）—— 两种都要能认出来。
 */
function localImportStamp(conn) {
  return conn.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%S', ?, 'localtime') AS s").get(importedAt).s;
}
const photoMtime = Math.floor(new Date(2019, 4, 1, 8, 0, 0).getTime() / 1000);
const photoStamp = mtimeStamp(photoMtime); // 本地串

test('修复：UTC 口径的入库时间 → 文件修改时间', () => {
  const conn = makeDb([
    { abs_path: 'a.jpg', created_at: importedAt, taken_at: '2026-11-10T02:00:00', fs_mtime: photoMtime },
  ]);
  const r = repairTakenAt(conn);
  assert.equal(r.fixed, 1);
  assert.equal(conn.prepare('SELECT taken_at FROM images').get().taken_at, photoStamp);
  assert.equal(countPending(conn), 0);
  conn.close();
});

test('修复：本地口径的入库时间（旧兜底逻辑写的是本地时钟）也要认出来', () => {
  const conn = makeDb([{ abs_path: 'b.jpg', created_at: importedAt, taken_at: '', fs_mtime: photoMtime }]);
  conn.prepare('UPDATE images SET taken_at = ?').run(localImportStamp(conn));
  repairTakenAt(conn);
  assert.equal(conn.prepare('SELECT taken_at FROM images').get().taken_at, photoStamp);
  conn.close();
});

test('修复：真实的 EXIF 时间不动', () => {
  const conn = makeDb([
    { abs_path: 'c.jpg', created_at: importedAt, taken_at: '2018-03-02T19:20:00', fs_mtime: photoMtime },
  ]);
  const r = repairTakenAt(conn);
  assert.equal(r.fixed + r.cleared, 0);
  assert.equal(conn.prepare('SELECT taken_at FROM images').get().taken_at, '2018-03-02T19:20:00');
  assert.equal(countPending(conn), 0);
  conn.close();
});

test('修复：连文件指纹都没有的行退回「未排入」，不再写入库时间', () => {
  const conn = makeDb([
    { abs_path: 'd.jpg', created_at: importedAt, taken_at: '', fs_mtime: 0 },
    { abs_path: 'e.jpg', created_at: importedAt, taken_at: '', fs_mtime: 0 },
  ]);
  // d.jpg 是「入库时间兜底」的行，e.jpg 本来就是空的 —— 两种都该留在待校正里
  conn.prepare("UPDATE images SET taken_at = ? WHERE abs_path = 'd.jpg'").run(localImportStamp(conn));
  const r = repairTakenAt(conn);
  assert.equal(r.cleared, 1);
  const rows = conn.prepare('SELECT taken_at FROM images ORDER BY id').all();
  assert.deepEqual(rows.map((x) => x.taken_at), ['', '']);
  // 这两张要算进「待校正」，否则用户永远看不到重建入口
  assert.equal(countPending(conn), 2);
  conn.close();
});

test('修复可重复执行（幂等）', () => {
  const conn = makeDb([
    { abs_path: 'f.jpg', created_at: importedAt, taken_at: '2026-11-10T02:00:00', fs_mtime: photoMtime },
  ]);
  repairTakenAt(conn);
  const before = conn.prepare('SELECT taken_at FROM images').get().taken_at;
  const second = repairTakenAt(conn);
  assert.equal(second.fixed + second.cleared, 0);
  assert.equal(conn.prepare('SELECT taken_at FROM images').get().taken_at, before);
  conn.close();
});

test('库结构不全时安静跳过，不抛异常', () => {
  const conn = new DatabaseSync(path.join(tmp, 'empty.db'));
  assert.deepEqual(repairTakenAt(conn), { fixed: 0, cleared: 0 });
  assert.equal(countPending(conn), 0);
  conn.close();
});
