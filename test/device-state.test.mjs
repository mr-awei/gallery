import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEVICE_STATE_FILE,
  appVersion,
  clearDeviceState,
  crashText,
  gpuForcedOff,
  isNativeCrashCode,
  readDeviceState,
  statePath,
  writeDeviceState,
} from '../server/lib/device-state.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-devstate-'));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄偶发占用 */
  }
});

test('原生崩溃码识别：Windows 上有符号/无符号两种写法', () => {
  assert.equal(isNativeCrashCode(3221225477), true); // 0xC0000005
  assert.equal(isNativeCrashCode(-1073741819), true); // 同一个码的有符号形式
  assert.equal(isNativeCrashCode(0xc00000fd), true);
  assert.equal(isNativeCrashCode(1), false);
  assert.equal(isNativeCrashCode(0), false);
  assert.equal(isNativeCrashCode(null), false);
  assert.equal(isNativeCrashCode('3221225477'), false);
});

test('崩溃码转文本带人话提示', () => {
  assert.match(crashText(3221225477), /0xC0000005/);
  assert.match(crashText(3221225477), /内存访问违例/);
  // 不在表里的码只给十六进制，不要瞎猜原因
  assert.match(crashText(0xc0000999), /0xC0000999/);
});

test('TUKU_FORCE_CPU 只认明确的真值', () => {
  assert.equal(gpuForcedOff({ TUKU_FORCE_CPU: '1' }), true);
  assert.equal(gpuForcedOff({ TUKU_FORCE_CPU: 'on' }), true);
  assert.equal(gpuForcedOff({ TUKU_FORCE_CPU: '  true ' }), true);
  assert.equal(gpuForcedOff({ TUKU_FORCE_CPU: '0' }), false);
  assert.equal(gpuForcedOff({}), false);
});

test('结论落盘、读回、可清除', () => {
  assert.equal(readDeviceState(tmp), null);
  const file = statePath(tmp);
  assert.equal(file, path.join(tmp, 'data', 'ai', DEVICE_STATE_FILE));

  writeDeviceState(tmp, { gpuDisabled: true, reason: '0xC0000005', code: 3221225477 });
  const st = readDeviceState(tmp);
  assert.equal(st.gpuDisabled, true);
  assert.equal(st.reason, '0xC0000005');
  assert.equal(st.code, 3221225477);

  // 合并写入：不清掉已有字段
  writeDeviceState(tmp, { version: '1.2.18' });
  const merged = readDeviceState(tmp);
  assert.equal(merged.gpuDisabled, true);
  assert.equal(merged.version, '1.2.18');

  clearDeviceState(tmp);
  assert.equal(readDeviceState(tmp), null);
});

test('文件损坏不会永久禁用显卡（读回 null）', () => {
  const file = statePath(tmp);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  assert.equal(readDeviceState(tmp), null);
  clearDeviceState(tmp);
});

test('版本号可用于升级后重试显卡', () => {
  assert.match(appVersion(), /^\d+\.\d+\.\d+/);
});
