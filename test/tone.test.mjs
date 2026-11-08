/** 影调 / 曲线纯函数单测（预览与写回共用同一套公式，公式漂了图就变了） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { curveFn, hasCurveAdjust, hasToneAdjust, toneMap, wbFromRgb, wbGains } from '../web/src/lib/tone.ts';
import { analyzePixels, autoToneFromPixels, autoWbFromPixels, classifyScene } from '../web/src/lib/auto-tone.ts';
import { renderPixels } from '../web/src/lib/adjust.ts';
import { ADJUST_DEFAULTS } from '../web/src/types.ts';

test('curveFn：无控制点时是恒等映射', () => {
  const f = curveFn([]);
  for (const x of [0, 0.25, 0.5, 0.75, 1]) assert.ok(Math.abs(f(x) - x) < 1e-9);
});

test('curveFn：恒等控制点保持恒等', () => {
  const f = curveFn([[0, 0], [128, 128], [255, 255]]);
  for (const x of [0, 0.2, 0.5, 0.8, 1]) assert.ok(Math.abs(f(x) - x) < 1e-6, `x=${x}`);
});

test('curveFn：提亮曲线在中间调上调且两端固定', () => {
  const f = curveFn([[128, 190]]);
  assert.ok(f(0.5) > 0.5);
  assert.ok(Math.abs(f(0) - 0) < 1e-9);
  assert.ok(Math.abs(f(1) - 1) < 1e-9);
});

test('curveFn：单调控制点产生单调输出（不超过 1e-3 抖动）', () => {
  const f = curveFn([[64, 40], [128, 120], [192, 220]]);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = f(i / 100);
    assert.ok(v >= prev - 1e-3, `x=${i / 100} 出现回落`);
    prev = v;
  }
});

test('toneMap：结果被夹在 0..1', () => {
  assert.equal(toneMap(-0.5, 0, 0, 0, 0), 0);
  assert.equal(toneMap(1.5, 0, 0, 0, 0), 1);
  assert.equal(toneMap(0.5, 1, 1, 0.5, -0.5) >= 0, true);
  assert.equal(toneMap(0.5, 1, 1, 0.5, -0.5) <= 1, true);
});

test('toneMap：提阴影主要作用于暗部，提亮高光主要作用于亮部', () => {
  const dark = 0.2;
  const bright = 0.8;
  const liftDark = toneMap(dark, 0.5, 0, 0, 0) - dark;
  const liftBright = toneMap(bright, 0.5, 0, 0, 0) - bright;
  assert.ok(liftDark > 0);
  assert.ok(liftDark > liftBright * 10, `阴影提亮应对暗部远强于亮部：${liftDark} vs ${liftBright}`);

  const hiDark = toneMap(dark, 0, 0.5, 0, 0) - dark;
  const hiBright = toneMap(bright, 0, 0.5, 0, 0) - bright;
  assert.ok(hiBright > 0);
  assert.ok(hiBright > hiDark * 10, `高光提亮应对亮部远强于暗部：${hiBright} vs ${hiDark}`);
});

test('hasToneAdjust / hasCurveAdjust 只在真的调过时为 true', () => {
  assert.equal(hasToneAdjust({}), false);
  assert.equal(hasToneAdjust({ shadows: 0, highlights: 0 }), false);
  assert.equal(hasToneAdjust({ shadows: 10 }), true);
  assert.equal(hasCurveAdjust({}), false);
});

test('wbFromRgb：中性灰算出接近 0 的色温/色调', () => {
  const { temperature, tint } = wbFromRgb(128, 128, 128);
  assert.ok(Math.abs(temperature) < 1, `temperature=${temperature}`);
  assert.ok(Math.abs(tint) < 1, `tint=${tint}`);
});

test('wbFromRgb：偏蓝画面需要向暖调拉（与偏红方向相反）', () => {
  const blue = wbFromRgb(80, 120, 200);
  const red = wbFromRgb(200, 120, 80);
  assert.ok(blue.temperature > red.temperature);
});

test('wbGains：无白平衡时三通道增益均为 1', () => {
  const [r, g, b] = wbGains({
    temperature: 0,
    tint: 0,
  });
  assert.ok(Math.abs(r - 1) < 1e-6);
  assert.ok(Math.abs(g - 1) < 1e-6);
  assert.ok(Math.abs(b - 1) < 1e-6);
});

test('wbGains：暖调抬高红、压低蓝，且增益恒正', () => {
  const [r, , b] = wbGains({ temperature: 40, tint: 0 });
  assert.ok(r > 1);
  assert.ok(b < 1);
  const gains = wbGains({ temperature: -100, tint: 100 });
  for (const g of gains) assert.ok(g > 0 && Number.isFinite(g));
});

/* ---------------- 全自动调色 ---------------- */
/** 造一张 RGBA 图：fill(i) 返回 [r,g,b] */
function makeImage(n, fill) {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = fill(i, n);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** 贴顶像素占比（三通道任一 ≥250 就算撞白，比只看亮度严格） */
function clipRatio(data, channels = 4) {
  let n = 0;
  let c = 0;
  for (let i = 0; i + 2 < data.length; i += channels) {
    n++;
    if (Math.max(data[i], data[i + 1], data[i + 2]) >= 250) c++;
  }
  return c / Math.max(1, n);
}

/** 跑一遍「自动 → 预览管线」，返回参数与渲染结果 */
function autoRender(data, channels = 4) {
  const t = autoToneFromPixels(data, channels);
  const out = new Uint8ClampedArray(data);
  renderPixels(out, channels, { ...ADJUST_DEFAULTS, ...t });
  return { t, out };
}

/* ---------------- 全自动调色：观感契约 ---------------- */

test('全自动：暗图提亮，但白场仍在安全线内（不多撞白）', () => {
  const data = makeImage(4000, (i) => {
    const v = 30 + (i % 60);
    return [v, v, v];
  });
  const { t, out } = autoRender(data);
  assert.ok(t.exposure > 0, `expect 提亮，got ${t.exposure}`);
  assert.ok(t.exposure <= 100, `提亮过头，got ${t.exposure}`);
  const p99 = analyzePixels(data, 4).p99;
  assert.ok(p99 * (1 + t.exposure * 0.008) <= 0.985, `曝光后白场越界：${p99 * (1 + t.exposure * 0.008)}`);
  assert.ok(clipRatio(out) <= clipRatio(data) + 0.01, '暗图提亮不该反而撞白');
});

test('全自动：已经撞白的图回收高光、不推白点', () => {
  const data = makeImage(4000, (i) => {
    const v = i % 10 === 0 ? 120 : 253;
    return [v, v, v];
  });
  const { t, out } = autoRender(data);
  assert.ok(t.highlights < 0, `expect 压高光，got ${t.highlights}`);
  assert.ok(t.whites <= 0, `already 溢出不该再加白点，got ${t.whites}`);
  assert.ok(clipRatio(out) <= clipRatio(data) + 0.01, `撞白比例涨了：${clipRatio(data)} → ${clipRatio(out)}`);
});

test('全自动：灰雾图靠曲线去灰（压黑点 + 拉中间对比），而不是只堆滑块', () => {
  const data = makeImage(4000, (i) => {
    const v = 120 + (i % 40);
    return [v, v, v];
  });
  const { t } = autoRender(data);
  assert.ok(t.curves.rgb.length >= 3, `灰图必须给出主曲线，got ${JSON.stringify(t.curves.rgb)}`);
  const f = curveFn(t.curves.rgb);
  assert.ok(f(0.5) < 0.46, `中间调要压下来才通透，got ${f(0.5).toFixed(3)}`);
  assert.ok(f(0.02) <= 0.05, `暗部要压黑（去灰），got ${f(0.02).toFixed(3)}`);
  // 亮部不能被压成灰；但曝光是最后一道乘法，曲线尾巴必须给它留余量（0.976/m），
  // 所以这里只要求"仍然够亮"，不要求贴着 1.0
  assert.ok(f(0.95) > 0.85, `亮部被压灰了，got ${f(0.95).toFixed(3)}`);
  assert.ok(f(1) >= f(0.95), '尾巴不能回头');
});

test('全自动：曲线控制点单调递增、值域合法、白场锚点收在安全线内', () => {
  // 黑到白的完整阶梯：既有暗部也有纯白，才能同时验证「压黑」和「保白」
  const data = makeImage(6000, (i) => {
    const v = i % 256;
    return [v, Math.round(v * 0.9), Math.round(v * 0.8)];
  });
  const { t, out } = autoRender(data);
  const pts = t.curves.rgb;
  assert.ok(pts.length >= 3);
  assert.deepEqual(pts[0], [0, 0], '首点必须在原点');
  // 曝光乘在曲线之后，所以曲线末点可以低于 255（留余量），但 x 必须收在 255
  assert.equal(pts[pts.length - 1][0], 255, '末点必须落在 255（曲线面板要求首末点固定）');
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i][0] > pts[i - 1][0], 'x 必须严格递增');
    assert.ok(pts[i][1] >= pts[i - 1][1], 'y 不能回头（否则暗部发灰）');
    assert.ok(pts[i][1] <= 255 && pts[i][1] >= 0);
  }
  // 「白场锚点」（曲线倒数第二点）必须留在 0.985 以内
  const anchor = pts[pts.length - 2];
  assert.ok(anchor[1] / 255 <= 0.9851, `白场锚点越界：${anchor[1] / 255}`);
  assert.ok(clipRatio(out) <= clipRatio(data) + 0.01, `撞白比例涨了：${clipRatio(data)} → ${clipRatio(out)}`);
  // 纯白调完必须还是白：曲线留余量不能把白压成灰
  let white = 255;
  for (let i = 0; i < out.length; i += 4) {
    if (data[i] === 255) white = Math.min(white, Math.max(out[i], out[i + 1], out[i + 2]));
  }
  assert.ok(white >= 235, `纯白被压成灰：${white}`);
});

