import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_STATE_FILE,
  appVersion,
  clearDeviceState,
  clearGpuProbe,
  crashText,
  defaultUserRoot,
  gpuForcedOff,
  gpuProbeCrashed,
  isNativeCrashCode,
  readDeviceState,
  statePath,
  writeDeviceState,
  writeGpuProbe,
} from '../server/lib/device-state.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('显卡探针：纸条落盘、建成后撤掉、只有 probing=true 才算崩过', () => {
  assert.equal(gpuProbeCrashed(null), false);
  assert.equal(gpuProbeCrashed({}), false);
  assert.equal(gpuProbeCrashed({ gpuDisabled: true }), false);
  assert.equal(gpuProbeCrashed({ probing: false }), false);
  assert.equal(gpuProbeCrashed({ probing: 'true' }), false, '字符串不算，避免脏文件误判');
  assert.equal(gpuProbeCrashed({ probing: true }), true);

  clearDeviceState(tmp);
  assert.equal(writeGpuProbe(tmp), true);
  const st = readDeviceState(tmp);
  assert.equal(gpuProbeCrashed(st), true);
  assert.match(String(st.version), /^\d+\.\d+\.\d+/, '纸条要带版本，方便排查是哪个版本崩的');

  // 建成会话 → 撤纸条，但不能顺手把别的结论删掉
  writeDeviceState(tmp, { note: 'keep-me' });
  clearGpuProbe(tmp);
  const after = readDeviceState(tmp);
  assert.equal(after.probing, false);
  assert.equal(after.note, 'keep-me');
  assert.equal(gpuProbeCrashed(after), false);

  // 没有纸条时清除是空操作，不能凭空造出文件
  clearDeviceState(tmp);
  assert.equal(clearGpuProbe(tmp), false);
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

test('默认用户目录只认环境变量，不依赖 server/config.js', () => {
  assert.equal(defaultUserRoot({ TUKU_USER_DATA: 'C:\\tmp\\x' }), 'C:\\tmp\\x');
  // 没有环境变量时回到仓库根，且这一步不能碰 fs（打包版里 config.js 会 mkdir 失败）
  const root = defaultUserRoot({});
  assert.equal(path.basename(root), path.basename(REPO_ROOT));
  assert.equal(root, REPO_ROOT);
});

/**
 * 打包版启动闸：主进程是「先求值整张静态 import 图、再执行 main.js 函数体」，
 * 而 TUKU_USER_DATA 是在函数体里注入的。只要静态图里出现 server/config.js，
 * 它就会在环境变量到位前 mkdirSync 建目录 —— 应用根是只读的 app.asar 时
 * Windows 直接 ENOTDIR，整个应用弹「A JavaScript error occurred in the main process」。
 * 所以这里从 electron/main.js 出发走一遍静态 import 图，禁止走到的文件里有 config.js。
 */
test('主进程静态 import 图不得包含 server/config.js（否则打包版启动即崩）', () => {
  const STATIC_IMPORT = /(?:^|\n)\s*(?:import\s+(?:[^'"]*?\sfrom\s+)?|export\s+[^'"]*?\sfrom\s+)['"]([^'"]+)['"]/g;
  const forbidden = path.join(REPO_ROOT, 'server', 'config.js');
  const seen = new Set();
  const stack = [path.join(REPO_ROOT, 'electron', 'main.js')];
  const offenders = [];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === forbidden) {
      offenders.push(file);
      continue;
    }
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(STATIC_IMPORT)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // 裸模块（electron / node: 内置）不归这里管
      const resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.startsWith(REPO_ROOT)) continue;
      stack.push(resolved);
    }
  }
  assert.deepEqual(offenders, [], '主进程静态依赖链里出现了 server/config.js');
  assert.ok(seen.size > 5, '静态 import 图没走通');
});
