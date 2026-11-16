/**
 * 热更内核（electron/main/hotfix.js）的状态机：下载/导入 → 待生效 → 换入 → 启动期看门狗。
 *
 * 这里不碰 electron，直接用真文件 + 真签名跑：坏包必须能自动隔离退回内置，
 * 否则用户会看到「装了热更，应用起不来」这种最难解释的故障。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { createHotfix } from '../electron/main/hotfix.js';
import { sha256, signManifest } from '../electron/lib/hotfix-manifest.js';
import { SCHEMA_VERSION } from '../server/db/schema-version.js';

const SHELL = '1.2.20';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });

/** 一份最小可用的热更包内容：既有 web 也有 server */
const FILES = {
  'web/index.html': '<html>hotfix-1</html>',
  'server/standalone.js': 'export const hotfix = 1;',
  'server/lib/a.js': 'export const a = 1;',
};

const manifestFor = (files, { seq = 1, notes = '修拼图首帧闪回', shellVersion = SHELL, priv = PRIV } = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  shellVersion,
  seq,
  notes,
  createdAt: '2026-11-16T00:00:00.000Z',
  files: Object.entries(files)
    .map(([p, text]) => ({ path: p, sha256: sha256(Buffer.from(text)), size: Buffer.byteLength(text) }))
    .sort((a, b) => a.path.localeCompare(b.path)),
  urls: [`https://example.com/pack-${seq}.zip`],
  // 签名在下面统一做，调用方拿到的是「本该签对的清单」
  __priv: priv,
});

/** 造一个 zip（内含已签名清单） */
async function packZip(files = FILES, opts = {}) {
  const raw = manifestFor(files, opts);
  const priv = raw.__priv;
  delete raw.__priv;
  const signed = signManifest(raw, priv);
  const zip = new JSZip();
  for (const [p, text] of Object.entries(files)) zip.file(p, text);
  zip.file('manifest.json', JSON.stringify(signed, null, 2));
  return { buf: await zip.generateAsync({ type: 'nodebuffer' }), manifest: signed };
}

