#!/usr/bin/env node
/**
 * 把「旧版单库」的记录合并进现在这个资源库。
 *
 * 背景：v1.1.2 之前每个素材目录旁边可能只有一个 gallery.db（素材目录/gallery.db）。
 * 多资源库改造后，每个库的库文件搬到了 <素材目录>/.tuku/lib_xxx/gallery.db，
 * 老库文件就变成了没人读的孤儿 —— 界面上看到的就是「一张图都没有」，但文件全在盘上。
 *
 * 这个脚本按 id 原样搬运 images / folders / image_folders / clip_vec 等表，
 * **不碰任何图片文件**，也不改旧库（只读）。默认 dry-run，加 --apply 才写。
 *
 * 用法：
 *   node scripts/merge-legacy-library.mjs --from "E:\白底图\gallery.db" \
 *        --to "E:\白底图\.tuku\lib_mw3m7cr1\gallery.db"            # 只看计划
 *   node scripts/merge-legacy-library.mjs --from ... --to ... --apply
 *
 * 写之前会先用 `VACUUM INTO` 给两个库各打一份一致性快照（应用开着也能安全备份）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// 搬运逻辑与应用内「自动合并旧库」共用一份（lib/legacy-copy.js），避免两处写反
import { copyLegacyTables } from '../server/lib/legacy-copy.js';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : '';
};
const from = path.resolve(argOf('from') || '');
const to = path.resolve(argOf('to') || '');
const apply = argv.includes('--apply');

if (!from || !to) {
  console.error('用法: node scripts/merge-legacy-library.mjs --from <旧 gallery.db> --to <当前库 gallery.db> [--apply]');
  process.exit(1);
}
for (const p of [from, to]) {
  if (!fs.existsSync(p)) {
    console.error('文件不存在:', p);
    process.exit(1);
  }
}

/** 需要搬运的表：顺序即依赖顺序（文件夹先于映射，图片先于向量） */
const TABLES = [
  'folders',
  'images',
  'image_folders',
  'clip_vec',
  'item_tags',
  'ai_desc',
  'image_quality',
  'wallpaper_fit',
  'smart_folders',
  'keywords',
  'playlists',
  'playlist_items',
  'trash',
  'wallpaper_log',
  'tidy_skip',
  'feedback',
  'kb_rules',
];

const legacy = new DatabaseSync(from, { readOnly: true });
const target = new DatabaseSync(to);

// 库里给 images 挂了触发器，回调是 JS 注册的自定义函数；不注册就报 no such function: sync_item_tags。
// 语义与 server/db.js 保持一致：tags 逗号串 ⇄ item_tags 行。
target.function('sync_item_tags', (id, tagsStr) => {
  const tags = String(tagsStr || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  target.prepare('DELETE FROM item_tags WHERE image_id = ?').run(id);
  const ins = target.prepare('INSERT OR IGNORE INTO item_tags(tag, image_id) VALUES (?, ?)');
  for (const t of tags) ins.run(t, id);
});
target.function('delete_item_tags', (id) => {
  target.prepare('DELETE FROM item_tags WHERE image_id = ?').run(id);
});

const tableNames = (db) =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const legacyTables = tableNames(legacy);
const targetTables = tableNames(target);

const count = (db, t) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()?.c || 0);
const targetImages = count(target, 'images');
const legacyImages = count(legacy, 'images');
console.info(`旧库 ${from}\n  图片 ${legacyImages} 张`);
console.info(`目标库 ${to}\n  现有图片 ${targetImages} 张`);
if (!legacyImages) {
  console.error('旧库里没有图片记录，没有可合并的内容。');
  process.exit(1);
}

/** 计算两库共有字段 */
const sharedCols = (t) => {
  const a = legacy.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const b = target.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  return b.filter((c) => a.includes(c));
};

const plan = [];
for (const t of TABLES) {
  if (!legacyTables.has(t) || !targetTables.has(t)) continue;
  const n = count(legacy, t);
  if (!n) continue;
  plan.push({ table: t, rows: n, cols: sharedCols(t) });
}
console.info('\n迁移计划：');
for (const p of plan) console.info(`  ${p.table.padEnd(14)} ${String(p.rows).padStart(6)} 行  (字段 ${p.cols.length})`);

if (!apply) {
  console.info('\n[dry-run] 未写入。确认无误后加 --apply 再跑一次。');
  process.exit(0);
}

/* ------------------------------ 备份 ------------------------------ */
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const backupDir = path.join(path.dirname(to), `_recovery-backup-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
target.exec(`VACUUM INTO '${path.join(backupDir, 'target-before.db').replace(/'/g, "''")}'`);
legacy.exec(`VACUUM INTO '${path.join(backupDir, 'legacy.db').replace(/'/g, "''")}'`);
console.info('\n备份已写入:', backupDir);

/* ------------------------------ 搬运 ------------------------------ */
target.exec('PRAGMA foreign_keys = OFF;');
copyLegacyTables(target, from);
for (const { table } of plan) {
  console.info(`  ${table}: 现有 ${count(target, table)} 行（旧库 ${count(legacy, table)} 行）`);
}
target.exec('BEGIN IMMEDIATE;');
try {
  // 缩略图路径指向的文件已经不存在（旧库的 thumbs 目录被删/被搬走过）时清空，
  // 让接口按需重新生成，而不是一直 404
  const rows = target.prepare("SELECT id, thumb FROM images WHERE COALESCE(thumb, '') <> ''").all();
  const clear = target.prepare("UPDATE images SET thumb = '' WHERE id = ?");
  let cleared = 0;
  for (const r of rows) {
    if (!fs.existsSync(r.thumb)) {
      clear.run(r.id);
      cleared++;
    }
  }
  console.info(`  失效缩略图路径已清空: ${cleared} 条`);

  // fs_mtime 是「URL 版本号」的来源：空值会让原图/缩略图带上 ?v=0 被长期强缓存
  const missingMtime = target.prepare("SELECT id, abs_path FROM images WHERE COALESCE(fs_mtime, 0) = 0").all();
  const setMtime = target.prepare('UPDATE images SET fs_mtime = ? WHERE id = ?');
  let filled = 0;
  for (const r of missingMtime) {
    try {
      const m = Math.round(fs.statSync(r.abs_path).mtimeMs / 1000);
      setMtime.run(m, r.id);
      filled++;
    } catch {
      /* 文件不在了：留 0，后续「清理缺失」会处理 */
    }
  }
  console.info(`  fs_mtime 补齐: ${filled}/${missingMtime.length} 条`);

  target.exec('COMMIT;');
} catch (err) {
  target.exec('ROLLBACK;');
  console.error('迁移失败，已回滚:', err.message);
  process.exit(1);
} finally {
  target.exec('PRAGMA foreign_keys = ON;');
}

/* --------------------------- 重建全文索引 --------------------------- */
try {
  target.exec("INSERT INTO images_fts(images_fts) VALUES('rebuild')");
  console.info('  全文索引已重建');
} catch (err) {
  console.warn('  全文索引重建失败（搜索会退化为 LIKE）:', err.message);
}

console.info('\n完成：目标库现有图片', count(target, 'images'), '张，文件夹', count(target, 'folders'), '个');
try {
  target.exec('DETACH DATABASE legacy');
} catch {
  /* 忽略 */
}
legacy.close();
target.close();
