import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FK_TABLES, applyForeignKeys, fkTail, foreignKeysEnabled } from '../server/db/foreign-keys.js';
import { installLibrarySchema } from '../server/db/schema.js';

/** 临时库：不碰磁盘，建完就是「新库」形态 */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  installLibrarySchema(db);
  return db;
}

function fkColumns(db, table) {
  return db
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all()
    .map((r) => `${r.from}->${r.table}.${r.to}/${r.on_delete}`);
}

test('新库的关联表全部带外键约束，且动作与清单一致', () => {
  const db = freshDb();
  for (const spec of FK_TABLES) {
    const got = fkColumns(db, spec.table).sort();
    const want = spec.refs.map((r) => `${r.column}->${r.parent}.id/${r.action}`).sort();
    assert.deepEqual(got, want, `${spec.table} 的外键与 foreign-keys.js 的清单不一致`);
  }
  db.close();
});

test('删素材时关联行自动级联删除（不再依赖触发器逐张表清）', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO images (id, abs_path, created_at, tags) VALUES (1, 'a.jpg', '2026-01-01', 'x,y');
    INSERT INTO image_comments (image_id, body, created_at) VALUES (1, '好图', '2026-01-01');
    INSERT INTO image_notes (image_id, body, created_at) VALUES (1, '笔记', '2026-01-01');
    INSERT INTO image_quality (image_id, sharpness, created_at) VALUES (1, 0.5, '2026-01-01');
  `);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM item_tags').get().n), 2);
  db.prepare('DELETE FROM images WHERE id = 1').run();
  for (const t of ['item_tags', 'image_comments', 'image_notes', 'image_quality']) {
    assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n), 0, `${t} 残留了孤儿行`);
  }
  db.close();
});

test('指向不存在父行的插入会被拒绝（真约束，不是事后对账）', () => {
  const db = freshDb();
  db.exec(`INSERT INTO images (id, abs_path, created_at) VALUES (1, 'a.jpg', '2026-01-01')`);
  assert.throws(
    () => db.exec(`INSERT INTO image_folders (image_id, folder_id) VALUES (1, 999)`),
    /FOREIGN KEY/i,
    '不存在的 folder_id 必须当场报错'
  );
  assert.throws(
    () => db.exec(`INSERT INTO item_tags (tag, image_id) VALUES ('x', 999)`),
    /FOREIGN KEY/i
  );
  db.close();
});

test('删人物把脸退回未归属，而不是连脸一起删', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO images (id, abs_path, created_at) VALUES (1, 'a.jpg', '2026-01-01');
    INSERT INTO persons (id, created_at) VALUES (7, '2026-01-01');
    INSERT INTO faces (image_id, person_id, x1, y1, x2, y2, vec, created_at)
      VALUES (1, 7, 0, 0, 10, 10, x'00', '2026-01-01');
  `);
  db.prepare('DELETE FROM persons WHERE id = 7').run();
  const face = db.prepare('SELECT person_id FROM faces').get();
  assert.equal(face?.person_id, null, '人脸应保留，只是失去归属');
  db.close();
});

test('删父夹连带子夹（以前靠 path 前缀 LIKE 手工删）', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO folders (id, name, parent_id, path, created_at, updated_at)
      VALUES (1, '父', NULL, '/1/', '2026-01-01', '2026-01-01'),
             (2, '子', 1, '/1/2/', '2026-01-01', '2026-01-01');
  `);
  db.prepare('DELETE FROM folders WHERE id = 1').run();
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM folders').get().n), 0);
  db.close();
});

test('老库重建：补上约束、清掉孤儿、保住正常行与 id', () => {
  const db = new DatabaseSync(':memory:');
  // 老形态：没有 REFERENCES，也没有 sqlite_sequence 依赖
  db.exec(`
    CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, abs_path TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER, path TEXT NOT NULL DEFAULT '');
    CREATE TABLE item_tags (tag TEXT NOT NULL, image_id INTEGER NOT NULL, PRIMARY KEY (tag, image_id));
    CREATE INDEX idx_item_tags_image ON item_tags(image_id);
    CREATE TABLE image_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
    -- 触发器会在重建表期间「短暂指向不存在的表」：ALTER TABLE ... RENAME 默认要重新
    -- 解析全库触发器，就会报 error in trigger ... no such table（实测踩过），
    -- 所以重建必须临时打开 legacy_alter_table。这条触发器就是防空转的哨兵。
    CREATE TRIGGER trg_item_tags_delete AFTER DELETE ON images BEGIN DELETE FROM item_tags WHERE image_id = OLD.id; END;
    INSERT INTO images (id, abs_path, created_at) VALUES (1, 'a.jpg', '2026-01-01'), (9, 'b.jpg', '2026-01-01');
    INSERT INTO folders (id, name, parent_id, path) VALUES (1, '父', 0, '/1/'), (2, '子', 1, '/1/2/');
    INSERT INTO item_tags (tag, image_id) VALUES ('keep', 1), ('orphan', 404);
    INSERT INTO image_comments (image_id, body, created_at) VALUES (1, '留着', '2026-01-01'), (404, '孤儿', '2026-01-01');
  `);

  const r = applyForeignKeys(db);
  assert.equal(r.skipped, false);
  assert.equal(r.violations, 0, '重建后不该还剩不一致关联');
  assert.deepEqual(r.failures, []);
  assert.ok(r.rebuilt.some((x) => x.table === 'item_tags'), 'item_tags 应该被重建');

  assert.deepEqual(fkColumns(db, 'item_tags'), ['image_id->images.id/CASCADE']);
  assert.equal(foreignKeysEnabled(db), true, '重建结束必须把外键开关打开');

  // 孤儿被清，正常行还在
  assert.deepEqual(
    db.prepare('SELECT tag FROM item_tags').all().map((x) => x.tag),
    ['keep']
  );
  assert.deepEqual(
    db.prepare('SELECT body FROM image_comments').all().map((x) => x.body),
    ['留着']
  );
  // parent_id = 0 的哨兵被归一成 NULL，否则新约束永远插不进根级文件夹
  assert.equal(db.prepare('SELECT parent_id FROM folders WHERE id = 1').get().parent_id, null);
  // 索引要补回来
  assert.ok(
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='idx_item_tags_image'").get(),
    '重建后索引丢了会让按图查标签变全表扫'
  );

  // 幂等：第二次跑只查标记
  const again = applyForeignKeys(db);
  assert.equal(again.skipped, true);
  assert.equal(again.rebuilt.length, 0);
  db.close();
});

test('fkTail 只给登记过的表追加约束', () => {
  assert.match(fkTail('item_tags'), /FOREIGN KEY \(image_id\) REFERENCES images\(id\) ON DELETE CASCADE/);
  assert.match(fkTail('faces'), /person_id\) REFERENCES persons\(id\) ON DELETE SET NULL/);
  assert.equal(fkTail('images'), '', 'images 是父表，不该被追加');
  assert.equal(fkTail('trash'), '', '回收站记录要留档，刻意不建外键');
});
