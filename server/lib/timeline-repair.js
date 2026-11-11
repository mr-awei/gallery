// @ts-check
/**
 * 时间线口径修复：把「入库时间兜底」的 taken_at 改回文件时间。
 *
 * 背景：v1.2.6 及更早版本给老库补 taken_at 列时，直接拿 created_at（入库时间）回填，
 * 于是 2019 年拍的照片全排到导入那天；而重建任务只在有 EXIF 时才改写，没有 EXIF 的图
 * （截图、下载的图、社交软件存的图）永远停在入库时间。另外 created_at 存的是 UTC，
 * 回填出来的串也是 UTC，与 EXIF / mtime 写入的本地时间口径不一致，
 * 「待校正」计数用 UTC 串比对，在 UTC+8 的机器上永远数不出来。
 *
 * 这里只做库内能做的事：用 fs_mtime 重算（不做磁盘 IO，启动路径不能扫全库）。
 * 文件时间也拿不到的行先把 taken_at 清空（＝不排进时间线），交给后台重建任务 stat 文件。
 */

/**
 * taken_at 仍是「入库时间兜底」的四种形态：空串 / UTC 串 / 本地串，外加早期可空列留下的 NULL
 * （现在的 schema 是 NOT NULL DEFAULT ''，正常「没时间」就是空串，IS NULL 只是兼容老库）
 */
export const IMPORT_TIME_ONLY = `(
  taken_at IS NULL
  OR taken_at = ''
  OR taken_at = substr(replace(created_at, 'Z', ''), 1, 19)
  OR taken_at = strftime('%Y-%m-%dT%H:%M:%S', created_at, 'localtime')
)`;

/** fs_mtime（秒级 unix）→ 'YYYY-MM-DDTHH:MM:SS' 本地串，与 taken-at.js 的写入格式一致 */
const FILE_STAMP_SQL = "strftime('%Y-%m-%dT%H:%M:%S', fs_mtime, 'unixepoch', 'localtime')";

/** @param {any} conn */
function tableExists(conn, table) {
  return Boolean(
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

/** @param {any} conn */
function columnsOf(conn, table) {
  try {
    return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)));
  } catch {
    return new Set();
  }
}

/** 库结构是否够用（新库 / 极老的库直接跳过） */
function ready(conn) {
  if (!tableExists(conn, 'images')) return false;
  const cols = columnsOf(conn, 'images');
  return ['taken_at', 'created_at', 'fs_mtime'].every((c) => cols.has(c));
}

/**
 * 修复「入库时间兜底」的行。
 * @param {any} conn
 * @returns {{fixed: number, cleared: number, error?: string}} fixed=改成文件时间的行数，cleared=退回未排入的行数
 */
export function repairTakenAt(conn) {
  if (!ready(conn)) return { fixed: 0, cleared: 0 };
  let fixed;
  let cleared;
  try {
    const r1 = conn
      .prepare(`UPDATE images SET taken_at = ${FILE_STAMP_SQL} WHERE ${IMPORT_TIME_ONLY} AND fs_mtime > 0`)
      .run();
    fixed = Number(r1?.changes || 0);
    // 文件指纹也没有：不能拿入库时间充数，先标成「未排入」，等重建任务 stat 文件。
    // 带上 fs_mtime 条件 —— 否则「刚创建的图 mtime 恰好等于入库秒」会被这条清回空串。
    const r2 = conn
      .prepare(
        `UPDATE images SET taken_at = '' WHERE taken_at <> '' AND ${IMPORT_TIME_ONLY}
         AND (fs_mtime IS NULL OR fs_mtime <= 0)`
      )
      .run();
    cleared = Number(r2?.changes || 0);
  } catch (err) {
    // 修复失败不该挡住开库：最坏情况是时间线仍然偏移，用户还能在页内手动重建
    console.error('[timeline] 拍摄时间口径修复失败：', err?.message || err);
    return { fixed: 0, cleared: 0, error: String(err?.message || err) };
  }
  return { fixed, cleared };
}

/**
 * 还有多少行的 taken_at 是入库时间 / 空的（界面据此提示要不要重建）。
 * @param {any} conn
 */
export function countPending(conn) {
  if (!ready(conn)) return 0;
  try {
    return Number(conn.prepare(`SELECT COUNT(*) AS n FROM images WHERE ${IMPORT_TIME_ONLY}`).get()?.n || 0);
  } catch {
    return 0;
  }
}
