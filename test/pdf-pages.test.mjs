import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 守住 countPdfPages 的句柄释放：以前 openSync 之后没有 finally，
// fstatSync/readSync 任一抛错就会跳过 closeSync —— Windows 上这个 PDF
// 一直处于被占用状态，删不掉也改不了名，而外层 catch 把错误吞掉，用户看不到原因。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-pdf-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_DATA_DIR = path.join(tmp, 'data');
process.env.TUKU_DEFAULT_STORAGE_DIR = path.join(tmp, 'storage');

const { countPdfPages } = await import('../server/routes/inspect.js');

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows：sqlite 句柄未释放时删不掉，留给系统临时目录 */
  }
});

test('数完页数句柄已关闭：Windows 上文件能立刻删除', () => {
  const p = path.join(tmp, 'sample.pdf');
  fs.writeFileSync(
    p,
    '%PDF-1.4\n1 0 obj<</Type/Page>>endobj\n2 0 obj<</Type/Pages/Count 1>>endobj\ntrailer<</Root 2 0 R>>'
  );
  const r = countPdfPages(p);
  assert.equal(r.pages, 1);
  assert.doesNotThrow(() => fs.rmSync(p, { force: true }), '读完后必须能立刻删除文件（句柄已释放）');
});

test('打不开的文件返回 0，不抛错也不留句柄', () => {
  const r = countPdfPages(path.join(tmp, 'not-there.pdf'));
  assert.equal(r.pages, 0);
  assert.equal(r.exact, false);
});

test('非 PDF 内容不抛错，按未知处理', () => {
  const p = path.join(tmp, 'junk.pdf');
  fs.writeFileSync(p, 'not a pdf at all, just text');
  const r = countPdfPages(p);
  assert.equal(r.pages, 0);
  assert.doesNotThrow(() => fs.rmSync(p, { force: true }));
});
