// @ts-check
/**
 * 导入命名模板：采集、拖拽 / 粘贴、手机投送、扩展、批量入库共用同一套渲染。
 *
 * 与「批量重命名」(server/routes/organize.js) 的区别：那个是入库后改已有文件，
 * 这里是在落盘前决定文件名，所以必须自己处理扩展名、非法字符与重名。
 * 原图永远不会被改名或移动——模板只作用于新写入 / 新复制出来的那一份。
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const INVALID = /[\\/:*?"<>|\r\n\t]/g;

/** 可用占位符（设置页据此生成说明） */
export const NAME_TEMPLATE_TOKENS = [
  { token: '{name}', desc: '原文件名（不含扩展名）' },
  { token: '{keyword}', desc: '采集关键词 / 导入关键词' },
  { token: '{source}', desc: '来源（bing、weibo、lan…）' },
  { token: '{width}', desc: '宽度' },
  { token: '{height}', desc: '高度' },
  { token: '{date}', desc: '日期 YYYYMMDD' },
  { token: '{time}', desc: '时间 HHmmss' },
  { token: '{datetime}', desc: '日期-时间' },
  { token: '{index}', desc: '本批序号，默认 4 位补零' },
  { token: '{ext}', desc: '扩展名（含点，如 .jpg）' },
  { token: '{random}', desc: '6 位随机串' },
];

/** 可直接保存复用的常见格式；空模板 = 沿用内置「关键词_来源_尺寸_时间戳_随机」 */
export const NAME_TEMPLATE_PRESETS = [
  { label: '内置默认（不启用模板）', value: '' },
  { label: '日期-序号（Eagle 常用）', value: '{date}-{index}{ext}' },
  { label: '关键词-日期-序号', value: '{keyword}_{date}_{index}{ext}' },
  { label: '来源-尺寸-序号', value: '{source}_{width}x{height}_{index}{ext}' },
  { label: '原名-日期', value: '{name}_{date}{ext}' },
  { label: '日期/时间/原文件名', value: '{date}_{time}_{name}{ext}' },
];

/**
 * @param {unknown} v
 * @param {number} [limit]
 */
function safe(v, limit = 60) {
  return String(v ?? '')
    .replace(INVALID, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * 渲染一个完整文件名（自动补扩展名）。
 * @param {string} tpl
 * @param {{ keyword?: string, source?: string, width?: number, height?: number,
 *   originalName?: string, ext?: string, index?: number, pad?: number, date?: Date }} [ctx]
 * @returns {string}
 */
export function renderNameTemplate(tpl, ctx = {}) {
  const d = ctx.date instanceof Date ? ctx.date : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const ext = safe(ctx.ext || '', 12).replace(/^\./, '').toLowerCase() || 'jpg';
  const original = safe(ctx.originalName || '', 80).replace(new RegExp(`\\.${ext}$`, 'i'), '');
  const pad = Math.min(8, Math.max(1, Number(ctx.pad) || 4));
  const values = {
    name: original || '素材',
    keyword: safe(ctx.keyword) || '壁纸',
    source: safe(ctx.source) || 'local',
    width: String(Number(ctx.width) || 0),
    height: String(Number(ctx.height) || 0),
    date,
    time,
    datetime: `${date}-${time}`,
    index: String(Math.max(1, Number(ctx.index) || 1)).padStart(pad, '0'),
    // 对齐 Eagle：{ext} 自带点，模板写成 {date}-{index}{ext} 就能直接得到完整文件名
    ext: `.${ext}`,
    random: crypto.randomBytes(3).toString('hex'),
  };
  let out = String(tpl || '').replace(/\{(\w+)\}/gi, (m, key) => {
    const v = values[key.toLowerCase()];
    return v === undefined ? m : v;
  });
  out = safe(out, 120);
  // 没写 {ext} 也要有扩展名，否则落盘的是一个没有后缀的文件
  if (!out.toLowerCase().endsWith(`.${ext}`)) out = out ? `${out}.${ext}` : `${date}-${values.index}.${ext}`;
  return out;
}

/**
 * 重名自动加 -1 / -2 …；同时检查磁盘，避免同一次批量里互相覆盖。
 * @param {string} dir
 * @param {string} name
 * @returns {string} 只返回文件名，不含目录
 */
export function uniqueTargetName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || '素材';
  let candidate = name;
  for (let n = 1; n <= 100000; n += 1) {
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    candidate = `${stem}-${n}${ext}`;
  }
  return `${stem}-${crypto.randomBytes(3).toString('hex')}${ext}`;
}

/**
 * 预览：给设置页用「库里最近 20 张」渲染目标名，并演示重名加后缀。
 * @param {string} tpl
 * @param {Array<{ title?: string, abs_path?: string, keyword?: string, source?: string,
 *   width?: number, height?: number, created_at?: string }>} rows
 * @returns {string[]}
 */
export function previewNameTemplate(tpl, rows) {
  const seen = new Set();
  return rows.map((row, i) => {
    const name = renderNameTemplate(tpl, {
      originalName: row.title || path.basename(String(row.abs_path || '')),
      keyword: row.keyword,
      source: row.source,
      width: row.width,
      height: row.height,
      ext: path.extname(String(row.abs_path || '')).replace(/^\./, '') || 'jpg',
      index: i + 1,
      date: row.created_at ? new Date(row.created_at) : new Date(),
    });
    let final = name;
    for (let n = 1; seen.has(final); n += 1) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      final = `${stem}-${n}${ext}`;
    }
    seen.add(final);
    return final;
  });
}
