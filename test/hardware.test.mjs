import test from 'node:test';
import assert from 'node:assert/strict';

// 守住「大模型功能最低配置」的语义：
// - 读不到显卡 ≠ 没有显卡（不能因此把人挡在门外）
// - 自检通过 = 真能跑，不再拿显存数字去否它
// - 基础显示适配器/虚拟显卡 = Vulkan 一定不可用（硬性阻断，不给「仍然继续」）
// - 内存/核心不足只警告，允许试一把
const {
  classifyGpu,
  parseWindowsGpus,
  parseMacGpus,
  parseLspci,
  vulkanVerdict,
  evaluateFeature,
  formatMB,
  HARDWARE_FEATURES,
} = await import('../server/lib/hardware.js');

const featureOf = (id) => HARDWARE_FEATURES.find((f) => f.id === id);

/* ------------------------------ 显卡分类 ------------------------------ */

test('classifyGpu 把真实显卡、基础适配器、虚拟显卡分开', () => {
  assert.equal(classifyGpu('NVIDIA GeForce RTX 3060'), 'real');
  assert.equal(classifyGpu('Intel(R) UHD Graphics 630'), 'real');
  assert.equal(classifyGpu('AMD Radeon RX 6600'), 'real');
  assert.equal(classifyGpu('Microsoft Basic Display Adapter'), 'basic');
  assert.equal(classifyGpu('Microsoft Basic Render Driver'), 'basic');
  assert.equal(classifyGpu('VMware SVGA 3D'), 'virtual');
  assert.equal(classifyGpu('Parsec Virtual Display Adapter'), 'virtual');
  assert.equal(classifyGpu(''), 'basic');
});

test('parseWindowsGpus 兼容数组与单对象，字段缺失不乱编', () => {
  const arr = parseWindowsGpus([
    { Name: 'NVIDIA GeForce RTX 3060', AdapterRAM: 4294967296, DriverVersion: '31.0.15.3699' },
    { Name: 'Microsoft Basic Display Adapter', AdapterRAM: 0, DriverVersion: '' },
    { Name: '   ', AdapterRAM: 1 },
  ]);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].name, 'NVIDIA GeForce RTX 3060');
  assert.equal(arr[0].vramMB, 4096);
  assert.equal(arr[0].kind, 'real');
  assert.equal(arr[1].kind, 'basic');
  // AdapterRAM=0 时显存未知必须是 null，不能写成 0MB
  assert.equal(arr[1].vramMB, null);

  const one = parseWindowsGpus({ Name: 'Intel UHD Graphics', AdapterRAM: 536870912 });
  assert.equal(one.length, 1);
  assert.equal(one[0].vramMB, 512);
  assert.deepEqual(parseWindowsGpus(null), []);
});

test('parseMacGpus / parseLspci 只认显示控制器行', () => {
  const mac = parseMacGpus('Graphics/Displays:\n      Chipset Model: Apple M2\n      VRAM (Total): 8 GB\n');
  assert.equal(mac.length, 1);
  assert.equal(mac[0].name, 'Apple M2');

  const lin = parseLspci(
    '00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 620 (rev 07)\n00:1f.3 Audio device: Intel Corporation\n'
  );
  assert.equal(lin.length, 1);
  assert.match(lin[0].name, /Intel Corporation UHD Graphics 620/);
});

/* ---------------------------- Vulkan 判定 ---------------------------- */

test('vulkanVerdict：读不到显卡回 unknown（不是不可用）', () => {
  const v = vulkanVerdict([]);
  assert.equal(v.capable, null);
  assert.match(v.reason, /没能读到显卡列表/);
});

test('vulkanVerdict：只有基础/虚拟显卡判死', () => {
  const v = vulkanVerdict([{ name: 'Microsoft Basic Display Adapter', kind: 'basic', vramMB: null }]);
  assert.equal(v.capable, false);
  assert.match(v.reason, /基础显示适配器或虚拟显卡/);
});

test('vulkanVerdict：自检通过就别再质疑显存', () => {
  const v = vulkanVerdict([{ name: 'GTX 1050', kind: 'real', vramMB: 512 }], {
    usable: true,
    gpu: 'GTX 1050 (Vulkan)',
    error: '',
  });
  assert.equal(v.capable, true);
  assert.match(v.reason, /自检已通过/);
});

test('vulkanVerdict：自检失败要带回原因', () => {
  const v = vulkanVerdict([{ name: 'GTX 1050', kind: 'real', vramMB: 2048 }], {
    usable: false,
    gpu: null,
    error: 'vkCreateInstance failed',
  });
  assert.equal(v.capable, false);
  assert.match(v.reason, /vkCreateInstance/);
});

/* --------------------------- 功能达标判定 --------------------------- */

const hwOf = (ramMB, cores, extra = {}) => ({
  cpu: { model: 'Test CPU', cores, arch: 'x64', platform: 'win32' },
  ram: { totalMB: ramMB, freeMB: ramMB },
  gpu: { devices: [], vulkan: { capable: null, reason: '' }, ...extra },
});

test('AI 抠图：内存达标放行，不达标只警告（允许试）', () => {
  const f = featureOf('matting');
  const good = evaluateFeature(f, hwOf(16384, 8));
  assert.equal(good.level, 'ok');
  assert.equal(good.ok, true);

  const low = evaluateFeature(f, hwOf(2048, 2));
  assert.equal(low.level, 'warn');
  assert.equal(low.ok, false);
  assert.equal(low.canProceedAnyway, true);
  assert.match(low.reason, /内存/);
});

