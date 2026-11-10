// @ts-check
/**
 * 拍摄时间归一化（时间线视图的唯一口径）。
 *
 * 为什么单独一层：taken_at 有三个来源——EXIF 时间（DateTimeOriginal，缺失时用 EXIF 的
 * DateTime）、文件修改时间 mtime、文件创建时间 birthtime。两者必须落成同一种可比较、
 * 可 substr 分月的字符串，否则时间线会「同年同月被拆成两组」，排序也会在时区边界跳。
 *
 * **入库时间（created_at）绝不参与**：那是「这张图什么时候被我们收录」，
 * 拿它当拍摄时间会让 2019 年拍的照片全部堆到导入那天，时间线就失去意义了。
 *
 * 统一格式：`YYYY-MM-DDTHH:MM:SS`（无时区后缀，按用户本地时钟理解）。
 */

const p2 = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DDTHH:MM:SS'（本地时间） */
export function localStamp(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 秒级文件时间戳 → 同格式；0/非法值返回空串（调用方再兜底） */
export function mtimeStamp(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  return localStamp(new Date(n * 1000));
}

/**
 * 文件时间：取「修改时间」与「创建时间」里较早的那个。
 *
 * 为什么不优先创建时间：Windows / FAT 复制文件时 mtime 被保留、创建时间被重置成复制时刻
 * （≈ 入库时间），单看创建时间等于又回到「收录时间」；反过来编辑过原图会把 mtime 推到
 * 编辑那天，单看 mtime 又会让老照片往前跳。取较早者两边都不吃亏：
 * 复制来的图 = 原始 mtime，截图 / 新拍的图 = 创建时间，改过的图 = 创建时间。
 * @param {{fsMtime?: number, fsBirthtime?: number}} [o] 秒级时间戳
 */
export function fileStamp({ fsMtime = 0, fsBirthtime = 0 } = {}) {
  const m = Number(fsMtime) > 0 ? Number(fsMtime) : 0;
  const b = Number(fsBirthtime) > 0 ? Number(fsBirthtime) : 0;
  if (m && b) return mtimeStamp(Math.min(m, b));
  return mtimeStamp(m || b);
}

/**
 * EXIF 时间 → 同格式。
 * 接受 '2026:11:02 14:33:05'、'2026-11-02T14:33:05'、'2026-11-02 14:33'。
 * 只认「看起来像摄影时间」的值（1970~2100），否则返回空串——
 * 相机没电重置成 1980-01-01 / 2000-01-01 / 1900-01-01 这类空值占位
 * 不该把一张照片塞进时间线最底部（数字照片不可能早于 1970）。
 */
export function exifStamp(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return '';
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] || '00'].map(Number);
  if (y < 1970 || y > 2100) return '';
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
}

/**
 * 挑拍摄时间：EXIF 优先，其次文件修改 / 创建时间；**都没有就返回空串**。
 *
 * 最后不再拿「现在」兜底：入库时间不是照片的时间，宁可让这张图先不排进时间线
 * （界面会显示「N 张待校正」，重建任务 stat 一次文件就能补上），也不要把今天的日期
 * 冒充成拍摄时间。EXIF 原始块由调用方交给 parseExif 解析（import 成环风险，这里不直接解析）。
 * @param {{exifTakenAt?: string, fsMtime?: number, fsBirthtime?: number}} [o]
 */
export function resolveTakenAt({ exifTakenAt = '', fsMtime = 0, fsBirthtime = 0 } = {}) {
  return exifStamp(exifTakenAt) || fileStamp({ fsMtime, fsBirthtime });
}

/** 月份键：'2026-11-10T09:00:00' → '2026-11'；非法值返回空串 */
export function monthOf(stamp) {
  const s = String(stamp || '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '';
}

/** 年份键：'2026-11-10T09:00:00' → '2026' */
export function yearOf(stamp) {
  const s = String(stamp || '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 4) : '';
}
