import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, decorateEngines, listEngines, runEngine, searchAll } from '../server/lib/reverse-engines.js';

/**
 * 全网搜图的两档语义必须守住：
 * upload = 服务端真上传（Yandex / SauceNAO），manual = 只能开页面让用户粘贴。
 * 这里不联网：只断言清单形状与「不需要文件字节时绝不读文件」这条边界。
 */

test('引擎清单：id 唯一、字段完整', () => {
  const ids = new Set();
  for (const e of ENGINES) {
    assert.ok(e.id && typeof e.id === 'string', 'id 必填');
    assert.ok(!ids.has(e.id), `id 重复：${e.id}`);
    ids.add(e.id);
    assert.ok(e.name, `${e.id} 缺名字`);
    assert.ok(e.region === 'cn' || e.region === 'global', `${e.id} 的国别只能是 cn / global`);
    assert.ok(e.mode === 'upload' || e.mode === 'manual', `${e.id} 的档位只能是 upload / manual`);
    if (e.mode === 'manual') assert.ok(/^https:\/\//.test(e.url || ''), `${e.id} 手动档必须给页面地址`);
  }
});

test('只有 Yandex / SauceNAO 走服务端上传', () => {
  const upload = ENGINES.filter((e) => e.mode === 'upload').map((e) => e.id).sort();
  assert.deepEqual(upload, ['saucenao', 'yandex']);
});

test('listEngines 返回的是副本，改调用方不会污染引擎表', () => {
  const list = listEngines();
  assert.equal(list.length, ENGINES.length);
  list[0].name = '改坏了';
  assert.notEqual(ENGINES[0].name, '改坏了');
});

test('网络体检：上传档按探测结果标记不可用，手动档不受影响', () => {
  const engines = decorateEngines({ engines: { yandex: { ok: false, error: 'ETIMEDOUT' }, saucenao: { ok: true } } });
  const yandex = engines.find((e) => e.id === 'yandex');
  assert.equal(yandex.ready, false);
  assert.match(yandex.reason, /国际网络不通/);
  assert.match(yandex.reason, /ETIMEDOUT/);

  const saucenao = engines.find((e) => e.id === 'saucenao');
  assert.equal(saucenao.ready, true);
  assert.equal(saucenao.reason, '');

  // 手动档不靠服务端上传：即便整个体检失败，也只是「页面打不开」，不该标成不可用
  const offline = decorateEngines({ engines: {} });
  for (const e of offline.filter((x) => x.mode === 'manual')) {
    assert.equal(e.ready, true, `${e.id} 是手动档，不该被国际网络体检拦掉`);
    assert.ok(e.why, `${e.id} 缺 why`);
  }
  assert.equal(decorateEngines(null).length, ENGINES.length);
});

test('采集图带公网地址时，Lens / TinEye 直接按地址搜（不用剪贴板）', async () => {
  const r = await runEngine('lens', null, { sourceUrl: 'https://example.com/a b.jpg' });
  assert.equal(r.mode, 'url');
  assert.equal(r.needsClipboard, undefined);
  assert.ok(r.url.startsWith('https://lens.google.com/uploadbyurl?url='));
  assert.ok(r.url.includes(encodeURIComponent('https://example.com/a b.jpg')));

  const t = await runEngine('tineye', null, { sourceUrl: 'https://example.com/x.jpg' });
  assert.equal(t.mode, 'url');
  assert.ok(t.url.startsWith('https://tineye.com/search?url='));
});

test('没有公网地址时回落到「打开页面 + 粘剪贴板」', async () => {
  const r = await runEngine('lens', null, { sourceUrl: '' });
  assert.equal(r.mode, 'manual');
  assert.equal(r.needsClipboard, true);
  assert.ok(r.url.startsWith('https://lens.google.com/'));
  // 非 http(s) 的地址（本地路径 / blob）不能拼进查询串
  const local = await runEngine('tineye', null, { sourceUrl: 'file:///e:/a.jpg' });
  assert.equal(local.mode, 'manual');
});

test('只点了手动档引擎时不读文件：CR2 也能直接开页面', async () => {
  const r = await searchAll('E:/不存在/a.CR2', ['baidu', 'sogou']);
  assert.equal(r.bytes, 0);
  assert.equal(r.results.length, 2);
  for (const one of r.results) {
    assert.equal(one.ok, true, `${one.engine} 不该因为读不到文件而失败`);
    assert.equal(one.needsClipboard, true);
  }
});

test('未知引擎不炸整次请求，只把原因带回自己那条', async () => {
  const r = await searchAll('E:/不存在/a.CR2', ['baidu', 'nope']);
  const bad = r.results.find((x) => x.engine === 'nope');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未知/);
  const good = r.results.find((x) => x.engine === 'baidu');
  assert.equal(good.ok, true);
});

test('上传档缺文件时明确报错，不假装成功', async () => {
  await assert.rejects(searchAll('E:/不存在/a.jpg', ['yandex']), /不在磁盘|ENOENT/i);
});

test('未知 id 直接问 runEngine 会被拒绝', async () => {
  await assert.rejects(runEngine('nope', null), /未知/);
});
