// @ts-check
/**
 * 旧库 → 主库的表搬运（纯 SQL，不依赖应用运行时的 db 单例）。
 *
 * 单独成一个模块的原因：server/lib/legacy-db.js 会 import db.js（打开当前资源库），
 * 而 scripts/merge-legacy-library.mjs 这种离线修复脚本不能顺手把应用库也打开。
 */

/** 需要搬运的附表：顺序即依赖顺序（文件夹先于映射，图片先于向量） */
export const LEGACY_TABLES = [
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

/**
 * 把 legacyFile 的数据按主库结构搬进 conn 的 main（自带事务）。
 * 调用方负责：conn 上已注册 sync_item_tags / delete_item_tags（images 触发器要用）。
 *
 * ⚠️ 本函数内部自己 BEGIN IMMEDIATE / COMMIT —— 离线脚本传进来的连接不一定是
 * 应用主连接，用不了 withTransaction。因此调用方**不得**再把它包在事务里，
 * 否则会抛 "cannot start a transaction within a transaction"（目前只有启动期的
 * autoMergeLegacy 调用，不在任何事务内）。
 * @param {import('./db-handle.js').DbHandle} conn
 * @param {string} legacyFile
 */
export function copyLegacyTables(conn, legacyFile) {
  const lit = String(legacyFile).replace(/'/g, "''");
  conn.exec(`ATTACH DATABASE '${lit}' AS legacy`);
  try {
    const legacyTables = new Set(
      conn.prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    conn.exec('BEGIN IMMEDIATE');
    try {
      for (const t of LEGACY_TABLES) {
        if (!legacyTables.has(t)) continue;
        // 主库的 NOT NULL 列有两种坑：
        //   1) 老库这一列是 NULL（老 schema 没约束）→ 必须 COALESCE
        //   2) 老库根本没有这一列（比如 folders.updated_at）→ 要给字面量
        // 否则 INSERT 触发 NOT NULL，而 OR IGNORE 会把它静默吞掉 —— 合并「成功」但 0 行。
        const mainInfo = conn.prepare(`PRAGMA main.table_info(${t})`).all();
        const oldCols = new Set(conn.prepare(`PRAGMA legacy.table_info(${t})`).all().map((c) => c.name));
        const literal = (type) => (String(type || '').toUpperCase().match(/INT|REAL|NUM|DEC|FLOA|DOUB/) ? '0' : "''");
        const names = [];
        const picks = [];
        for (const c of mainInfo) {
          const isPk = Number(c.pk) > 0;
          if (oldCols.has(c.name)) {
            names.push(c.name);
            // 注意：SELECT 里要按「表别名」限定，不能用 schema 名（legacy.id 会被当成列名报错）
            picks.push(c.notnull && !isPk ? `COALESCE(src."${c.name}", ${literal(c.type)})` : `src."${c.name}"`);
          } else if (c.notnull && !isPk && c.dflt_value === null) {
            names.push(c.name);
            picks.push(literal(c.type));
          }
        }
        if (!names.length) continue;
        const list = names.map((c) => `"${c}"`).join(', ');
        conn
          .prepare(`INSERT OR IGNORE INTO main."${t}" (${list}) SELECT ${picks.join(', ')} FROM legacy."${t}" AS src`)
          .run();
      }
      // 显式带 id 插入后序列可能落后（被 IGNORE 掉的行不留痕），抬到当前最大值
      for (const t of ['images', 'folders']) {
        const exists = conn.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=?").get(t);
        if (!exists) continue;
        const max = Number(conn.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM main.${t}`).get()?.m || 0);
        const row = conn.prepare('SELECT seq FROM main.sqlite_sequence WHERE name = ?').get(t);
        if (row) conn.prepare('UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?').run(max, t);
        else conn.prepare('INSERT INTO main.sqlite_sequence(name, seq) VALUES (?, ?)').run(t, max);
      }
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
  } finally {
    try {
      conn.exec('DETACH DATABASE legacy');
    } catch {
      /* 忽略 */
    }
  }
}
