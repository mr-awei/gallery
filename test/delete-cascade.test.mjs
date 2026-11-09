import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 复核「删素材要连带清干净」：
 * 以前只有回收站 / 导入两条路径手工清关联，去重回滚与批量淘汰直接 DELETE images
 * 就留下孤儿 —— 文件夹张数虚高、封面指向已删图、评论永久残留、向量还能把已删素材召回。
 * 现在统一由删除触发器兜住，任何删除路径都该干净。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-cascade-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_CLIP = 'off';

const { db, getPathIndexState, retryPathIndex } = await import('../server/db.js');

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

const now = new Date().toISOString();
const insImg = db.prepare('INSERT INTO images (abs_path, title, created_at) VALUES (?, ?, ?)');
const insFolder = db.prepare(
  'INSERT INTO folders (name, parent_id, path, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)'
);

const mkImage = (name) => Number(insImg.run(path.join(tmp, name), name, now).lastInsertRowid);

const countFor = (table, imageId) =>
  Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE image_id = ?`).get(imageId)?.c) || 0;

test('删素材后：文件夹 / 评论 / 向量 / 画质 / 标注 / OCR 全部跟着消失', () => {
  const img = mkImage('a.jpg');
  const folderId = Number(insFolder.run('测试夹', '/x/', now, now).lastInsertRowid);
  db.prepare('INSERT INTO image_folders (image_id, folder_id) VALUES (?, ?)').run(img, folderId);
  db.prepare('INSERT INTO image_comments (image_id, body, created_at) VALUES (?, ?, ?)').run(img, '一条评论', now);
  db.prepare('INSERT INTO clip_vec (image_id, dim, vec, created_at) VALUES (?, ?, ?, ?)').run(
    img,
    4,
    Buffer.alloc(16),
    now
  );
  db.prepare('INSERT INTO image_quality (image_id, sharpness, created_at) VALUES (?, ?, ?)').run(img, 0.5, now);
  db.prepare('INSERT INTO image_annotations (image_id, data, updated_at) VALUES (?, ?, ?)').run(img, '[]', now);
  db.prepare('INSERT INTO image_ocr (image_id, text, lang, engine, created_at) VALUES (?, ?, ?, ?, ?)').run(
    img,
    '识别文字',
    'chi_sim',
    'windows',
    now
  );

  assert.equal(countFor('image_folders', img), 1);
  assert.equal(countFor('image_comments', img), 1);
  assert.equal(countFor('clip_vec', img), 1);
  assert.equal(countFor('image_quality', img), 1);
  assert.equal(countFor('image_annotations', img), 1);
  assert.equal(countFor('image_ocr', img), 1);

  // 与「去重回滚 / 批量淘汰」同款：只删主表一行
  db.prepare('DELETE FROM images WHERE id = ?').run(img);

  assert.equal(countFor('image_folders', img), 0, '文件夹关联成了孤儿，侧栏张数会虚高');
  assert.equal(countFor('image_comments', img), 0, '评论残留，库会越用越大');
  assert.equal(countFor('clip_vec', img), 0, '向量残留，相似图会把已删素材召回');
  assert.equal(countFor('image_quality', img), 0, '画质分残留，「整理」页会把它当有效数据');
  assert.equal(countFor('image_annotations', img), 0, '标注残留，重新导入同 id 时可能串到别的图');
  assert.equal(countFor('image_ocr', img), 0, 'OCR 残留，搜索会命中已删素材的文字');
});

test('六张关联表的删除触发器都在（防止将来被漏掉）', () => {
  const want = [
    'trg_image_folders_delete',
    'trg_image_comments_delete',
    'trg_clip_vec_delete',
    'trg_image_quality_delete',
    'trg_image_annotations_delete',
    'trg_image_ocr_delete',
  ];
  const got = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r) => r.name)
  );
  for (const name of want) assert.ok(got.has(name), `缺少删除触发器：${name}`);
});

test('批量删除同样干净（触发器逐行生效）', () => {
  const ids = [mkImage('b1.jpg'), mkImage('b2.jpg'), mkImage('b3.jpg')];
  const folderId = Number(insFolder.run('批量夹', '/y/', now, now).lastInsertRowid);
  for (const id of ids) {
    db.prepare('INSERT INTO image_folders (image_id, folder_id) VALUES (?, ?)').run(id, folderId);
  }
  const marks = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM images WHERE id IN (${marks})`).run(...ids);
  for (const id of ids) assert.equal(countFor('image_folders', id), 0);
});

test('abs_path 唯一索引：状态可读，重复存在时能如实报出来', () => {
  const st = getPathIndexState();
  assert.equal(typeof st.ok, 'boolean');
  // 新建库应当是建起来的
  assert.equal(st.ok, true, `新建库的唯一索引没建起来：${st.error}`);
  // 再跑一次是幂等的，不会因为已存在而报错
  assert.equal(retryPathIndex().ok, true);
});
