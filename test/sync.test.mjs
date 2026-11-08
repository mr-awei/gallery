import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_FORMAT,
  SYNC_VERSION,
  SNAPSHOT_FILES,
  sha256,
  validateManifest,
  fingerprintOf,
  hasLocalBaseline,
  syncDecision,
  canPublish,
} from '../server/lib/sync.js';

const HASH = sha256(Buffer.from('x'));
const manifest = (over = {}) => ({
  format: SYNC_FORMAT,
  version: SYNC_VERSION,
  revision: 3,
  deviceId: 'device-a',
  libraryName: '图库',
  files: SNAPSHOT_FILES.map((name) => ({ name, sha256: HASH, size: 12 })),
  ...over,
});

test('同步清单：格式 / 版本 / 文件校验和都必须合法', () => {
  assert.equal(validateManifest(manifest()).manifest.revision, 3);
  assert.equal(HASH.length, 64);
  assert.match(validateManifest({ kind: 'other' }).error, /不是图库同步文件夹/);
  assert.match(validateManifest(manifest({ version: 99 })).error, /高于当前支持/);
  assert.match(validateManifest(manifest({ revision: 0 })).error, /revision/);
  assert.match(validateManifest(manifest({ files: [] })).error, /文件列表不完整/);
  assert.match(validateManifest(manifest({ files: [{ name: 'gallery.db', sha256: 'nope' }, { name: 'library.json', sha256: HASH }] })).error, /校验和不合法/);
  assert.match(validateManifest(null).error, /为空/);
  // 两条都叫 gallery.db 时旧的循环会放行，pull 就会跳过 library.json 校验并在恢复处 500
  assert.match(
    validateManifest(manifest({
      files: [
        { name: 'gallery.db', sha256: HASH, size: 1 },
        { name: 'gallery.db', sha256: HASH, size: 1 },
      ],
    })).error,
    /重复或缺失/
  );
});

test('拉取决策：已是最新跳过、脏数据默认冲突、force 才放行', () => {
  assert.equal(syncDecision({ localRevision: 3, remoteRevision: 3, dirty: true }).action, 'up-to-date');
  assert.equal(syncDecision({ localRevision: 4, remoteRevision: 3 }).action, 'up-to-date');
  assert.equal(syncDecision({ localRevision: 2, remoteRevision: 3 }).action, 'pull');
  assert.equal(syncDecision({ localRevision: 2, remoteRevision: 3, dirty: true }).action, 'conflict');
  assert.equal(syncDecision({ localRevision: 2, remoteRevision: 3, dirty: true, force: true }).action, 'pull');
  assert.match(syncDecision({ localRevision: 0, remoteRevision: 3, dirty: true }).reason, /先发布本机改动/);
});

test('发布决策：别的设备有更新的版本且本机没拉过，禁止覆盖', () => {
  assert.equal(canPublish({ deviceId: 'b', lastPulledRevision: 0, remote: null }).ok, true);
  assert.equal(canPublish({ deviceId: 'b', lastPulledRevision: 3, remote: manifest() }).ok, true);
  const blocked = canPublish({ deviceId: 'b', lastPulledRevision: 2, remote: manifest() });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /先拉取再发布/);
  assert.equal(canPublish({ deviceId: 'device-a', lastPulledRevision: 0, remote: manifest() }).ok, true);
});

test('同步基线：只拉取过也算有基线，全新机器不报冲突', () => {
  assert.equal(hasLocalBaseline({ lastPublishedRevision: 0, lastPulledRevision: 0 }), false);
  assert.equal(hasLocalBaseline({ lastPublishedRevision: 2, lastPulledRevision: 0 }), true);
  // 回归点：以前这条恒 false，导致「拉取后本机又改了」永远不触发冲突检测
  assert.equal(hasLocalBaseline({ lastPublishedRevision: 0, lastPulledRevision: 3 }), true);
  assert.equal(hasLocalBaseline({}), false);
});

test('本机指纹：四元组变化都会被识别', () => {
  const a = fingerprintOf({ images: 12, maxImage: 12, maxOp: 4, folders: 2 });
  assert.equal(a, '12:12:4:2');
  assert.notEqual(a, fingerprintOf({ images: 12, maxImage: 12, maxOp: 5, folders: 2 }));
  assert.notEqual(a, fingerprintOf({ images: 13, maxImage: 13, maxOp: 4, folders: 2 }));
  assert.equal(fingerprintOf({}), '0:0:0:0');
});
