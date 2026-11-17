import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parsePidRecord,
  parseProcessAudit,
  isServiceCommandLine,
  normalizeStartedAt,
  shouldKillStale,
  readPidRecord,
  writePidRecord,
  removePidRecord,
} from '../electron/lib/stale-process.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-stalepid-'));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄偶发占用 */
  }
});

const entry = 'e:/gemvault/server/standalone.js';
const record = {
  pid: 4321,
  startedAt: '2026-11-06T03:00:00.000Z',
  entry,
  userDataDir: tmp,
};
const audit = {
  pid: 4321,
  startedAt: '2026-11-06T03:00:00.500Z',
  commandLine: '"C:\\Program Files\\node.exe" "E:\\gemvault\\server\\standalone.js"',
};

test('PID 记录：字段校验能挡住脏数据 / PID 复用 / 伪造时间', () => {
  assert.deepEqual(parsePidRecord(JSON.stringify(record)), record);
  assert.equal(parsePidRecord('not json'), null);
  assert.equal(parsePidRecord({ ...record, pid: -1 }), null);
  assert.equal(parsePidRecord({ ...record, startedAt: 'yesterday' }), null);
  assert.equal(parsePidRecord({ ...record, entry: '' }), null);
});

test('命令行特征：只认本服务的 standalone.js，别的应用不能误杀', () => {
  assert.equal(isServiceCommandLine(audit.commandLine, entry), true);
  assert.equal(isServiceCommandLine('node.exe E:\\other\\app\\server.js', entry), false);
  assert.equal(isServiceCommandLine('', entry), false);
  assert.equal(isServiceCommandLine('node.exe E:\\gemvault\\server\\standalone.js', entry), true);
});

test('WMI 进程审计：CreationDate 的 /Date(ms)/ 与 ISO 都能解析', () => {
  const ms = Date.parse(audit.startedAt);
  const raw = JSON.stringify({
    ProcessId: 4321,
    CreationDate: `/Date(${ms})/`,
    CommandLine: audit.commandLine,
  });
  assert.deepEqual(parseProcessAudit(raw), audit);
  assert.deepEqual(parseProcessAudit([{ ProcessId: 4321, CreationDate: record.startedAt, CommandLine: 'x' }]), {
    pid: 4321,
    startedAt: record.startedAt,
    commandLine: 'x',
  });
  assert.equal(parseProcessAudit(''), null);
  assert.equal(normalizeStartedAt(ms), audit.startedAt);
});

test('回收判定：时间/命令行/PID 三重不符一律拒绝，命中才杀', () => {
  assert.equal(shouldKillStale(record, audit, 999).kill, true);
  assert.equal(shouldKillStale(null, audit, 999).kill, false);
  assert.equal(shouldKillStale(record, null, 999).reason, '进程已退出');
  assert.equal(shouldKillStale(record, audit, 4321).reason, '记录指向自身');
  assert.equal(
    shouldKillStale(record, { ...audit, commandLine: 'node.exe other.js' }, 999).reason,
    'PID 已被其它进程复用'
  );
  assert.equal(
    shouldKillStale(record, { ...audit, startedAt: '2026-11-05T03:00:00.000Z' }, 999).reason,
    '创建时间不匹配（PID 复用）'
  );
  // Unix 的 ps 拿不到创建时间：退化为命令行匹配，仍然能回收
  assert.equal(shouldKillStale(record, { ...audit, startedAt: '' }, 999).kill, true);
});

test('PID 文件：写入 → 读回 → 正常退出删除', () => {
  writePidRecord(tmp, record);
  assert.deepEqual(readPidRecord(tmp), record);
  removePidRecord(tmp);
  assert.equal(readPidRecord(tmp), null);
});
