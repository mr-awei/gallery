import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ORPHAN_RULES, cleanOrphans, scanOrphans } from '../server/lib/integrity.js';

/** 最小可跑的表结构：只建规则涉及且会插数据的几张 */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE images (id INTEGER PRIMARY KEY, stack_id INTEGER);
    CREATE TABLE folders (id INTEGER PRIMARY KEY, parent_id INTEGER, cover_image_id INTEGER);
    CREATE TABLE persons (id INTEGER PRIMARY KEY);
    CREATE TABLE playlists (id INTEGER PRIMARY KEY);
    CREATE TABLE item_tags (image_id INTEGER, tag TEXT);
    CREATE TABLE clip_vec (image_id INTEGER, v BLOB);
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY, playlist_id INTEGER, image_id INTEGER);
    CREATE TABLE trash (id INTEGER PRIMARY KEY, image_id INTEGER);
    INSERT INTO images (id, stack_id) VALUES (1, NULL), (2, 1);
    INSERT INTO folders (id, parent_id, cover_image_id) VALUES (1, NULL, 1);
    INSERT INTO persons (id) VALUES (1);
    INSERT INTO playlists (id) VALUES (1);
  `);
  return db;
}

test('扫描能数出各类孤儿，NULL 与 0 这两种「没关联」都不算孤儿', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO item_tags (image_id, tag) VALUES (1, 'a'), (99, 'b'), (100, 'c');
    INSERT INTO clip_vec (image_id, v) VALUES (98, x'00');
    INSERT INTO playlist_items (playlist_id, image_id) VALUES (1, 97);
    INSERT INTO trash (image_id) VALUES (1);
    -- 真实库里 stack_id 全库都是 0、person_id 未归属是 NULL，不能被当成孤儿
    INSERT INTO images (id, stack_id) VALUES (3, 0);
    INSERT INTO persons (id) VALUES (2);
  `);
  const r = scanOrphans(db);
  const get = (t) => r.byTable.find((x) => x.table === t)?.count || 0;
  assert.equal(get('item_tags'), 2);
  assert.equal(get('clip_vec'), 1);
  assert.equal(get('playlist_items'), 1);
  assert.equal(get('trash'), 0);
  assert.equal(get('images'), 0, 'stack_id = 0 是「未堆叠」，不是孤儿');
  assert.equal(r.total, 4);
  db.close();
});

test('默认 dryRun 只报告不删', () => {
  const db = makeDb();
  db.exec("INSERT INTO item_tags (image_id, tag) VALUES (42, 'x')");
  const r = cleanOrphans(db);
  assert.equal(r.dryRun, true);
  assert.equal(r.total, 1);
  const left = db.prepare('SELECT COUNT(*) AS n FROM item_tags').get();
  assert.equal(Number(left.n), 1, 'dryRun 不该删任何东西');
  db.close();
});

test('真清理后归零，且正常的行不动', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO item_tags (image_id, tag) VALUES (1, 'keep'), (77, 'orphan');
    INSERT INTO clip_vec (image_id, v) VALUES (76, x'00');
  `);
  const r = cleanOrphans(db, { dryRun: false });
  assert.equal(r.dryRun, false);
  assert.equal(r.total, 2);
  assert.equal(scanOrphans(db).total, 0);
  const kept = db.prepare('SELECT tag FROM item_tags').all().map((x) => x.tag);
  assert.deepEqual(kept, ['keep']);
  db.close();
});

test('老库缺表缺列也不会抛错（当成没孤儿）', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE images (id INTEGER PRIMARY KEY)');
  const r = scanOrphans(db);
  assert.equal(r.total, 0);
  assert.deepEqual(r.byTable, []);
  db.close();
});

test('规则表覆盖了库里所有含 image_id 的表（新增表时必须补规则）', () => {
  // 这份清单来自 PRAGMA table_info 实测；漏一张就意味着那张表的孤儿永远清不掉
  const withImageId = [
    'ai_desc',
    'clip_vec',
    'edit_history',
    'edit_ops',
    'faces',
    'image_annotations',
    'image_comments',
    'image_folders',
    'image_notes',
    'image_ocr',
    'image_quality',
    'item_tags',
    'playlist_items',
    'trash',
    'wallpaper_fit',
    'wallpaper_log',
  ];
  const covered = new Set(ORPHAN_RULES.map((r) => r.table));
  for (const t of withImageId) assert.ok(covered.has(t), `${t} 没有孤儿清理规则`);
  // 反方向：规则里不该出现笔误写错的表名（拼错会被静默跳过）
  for (const t of covered) {
    assert.ok(
      withImageId.includes(t) || ['folders', 'images'].includes(t),
      `规则里出现了不该有孤儿清理的表：${t}`
    );
  }
});
