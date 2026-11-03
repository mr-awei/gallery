/**
 * 调色预览（web/src/lib/adjust.ts::renderPixels）与成品（server/lib/edit.js）的一致性原则。
 *
 * 这里不跨进程对比两份实现（后端一 import 就会开库），而是守住几条「算法形状」的硬约束：
 * 影调必须作用在**亮度域**（按比例缩放三通道），曲线才是逐通道。
 * 曾经预览走的是「逐通道 toneMap 查表」，高饱和区域会偏色，与成品对不上；
 * 那套死代码已删，这里防止它被重新发明一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPixels } from '../web/src/lib/adjust.ts';
import { ADJUST_DEFAULTS } from '../web/src/types.ts';

const P = (patch = {}) => ({ ...ADJUST_DEFAULTS, ...patch });

function render(rgb, patch) {
  const data = new Uint8ClampedArray([...rgb, 255]);
  renderPixels(data, 4, P(patch));
  return [data[0], data[1], data[2]];
}

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hue = ([r, g, b]) => {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const d = mx - mn;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};
const hueDiff = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

test('影调作用在亮度域：提亮阴影后高饱和图仍是同一色相', () => {
  const red = [200, 30, 30];
  const out = render(red, { shadows: 70 });
  assert.ok(lum(out) > lum(red), '阴影提亮应让画面整体变亮');
  assert.ok(hueDiff(hue(red), hue(out)) < 1.5, `色相被改变了：${hue(red)} → ${hue(out)}`);
});

test('影调作用在亮度域：中性灰提亮后仍是中性灰', () => {
  const out = render([80, 80, 80], { shadows: 80, highlights: -20 });
  assert.ok(Math.abs(out[0] - out[1]) <= 1 && Math.abs(out[1] - out[2]) <= 1, `出现色偏：${out}`);
  assert.ok(out[0] > 80);
});

test('曲线是逐通道的：只调红通道不动绿蓝', () => {
  // 控制点至少要两个才算「画过曲线」（单点无斜率，内部按恒等处理）
  const out = render([120, 120, 120], {
    curves: { ...ADJUST_DEFAULTS.curves, r: [[0, 0], [128, 200], [255, 255]] },
  });
  assert.ok(out[0] > 150, `红通道应被抬升：${out[0]}`);
  assert.ok(out[1] === 120 && out[2] === 120, `绿/蓝不该变：${out}`);
});

test('只调曝光时没有额外的亮度损失（亮度表不该在无影调时参与）', () => {
  // 影调表的下标是 v|0，若在没调影调时也跑一遍「按亮度比例缩放」，
  // k = floor(y)/y < 1，整幅图会被悄悄压暗（128*1.2 = 153.6，正确的应为 154）
  const out = render([128, 128, 128], { exposure: 25 });
  assert.deepEqual(out, [154, 154, 154]);
});

test('只调曝光时三通道同步缩放，不产生色偏', () => {
  const out = render([60, 30, 15], { exposure: 40 });
  assert.ok(Math.abs(out[0] - 60 * 1.32) <= 1 && Math.abs(out[2] - 15 * 1.32) <= 1, `${out}`);
});

test('默认参数是恒等变换（预览不做多余手脚）', () => {
  for (const px of [[10, 20, 30], [120, 90, 200], [250, 250, 250]]) {
    const out = render(px, {});
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(out[i] - px[i]) <= 1, `${px} → ${out}`);
  }
});

test('白平衡：暖调抬高红、压低蓝', () => {
  const out = render([128, 128, 128], { temperature: 40 });
  assert.ok(out[0] > 128 && out[2] < 128, `${out}`);
});
