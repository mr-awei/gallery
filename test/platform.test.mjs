import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, platformSummary } from '../server/lib/platform.js';

test('Windows：完整桌面能力', () => {
  const c = capabilitiesFor('win32');
  assert.equal(c.family, 'windows');
  for (const k of ['desktopLayer', 'liveWallpaper', 'multiMonitorWallpaper', 'gpuMeter', 'foregroundApp', 'staticWallpaper', 'screensaver', 'library']) {
    assert.equal(c[k], true, k);
  }
  assert.match(platformSummary(c), /完整桌面能力/);
});

test('macOS / Linux：图库能力齐全，动态壁纸降级但静态壁纸与屏保可用', () => {
  for (const p of ['darwin', 'linux']) {
    const c = capabilitiesFor(p);
    assert.equal(c.liveWallpaper, false);
    assert.equal(c.desktopLayer, false);
    assert.equal(c.gpuMeter, false);
    assert.equal(c.foregroundApp, false);
    assert.equal(c.staticWallpaper, true);
    assert.equal(c.screensaver, true);
    for (const k of ['library', 'openApi', 'lan', 'plugins', 'sync', 'workshop', 'ocr']) {
      assert.equal(c[k], true, `${p}.${k}`);
    }
    assert.match(platformSummary(c), /基础版/);
    assert.match(c.notes.join(''), /静态系统壁纸/);
  }
});

test('未知平台：能力矩阵不谎报，仍能用图库', () => {
  const c = capabilitiesFor('freebsd');
  assert.equal(c.liveWallpaper, false);
  assert.equal(c.staticWallpaper, false);
  assert.equal(c.library, true);
  assert.equal(c.screensaver, true);
});