test('全自动：中性灰不动白平衡与饱和；发闷的图才补自然饱和度', () => {
  const gray = makeImage(2000, () => [128, 128, 128]);
  const tg = autoToneFromPixels(gray, 4);
  assert.ok(Math.abs(tg.temperature) <= 2 && Math.abs(tg.tint) <= 2, `neutral 白平衡不该动：${tg.temperature}/${tg.tint}`);

  const dull = makeImage(2000, (i) => {
    const v = 100 + (i % 30);
    return [v, v - 4, v - 8];
  });
  const td = autoToneFromPixels(dull, 4);
  assert.ok(td.vibrance >= 0, `expect 自然饱和度不为负，got ${td.vibrance}`);
});

test('全自动：正常曝光的照片只做微调（自动不该大幅乱动好照片）', () => {
  const data = makeImage(4000, (i) => {
    const v = 100 + (i % 50);
    return [v, v, v];
  });
  const t = autoToneFromPixels(data, 4);
  // 择优会给「稍微偏闷」的好照片补一点点亮度，这没问题；但不能动成另一张照片
  assert.ok(Math.abs(t.exposure) <= 8, `正常曝光的图只该微调，got ${t.exposure}`);
  assert.ok(t.whites >= 0, `本轮不该压白点，got ${t.whites}`);
});

