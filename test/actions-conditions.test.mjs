import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 复核「动作」的三件套：条件规则 / 逐图预演 / 批量撤销。
 * - 条件不命中的素材必须被跳过，并在结果里如实计数
 * - 预演只算不写：跑完 dryRun 后库里的值一个都不该变
 * - 真正执行后写一条 op_log，撤销能把标题 / 标签 / 备注 / 评分 / 收藏改回去
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-actions-'));
process.env.TUKU_USER_DATA = tmp;
process.env.TUKU_CLIP = 'off';

const { db } = await import('../server/db.js');
// 撤销执行器注册在 routes/jobs.js 顶层，导入即生效（不启动服务）
await import('../server/routes/jobs.js');
const { listActions, runAction, saveAction } = await import('../server/lib/actions.js');
const { undoLast, listOps } = await import('../server/oplog.js');

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
const ins = db.prepare('INSERT INTO images (abs_path, title, tags, note, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const ids = [];
for (const [i, rating] of [5, 1, 4].entries()) {
  ids.push(
    Number(
      ins.run(path.join(tmp, `a-${i}.jpg`), `标题${i}`, '旧标签', '旧备注', rating, now).lastInsertRowid
    )
  );
}

const rowOf = (id) => db.prepare('SELECT title, tags, note, rating, favorite FROM images WHERE id = ?').get(id);

test('条件规则：不命中的素材被跳过，命中的照常执行', async () => {
  const saved = saveAction({
    name: '高分降星',
    steps: [{ type: 'rate', rating: 2 }],
    conditions: { combine: 'and', rules: { minRating: 4 } },
  });

  const act = listActions().find((a) => a.id === saved.id);
  assert.ok(act, '动作没保存成功');
  assert.equal(act.conditions.rules.minRating, 4, '条件没落库');

  const r = await runAction(saved.id, ids);
  assert.equal(r.total, 3);
  assert.equal(r.okCount, 2, '评分≥4 的两张应该被执行');
  assert.equal(r.skipped, 1, '评分 1 的那张应该被条件跳过');
  assert.equal(Number(rowOf(ids[0]).rating), 2);
  assert.equal(Number(rowOf(ids[2]).rating), 2);
  assert.equal(Number(rowOf(ids[1]).rating), 1, '被跳过的素材不该被改');
});

test('预演：只算不写，能说出「改前 → 改后」', async () => {
  const saved = saveAction({
    name: '改名预演',
    steps: [{ type: 'title', mode: 'template', template: 'X-{index}' }],
  });
  const before = rowOf(ids[0]).title;
  const r = await runAction(saved.id, [ids[0]], { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.okCount, 1);
  const step = r.items[0].preview?.[0];
  assert.ok(step, '预演没有返回步骤结果');
  assert.equal(step.diffs[0].field, '标题');
  assert.equal(step.diffs[0].before, before);
  assert.equal(step.diffs[0].after, 'X-01');
  assert.equal(rowOf(ids[0]).title, before, '预演不许写库');
});

test('批量撤销：标题 / 标签 / 评分全部回到执行前', async () => {
  const saved = saveAction({
    name: '全字段改写',
    steps: [
      { type: 'title', mode: 'prefix', text: '改-' },
      { type: 'tag', mode: 'add', tags: '新标签' },
      { type: 'rate', rating: 1 },
      { type: 'favorite', value: true },
    ],
  });
  const before = ids.map((id) => ({ id, ...rowOf(id) }));

  const r = await runAction(saved.id, ids);
  assert.equal(r.okCount, 3);
  assert.ok(rowOf(ids[0]).title.startsWith('改-'), '执行没生效');

  const ops = listOps(5);
  assert.equal(ops[0].op, 'action', '执行后没有写撤销记录');
  assert.equal(ops[0].undoable, true);

  await undoLast();

  for (const b of before) {
    const cur = rowOf(b.id);
    assert.equal(cur.title, b.title);
    assert.equal(cur.tags, b.tags);
    assert.equal(Number(cur.rating), Number(b.rating));
    assert.equal(Number(cur.favorite), Number(b.favorite));
  }
});
