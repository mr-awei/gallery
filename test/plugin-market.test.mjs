import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

// config/db 首次 import 就固化用户目录，必须先注入隔离的 ASCII 临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-market-'));
process.env.TUKU_USER_DATA = tmp;
const {
  loadBuiltinMarket,
  marketView,
  parsePluginPackage,
  readBuiltinPackage,
  installPluginPackage,
  uninstallPlugin,
  validateMarketIndex,
} = await import('../server/lib/plugin-market.js');
const { findPlugin } = await import('../server/lib/plugin-host.js');

after(async () => {
  try {
    const { db } = await import('../server/db.js');
    db.close();
  } catch {
    /* 已关闭 */
  }
  delete process.env.TUKU_USER_DATA;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄释放有延迟 */
  }
});

const manifest = {
  id: 'unit-test-plugin',
  name: '单测插件',
  version: '1.2.3',
  entry: 'index.js',
  permissions: ['image:read', 'log'],
  actions: ['run'],
  description: '仅用于单测',
};
const source = 'export default async function run({ image, log }) { log("ok"); return { result: 1 }; }\n';

/** @param {Record<string, string>} extra */
const jsonPackage = (extra = {}) =>
  Buffer.from(JSON.stringify({ format: 'tuku-plugin/1', manifest, files: { 'index.js': source, ...extra } }), 'utf8');

test('市场索引：字段收敛、非法索引拒绝', () => {
  const builtin = loadBuiltinMarket();
  assert.ok(builtin.plugins.length >= 2);
  assert.ok(builtin.plugins.every((p) => p.id && p.name && Array.isArray(p.permissions)));
  const clean = validateMarketIndex({
    plugins: [{ id: 'x', name: 'X', permissions: ['image:read', 'evil:all'], source: 'remote' }],
  });
  assert.deepEqual(clean.plugins[0].permissions, ['image:read'], '未知权限要被过滤掉');
  assert.throws(() => validateMarketIndex({}), /缺少 plugins/);
  assert.throws(() => validateMarketIndex({ plugins: 'no' }), /缺少 plugins/);
  assert.ok(marketView().plugins.length >= 2);
});

test('插件包：随包 JSON、ZIP、非法路径与未知权限', async () => {
  const builtinBuf = readBuiltinPackage('rating-from-tags.tuku-plugin');
  const builtin = await parsePluginPackage(builtinBuf, 'rating-from-tags.tuku-plugin');
  assert.equal(builtin.manifest.id, 'rating-from-tags');
  assert.ok(builtin.files['index.js']);

  const parsed = await parsePluginPackage(jsonPackage(), 'unit.tuku-plugin');
  assert.equal(parsed.manifest.id, manifest.id);
  assert.equal(parsed.manifest.version, '1.2.3');

  const zip = new JSZip();
  zip.file('plugin.json', JSON.stringify(manifest));
  zip.file('index.js', source);
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
  const fromZip = await parsePluginPackage(zipBuf, 'unit.zip');
  assert.equal(fromZip.manifest.id, manifest.id);

  await assert.rejects(
    () => parsePluginPackage(jsonPackage({ '../evil.js': source }), 'x.tuku-plugin'),
    /非法路径/,
    '路径穿越必须拒绝'
  );
  await assert.rejects(
    () => parsePluginPackage(jsonPackage({ 'payload.exe': source }), 'x.tuku-plugin'),
    /不允许的文件类型/,
    '非 js/json 文件必须拒绝'
  );
  await assert.rejects(
    () => parsePluginPackage(Buffer.from(JSON.stringify({ format: 'other/9', manifest })), 'x.tuku-plugin'),
    /不是受支持的插件包格式/
  );
  await assert.rejects(
    () => parsePluginPackage(Buffer.alloc(600 * 1024), 'x.tuku-plugin'),
    /插件包过大/
  );
  const badPerm = { ...manifest, permissions: ['image:read', 'fs:write'] };
  await assert.rejects(
    () => parsePluginPackage(Buffer.from(JSON.stringify({ format: 'tuku-plugin/1', manifest: badPerm, files: { 'index.js': source } })), 'x.tuku-plugin'),
    /未知权限/
  );
  await assert.rejects(
    () => parsePluginPackage(Buffer.from(JSON.stringify({ format: 'tuku-plugin/1', manifest: { ...manifest, entry: 'missing.js' }, files: { 'index.js': source } })), 'x.tuku-plugin'),
    /入口文件不存在/
  );
});

test('在线安装落地：宿主立刻发现、权限回显、卸载后运行态立即失效', async () => {
  const parsed = await parsePluginPackage(jsonPackage(), 'unit.tuku-plugin');
  const result = await installPluginPackage(parsed);
  assert.equal(result.id, manifest.id);
  assert.equal(result.builtin, false);
  assert.deepEqual(result.permissions, ['image:read', 'log']);

  const found = findPlugin(manifest.id);
  assert.ok(found, '安装后宿主必须立刻能发现插件');
  assert.equal(found.builtin, false);
  assert.equal(found.version, '1.2.3');
  assert.ok(fs.existsSync(path.join(found.dir, 'index.js')));

  // 重复安装同 id：覆盖而不是产生两个副本
  const again = await installPluginPackage(parsed);
  assert.equal(again.id, manifest.id);
  assert.equal(findPlugin(manifest.id)?.dir, found.dir);

  const removed = await uninstallPlugin(manifest.id);
  assert.equal(removed.ok, true);
  assert.equal(findPlugin(manifest.id), null, '卸载后宿主必须立刻不再返回该插件');
  await assert.rejects(() => uninstallPlugin('note-date'), /内置插件不能卸载/);
  await assert.rejects(() => uninstallPlugin('does-not-exist'), /插件不存在/);
});
