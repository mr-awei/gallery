// @ts-check
/**
 * 拍摄时间归一化（时间线视图的唯一口径）。
 *
 * 为什么单独一层：taken_at 有两个来源——EXIF DateTimeOriginal（相机本地时间，无时区）
 * 与文件 mtime / 入库时间（时间戳）。两者必须落成同一种可比较、可 substr 分月的字符串，
 * 否则时间线会「同年同月被拆成两组」，排序也会在时区边界跳。
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

/** 秒级文件 mtime → 同格式；0/非法值返回空串（调用方再兜底） */
export function mtimeStamp(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  return localStamp(new Date(n * 1000));
}

/**
 * EXIF 时间 → 同格式。
 * 接受 '2026:11:02 14:33:05'、'2026-11-02T14:33:05'、'2026-11-02 14:33'。
 * 只认「看起来像摄影时间」的值（年份 1900~2100），否则返回空串——
 * 相机没电重置成 2000-01-01 这类脏值不该把一张照片塞进时间线最底部。
 */
export function exifStamp(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return '';
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] || '00'].map(Number);
  if (y < 1900 || y > 2100) return '';
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
}

/**
 * 挑拍摄时间：EXIF 优先，其次文件 mtime，最后入库时间。
 * EXIF 原始块由调用方交给 parseExif 解析（import 成环风险，这里不直接解析）。
 * @param {{exifTakenAt?: string, fsMtime?: number, now?: Date}} [o]
 */
export function resolveTakenAt({ exifTakenAt = '', fsMtime = 0, now = new Date() } = {}) {
  return exifStamp(exifTakenAt) || mtimeStamp(fsMtime) || localStamp(now);
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