/** 建一套隔离沙盒：假 appRoot + 假 userData + 一个 hotfix 实例 */
function sandbox({ fetchImpl } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-hotfix-'));
  const appRoot = path.join(base, 'app');
  const userDataDir = path.join(base, 'user');
  fs.mkdirSync(path.join(appRoot, 'server'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'server', 'standalone.js'), '// 内置版本');
  fs.writeFileSync(path.join(appRoot, 'server', 'hotfix-entry.js'), '// shim');
  const hot = createHotfix({
    userDataDir,
    appRoot,
    shellVersion: SHELL,
    schemaVersion: SCHEMA_VERSION,
    publicKeyPem: PUB,
    feedUrls: ['https://feed.example/manifest.json'],
    fetchImpl,
  });
  return { base, appRoot, userDataDir, hot, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** 把 pack 写成文件（importZip 只接受路径） */
function writePack(base, buf) {
  const file = path.join(base, `pack-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, buf);
  return file;
}

test('导入的包先落 pending，下次启动才换入并给出叠加层入口', async () => {
  const s = sandbox();
  try {
    const { buf } = await packZip();
    assert.equal(s.hot.state().activeSeq, 0);
    const res = await s.hot.importZip(writePack(s.base, buf));
    assert.equal(res.updated, true, res.error);
    assert.equal(s.hot.state().pendingSeq, 1);
    assert.equal(s.hot.state().activeSeq, 0);

    const decision = s.hot.boot();
    assert.equal(decision.mode, 'overlay');
    assert.equal(decision.seq, 1);
    // server 走 asar 里的 shim，叠加层只提供文件与环境变量
    assert.equal(decision.serverEntry, path.join(s.appRoot, 'server', 'hotfix-entry.js'));
    assert.equal(decision.env.TUKU_HOTFIX_ENTRY, path.join(s.hot.dir.current, 'server', 'standalone.js'));
    assert.equal(decision.env.TUKU_HOTFIX_ROOT, s.hot.dir.current);
    assert.equal(decision.webOverlay, path.join(s.hot.dir.current, 'web'));
    assert.equal(decision.manifest.notes, '修拼图首帧闪回');
    assert.equal(s.hot.state().pendingSeq, 0);
    assert.equal(s.hot.state().activeSeq, 1);

    s.hot.markReady();
    assert.equal(s.hot.boot().mode, 'overlay');
  } finally {
    s.done();
  }
});

test('连续两次启动都没销账 → 隔离坏包并退回内置版本', async () => {
  const s = sandbox();
  try {
    const { buf } = await packZip();
    await s.hot.importZip(writePack(s.base, buf));

    assert.equal(s.hot.boot().mode, 'overlay'); // 第一次尝试（服务没起来）
    assert.equal(s.hot.boot().mode, 'overlay'); // 第二次尝试（tries=1）
    const third = s.hot.boot(); // 累计两次未就绪，不该再拿用户当小白鼠
    assert.equal(third.mode, 'builtin');
    assert.match(third.note, /连续 2 次未能就绪/);
    assert.deepEqual(s.hot.state().badSeqs, [1]);
    assert.equal(s.hot.state().activeSeq, 0);
    // 坏包被改名留在原地，方便排查而不是静默删掉
    assert.ok(fs.readdirSync(s.hot.dir.root).some((n) => n.startsWith('broken-')));
    assert.equal(fs.existsSync(s.hot.dir.current), false);
  } finally {
    s.done();
  }
});

test('已生效的包文件被改坏 → 启动时校验失败并退回内置', async () => {
  const s = sandbox();
  try {
    const { buf } = await packZip();
    await s.hot.importZip(writePack(s.base, buf));
    assert.equal(s.hot.boot().mode, 'overlay');
    s.hot.markReady();

    fs.writeFileSync(path.join(s.hot.dir.current, 'server', 'lib', 'a.js'), 'export const a = 999;');
    const decision = s.hot.boot();
    assert.equal(decision.mode, 'builtin');
    assert.match(decision.note, /校验失败/);
    assert.equal(decision.serverEntry, path.join(s.appRoot, 'server', 'standalone.js'));
  } finally {
    s.done();
  }
});

test('包内文件与清单 sha256 不符：拒收，且不留待生效记录', async () => {
  const s = sandbox();
  try {
    // 清单按 A 签名，包里塞 B —— 模拟镜像被替换或下载截断
    const { buf, manifest } = await packZip();
    const zip = new JSZip();
    for (const f of manifest.files) {
      zip.file(f.path, f.path.endsWith('index.html') ? '<html>tampered</html>' : '<x/>');
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const bad = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await s.hot.importZip(writePack(s.base, bad));
    assert.equal(res.updated, false);
    assert.match(res.error, /解包校验失败/);
    assert.equal(s.hot.state().pendingSeq, 0);
    assert.equal(fs.readdirSync(s.hot.dir.root).some((n) => n.startsWith('staging-')), false);
  } finally {
    s.done();
  }
});

test('壳版本不一致的清单装不上（那该走安装包）', async () => {
  const s = sandbox();
  try {
    const { buf } = await packZip(FILES, { shellVersion: '1.2.19' });
    const res = await s.hot.importZip(writePack(s.base, buf));
    assert.equal(res.updated, false);
    assert.match(res.error, /清单针对 1\.2\.19/);
  } finally {
    s.done();
  }
});

test('清单签名不对 → 直接拒收', async () => {
  const s = sandbox();
  try {
    const { buf, manifest } = await packZip();
    const forged = { ...manifest, notes: '偷偷改一行说明' };
    const zip = new JSZip();
    for (const [p, text] of Object.entries(FILES)) zip.file(p, text);
    zip.file('manifest.json', JSON.stringify(forged, null, 2));
    const res = await s.hot.importZip(writePack(s.base, await zip.generateAsync({ type: 'nodebuffer' })));
    assert.equal(res.updated, false);
    assert.match(res.error, /验签失败/);
  } finally {
    s.done();
  }
});

test('check() 从 feed 拉清单与整包，落到 pending', async () => {
  const { buf, manifest } = await packZip();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest), { status: 200 });
    if (url === manifest.urls[0]) return new Response(buf, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const s = sandbox({ fetchImpl });
  try {
    const res = await s.hot.check();
    assert.equal(res.updated, true, res.error);
    assert.equal(res.seq, 1);
    assert.equal(res.files, 3);
    assert.equal(s.hot.state().pendingSeq, 1);
    assert.equal(seen.length, 2);

    // 同一个包再查一次：seq 不涨就是「已是最新」，不能重复下载
    const again = await s.hot.check();
    assert.equal(again.updated, false);
    assert.match(again.error, /不高于已应用的 1/);
  } finally {
    s.done();
  }
});

test('下载地址全都取不到包 → 报错且不落 pending', async () => {
  const { manifest } = await packZip();
  const fetchImpl = async (url) => {
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const s = sandbox({ fetchImpl });
  try {
    const res = await s.hot.check();
    assert.equal(res.updated, false);
    assert.match(res.error, /HTTP 404/);
    assert.equal(s.hot.state().pendingSeq, 0);
  } finally {
    s.done();
  }
});

test('applyPending：立即生效只换入，不负责启停服务', async () => {
  const s = sandbox();
  try {
    assert.deepEqual(s.hot.applyPending(), { applied: false, seq: 0 });
    const { buf } = await packZip();
    await s.hot.importZip(writePack(s.base, buf));
    const res = s.hot.applyPending();
    assert.equal(res.applied, true);
    assert.equal(res.seq, 1);
    assert.equal(s.hot.state().activeSeq, 1);
    assert.equal(s.hot.state().pendingSeq, 0);
  } finally {
    s.done();
  }
});

test('没有公钥时不启用热更（宁可没功能，也不要没验签）', async () => {
  const s = sandbox();
  try {
    const off = createHotfix({
      userDataDir: s.userDataDir,
      appRoot: s.appRoot,
      shellVersion: SHELL,
      schemaVersion: SCHEMA_VERSION,
      publicKeyPem: '',
      feedUrls: ['https://feed.example/manifest.json'],
    });
    const decision = off.boot();
    assert.equal(decision.mode, 'builtin');
    assert.equal(decision.serverEntry, path.join(s.appRoot, 'server', 'standalone.js'));
    assert.equal((await off.check()).updated, false);
  } finally {
    s.done();
  }
});