test('全自动：舞台/逆光（暗背景 + 大面积撞白）不许加曝光，还要回收高光', () => {
  const data = makeImage(6000, (i) => {
    const k = i % 100;
    if (k < 77) return [8, 6, 10];
    if (k < 90) return [252, 250, 255];
    return [200, 195, 205];
  });
  const t = autoToneFromPixels(data, 4);
  assert.ok(t.exposure <= 0, `撞白的图不许再加曝光，got ${t.exposure}`);
  assert.ok(t.exposure >= -30, `也不能一路压到黑，got ${t.exposure}`);
  assert.ok(t.highlights < 0, `高光必须回收，got ${t.highlights}`);
  assert.ok(t.whites <= 0, `撞白的图不该推白点，got ${t.whites}`);
});

test('全自动：偏色图只做部分白平衡（不把舞台灯抹平）', () => {
  const data = makeImage(3000, (i) => [90 + (i % 10), 150 + (i % 10), 100 + (i % 10)]);
  const t = autoToneFromPixels(data, 4);
  const full = autoWbFromPixels(data, 4);
  assert.notEqual(full.tint, 0, '这张图本该有白平衡校正量');
  assert.ok(Math.abs(t.tint) < Math.abs(full.tint), `全自动要比满量保守：${t.tint} vs ${full.tint}`);
  assert.equal(Math.sign(t.tint), Math.sign(full.tint), '方向不能反');
  assert.ok(Math.abs(t.temperature) <= Math.abs(full.temperature) + 1);
});

