/**
 * 非破坏编辑的几何运算契约：
 * 旋转换向、裁切取框、成品尺寸推算——这三件事算错不会报错，只会让用户看到
 * 「少一块」或者构图偏，所以必须钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRaw, effectiveSize, rotateRaw } from '../server/lib/nd-geometry.js';

/** 造一张 width×height 的灰度图，像素值 = 行优先序号，方便断言搬运结果 */
function gray(w, h) {
  const data = Buffer.allocUnsafe(w * h);
  for (let i = 0; i < w * h; i++) data[i] = i;
  return { data, width: w, height: h, channels: 1 };
}

test('rotateRaw：顺时针 90° 的像素落点与宽高互换', () => {
  // 2×3: [0 1 / 2 3 / 4 5] → 顺时针后 3×2: [4 2 0 / 5 3 1]
  const out = rotateRaw(gray(2, 3), 'cw');
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  assert.deepEqual([...out.data], [4, 2, 0, 5, 3, 1]);
});

test('rotateRaw：逆时针 90° 是顺时针的逆运算', () => {
  const src = gray(2, 3);
  const once = rotateRaw(src, 'cw');
  const back = rotateRaw(once, 'ccw');
  assert.equal(back.width, 2);
  assert.equal(back.height, 3);
  assert.deepEqual([...back.data], [...src.data]);
});

test('rotateRaw：RGB 三通道按通道整体搬运，不串色', () => {
  // 1×2，像素 A=(1,2,3) 在上，B=(4,5,6) 在下；顺时针后 B 在左、A 在右
  const img = { data: Buffer.from([1, 2, 3, 4, 5, 6]), width: 1, height: 2, channels: 3 };
  const out = rotateRaw(img, 'cw');
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.deepEqual([...out.data], [4, 5, 6, 1, 2, 3]);
});

test('cropRaw：归一化框换算成像素并保证不越界', () => {
  const src = gray(4, 4);
  const out = cropRaw(src, { rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } });
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  // 右上角 2×2：第 1 行 [2,3]，第 2 行 [6,7]
  assert.deepEqual([...out.data], [2, 3, 6, 7]);
});

test('cropRaw：右下班角粗取整也不越界（宽高至少 1 像素）', () => {
  const src = gray(3, 3);
  const out = cropRaw(src, { rect: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } });
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.deepEqual([...out.data], [8]);
});

test('cropRaw：空框/零面积不改图（避免把整张图弄没了）', () => {
  const src = gray(2, 2);
  const out = cropRaw(src, { rect: { x: 0, y: 0, w: 0, h: 0 } });
  assert.equal(out, src);
});

test('effectiveSize：旋转换宽高、裁切按比例缩、输出尺寸优先', () => {
  const row = { width: 4000, height: 3000 };
  assert.deepEqual(effectiveSize(row, []), { width: 4000, height: 3000 });
  assert.deepEqual(effectiveSize(row, [{ kind: 'rotate', params: { dir: 'cw' } }]), {
    width: 3000,
    height: 4000,
  });
  assert.deepEqual(
    effectiveSize(row, [
      { kind: 'crop', params: { rect: { x: 0, y: 0, w: 0.5, h: 0.5 } } },
    ]),
    { width: 2000, height: 1500 }
  );
  assert.deepEqual(
    effectiveSize(row, [
      { kind: 'crop', params: { rect: { x: 0, y: 0, w: 0.5, h: 0.5 } } },
      { kind: 'rotate', params: { dir: 'ccw' } },
      { kind: 'crop', params: { rect: { x: 0, y: 0, w: 1, h: 0.5 } } },
    ]),
    { width: 1500, height: 1000 },
    '裁切框相对「当前画面」，必须按顺序推算'
  );
  assert.deepEqual(
    effectiveSize(row, [
      { kind: 'crop', params: { rect: { x: 0, y: 0, w: 1, h: 1 }, outWidth: 800, outHeight: 600 } },
    ]),
    { width: 800, height: 600 }
  );
});
