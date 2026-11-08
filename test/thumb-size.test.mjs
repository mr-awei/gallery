/**
 * 缩略图尺寸契约（用户需求：滑块无极 + 五档预设，默认落在「中小」）：
 * 默认值必须就是「中小」档，否则老用户升级后画面会莫名其妙变大/变小。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { THUMB_DEFAULT, THUMB_MAX, THUMB_MIN, THUMB_PRESETS, clampThumbWidth, thumbPresetOf } from '../web/src/lib/thumb-size.ts';

test('五档预设：小/中小/中/中大/大，宽度递增且唯一', () => {
  assert.deepEqual(
    THUMB_PRESETS.map((p) => p.label),
    ['小', '中小', '中', '中大', '大']
  );
  const widths = THUMB_PRESETS.map((p) => p.width);
  assert.deepEqual([...widths].sort((a, b) => a - b), widths, '宽度必须递增');
  assert.equal(new Set(widths).size, widths.length);
  for (const w of widths) {
    assert.ok(w >= THUMB_MIN && w <= THUMB_MAX, `${w} 不在滑块区间内`);
  }
});

test('默认值 = 中小档（老版默认 250 不能被改掉）', () => {
  assert.equal(THUMB_DEFAULT, 250);
  assert.equal(thumbPresetOf(THUMB_DEFAULT)?.label, '中小');
});

test('clampThumbWidth：越界收边、脏值回落默认', () => {
  assert.equal(clampThumbWidth(10), THUMB_MIN);
  assert.equal(clampThumbWidth(9999), THUMB_MAX);
  assert.equal(clampThumbWidth(Number.NaN), THUMB_DEFAULT);
  assert.equal(clampThumbWidth(320.6), 321, '滑块像素值取整');
});

test('thumbPresetOf：滑块拖到档位附近仍算该档，偏远则无档位', () => {
  assert.equal(thumbPresetOf(THUMB_DEFAULT + 5)?.label, '中小');
  assert.equal(thumbPresetOf(THUMB_DEFAULT + 40), null);
});
