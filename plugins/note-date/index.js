/**
 * 官方插件：备注补日期前缀（ESM）。
 *
 * args.date 可传 'YYYY-MM-DD'；不传就用运行当天。已有日期前缀（含 2026/11/08、2026.11.08）
 * 一律跳过，避免反复运行堆出「2026-11-08 2026-11-08 …」。
 * 备注为空时把日期 + 一句占位写进去，方便后续补内容时不用自己敲。
 */
const DATED = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default async function run({ image, args, log }) {
  const note = String(image?.note || '');
  if (DATED.test(note)) {
    log('备注已有日期前缀，跳过');
    return { logs: ['已带日期，未改动'], result: { changed: false } };
  }
  const raw = String(args?.date || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today();
  const next = note.trim() ? `${date} ${note.trim()}` : `${date} `;
  log(`备注补日期 ${date}`);
  return {
    logs: [`date=${date}`],
    patch: { note: next },
    result: { changed: true, note: next },
  };
}
