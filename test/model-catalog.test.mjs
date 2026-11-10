import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, MODEL_GROUPS, catalogItem, mergeCatalog, summarizeCatalog } from '../server/lib/model-catalog.js';

/**
 * 下载中心的清单是「全部模型」的唯一真相：各模块按 id 分发，界面按 group 分组。
 * 这里守的是「清单自身不会说错话」——id 不重复、前缀与分组对得上、体积不是瞎写的 0。
 * 不做路径与 IO 断言（那属于 registry，import 会拉 db）。
 */

test('清单：每个条目字段完整，id 唯一', () => {
  const ids = new Set();
  for (const m of MODEL_CATALOG) {
    assert.ok(m.id && typeof m.id === 'string', 'id 必填');
    assert.ok(!ids.has(m.id), `id 重复：${m.id}`);
    ids.add(m.id);
    assert.ok(m.name && m.desc, `${m.id} 缺名称或说明`);
    assert.ok(MODEL_GROUPS.some((g) => g.id === m.group), `${m.id} 的分组不存在：${m.group}`);
    assert.ok(Number.isFinite(m.sizeHint) && m.sizeHint > 0, `${m.id} 的 sizeHint 必须是正数`);
    assert.ok(m.source && m.license, `${m.id} 必须写明来源与许可`);
    assert.equal(typeof m.required, 'boolean');
    assert.equal(typeof m.pinned, 'boolean');
  }
});

test('清单：id 前缀与分组一致（分发靠前缀，错了就永远装不上）', () => {
  const prefixOf = {
    upscale: ['upscale:', 'esrgan:', 'onnx:'],
    matting: ['matting:'],
    face: ['face:'],
    semantic: ['semantic:'],
  };
  for (const m of MODEL_CATALOG) {
    const allowed = prefixOf[m.group] || [];
    assert.ok(
      allowed.some((p) => m.id.startsWith(p)),
      `${m.id} 的前缀不属于分组 ${m.group}`
    );
  }
});

test('清单：每个功能都有核心权重（required 不能全空）', () => {
  for (const g of MODEL_GROUPS) {
    assert.ok(
      MODEL_CATALOG.some((m) => m.group === g.id),
      `分组 ${g.id} 没有任何条目`
    );
  }
  assert.ok(MODEL_CATALOG.some((m) => m.required), '至少要有一个 required 条目');
});

test('catalogItem：找不到返回 null 而不是 undefined', () => {
  assert.equal(catalogItem('nope'), null);
  assert.equal(catalogItem(MODEL_CATALOG[0].id)?.id, MODEL_CATALOG[0].id);
});

test('mergeCatalog：未安装不虚报体积，安装后取磁盘实际值', () => {
  const id = 'matting:u2net';
  const notInstalled = mergeCatalog({}).find((m) => m.id === id);
  assert.equal(notInstalled.installed, false);
  assert.equal(notInstalled.size, 0, '没装就该是 0，不能拿 sizeHint 冒充占用');
  assert.equal(notInstalled.state, 'idle');

  const installed = mergeCatalog({ [id]: { installed: true, size: 12345 } }).find((m) => m.id === id);
  assert.equal(installed.size, 12345);
  assert.equal(installed.state, 'installed');
  assert.equal(installed.removable, true);

  // 探测给不出体积时退回清单里的预计体积，界面至少不显示 0MB
  const noSize = mergeCatalog({ [id]: { installed: true } }).find((m) => m.id === id);
  assert.equal(noSize.size, noSize.sizeHint);
});

test('mergeCatalog：进度被夹到 0~100，-1 保留表示「不知道总量」', () => {
  const id = MODEL_CATALOG[0].id;
  const over = mergeCatalog({ [id]: { installed: false, progress: 180 } }).find((m) => m.id === id);
  assert.equal(over.progress, 100);
  const neg = mergeCatalog({ [id]: { installed: false, progress: -5 } }).find((m) => m.id === id);
  assert.equal(neg.progress, 0);
});

test('summarizeCatalog：汇总已装数、占用、可清理与下载中项', () => {
  const items = mergeCatalog({
    'matting:u2net': { installed: true, size: 100 },
    'matting:birefnet-lite': { installed: true, size: 200, state: 'downloading', progress: 40 },
    'face:buffalo-l': { installed: false },
  });
  const s = summarizeCatalog(items);
  assert.equal(s.total, MODEL_CATALOG.length);
  assert.equal(s.installed, 2);
  assert.equal(s.bytes, 300);
  assert.equal(s.removableBytes, 300);
  assert.equal(s.active, 1);
  assert.equal(s.activeId, 'matting:birefnet-lite');
  const mattingGroup = s.groups.find((g) => g.id === 'matting');
  assert.equal(mattingGroup.installed, 2);
  assert.equal(mattingGroup.bytes, 300);
});

test('summarizeCatalog：空清单不会除零或抛错', () => {
  const s = summarizeCatalog([]);
  assert.equal(s.total, 0);
  assert.equal(s.installed, 0);
  assert.equal(s.bytes, 0);
  assert.equal(s.groups.length, MODEL_GROUPS.length);
});
