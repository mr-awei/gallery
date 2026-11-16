// @ts-check
/**
 * 夜间时段判断的纯函数（不碰数据库与调度，方便单测）。
 *
 * 独立一层的唯一原因：跨午夜时段是最容易写反的边界（22:00–06:00 里，
 * 23:30 算在窗口内、05:59 也算、但 12:00 不算），必须有测试盯着。
 */

/** 可选的批处理任务 */
export const NIGHT_TASKS = /** @type {const} */ (['semantic', 'face']);

/**
 * 'HH:MM' → 当天分钟数；非法值回落到 fallback。
 * 允许 '24:00' 表示当天结束（= 1440）。
 */
export function parseClock(text, fallback = 0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 24 || min > 59) return fallback;
  const v = h * 60 + min;
  return v >= 0 && v <= 1440 ? v : fallback;
}

/** 分钟数 → 'HH:MM'（显示用；24:00 原样保留） */
export function formatClock(minute) {
  const v = Math.max(0, Math.min(1440, Math.round(Number(minute) || 0)));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/**
 * 是否落在时段内。
 * - start === end 视为全天（用户把两端设成一样，意图通常是「一直跑」）
 * - start > end 支持跨午夜（22:00–06:00）
 */
export function inWindow(nowMinute, startMinute, endMinute) {
  const norm = (v) => ((Math.round(v) % 1440) + 1440) % 1440;
  const n = norm(nowMinute);
  const s = norm(startMinute);
  const e = norm(endMinute);
  if (s === e) return true;
  if (s < e) return n >= s && n < e;
  return n >= s || n < e;
}

/** 逗号分隔的任务串 → 合法任务数组（空/非法全落回两项都跑） */
export function parseTasks(raw) {
  const list = String(raw || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => NIGHT_TASKS.includes(/** @type {any} */ (t)));
  return list.length ? list : /** @type {string[]} */ ([...NIGHT_TASKS]);
}
