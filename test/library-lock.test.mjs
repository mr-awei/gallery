import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 守住资源库密码锁的语义：每个库各自一把、设密码的人当场不被关在门外、
// 切库（resetLibraryLock）后回到锁定态、原密码不对就不能改/不能删、库里只存 scrypt 哈希。
// 注意库目录要用 ASCII 名（中文路径下 node:sqlite 句柄删不掉，见项目记忆）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-liblock-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = path.join(tmp, 'storage');

const { globalDb } = await import('../server/db.js');
const {
  libraryLockState,
  setLibraryPassword,
  verifyLibraryPassword,
  unlockLibrary,
  sealLibrary,
  clearLibraryPassword,
  resetLibraryLock,
  markLibraryUnlocked,
} = await import('../server/lib/library-lock.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

const libDir = path.join(tmp, 'lib-a');
fs.mkdirSync(libDir, { recursive: true });
const libId = Number(
  globalDb
    .prepare('INSERT INTO libraries (name, path, root_path, thumb_dir, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('锁测试库', libDir, libDir, path.join(libDir, 'thumbs'), new Date().toISOString()).lastInsertRowid
);

test('资源库密码锁：默认无密码、不锁', () => {
  const s = libraryLockState(libId);
  assert.equal(s.exists, true);
  assert.equal(s.hasPassword, false);
  assert.equal(s.locked, false);
  // 不存在的库不能炸
  assert.equal(libraryLockState(999999).exists, false);
});

test('资源库密码锁：少于 4 位拒绝', () => {
  assert.throws(() => setLibraryPassword(libId, '123'), /至少 4 位/);
  assert.equal(libraryLockState(libId).hasPassword, false);
});

test('资源库密码锁：设完当场解锁，手动上锁后回到锁定态', () => {
  setLibraryPassword(libId, 'abcd-1234');
  const afterSet = libraryLockState(libId);
  assert.equal(afterSet.hasPassword, true);
  // 设密码的人不该立刻被自己关在门外
  assert.equal(afterSet.locked, false);

  sealLibrary(libId);
  assert.equal(libraryLockState(libId).locked, true);

  assert.equal(verifyLibraryPassword(libId, 'abcd-1234'), true);
  assert.equal(verifyLibraryPassword(libId, 'abcd-12345'), false);
});

test('资源库密码锁：解锁要密码，错密码不解', () => {
  sealLibrary(libId);
  assert.throws(() => unlockLibrary(libId, 'wrong'), /密码不正确/);
  assert.equal(libraryLockState(libId).locked, true);

  unlockLibrary(libId, 'abcd-1234');
  assert.equal(libraryLockState(libId).locked, false);
});

test('资源库密码锁：切库后重新锁上（解锁态是按库记的，不能跟着走）', () => {
  unlockLibrary(libId, 'abcd-1234');
  assert.equal(libraryLockState(libId).locked, false);

  resetLibraryLock();
  assert.equal(libraryLockState(libId).locked, true);

  // 切库路由验完密码会 mark 一次，模拟它
  markLibraryUnlocked(libId);
  assert.equal(libraryLockState(libId).locked, false);
});

test('资源库密码锁：改密码必须给原密码', () => {
  assert.throws(() => setLibraryPassword(libId, 'new-pass-1'), /原密码不正确/);
  assert.throws(() => setLibraryPassword(libId, 'new-pass-1', 'bad-old'), /原密码不正确/);
  assert.equal(verifyLibraryPassword(libId, 'abcd-1234'), true);

  setLibraryPassword(libId, 'new-pass-1', 'abcd-1234');
  assert.equal(verifyLibraryPassword(libId, 'new-pass-1'), true);
  assert.equal(verifyLibraryPassword(libId, 'abcd-1234'), false);
});

test('资源库密码锁：删密码必须给原密码，删完不再拦', () => {
  assert.throws(() => clearLibraryPassword(libId, 'bad'), /密码不正确/);
  assert.equal(libraryLockState(libId).hasPassword, true);

  clearLibraryPassword(libId, 'new-pass-1');
  const s = libraryLockState(libId);
  assert.equal(s.hasPassword, false);
  assert.equal(s.locked, false);
});

test('资源库密码锁：库里只存 scrypt 哈希，不存明文', () => {
  setLibraryPassword(libId, 'plaintext-pw');
  const row = globalDb.prepare('SELECT lock_hash, lock_salt FROM libraries WHERE id = ?').get(libId);
  assert.equal(row.lock_hash.includes('plaintext-pw'), false);
  assert.equal(row.lock_hash.length, 128); // sha512 级 64 字节 hex
  assert.equal(row.lock_salt.length, 32); // 16 字节盐的 hex

  // 同一个密码再设一次，盐必须换（否则两张表拖库能看出是不是同一个密码）
  const salt1 = row.lock_salt;
  clearLibraryPassword(libId, 'plaintext-pw');
  setLibraryPassword(libId, 'plaintext-pw');
  const salt2 = globalDb.prepare('SELECT lock_salt FROM libraries WHERE id = ?').get(libId).lock_salt;
  assert.notEqual(salt1, salt2);
});
