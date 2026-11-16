import fs from 'node:fs';
import { repairTakenAt } from '../lib/timeline-repair.js';
import { installLibrarySchema } from './schema.js';
import { SCHEMA_VERSION } from './schema-version.js';
import { noteSchemaWarning, resetSchemaWarnings } from './state.js';

/**
 * 单调迁移列表：每项 { version, note, run(conn) }。
 * - 只在「真的改表结构」时追加新版本，版本号必须严格递增；
 * - run 必须幂等（迁移中途失败后重跑不会把库改坏）；
 * - 老库的「逐列探测 + 补列」仍留在 schema.js 的 reconcile 段里（它本身就是幂等的），
 *   这里只负责记版本、跑增量步骤、失败回滚。
 *
 * 以前没有任何版本号：迁移全靠 PRAGMA table_info 猜测，失败既不回滚也不留痕，
 * 降级安装或绿色版/安装版共用一个 userData 时，跨版本 schema 混用只能靠运气。
 */
const MIGRATIONS = [
  { version: 1, note: '引入 schema 版本表（基线；结构由幂等 reconcile 对齐）', run() {} },
  {
    version: 2,
    note: '清理历史孤儿关联（image_folders / image_comments / clip_vec）',
    run(conn) {
      // 旧版本删素材只删 images 行，关联表没人清：文件夹张数虚高、封面指向已删图、评论永久残留。
      // 新库上这些表还没建（本迁移在建表语句之前跑），所以要逐个探测存在性。
      const has = (t) =>
        !!conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      if (!has('images')) return;
      for (const table of ['image_folders', 'image_comments', 'clip_vec']) {
        if (!has(table)) continue;
        conn.prepare(`DELETE FROM ${table} WHERE image_id NOT IN (SELECT id FROM images)`).run();
      }
    },
  },
  {
    version: 3,
    note: '清理历史孤儿关联（image_quality / image_annotations / image_ocr）',
    run(conn) {
      // 上一轮只补了 image_folders / image_comments / clip_vec 三张表的触发器，
      // 这三张（画质分、标注、OCR）同样以 image_id 为主键，删素材后一直没人清。
      const has = (t) =>
        !!conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      if (!has('images')) return;
      for (const table of ['image_quality', 'image_annotations', 'image_ocr']) {
        if (!has(table)) continue;
        conn.prepare(`DELETE FROM ${table} WHERE image_id NOT IN (SELECT id FROM images)`).run();
      }
    },
  },
  {
    version: 4,
    note: '时间线口径：taken_at 不再用入库时间兜底，改用文件修改 / 创建时间',
    run(conn) {
      // 老版本补 taken_at 列时拿 created_at（入库时间）回填，导致 2019 年的照片全排到导入那天；
      // 这里按 fs_mtime 重算，连文件指纹都没有的行先清空（时间线页会提示重建）。
      repairTakenAt(conn);
    },
  },
];

// 版本号是「热更包能不能装」的闸门之一（见 electron/main/hotfix.js），
// 所以由 schema-version.js 单独对外，这里只做一致性断言：两边不同步立刻炸，别悄悄放过。
const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.version || 0;
if (LATEST_MIGRATION !== SCHEMA_VERSION) {
  throw new Error(`SCHEMA_VERSION(${SCHEMA_VERSION}) 与迁移表最新版本(${LATEST_MIGRATION}) 不一致`);
}

/**
 * 升级前留一份一致性快照：VACUUM INTO 会带上 WAL 里已提交但还没合并的数据。
 * @returns {{ ok: boolean, path?: string, error?: string }}
 *   ok=false 表示「该备份但没备份成」；调用方对会改结构的迁移必须中止，不能带着假备份继续。
 */
function backupBeforeUpgrade(conn, fromVersion) {
  let file;
  try {
    file = String(conn.prepare('PRAGMA database_list').get()?.file || '');
  } catch (err) {
    return { ok: false, error: `读不到数据库路径：${err?.message || err}` };
  }
  if (!file) return { ok: true }; // 内存库没有可备份的磁盘文件
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = `${file}.bak-v${fromVersion || 'legacy'}-${stamp}`;
  if (fs.existsSync(dest)) return { ok: true, path: dest }; // 今天已经备份过，别每次切库都复制一份
  try {
    // VACUUM INTO 不接受参数绑定，路径里的单引号必须自己转义
    conn.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    console.info('[db] 升级前已备份到', dest);
    return { ok: true, path: dest };
  } catch (err) {
    const message = String(err?.message || err);
    console.warn('[db] 升级前备份失败：', message);
    return { ok: false, error: message };
  }
}

/** 打开连接后的结构编排：版本化迁移 + 幂等 reconcile，全程一个事务 */
export function initLibrarySchema(conn) {
  resetSchemaWarnings(); // 每次 open（含切库）重置：告警只描述「当前这个库」的状态
  // ---- 版本化迁移：先建版本表，老库没有它 = 0 ----
  conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const fromVersion = Number(conn.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v) || 0;
  if (fromVersion > SCHEMA_VERSION) {
    // 降级安装：新库里有本版本不认识的列/表。幂等 reconcile 不会删东西，
    // 但写进去的数据旧代码可能读不懂 —— 至少留一份备份并明确告警。
    console.error(
      `[db] 这个库由更高版本创建（v${fromVersion} > v${SCHEMA_VERSION}），请升级应用后再使用；已自动备份。`
    );
    const downgradeBackup = backupBeforeUpgrade(conn, `newer-${fromVersion}`);
    if (!downgradeBackup.ok) noteSchemaWarning(`降级前备份失败：${downgradeBackup.error}`);
  } else if (fromVersion > 0 && fromVersion < SCHEMA_VERSION) {
    // 只在「真的要跑结构迁移」时备份：
    // 老库（fromVersion = 0）走的仍是幂等 reconcile（只补列/建索引，不删不改），
    // 对它做 VACUUM INTO 等于在启动路径上复制一整个可能几个 GB 的库，得不偿失。
    //
    // 备份失败必须中止：以前只 console.warn 就继续跑迁移，用户以为有回退点、实际没有；
    // 迁移一旦失败（断电 / 磁盘满 / 老库结构异常）就没有任何可恢复的快照。
    const backup = backupBeforeUpgrade(conn, fromVersion);
    if (!backup.ok) {
      throw new Error(
        `升级前备份失败，已中止迁移（v${fromVersion} → v${SCHEMA_VERSION}）：${backup.error}。` +
          '库结构未做任何改动；请先手动复制一份 gallery.db（或处理磁盘空间 / 权限）后重新启动。'
      );
    }
  }

  conn.exec('BEGIN');
  try {
    for (const m of MIGRATIONS) {
      if (m.version <= fromVersion) continue;
      m.run(conn);
      conn
        .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString());
    }

    // 建表 / 触发器 / 补列 / 补索引 / 回填（顺序约束见 schema.js 的 installLibrarySchema）
    installLibrarySchema(conn);

    conn
      .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION, new Date().toISOString());
    conn.exec('COMMIT');
  } catch (err) {
    // SQLite 的 DDL 也在事务里：中途失败就整体回滚，库还是迁移前的样子，
    // 不会留下「加了一半列」的半成品（以前失败只抛错，状态未知）。
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 事务可能已经被 SQLite 自己回滚 */
    }
    throw new Error(
      `库结构迁移失败（v${fromVersion} → v${SCHEMA_VERSION}）：${err?.message || err}`,
      { cause: err }
    );
  }
}
