import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 守住「颜色搜索 / 偏好训练 / 知识库重打分不再全表进内存」：
// 三处都改成了按 id 游标分批。用超过两批（2000 + 500）的数据验证游标
// 不会漏掉后面的页，也不会因为分批事务丢写。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-batchscan-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_CLIP = 'off';
process.env.TUKU_MODEL_DIR = path.join(tmp, 'models');

const { db } = await import('../server/db.js');
const { scoreByColor, searchByColor } = await import('../server/search.js');
const { rescoreAll } = await import('../server/kb.js');
const { trainPreference } = await import('../server/preference.js');

test.after(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄偶发占用，留给系统临时目录 */
  }
});

const TOTAL = 2500;
const now = new Date().toISOString();
const cols = new Set(db.prepare('PRAGMA table_info(images)').all().map((r) => r.name));
for (const c of ['dominant', 'rating', 'favorite', 'score', 'score_reason', 'pref', 'width', 'height', 'hue']) {
  assert.ok(cols.has(c), `images 缺少列 ${c}`);
}

const ins = db.prepare(
  `INSERT INTO images(abs_path, created_at, dominant, rating, favorite, score, score_reason, pref, width, height, hue)
   VALUES (?, ?, ?, ?, ?, 100, '', 0, 800, 600, 'red')`
);
db.exec('BEGIN');
for (let i = 1; i <= TOTAL; i++) {
  const pos = i <= 12 ? 1 : 0;
  const neg = i > 12 && i <= 24 ? 1 : 0;
  ins.run(path.join(tmp, `img-${i}.jpg`), now, '#ff0000', neg, pos);
}
db.exec('COMMIT');

test('颜色搜索按游标扫完全库，且 topK 只留结果不留在途数据', () => {
  assert.equal(scoreByColor('#ff0000', 48, 0).length, TOTAL, '游标必须推进到最后一批');
  assert.equal(scoreByColor('#ff0000', 48, 5).length, 5);
  assert.equal(searchByColor('#ff0000', 48, 7).length, 7);
});

test('知识库重打分分批事务覆盖全库，不漏最后一页', () => {
  db.prepare(
    `INSERT INTO kb_rules(type, value, label, weight, hits, origin, enabled, created_at, updated_at)
     VALUES ('resolution', '10000', '低清', 10, 1, 'user', 1, ?, ?)`
  ).run(now, now);
  const r = rescoreAll();
  assert.equal(r.updated, TOTAL);
  assert.equal(r.written, TOTAL, '每批都要写，且分数没变的行不重复写');
  const last = db.prepare('SELECT score FROM images ORDER BY id ASC LIMIT 1').get();
  assert.equal(last.score, 90, 'id 最小的那批也必须被重打分');
});

test('偏好训练只取行为信号样本，打分写回仍覆盖全库', () => {
  const r = trainPreference();
  assert.equal(r.ok, true, `训练应成功：${JSON.stringify(r)}`);
  assert.equal(r.samples, 24, '没有行为信号的图不参与训练');
  assert.equal(r.pos, 12);
  assert.equal(r.neg, 12);
  assert.equal(r.updated, TOTAL, '写回游标必须推进到最后一批');
  const last = db.prepare('SELECT pref FROM images ORDER BY id ASC LIMIT 1').get();
  assert.ok(Number.isFinite(last.pref) && last.pref >= 0 && last.pref <= 100);
});