test('全自动：人像保护肤色（橙红降饱和、橙色提亮、自然饱和度收敛）', () => {
  const data = makeImage(4000, (i) => {
    const v = i % 20;
    return [214 + v > 255 ? 255 : 214 + v, 168 + (v >> 1), 138 + (v >> 2)];
  });
  const s = analyzePixels(data, 4);
  assert.ok(s.skinFrac > 0.4, `肤色占比要认得出来，got ${s.skinFrac.toFixed(2)}`);
  assert.equal(classifyScene(s).portrait, true);
  const t = autoToneFromPixels(data, 4);
  assert.ok(t.colorMixer.bands.orange.s < 0, `橙带该降饱和，got ${t.colorMixer.bands.orange.s}`);
  assert.ok(t.colorMixer.bands.orange.l > 0, `橙色该提亮一点，got ${t.colorMixer.bands.orange.l}`);
  assert.ok(t.vibrance <= 12, `人像别把皮肤推到发红，got ${t.vibrance}`);
});

test('全自动：蓝天/绿植单独加强（不是全图一刀切加饱和）', () => {
  const data = makeImage(4000, (i) => {
    const k = i % 100;
    if (k < 60) return [70, 130, 220];
    if (k < 90) return [60, 150, 70];
    return [210, 210, 210];
  });
  const t = autoToneFromPixels(data, 4);
  assert.ok(t.colorMixer.bands.blue.s > 0, `蓝天该加饱和，got ${t.colorMixer.bands.blue.s}`);
  assert.ok(t.colorMixer.bands.blue.l < 0, `蓝天该压暗一点才深邃，got ${t.colorMixer.bands.blue.l}`);
  assert.ok(t.colorMixer.bands.green.s > 0, `绿植该加饱和，got ${t.colorMixer.bands.green.s}`);
});

test('全自动：多种图上都不新增撞白（硬约束）', () => {
  const cases = [
    (i) => [30 + (i % 60), 30 + (i % 60), 30 + (i % 60)],
    (i) => [200 + (i % 55), 190 + (i % 55), 210 + (i % 40)],
    (i) => [120 + (i % 40), 118 + (i % 40), 122 + (i % 40)],
    (i) => [i % 5 === 0 ? 240 : 20, i % 5 === 0 ? 240 : 20, i % 5 === 0 ? 240 : 20],
  ];
  for (const fill of cases) {
    const data = makeImage(6000, fill);
    const { out } = autoRender(data);
    assert.ok(clipRatio(out) <= clipRatio(data) + 0.01, `撞白比例涨了：${clipRatio(data)} → ${clipRatio(out)}`);
  }
});

test('全自动：空图返回全 0，不产生 NaN', () => {
  const t = autoToneFromPixels(new Uint8ClampedArray(0), 4);
  for (const k of ['temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation', 'vibrance']) {
    assert.equal(t[k], 0);
  }
  assert.deepEqual(t.curves.rgb, []);
});

test('全自动：2MP 预览图的分析耗时在预算内', () => {
  const data = makeImage(700000, (i) => [i % 256, (i * 3) % 256, (i * 7) % 256]);
  const t0 = process.hrtime.bigint();
  autoToneFromPixels(data, 4);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 400, `分析太慢：${ms.toFixed(0)}ms`);
});
