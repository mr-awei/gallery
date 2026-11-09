import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 复核「触发器删 clip_vec 行不会让已删素材被相似检索召回」：
 * 删除素材走触发器直接删 clip_vec，不会通知内存里的 HNSW / 分桶索引，已删素材的向量
 * 可能残留在索引里。topSimilar 现在以 images 表为准兜底过滤（keepLive），无论删除走哪条路径，
 * 已删素材都不应再被当成「相似 / 重复」命中。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-clip-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_CLIP = 'off';

const { db } = await import('../server/db.js');
const clip = await import('../server/clip.js');

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
const DIM = 4;
const mkImg = (name) =>
  Number(
    db
      .prepare('INSERT INTO images (abs_path, title, created_at) VALUES (?, ?, ?)')
      .run(path.join(tmp, name), name, now).lastInsertRowid
  );
const putVec = (id, vec) =>
  db
    .prepare('INSERT INTO clip_vec (image_id, dim, vec, created_at) VALUES (?, ?, ?, ?)')
    .run(id, vec.length, Buffer.from(new Float32Array(vec).buffer), now);

test('删图后，相似检索不再召回已删素材', async () => {
  const keep = mkImg('keep.jpg');
  const gone = mkImg('gone.jpg');
  // 两个正交向量：各自查询时只应命中自己
  putVec(keep, [1, 0, 0, 0]);
  putVec(gone, [0, 1, 0, 0]);

  const simKeep = await clip.topSimilar(new Float32Array([1, 0, 0, 0]), { k: 5, minCos: 0.5, ann: false });
  assert.ok(simKeep.some((h) => h.id === keep), '应命中 keep');

  // 删掉 gone（触发器清掉它的 clip_vec 行，但内存索引还留着陈旧向量）
  db.prepare('DELETE FROM images WHERE id = ?').run(gone);
  assert.equal(clip.embeddingCount(), 1, 'clip_vec 应已随触发器被清掉一条');

  const simGone = await clip.topSimilar(new Float32Array([0, 1, 0, 0]), { k: 5, minCos: 0.5, ann: false });
  assert.ok(!simGone.some((h) => h.id === gone), '已删素材不应再被相似检索召回');
});
