// @ts-check
/**
 * 真外键（FOREIGN KEY）：约束声明 + 老库原地重建 + 连接级开关。
 *
 * 以前库里 35 张表一个外键都没建，跨表一致性全靠业务代码和触发器兜：
 * 在 SQL 里删一张图、导入导出、进程被杀，都会留下指向已删素材的关联行；
 * 只能靠 integrity.js 的「对账」事后清理 —— 那是补丁，不是约束。
 *
 * 现在的做法：
 * 1. 新库：建表 DDL 里直接带 REFERENCES（schema-sql.js 里用 fkTail() 拼进去）
 * 2. 老库：SQLite 不支持 ALTER TABLE ADD CONSTRAINT，只能「建新表 → 搬数据 → 换名」，
 *    由 applyForeignKeys() 在连接打开后跑一次（幂等，靠 schema_flags 记标记）
 * 3. 连接：applyPragmas() 每个连接都 `PRAGMA foreign_keys = ON`（默认是 OFF！）
 *
 * 重建必须在事务外把 `PRAGMA foreign_keys` 临时关掉：DROP 父表（folders 自引用、
 * images）在开启状态下会级联删掉刚搬进新表的子行 —— 干净的数据被自己删光。
 *
 * 刻意不建外键的表（写在这里，免得以后被人当漏项补上）：
 * - images.*：父表本身；且 images.stack_id 用 0 表示「没堆叠」，0 不是合法父 id，
 *   建 FK 就得把百万行里的 0 全改成 NULL，牵连所有 `stack_id = 0` 的查询
 * - trash / wallpaper_log / feedback：删素材后仍要留档，image_id 指的是「曾经的」素材
 * - folders.cover_image_id / persons.cover_face_id：封面被删时要保留文件夹/人物行
 *   （业务层回退到自动封面），而建 SET NULL 需要连带重建 images / persons 两张主表
 */

/**
 * 子表 → 约束列表。**数组顺序即重建顺序，父表必须排在子表前面**：
 * `folders` 自引用且是 `image_folders` 的父表，`images` / `playlists` / `persons`
 * 都先于引用它们的表存在（它们是老表，本模块不重建）。
 *
 * @typedef {{ column: string, parent: string, action: 'CASCADE'|'SET NULL' }} FkRef
 * @typedef {{ table: string, refs: FkRef[] }} FkTable
 * @type {FkTable[]}
 */
