// @ts-check
// 图片拼接 / 联系表（contact sheet）
//
// 对齐 Eagle 4 Build 21 的「拼接工具」：N 张图按固定列数排成一张对照图，
// 可调列数、间距、底色、单元尺寸与输出格式。纯 sharp composite，无外部依赖。
import sharp from 'sharp';
import * as lib from '../library.js';

export const STITCH_MAX = 60;
const MAX_SIDE = 20000;

function parseColor(input) {
  const s = String(input || '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return '#ffffff';
}

/**
 * @param {{ids?:number[], columns?:number, gap?:number, bg?:string, cell?:number, format?:string, quality?:number}} opts
 */
export async function buildStitch(opts = {}) {
  const ids = (Array.isArray(opts.ids) ? opts.ids : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, STITCH_MAX);
  if (!ids.length) throw new Error('没有选择任何素材');
  const columns = Math.min(10, Math.max(1, Number(opts.columns) || 4));
  const gapRaw = Number(opts.gap);
  const gap = Number.isFinite(gapRaw) ? Math.min(120, Math.max(0, gapRaw)) : 12;
  const bg = parseColor(opts.bg);
  const format = ['jpeg', 'png', 'webp'].includes(String(opts.format)) ? String(opts.format) : 'jpeg';
  const quality = Math.min(100, Math.max(40, Number(opts.quality) || 90));

  const rows = ids.map((id) => lib.getImage(id)).filter(Boolean);
  if (!rows.length) throw new Error('选中的素材都不存在');

  // 不传 cell（前端「自适应原图」）时按这批图的中位宽度定单元格：
  // 旧实现直接回落到 400px，5120 宽的图拼出来也被压成 400；用最大宽度又会被一两张巨图带偏，
  // 导致小图在大格子里缩成一小块。中位数取舍更稳。
  const cellOpt = Number(opts.cell);
  const widths = rows.map((r) => Number(r.width) || 0).filter((w) => w > 0).sort((a, b) => a - b);
  const median = widths.length ? widths[Math.floor(widths.length / 2)] : 400;
  const autoCell = Math.min(1200, Math.max(200, median));
  const cell = Number.isFinite(cellOpt) && cellOpt >= 80 ? Math.min(1600, cellOpt) : autoCell;

  // 单元格高度按第一张的宽高比定，整张表统一，视觉上才像联系表
  const first = rows.find((r) => r.width && r.height) || rows[0];
  const aspect = first?.width && first?.height ? first.height / first.width : 1;
  const cellW = cell;
  const cellH = Math.max(40, Math.round(cell * Math.min(2, Math.max(0.4, aspect))));

  const cols = Math.min(columns, rows.length);
  const rowCount = Math.ceil(rows.length / cols);
  let width = cols * cellW + gap * (cols + 1);
  let height = rowCount * cellH + gap * (rowCount + 1);

  // 超大拼图会让内存爆掉：等比缩小单元尺寸而不是拒绝
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const cw = Math.max(40, Math.round(cellW * scale));
  const ch = Math.max(30, Math.round(cellH * scale));
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const composites = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.abs_path) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = gap + col * (cw + gap);
    const top = gap + row * (ch + gap);
    try {
      const buf = await sharp(r.abs_path, { failOn: 'none', pages: 1 })
        .rotate()
        .resize({ width: cw, height: ch, fit: 'contain', background: bg })
        .flatten({ background: bg })
        .toBuffer();
      composites.push({ input: buf, left, top });
    } catch {
      // 单张解不开就留空位，不影响整张表
    }
  }
  if (!composites.length) throw new Error('这些素材都无法解码成图片（视频/3D/字体不能拼接）');

  let pipe = sharp({
    create: { width, height, channels: 4, background: bg },
  }).composite(composites);
  if (format === 'png') pipe = pipe.png({ compressionLevel: 9 });
  else if (format === 'webp') pipe = pipe.webp({ quality });
  else pipe = pipe.jpeg({ quality, mozjpeg: true });
  const buffer = await pipe.toBuffer();
  return {
    buffer,
    mime: format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg',
    ext: format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpg',
    width,
    height,
    count: composites.length,
    skipped: rows.length - composites.length,
  };
}
