// @ts-check
/**
 * 时间线的日期区间换算（纯函数，只做字符串运算，可单测）。
 *
 * 为什么单独一层：taken_at 是 'YYYY-MM-DD HH:MM:SS' 字符串，按天/按月取图都靠
 * 「字符串区间比较」走 idx_images_taken（用 substr(taken_at,1,7) = ? 会退化成全表扫）。
 * 区间上界跨月/跨年时最容易算错，而算错的表现是「最后一天/12 月整月丢图」，
 * 界面上只是数字少了一点，很难一眼看出来 —— 所以这里配单测锁住。
 */

/**
 * 'YYYY-MM' → 下个月同格式（跨年安全）
 * @param {string} month
 */
export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/**
 * 'YYYY-MM-DD' → 次日同格式（跨月/跨年/闰年安全）
 * @param {string} day
 */
export function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
