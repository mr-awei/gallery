import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 复核「4K 合成是否仍占三份全屏缓冲」：
// 3840×2160 RGBA 一份 ≈ 33MB，旧实现同时物化「背景 raw + 前景 raw + 合成输出」≈ 100MB。
// 现在前景是压缩 JPEG buffer、背景是 sharp 管线、输出直接 toFile，不做全屏 raw 物化。
// 这里跑一次真实 4K 合成并采样内存曲线，同时静态守住这条流水线约束。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-4k-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_CLIP = 'off';

const sharp = (await import('sharp')).default;
const { db } = await import('../server/db.js');
const { buildWallpaper } = await import('../server/wallpaper.js');

const SRC = path.join(tmp, 'source-4k.jpg');
const FULL_RGBA = 3840 * 2160 * 4;

test.after(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄偶发占用 */
  }
});

test('4K 静态壁纸合成：只物化一份压缩前景，输出直接写盘', async () => {
  await sharp({
    create: { width: 3840, height: 2160, channels: 3, background: { r: 120, g: 140, b: 160 } },
  })
    .jpeg({ quality: 82 })
    .toFile(SRC);
  db.prepare('INSERT INTO images(abs_path, created_at, width, height) VALUES (?, ?, 3840, 2160)').run(
    SRC,
    new Date().toISOString()
  );
  const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  const usage = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.external + (m.arrayBuffers || 0);
  };
  const before = usage();
  const samples = [];
  const timer = setInterval(() => samples.push(usage()), 10);
  let result;
  try {
    result = await buildWallpaper(id, 'black', { width: 3840, height: 2160, tag: 'verify4k' });
  } finally {
    clearInterval(timer);
  }
  const peak = Math.max(...samples, usage()) - before;
  console.log(
    `  [4K 合成内存曲线] 采样 ${samples.length} 次，峰值增量 ${(peak / 1024 / 1024).toFixed(1)}MB` +
      `（一份全屏 RGBA=${(FULL_RGBA / 1024 / 1024).toFixed(1)}MB）`
  );
  assert.ok(fs.existsSync(result.path), '应生成壁纸文件');
  // 关闭条件是「不再出现三份全屏缓冲」。以前阈值写成 3*FULL_RGBA+64MB，
  // 恰好把三份都放行了 —— 断言和结论完全脱节。现在只允许「一份全屏 RGBA + 16MB 余量」，
  // 低于两份，退化回两份或三份都会直接红。sharp/libvips 的 native 内存不计入
  // heapUsed，所以这条断言拦的是 JS 侧物化，不假装是精确测量。
  assert.ok(peak < FULL_RGBA + 16 * 1024 * 1024, `峰值增量异常：${(peak / 1024 / 1024).toFixed(1)}MB`);

  const source = fs.readFileSync(new URL('../server/wallpaper.js', import.meta.url), 'utf8');
  assert.match(source, /\.composite\(\[\{ input: fg/, '合成应复用压缩前景 buffer');
  assert.match(source, /\.toFile\(outPath\)/, '输出应直接写盘而不是再物化一份全屏 buffer');
  assert.doesNotMatch(source, /\.raw\(\)\s*\.toBuffer\(\);\s*\n\s*const fg/, '前景不应是全屏 raw 像素');
});