export const FK_TABLES = [
  // 父子文件夹：删父夹连带子夹（以前靠 path 前缀 LIKE 手工删，漏一次就留孤儿）
  { table: 'folders', refs: [{ column: 'parent_id', parent: 'folders', action: 'CASCADE' }] },
  {
    table: 'playlist_items',
    refs: [
      { column: 'playlist_id', parent: 'playlists', action: 'CASCADE' },
      { column: 'image_id', parent: 'images', action: 'CASCADE' },
    ],
  },
  { table: 'item_tags', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  {
    table: 'image_folders',
    refs: [
      { column: 'image_id', parent: 'images', action: 'CASCADE' },
      { column: 'folder_id', parent: 'folders', action: 'CASCADE' },
    ],
  },
  { table: 'image_annotations', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'image_comments', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'image_notes', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'image_ocr', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'image_quality', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'clip_vec', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'ai_desc', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'edit_history', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'edit_ops', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  { table: 'wallpaper_fit', refs: [{ column: 'image_id', parent: 'images', action: 'CASCADE' }] },
  {
    // 人脸：素材删了脸跟着删；人物被删则把脸退回「未归属」，而不是连脸一起删
    table: 'faces',
    refs: [
      { column: 'image_id', parent: 'images', action: 'CASCADE' },
      { column: 'person_id', parent: 'persons', action: 'SET NULL' },
    ],
  },
];

/** 这张表要追加到 CREATE TABLE 末尾的约束原文（没有外键的表返回空串） */
export function fkTail(table) {
  const spec = FK_TABLES.find((t) => t.table === table);
  if (!spec) return '';
  return (
    ',\n  ' +
    spec.refs
      .map((r) => `FOREIGN KEY (${r.column}) REFERENCES ${r.parent}(id) ON DELETE ${r.action}`)
      .join(',\n  ')
  );
}

/** 重建标记：以后要给新表补外键时把版本号 +1，老库会再跑一遍 */
const FK_FLAG_KEY = 'foreign_keys_v1';

function tableExists(conn, name) {
  return !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasForeignKey(conn, table) {
  return conn.prepare(`PRAGMA foreign_key_list(${table})`).all().length > 0;
}

/**
 * 搬数据前先清孤儿：新表带约束，INSERT 会校验，孤儿留在里面会直接撞约束。
 * 这与 ON DELETE CASCADE 的语义一致 —— 父行没了，子行本来就该没。
 */
function cleanOrphansBeforeRebuild(conn, table, ref) {
  if (!tableExists(conn, ref.parent) || !tableExists(conn, table)) return;
  const col = `${table}.${ref.column}`;
  // 0 / NULL 都是「没有关联」的哨兵值（folders.parent_id、faces.person_id），不是孤儿
  const orphan = `${col} IS NOT NULL AND ${col} <> 0 AND NOT EXISTS (SELECT 1 FROM ${ref.parent} p WHERE p.id = ${col})`;
  if (ref.action === 'SET NULL') {
    conn.prepare(`UPDATE ${table} SET ${ref.column} = NULL WHERE ${orphan}`).run();
    return;
  }
  conn.prepare(`DELETE FROM ${table} WHERE ${orphan}`).run();
}

/** 把 0 归一成 NULL：0 不是合法父 id，留着会让新约束永远插不进去 */
function normalizeSentinel(conn, table, ref) {
  try {
    conn.prepare(`UPDATE ${table} SET ${ref.column} = NULL WHERE ${ref.column} = 0`).run();
  } catch {
    /* 列可能不存在（老库缺列），交给后面的 reconcile 补 */
  }
}

/**
 * 把 CREATE TABLE 原文的表名换成临时名，并在最后一个 ')' 前插入约束。
 * 只改首个 CREATE TABLE 后面的表名 —— 我们的 DDL 从不加引号，不必处理引号变体。
 */
function tmpCreateSql(src, table, tmp) {
  const close = src.lastIndexOf(')');
  if (close < 0) return '';
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = src.slice(0, close).replace(new RegExp(`^(\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)${esc}\\b`, 'i'), `$1"${tmp}"`);
  if (head === src.slice(0, close)) return '';
  return `${head}${fkTail(table)}\n)`;
}

/** 用「建新表 → 搬数据 → 删旧表 → 改名」给一张表补上外键 */
function rebuildTable(conn, spec) {
  const { table } = spec;
  if (!tableExists(conn, table)) return { skipped: 'missing' };
  if (hasForeignKey(conn, table)) return { skipped: 'already' };

  const src = String(
    conn.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || ''
  );
  const close = src.lastIndexOf(')');
  if (!src || close < 0) return { skipped: 'unparsable' };

  for (const ref of spec.refs) normalizeSentinel(conn, table, ref);
  for (const ref of spec.refs) cleanOrphansBeforeRebuild(conn, table, ref);

  const cols = conn
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => String(c.name));
  if (!cols.length) return { skipped: 'unparsable' };

  const tmp = `fk_rebuild_${table}`;
  // 索引单独记下来：DROP TABLE 会把它们一起带走，改完名要补回去
  const indexes = conn
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
    .all(table)
    .map((r) => String(r.sql));
  let seq = 0;
  try {
    seq = Number(conn.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq || 0);
  } catch {
    /* 没有 AUTOINCREMENT 表时 sqlite_sequence 可能不存在 */
  }

  const createSql = tmpCreateSql(src, table, tmp);
  if (!createSql) return { skipped: 'unparsable' };

  conn.exec(`DROP TABLE IF EXISTS ${tmp}`);
  // 在最后一个 ')' 前插入约束：CREATE 原文里已经有完整列定义，只补约束最省事
  conn.exec(createSql);
  const list = cols.map((c) => `"${c}"`).join(', ');
  conn.prepare(`INSERT INTO ${tmp} (${list}) SELECT ${list} FROM ${table}`).run();
  conn.exec(`DROP TABLE ${table}`);
  conn.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  for (const sql of indexes) conn.exec(sql);
  // AUTOINCREMENT 的序号随 DROP 一起没了，抬回原值避免 id 回退（撤销/重做会指错行）
  try {
    const row = conn.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table);
    const next = Math.max(Number(row?.seq || 0), seq);
    if (row) conn.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(next, table);
    else if (next) conn.prepare('INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)').run(table, next);
  } catch {
    /* 同上：没有 sqlite_sequence 就跳过 */
  }
  return { rebuilt: true, rows: Number(conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0) };
}

/**
 * 打开库之后跑一次：老表补外键 + 全库外键体检。
 *
 * 期间必须关掉 `PRAGMA foreign_keys`（DROP 父表会级联清空新表），跑完再打开 ——
 * 所以调用点不能在事务里。整体幂等：schema_flags 里有标记就只做体检之外的空转。
 *
 * @param {import('../lib/db-handle.js').DbHandle} conn
 * @returns {{ skipped: boolean, rebuilt: {table:string,rows:number}[], failures: {table:string,error:string}[], violations: number }}
 */
export function applyForeignKeys(conn) {
  conn.exec('CREATE TABLE IF NOT EXISTS schema_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const out = { skipped: false, rebuilt: [], failures: [], violations: 0 };
  if (conn.prepare('SELECT 1 AS x FROM schema_flags WHERE key=?').get(FK_FLAG_KEY)) {
    out.skipped = true;
    return out;
  }

  // 三个 pragma 都是「只在重建期间」的：
  // - foreign_keys OFF：DROP 父表（folders 自引用）会级联清掉刚搬进新表的子行
  // - legacy_alter_table ON：RENAME 时不去重新解析全库触发器。否则
  //   `trg_image_folders_delete` 会在 image_folders 被删、改名还没落地的那一瞬间
  //   报 "error in trigger ...: no such table"，把整次重建打断（实测踩过）
  // - 全部语句放进一个事务：半边完成的 schema 比不建外键更糟，失败就整体回退
  conn.exec('PRAGMA legacy_alter_table = ON');
  conn.exec('PRAGMA foreign_keys = OFF');
  try {
    conn.exec('BEGIN');
    try {
      for (const spec of FK_TABLES) {
        let r;
        try {
          r = rebuildTable(conn, spec);
        } catch (err) {
          err.table = spec.table;
          throw err;
        }
        if (r.rebuilt) {
          out.rebuilt.push({ table: spec.table, rows: r.rows || 0 });
          console.info(`[db] 关联表 ${spec.table} 已补外键约束（${r.rows} 行）`);
        }
      }
      try {
        out.violations = conn.prepare('PRAGMA foreign_key_check').all().length;
      } catch {
        /* 老 SQLite 没有 foreign_key_check 就跳过体检 */
      }
      conn.exec('COMMIT');
    } catch (err) {
      // 一张表失败就整体回退：留下半新半旧的 schema 会让应用起不来
      try {
        conn.exec('ROLLBACK');
      } catch {
        /* 事务可能已经被 SQLite 自己回滚了 */
      }
      out.failures.push({ table: String(err?.table || ''), error: String(err?.message || err) });
      console.warn('[db] 外键重建失败，已回退（库保持原样，功能不受影响）：', err?.message || err);
    }
  } finally {
    conn.exec('PRAGMA legacy_alter_table = OFF');
    conn.exec('PRAGMA foreign_keys = ON');
  }
  if (out.violations) console.warn(`[db] 外键体检发现 ${out.violations} 条不一致关联`);

  // 标记照样写：失败也写，否则每次启动都要把几十万行重建一遍再回退
  conn
    .prepare('INSERT OR REPLACE INTO schema_flags(key, value) VALUES (?, ?)')
    .run(FK_FLAG_KEY, JSON.stringify({ at: new Date().toISOString(), ...out }));
  return out;
}

/** 当前连接的外键开关状态（界面 / 诊断用） */
export function foreignKeysEnabled(conn) {
  try {
    return Number(conn.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0) === 1;
  } catch {
    return false;
  }
}

/**
 * 健康页用的轻量状态：只读开关和上次重建留下的快照。
 * 不做 `PRAGMA foreign_key_check` —— 那是全表扫描，百万行库上要秒级，
 * 健康页是打开就请求的，实时体检单独走 checkForeignKeys()。
 */
export function foreignKeyStatus(conn) {
  let snapshot = { at: '', violations: 0, rebuilt: [], failures: [] };
  try {
    const raw = conn.prepare('SELECT value FROM schema_flags WHERE key=?').get(FK_FLAG_KEY)?.value;
    if (raw) snapshot = { ...snapshot, ...JSON.parse(String(raw)) };
  } catch {
    /* 老库还没有 schema_flags，就当没跑过 */
  }
  return {
    enabled: foreignKeysEnabled(conn),
    builtAt: String(snapshot.at || ''),
    // 建库/重建那一刻的体检结果：>0 说明老数据里有外键管不到的历史坏账
    violations: Number(snapshot.violations || 0),
    rebuilt: Array.isArray(snapshot.rebuilt) ? snapshot.rebuilt : [],
    failures: Array.isArray(snapshot.failures) ? snapshot.failures : [],
  };
}

/** 实时外键体检（手动触发）：返回违反约束的行，最多 50 条用于界面展示 */
export function checkForeignKeys(conn) {
  try {
    const rows = conn.prepare('PRAGMA foreign_key_check').all();
    return {
      ok: rows.length === 0,
      total: rows.length,
      rows: rows.slice(0, 50).map((r) => ({
        table: String(r.table || ''),
        rowid: Number(r.rowid || 0),
        parent: String(r.parent || ''),
        fkid: Number(r.fkid || 0),
      })),
    };
  } catch (err) {
    return { ok: false, total: 0, rows: [], error: String(err?.message || err) };
  }
}
