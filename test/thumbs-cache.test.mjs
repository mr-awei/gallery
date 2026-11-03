import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config 在 import 时读环境变量，所以必须先设好再去动态 import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemvault-thumbcache-'));
process.env.GEM_USER_DATA = tmp;
process.env.GEM_DATA_DIR = path.join(tmp, 'data');
process.env.GEM_DEFAULT_STORAGE_DIR = path.join(tmp, 'storage');

const { isCacheFresh, existingThumbPath, existingPreviewPath, thumbPathFor, legacyThumbPath, mtimeOf } = await import(
  '../server/thumbs.js'
);

// sqlite 句柄要等进程退出才放，Windows 上 rm 会 EPERM；清不掉就留给系统临时目录
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 忽略：句柄未释放 */
  }
});

const OLD = new Date('2020-01-01T00:00:00Z');
const NEW = new Date('2026-01-01T00:00:00Z');

function write(p, size = 32, mtime = NEW) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 7));
  fs.utimesSync(p, mtime, mtime);
}

test('isCacheFresh：早于源文件的缓存一律不算命中', () => {
  const p = path.join(tmp, 'a.jpg');
  write(p, 32, OLD);
  assert.equal(isCacheFresh(p, NEW.getTime()), false, '旧文件不能当新缓存用');
  assert.equal(isCacheFresh(p, OLD.getTime()), true);
  // 不传时间基准时退化为「存在即有效」（只想看有没有的调用方）
  assert.equal(isCacheFresh(p), true);
});

test('isCacheFresh：空文件 / 不存在都不算命中', () => {
  const empty = path.join(tmp, 'empty.jpg');
  write(empty, 0);
  assert.equal(isCacheFresh(empty, 0), false);
  assert.equal(isCacheFresh(path.join(tmp, 'nope.jpg'), 0), false);
  assert.equal(isCacheFresh(''), false);
});

test('existingThumbPath：旧 id 残留的缩略图不会被认领', () => {
  const id = 4242;
  const stale = thumbPathFor(id);
  write(stale, 32, OLD); // 上一辈子同一个 id 留下的缩略图
  const srcMtime = NEW.getTime(); // 新图是刚写进来的
  assert.equal(existingThumbPath(id, srcMtime), '', '必须视为缺图，让调用方重新生成');

  write(stale, 32, NEW);
  assert.equal(existingThumbPath(id, srcMtime), stale, '新鲜的缓存照常命中');
});

test('existingThumbPath：旧平铺目录仍然兼容，但同样要比 mtime', () => {
  const id = 5151;
  const legacy = legacyThumbPath(id);
  write(legacy, 32, OLD);
  assert.equal(existingThumbPath(id, NEW.getTime()), '');
  write(legacy, 32, NEW);
  assert.equal(existingThumbPath(id, NEW.getTime()), legacy);
});

test('existingThumbPath：桶内优先于旧平铺', () => {
  const id = 6060;
  const bucketed = thumbPathFor(id);
  const legacy = legacyThumbPath(id);
  write(legacy, 32, NEW);
  write(bucketed, 32, NEW);
  assert.equal(existingThumbPath(id, NEW.getTime()), bucketed);
});

test('existingPreviewPath：灯箱预览图同样按 mtime 判定', () => {
  const id = 7171;
  const pv = path.join(path.dirname(thumbPathFor(id)), `${id}-pv.jpg`);
  write(pv, 64, OLD);
  assert.equal(existingPreviewPath(id, NEW.getTime()), '');
  write(pv, 64, NEW);
  assert.equal(existingPreviewPath(id, NEW.getTime()), pv);
  assert.equal(existingPreviewPath(id), pv);
});

test('mtimeOf：取不到返回 0', () => {
  assert.equal(mtimeOf(path.join(tmp, 'missing.jpg')), 0);
  assert.ok(mtimeOf(thumbPathFor(4242)) > 0);
});
