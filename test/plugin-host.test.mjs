/**
 * T-24 插件沙箱回归：插件子进程必须拦住 node:fs / child_process / net 等危险模块的动态导入，
 * 且正常插件（只读数据、返回 patch）仍可运行，主进程不受影响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(__dirname, '..', 'server', 'plugin-runtime.js');

function runRuntime(entry, permissions = []) {
  const payload = JSON.stringify({
    entry,
    action: 'run',
    permissions,
    image: { id: 'x', title: 't', tags: '', note: '', rating: 0, favorite: false, width: 0, height: 0, mediaKind: 'image' },
    args: {},
  });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNTIME, payload], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += String(b)));
    child.stderr.on('data', (b) => (stderr += String(b)));
    child.on('close', () => resolve({ stdout, stderr }));
  });
}

test('插件动态 import(node:fs) 被沙箱拒绝', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tuku-plug-'));
  const entry = path.join(dir, 'evil.mjs');
  await fsp.writeFile(
    entry,
    `export default async function run() {
       await import('node:fs');
       return { patch: { tags: ['should-not-apply'] } };
     }`
  );
  const { stdout } = await runRuntime(entry, ['image:write']);
  const line = stdout.split('\n').find((l) => l.startsWith('__TUKU_PLUGIN__'));
  assert.ok(line, '插件应返回结果行（错误也应通过结果行上报）');
  const msg = JSON.parse(line.slice('__TUKU_PLUGIN__'.length));
  assert.equal(msg.type, 'error');
  assert.match(msg.message, /不允许访问模块|node:fs|沙箱/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('正常插件（只读 + 返回 patch）仍可运行', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tuku-plug-'));
  const entry = path.join(dir, 'ok.mjs');
  await fsp.writeFile(
    entry,
    `export default async function run({ image, args, log }) {
       log('hello');
       return { patch: { tags: ['auto-' + (args.prefix || 'x')] } };
     }`
  );
  const { stdout } = await runRuntime(entry, ['image:read', 'image:write', 'log']);
  const line = stdout.split('\n').find((l) => l.startsWith('__TUKU_PLUGIN__'));
  assert.ok(line);
  const msg = JSON.parse(line.slice('__TUKU_PLUGIN__'.length));
  assert.equal(msg.type, 'result');
  assert.deepEqual(msg.value.patch.tags, ['auto-x']);
  assert.deepEqual(msg.value.logs, ['hello']);
  await fsp.rm(dir, { recursive: true, force: true });
});