test('AI 抠图：可用内存紧张时达标也要给出提醒', () => {
  const hw = hwOf(16384, 8);
  hw.ram.freeMB = 400;
  const f = evaluateFeature(featureOf('matting'), hw);
  assert.equal(f.level, 'ok');
  const ram = f.checks.find((c) => c.id === 'ram');
  assert.match(ram.note, /可用内存偏少/);
});

test('AI 超分（Vulkan）：没有可用显卡是硬阻断', () => {
  const hw = hwOf(16384, 8, {
    devices: [{ name: 'Microsoft Basic Display Adapter', kind: 'basic', vramMB: null }],
    vulkan: vulkanVerdict([{ name: 'Microsoft Basic Display Adapter', kind: 'basic', vramMB: null }]),
  });
  const f = evaluateFeature(featureOf('upscale-vulkan'), hw);
  assert.equal(f.level, 'blocked');
  assert.equal(f.ok, false);
  assert.equal(f.canProceedAnyway, false);
  assert.match(f.reason, /显卡/);
});

test('AI 超分（Vulkan）：有显卡但没自检时放行（提示以自检为准）', () => {
  const hw = hwOf(16384, 8, {
    devices: [{ name: 'NVIDIA GeForce RTX 3060', kind: 'real', vramMB: 4096 }],
    vulkan: vulkanVerdict([{ name: 'NVIDIA GeForce RTX 3060', kind: 'real', vramMB: 4096 }]),
  });
  const f = evaluateFeature(featureOf('upscale-vulkan'), hw);
  assert.equal(f.level, 'warn');
  assert.equal(f.canProceedAnyway, true);
  const gpu = f.checks.find((c) => c.id === 'gpu');
  assert.match(gpu.note, /自检/);
});

test('AI 超分（Vulkan）：非 Windows 直接判不能跑（运行库只有 win32 包）', () => {
  const hw = hwOf(16384, 8, {
    devices: [{ name: 'Apple M2', kind: 'real', vramMB: null }],
    vulkan: vulkanVerdict([{ name: 'Apple M2', kind: 'real', vramMB: null }]),
  });
  hw.cpu.platform = 'darwin';
  hw.cpu.arch = 'arm64';
  const f = evaluateFeature(featureOf('upscale-vulkan'), hw);
  assert.equal(f.level, 'blocked');
  assert.equal(f.canProceedAnyway, false);
  assert.ok(f.checks.some((c) => c.id === 'platform' && !c.ok));
});

test('AI 超分（Vulkan）：自检通过 + 8G 内存 = 达标', () => {
  const hw = hwOf(16384, 8, {
    devices: [{ name: 'NVIDIA GeForce RTX 3060', kind: 'real', vramMB: 4096 }],
    vulkan: { capable: true, reason: '运行库自检已通过（显卡：RTX 3060）' },
  });
  const f = evaluateFeature(featureOf('upscale-vulkan'), hw);
  assert.equal(f.level, 'ok');
  assert.equal(f.ok, true);
});

test('Swin2SR 档：4G 内存不算达标，但仍可继续', () => {
  const f = evaluateFeature(featureOf('upscale-onnx'), hwOf(4096, 2));
  assert.equal(f.level, 'warn');
  assert.equal(f.canProceedAnyway, true);
});

test('人脸扫描：内存不足只警告（允许试），且不宣称需要显卡', () => {
  const f = featureOf('face');
  assert.ok(f, '人脸扫描应进最低配置表');
  const low = evaluateFeature(f, hwOf(2048, 2));
  assert.equal(low.level, 'warn');
  assert.equal(low.canProceedAnyway, true);
  assert.ok(!low.checks.some((c) => c.id === 'gpu'), '人脸在 CPU 上跑，不该有显卡检查');
  assert.equal(evaluateFeature(f, hwOf(16384, 8)).level, 'ok');
});

test('语义检索（CLIP）：4G 以下只警告，权重常驻要说明', () => {
  const f = featureOf('semantic');
  assert.equal(evaluateFeature(f, hwOf(2048, 2)).level, 'warn');
  assert.ok(f.basis.some((b) => /常驻/.test(b)));
});

test('消除是纯像素算法，任何机器都通过且不宣称需要显卡', () => {
  const f = evaluateFeature(featureOf('inpaint'), hwOf(2048, 1));
  assert.equal(f.level, 'ok');
  assert.equal(f.checks.length, 0);
  assert.match(f.engine, /纯像素/);
  assert.ok(f.basis.some((b) => /不是生成式 AI/.test(b)));
});

test('formatMB 说人话', () => {
  assert.equal(formatMB(4096), '4.0 GB');
  assert.equal(formatMB(16384), '16 GB');
  assert.equal(formatMB(512), '512 MB');
  assert.equal(formatMB(0), '未知');
});

test('每个功能都带标签、判定字段与依据（表不能有半成品行）', () => {
  for (const f of HARDWARE_FEATURES) {
    const r = evaluateFeature(f, hwOf(32768, 16));
    assert.ok(r.id && r.label && r.engine, `${f.id} 缺标签`);
    assert.ok(Array.isArray(r.basis) && r.basis.length > 0, `${f.id} 缺依据`);
    assert.ok(['ok', 'warn', 'blocked'].includes(r.level), `${f.id} level 非法`);
    assert.equal(typeof r.canProceedAnyway, 'boolean');
  }
});
