// @ts-check
/**
 * 一致性守卫（应用层等价外键）。
 *
 * 库里 35 张表一个外键都没建：跨表一致性全靠业务代码，而异常路径（进程被杀、
 * 磁盘满、断电）正好会跳过这些代码，留下指向已删除图片的孤儿行。孤儿本身不报错，
 * 但会让统计虚高、向量索引越滚越大、回收站列表里出现「点开是空白」的条目。
 *
 * 这里不建外键（30 万张的库上重建表风险太大），而是：
 * 1. 删除路径上已有的清理逻辑保持不变；
 * 2. 另给一个「对账 + 清理」入口，设置页可以随时跑，也能在启动后低频自检。
 *
 * 规则表是显式列出来的：新增依赖 image_id 的表时要记得加进来，
 * 单测会断言每张含 image_id 的表都已被规则覆盖（漏了会红）。
 */

/**
 * 孤儿规则：table.column 指向 parent.id。
 * @type {{table:string, column:string, parent:string, note:string}[]}
 */
export const ORPHAN_RULES = [
  { table: 'item_tags', column: 'image_id', parent: 'images', note: '标签关联' },
  { table: 'image_folders', column: 'image_id', parent: 'images', note: '文件夹归属' },
  { table: 'image_annotations', column: 'image_id', parent: 'images', note: '标注' },
  { table: 'image_comments', column: 'image_id', parent: 'images', note: '评论' },
  { table: 'image_notes', column: 'image_id', parent: 'images', note: '备注' },
  { table: 'image_ocr', column: 'image_id', parent: 'images', note: 'OCR 文本' },
  { table: 'image_quality', column: 'image_id', parent: 'images', note: '质量分' },
  { table: 'clip_vec', column: 'image_id', parent: 'images', note: '语义向量' },
  { table: 'ai_desc', column: 'image_id', parent: 'images', note: 'AI 描述' },
  { table: 'edit_history', column: 'image_id', parent: 'images', note: '编辑历史' },
  { table: 'edit_ops', column: 'image_id', parent: 'images', note: '编辑操作' },
  { table: 'faces', column: 'image_id', parent: 'images', note: '人脸' },
  { table: 'wallpaper_fit', column: 'image_id', parent: 'images', note: '壁纸适配' },
  { table: 'wallpaper_log', column: 'image_id', parent: 'images', note: '壁纸日志' },
  { table: 'playlist_items', column: 'image_id', parent: 'images', note: '清单条目' },
  { table: 'trash', column: 'image_id', parent: 'images', note: '回收站记录' },
  { table: 'faces', column: 'person_id', parent: 'persons', note: '人脸归属' },
  { table: 'image_folders', column: 'folder_id', parent: 'folders', note: '文件夹反查' },
  { table: 'folders', column: 'parent_id', parent: 'folders', note: '父子文件夹' },
  { table: 'folders', column: 'cover_image_id', parent: 'images', note: '文件夹封面' },
  { table: 'images', column: 'stack_id', parent: 'images', note: '堆叠主图' },
  { table: 'playlist_items', column: 'playlist_id', parent: 'playlists', note: '清单反查' },
];

/**
 * 孤儿不是「父行不存在」就够了：库里大量列用 NULL 或 0 表示「没有关联」
 * （images.stack_id 全库都是 0，faces.person_id 未归属是 NULL）。
 * 不排除这两种哨兵值，整库都会被判成孤儿。
 */
function orphanCond(rule) {
  const col = `${rule.table}.${rule.column}`;
  return `${col} IS NOT NULL AND ${col} <> 0 AND NOT EXISTS (SELECT 1 FROM ${rule.parent} p WHERE p.id = ${col})`;
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => String(c.name) === column);
}

/**
 * 只保留「表和列都真的存在」的规则：老库升级上来可能缺某些表，
 * 缺表就当没孤儿，不能因此让整个对账抛错。
 */
function activeRules(db) {
  return ORPHAN_RULES.filter((r) => hasTable(db, r.table) && hasTable(db, r.parent) && hasColumn(db, r.table, r.column));
}

/**
 * 统计孤儿（不写库）。
 * @param {any} db
 * @returns {{total:number, byTable:{table:string, column:string, parent:string, note:string, count:number}[]}}
 */
export function scanOrphans(db) {
  const byTable = activeRules(db).map((r) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${r.table} WHERE ${orphanCond(r)}`).get();
    return { ...r, count: Number(row?.n || 0) };
  });
  return { total: byTable.reduce((s, x) => s + x.count, 0), byTable };
}

/**
 * 清理孤儿。dryRun 时只回报会删多少（默认 dryRun，避免误删）。
 * @param {any} db
 * @param {{dryRun?:boolean}} [opts]
 */
export function cleanOrphans(db, { dryRun = true } = {}) {
  const scanned = scanOrphans(db);
  if (dryRun) return { dryRun: true, total: scanned.total, byTable: scanned.byTable };

  const deleted = [];
  db.exec('BEGIN');
  try {
    for (const r of scanned.byTable) {
      if (!r.count) continue;
      // 必须用同一份条件再删一次：扫描与删除之间可能又有新增孤儿
      const info = db.prepare(`DELETE FROM ${r.table} WHERE ${orphanCond(r)}`).run();
      const n = Number(info?.changes || 0);
      if (n) deleted.push({ table: r.table, column: r.column, note: r.note, count: n });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { dryRun: false, total: deleted.reduce((s, x) => s + x.count, 0), byTable: deleted };
}
