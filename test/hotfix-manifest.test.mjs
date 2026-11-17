/**
 * 热更清单的纯逻辑：规范化、验签、白名单、版本闸门。
 *
 * 这一层是「没有自建服务器」时的全部安全边界：
 * 清单可能来自任何镜像，只有签名与闸门能决定它能不能装。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  canonicalJson,
  fileAllowed,
  manifestPayload,
  manifestProblem,
  signManifest,
  verifyManifest,
} from '../electron/lib/hotfix-manifest.js';
import { SCHEMA_VERSION } from '../server/db/schema-version.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });

const file = (p) => ({ path: p, sha256: 'a'.repeat(64), size: 10 });

const baseManifest = () => ({
  schemaVersion: SCHEMA_VERSION,
  shellVersion: '1.2.20',
  seq: 3,
  notes: '修拼图首帧闪回',
  createdAt: '2026-11-16T00:00:00.000Z',
  files: [file('web/index.html'), file('server/lib/stitch.js')],
  urls: ['https://github.com/mr-awei/gallery/releases/download/hotfix/pack-3.zip'],
});

const ctx = { shellVersion: '1.2.20', schemaVersion: SCHEMA_VERSION, lastSeq: 2 };

test('canonicalJson 与键序无关', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
  // undefined 字段必须被丢掉，否则签名端/验签端会差一个键
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test('签名与验签可以往返', () => {
  const signed = signManifest(baseManifest(), PRIV);
  assert.equal(verifyManifest(signed, PUB), true);
  assert.equal(manifestProblem(signed, ctx), '');
});

test('改任何一个被签名字段都会验签失败', () => {
  const signed = signManifest(baseManifest(), PRIV);
  assert.equal(verifyManifest({ ...signed, seq: 99 }, PUB), false);
  assert.equal(verifyManifest({ ...signed, shellVersion: '1.2.21' }, PUB), false);
  const tampered = { ...signed, files: [file('server/lib/stitch.js'), file('web/evil.js')] };
  assert.equal(verifyManifest(tampered, PUB), false);
});

test('没有 sig / 公钥缺失都不能算通过', () => {
  assert.equal(verifyManifest(baseManifest(), PUB), false);
  assert.equal(verifyManifest(signManifest(baseManifest(), PRIV), ''), false);
  assert.equal(verifyManifest(null, PUB), false);
});

test('被签名的串不含 sig 字段', () => {
  const signed = signManifest(baseManifest(), PRIV);
  assert.equal(manifestPayload(signed), manifestPayload(baseManifest()));
});

test('白名单只放 web / server / plugins，且挡掉穿越', () => {
  assert.equal(fileAllowed('web/index.html'), true);
  assert.equal(fileAllowed('server/lib/a.js'), true);
  assert.equal(fileAllowed('plugins/x/manifest.json'), true);
  // 以下都属于「壳」，只能走安装包
  assert.equal(fileAllowed('electron/main.js'), false);
  assert.equal(fileAllowed('package.json'), false);
  assert.equal(fileAllowed('web/../electron/main.js'), false);
  assert.equal(fileAllowed('/etc/passwd'), false);
  assert.equal(fileAllowed('C:/Windows/system32/x.dll'), false);
  assert.equal(fileAllowed('server/native.node'), false);
  assert.equal(fileAllowed('web/x.js'), true);
});

test('壳版本不同一律拒装（热更只对同一个壳生效）', () => {
  const signed = signManifest(baseManifest(), PRIV);
  assert.match(manifestProblem(signed, { ...ctx, shellVersion: '1.2.21' }), /当前 1\.2\.21/);
});

test('库版本不同一律拒装（回滚会变成库比代码新）', () => {
  const signed = signManifest(baseManifest(), PRIV);
  assert.match(manifestProblem(signed, { ...ctx, schemaVersion: SCHEMA_VERSION + 1 }), /数据库版本/);
});

test('seq 不递增就拒装（防重放旧包）', () => {
  const signed = signManifest(baseManifest(), PRIV);
  assert.match(manifestProblem(signed, { ...ctx, lastSeq: 3 }), /seq 3/);
  assert.equal(manifestProblem(signed, { ...ctx, lastSeq: 2 }), '');
});

test('清单结构不合法时给出可读原因', () => {
  const signed = signManifest(baseManifest(), PRIV);
  assert.match(manifestProblem({ ...signed, files: [] }, ctx), /没有文件/);
  assert.match(manifestProblem({ ...signed, files: [file('web/a.js'), file('web/a.js')] }, ctx), /重复文件/);
  assert.match(manifestProblem({ ...signed, files: [{ path: 'web/a.js', size: 1 }] }, ctx), /sha256/);
  assert.match(manifestProblem({ ...signed, urls: [] }, ctx), /下载地址/);
  assert.match(manifestProblem({ ...signed, urls: ['http://x/y.zip'] }, ctx), /https/);
  assert.match(manifestProblem({ ...signed, seq: 0 }, ctx), /seq 非法/);
});

test('schema 版本常量是正整数（与 migrate 的一致性由启动断言兜底）', () => {
  assert.equal(Number.isInteger(SCHEMA_VERSION), true);
  assert.ok(SCHEMA_VERSION >= 1);
});
