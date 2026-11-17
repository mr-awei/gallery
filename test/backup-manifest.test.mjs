import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyBackup, writeManifest } from '../server/lib/backup-manifest.js';

/**
 * 造一个「看起来像备份」的目录。用 ASCII 名（Windows 中文路径下 node:sqlite 有句柄问题，
 * 虽然这里不碰 sqlite，也不该给未来加用例的人埋坑）。
 */
function makeBackup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-backup-'));
  fs.writeFileSync(path.join(dir, 'gallery.db'), Buffer.from('SQLite format 3\0fake'));
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ schema: 1, images: [] }));
  fs.mkdirSync(path.join(dir, 'thumbs', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'thumbs', 'ab', 'x.webp'), Buffer.from('thumb'));
  writeManifest(dir, { images: 3, folders: 1, tags: 2 });
  return dir;
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('清单写完就能通过预检，并把素材数量带出来', () => {
  const dir = makeBackup();
  try {
    const r = verifyBackup(dir);
    assert.equal(r.ok, true, r.problems.join('；'));
    assert.deepEqual(r.problems, []);
    assert.equal(r.counts.images, 3);
    assert.equal(r.manifest.thumbs.files, 1);
  } finally {
    cleanup(dir);
  }
});

test('文件被改坏 → 报校验和不符（而不是等到恢复中途才炸）', () => {
  const dir = makeBackup();
  try {
    fs.appendFileSync(path.join(dir, 'library.json'), ' ');
    const r = verifyBackup(dir);
    assert.equal(r.ok, false);
    assert.ok(
      r.problems.some((p) => /library\.json 大小不符|library\.json 校验和不符/.test(p)),
      r.problems.join('；')
    );
  } finally {
    cleanup(dir);
  }
});

test('缺文件 → 明确指出缺哪个', () => {
  const dir = makeBackup();
  try {
    fs.rmSync(path.join(dir, 'gallery.db'));
    const r = verifyBackup(dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('gallery.db')), r.problems.join('；'));
  } finally {
    cleanup(dir);
  }
});

test('删掉缩略图只警告不拦（缩略图可按需重建）', () => {
  const dir = makeBackup();
  try {
    fs.rmSync(path.join(dir, 'thumbs'), { recursive: true, force: true });
    const r = verifyBackup(dir);
    assert.equal(r.ok, true, r.problems.join('；'));
    assert.ok(r.warnings.some((w) => w.includes('缩略图')), r.warnings.join('；'));
  } finally {
    cleanup(dir);
  }
});

test('老备份没有清单：照样放行，但要提示只能靠数据库自检', () => {
  const dir = makeBackup();
  try {
    fs.rmSync(path.join(dir, 'manifest.json'));
    const r = verifyBackup(dir);
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes('manifest.json')), r.warnings.join('；'));
  } finally {
    cleanup(dir);
  }
});

test('调用方传正斜杠路径也要能通过（Windows 上 path.join 会换成反斜杠）', () => {
  const dir = makeBackup();
  try {
    const forward = dir.replace(/\\/g, '/');
    const r = verifyBackup(forward);
    assert.equal(r.ok, true, r.problems.join('；'));
  } finally {
    cleanup(dir);
  }
});

test('清单被写坏 / 路径越界 → 拒绝', () => {
  const dir = makeBackup();
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ 半截');
    assert.equal(verifyBackup(dir).ok, false);

    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ files: [{ path: '../../etc/passwd', bytes: 1, sha256: 'x' }] })
    );
    const r = verifyBackup(dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('越界')), r.problems.join('；'));
  } finally {
    cleanup(dir);
  }
});
