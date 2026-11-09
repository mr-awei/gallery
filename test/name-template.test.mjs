import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NAME_TEMPLATE_PRESETS,
  NAME_TEMPLATE_TOKENS,
  previewNameTemplate,
  renderNameTemplate,
  uniqueTargetName,
} from '../server/lib/name-template.js';

const fixedDate = new Date(2026, 10, 9, 14, 5, 3); // 2026-11-09 14:05:03

test('模板渲染：占位符、日期、序号与自动补扩展名', () => {
  const out = renderNameTemplate('{date}-{index}{ext}', {
    ext: 'jpg',
    index: 7,
    date: fixedDate,
  });
  assert.equal(out, '20261109-0007.jpg');

  const full = renderNameTemplate('{keyword}_{source}_{width}x{height}_{name}{ext}', {
    keyword: '春季 选品',
    source: 'lan',
    width: 1920,
    height: 1080,
    originalName: 'DSC_0012.jpg',
    ext: 'jpg',
    date: fixedDate,
  });
  assert.equal(full, '春季 选品_lan_1920x1080_DSC_0012.jpg');
  assert.ok(NAME_TEMPLATE_PRESETS.length >= 4);
  assert.ok(NAME_TEMPLATE_TOKENS.some((t) => t.token === '{index}'));
});

test('模板渲染：过滤非法字符、未知占位符保留、空模板有兜底', () => {
  const out = renderNameTemplate('{keyword}/{name}{ext}', {
    keyword: 'a:b*c?',
    originalName: 'weird\nname.jpg',
    ext: 'JPG',
    date: fixedDate,
  });
  assert.ok(!/[\\/:*?"<>|\r\n\t]/.test(out));
  assert.ok(out.endsWith('.jpg'));
  assert.ok(renderNameTemplate('{unknown}', { ext: 'png' }).includes('unknown'));
  assert.ok(renderNameTemplate('', { ext: 'png', date: fixedDate }).endsWith('.png'));
});

test('重名自动加 -1 / -2，不覆盖已有文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-name-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
    assert.equal(uniqueTargetName(dir, 'a.jpg'), 'a-1.jpg');
    fs.writeFileSync(path.join(dir, 'a-1.jpg'), 'x');
    assert.equal(uniqueTargetName(dir, 'a.jpg'), 'a-2.jpg');
    assert.equal(uniqueTargetName(dir, 'b.jpg'), 'b.jpg');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放有延迟，交给系统清理 */
    }
  }
});

test('预览：20 个目标名逐条递增，同名自动加后缀', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    title: `示例 ${i + 1}.jpg`,
    abs_path: `示例 ${i + 1}.jpg`,
    keyword: '壁纸',
    source: 'local',
    width: 800,
    height: 600,
    created_at: fixedDate.toISOString(),
  }));
  const names = previewNameTemplate('{date}-{index}{ext}', rows);
  assert.equal(names.length, 20);
  assert.equal(names[0], '20261109-0001.jpg');
  assert.equal(names[19], '20261109-0020.jpg');
  assert.equal(new Set(names).size, 20);

  // 模板里没有 {index}：20 张全同名，必须自动加后缀而不是互相覆盖
  const same = previewNameTemplate('{keyword}{ext}', rows);
  assert.equal(same.length, 20);
  assert.equal(new Set(same).size, 20);
  assert.equal(same[0], '壁纸.jpg');
  assert.equal(same[1], '壁纸-1.jpg');
});
