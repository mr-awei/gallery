import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discardDownloaded, moveDownloaded } from '../electron/lib/download-target.js';

/** 建一个临时工作目录（ASCII 名，避免 Windows 上中文路径的句柄麻烦） */
async function workDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tuku-dl-'));
}

test('moveDownloaded 同分区改名：内容不变，原地不留', async () => {
  const dir = await workDir();
  const from = path.join(dir, 'provisional.bin');
  const to = path.join(dir, '拼接图.jpg');
  await fs.writeFile(from, 'pixels');

  assert.equal(await moveDownloaded(from, to), to);
  assert.equal(await fs.readFile(to, 'utf8'), 'pixels');
  await assert.rejects(fs.access(from));
  await fs.rm(dir, { recursive: true, force: true });
});

test('moveDownloaded 目标已存在时覆盖（与覆盖保存的语义一致）', async () => {
  const dir = await workDir();
  const from = path.join(dir, 'a.bin');
  const to = path.join(dir, 'b.bin');
  await fs.writeFile(from, 'new');
  await fs.writeFile(to, 'old');

  await moveDownloaded(from, to);
  assert.equal(await fs.readFile(to, 'utf8'), 'new');
  await fs.rm(dir, { recursive: true, force: true });
});

test('moveDownloaded 起止相同直接返回，不误删', async () => {
  const dir = await workDir();
  const file = path.join(dir, 'same.bin');
  await fs.writeFile(file, 'keep');

  assert.equal(await moveDownloaded(file, file), file);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  await fs.rm(dir, { recursive: true, force: true });
});

test('discardDownloaded 连占位残留的 .crdownload 一起清掉', async () => {
  const dir = await workDir();
  const file = path.join(dir, 'part.bin');
  await fs.writeFile(file, 'half');
  await fs.writeFile(`${file}.crdownload`, 'half');

  await discardDownloaded(file);
  await assert.rejects(fs.access(file));
  await assert.rejects(fs.access(`${file}.crdownload`));
  await fs.rm(dir, { recursive: true, force: true });
});

test('discardDownloaded 对不存在的文件不抛错（取消时常常还没建文件）', async () => {
  const dir = await workDir();
  await discardDownloaded(path.join(dir, 'nothing.bin'));
  await fs.rm(dir, { recursive: true, force: true });
});
