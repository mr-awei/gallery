import test from 'node:test';
import assert from 'node:assert/strict';

// 「下次打开时安装」的记账判定：
// 记账版本比当前新 = 本次启动必须装（pending）；已经达到或超过 = 上次装成了（done）；
// 没有记账 / 记账坏了 = 正常流程（none）。判错一边的代价是「该强制的没强制」或「把人锁死」。
const { compareVersions, deferralVerdict } = await import('../electron/lib/update-policy.js');

test('compareVersions 逐段比较数字', () => {
  assert.equal(compareVersions('1.2.12', '1.2.11'), 1);
  assert.equal(compareVersions('1.2.11', '1.2.12'), -1);
  assert.equal(compareVersions('1.2.12', '1.2.12'), 0);
  // 段数不同时短的一侧按 0 补齐：1.3 比 1.2.9 新
  assert.equal(compareVersions('1.3', '1.2.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  // 带 v 前缀与预发布后缀也能比（不追求 semver 语义，只求「谁更新」不错）
  assert.equal(compareVersions('v2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.2.12-beta.1', '1.2.11'), 1);
});

test('deferralVerdict：记账比当前新 = 本次必须先装', () => {
  assert.equal(deferralVerdict('1.2.13', '1.2.12'), 'pending');
});

test('deferralVerdict：已经升到记账版本 = 上次装成了，清账', () => {
  assert.equal(deferralVerdict('1.2.13', '1.2.13'), 'done');
  // 用户手动装了更高版本也算装成
  assert.equal(deferralVerdict('1.2.13', '1.2.14'), 'done');
});

test('deferralVerdict：没有记账或记账损坏 = 正常流程', () => {
  assert.equal(deferralVerdict('', '1.2.12'), 'none');
  assert.equal(deferralVerdict('   ', '1.2.12'), 'none');
  assert.equal(deferralVerdict(null, '1.2.12'), 'none');
  // 脏数据（没有数字）不能当成 pending，否则永久锁死
  assert.equal(deferralVerdict('latest', '1.2.12'), 'none');
});
