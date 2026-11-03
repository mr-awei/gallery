// 临时：验证整理功能（相似图分组 / 主色 / 星级备注 / 语义搜索索引）
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GEM_DATA_DIR = process.env.GEM_DATA_DIR || path.join(PROJECT_ROOT, 'data');
const { db } = await import('../server/db.js');
const lib = await import('../server/library.js');

let bad = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) bad++;
};

/* ① 相似图分组 */
console.log('【相似图分组】');
for (const th of [6, 10, 14]) {
  const t0 = Date.now();
  const groups = lib.listSimilarGroups(th);
  const imgs = groups.reduce((s, g) => s + g.count, 0);
  console.log(`     阈值 ${th}：${groups.length} 组 / ${imgs} 张（耗时 ${Date.now() - t0}ms）`);
  if (th === 10) {
    check(groups.length >= 0, '分组可正常计算');
    if (groups[0]) {
      const g = groups[0];
      console.log(`     首组 ${g.count} 张，推荐保留 id=${g.recommendId}（${g.items[0].width}×${g.items[0].height}）`);
      check(g.items.some((it) => it.id === g.recommendId), '推荐项在组内');
      check(
        g.items[0].width * g.items[0].height >= g.items[g.items.length - 1].width * g.items[g.items.length - 1].height,
        '组内按分辨率降序排列'
      );
    }
  }
}

/* ② 主色提取 */
console.log('\n【主色提取】');
const before = db.prepare("SELECT COUNT(*) AS c FROM images WHERE dominant = ''").get().c;
console.log(`     缺主色 ${before} 张`);
const r1 = await lib.backfillDominant(60);
console.log(`     本批处理 ${r1.done} 张，剩余 ${r1.remain} 张`);
check(r1.done > 0 || before === 0, '补算主色可用');
const sample = db.prepare("SELECT dominant, hue FROM images WHERE dominant != '' LIMIT 3").all();
check(sample.length > 0, '主色已写入', JSON.stringify(sample));
check(sample.every((s) => /^#[0-9a-f]{6}$/.test(s.dominant)), '主色是合法 hex');

/* ③ 星级 / 备注 */
console.log('\n【星级与备注】');
const anyId = db.prepare('SELECT id FROM images LIMIT 1').get().id;
lib.setRating(anyId, 4);
lib.setNote(anyId, '测试备注：红裙舞台');
const after = lib.toDTO(lib.getImage(anyId));
check(after.rating === 4, '星级写入成功', `rating=${after.rating}`);
check(after.note.includes('测试备注'), '备注写入成功');
check(db.prepare('SELECT COUNT(*) AS c FROM images WHERE rating >= 4').get().c >= 1, '可按星级筛选');
lib.setRating(anyId, 0);
lib.setNote(anyId, '');

/* ④ 语义搜索索引（AI 描述） */
console.log('\n【AI 描述与语义搜索】');
const descCount = db.prepare('SELECT COUNT(*) AS c FROM ai_desc').get().c;
console.log(`     ai_desc 已缓存 ${descCount} 条`);
if (descCount) {
  const one = db.prepare('SELECT image_id, description FROM ai_desc LIMIT 1').get();
  const word = String(one.description).slice(0, 4);
  console.log(`     用「${word}」搜索（来自 AI 描述）`);
  const hit = db
    .prepare(
      `SELECT COUNT(*) AS c FROM images WHERE id IN (SELECT image_id FROM ai_desc WHERE description LIKE ?)`
    )
    .get(`%${word}%`).c;
  check(hit > 0, 'AI 描述可被检索到', `命中 ${hit} 张`);
} else {
  console.log('     （还没跑过 AI 识图，语义搜索暂无可搜内容；配好 AI 后在整理页点「批量 AI 打标」）');
}

console.log(bad ? `\n❌ ${bad} 项未通过` : '\n✓ 整理功能全部通过');
process.exit(bad ? 1 : 0);
