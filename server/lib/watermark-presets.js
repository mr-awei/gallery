// @ts-check
// 水印样式库：22 款，纯 SVG 排版，不含 IO。
//
// 设计语言按专业修图软件（美图秀秀 / 美图设计室）的路子统一：
//   · 字重 400/500 为主，靠字距和细线拉质感，而不是靠加粗加大
//   · 型号是主行（0.6~0.85 fs），参数/时间是副行（0.55~0.66 fs），绝不并成一大坨
//   · 装饰只用「极细线 + 半透明色块 + 圆角卡片」三样，线宽不超过 fs*0.05
//   · 每款有明确锚点（LOGO_SPOTS），只有字标时也落在同一个位置
//
// c: { W,H, P:{x,y,w,h} 照片矩形, lines:[{key,text}], fs 基准字号, pad, main 主色,
//      logo:{show}, brandName, opts, frameLight }
//
// 每款样式可以声明自己能排哪些信息（key 见 WATERMARK_FIELDS）：
//   uses  —— 这款只排这几项；不写 = 勾了什么都排
//   needs —— 至少要有其中一项，否则排出来是空的（胶片日期没有日期就什么都不画）
// 声明了才能告诉用户「为什么选了它却没水印」，而不是静默交出一张原图。
import { estWidth, logoMark, logoWidth, MONO, SANS, SERIF, t } from './watermark-meta.js';

const bottom = (c) => c.P.y + c.P.h - c.pad;
const cameraText = (c) => c.lines.find((l) => l.key === 'camera')?.text || '';
const timeText = (c) => c.lines.find((l) => l.key === 'time')?.text || '';
const hair = (c) => Math.max(1, c.fs * 0.045); // 极细线
const INK = '#141414';
const PAPER = '#ffffff';

/** 从下往上码行：最后一行压在 lastY，返回每行基线 */
function stackUp(rows, lastY, lineH = 1.45) {
  const ys = [lastY];
  for (let i = rows.length - 1; i > 0; i -= 1) ys.unshift(ys[0] - rows[i - 1].size * lineH);
  return ys;
}

/** 多行文字：最后一行贴 lastY，行内可逐行覆盖字号/字色/字体 */
function drawRows(rows, { x, lastY, anchor = 'start', fill, lineH = 1.45, shadow = true }) {
  const ys = stackUp(rows, lastY, lineH);
  return rows
    .map((r, i) =>
      t({
        x: r.x ?? x,
        y: ys[i],
        text: r.text,
        size: r.size,
        fill: r.fill || fill,
        anchor: r.anchor || anchor,
        weight: r.weight ?? 400,
        opacity: r.opacity ?? 1,
        spacing: r.spacing || 0,
        font: r.font || SANS,
        italic: Boolean(r.italic),
        shadow: r.shadow ?? shadow,
      })
    )
    .join('');
}

/** 按可用宽度截断（超出补省略号）：圆徽标、窄框这类容器必须自己控宽 */
function fitWidth(text, size, maxW, spacing = 0) {
  const src = String(text || '');
  let out = '';
  for (const ch of src) {
    if (estWidth(out + ch, size) + spacing * out.length > maxW) return out ? `${out.trimEnd()}…` : ch;
    out += ch;
  }
  return out;
}

/** 取若干字段的文本（按给定顺序，空值自动跳过） */
function pick(c, keys) {
  return keys.map((k) => c.lines.find((l) => l.key === k)?.text).filter(Boolean);
}

/**
 * 型号去掉重复的品牌前缀：「Canon EOS R5」+ 品牌「Canon」→「EOS R5」。
 * 同一行里既有字标又写型号时用它，免得排出「CANON Canon EOS R5」。
 */
function modelOnly(c) {
  const camera = cameraText(c);
  const brand = String(c.brandName || '').trim();
  if (!camera) return '';
  if (brand && camera.toLowerCase().startsWith(brand.toLowerCase())) return camera.slice(brand.length).trim() || camera;
  return camera;
}

const paramsLine = (c) => pick(c, ['aperture', 'shutter', 'iso']).join('   ');
const metaLine = (c) => pick(c, ['time', 'location']).join(' · ');
/**
 * 副行：参数 → 时间地点 → 「其它信息」兜底。
 * 兜底必须把相机型号排除：型号已经是主行，再拼进副行就成了
 * 「EOS 5D Mark IV / Canon EOS 5D Mark IV」上下各写一遍（用户截图里的重复就是这个）。
 */
const subLine = (c) =>
  paramsLine(c) ||
  metaLine(c) ||
  c.lines.filter((l) => l.key !== 'camera').map((l) => l.text).join(' · ');

/** 多行文字在一条带子里垂直居中：按字号算出每行基线 */
function stackBaselines(cy, sizes, lineH = 1.28) {
  const total = sizes.reduce((s, v) => s + v * lineH, 0);
  let y = cy - total / 2;
  return sizes.map((s) => {
    const baseline = y + s * 0.8;
    y += s * lineH;
    return baseline;
  });
}

/* ---------------- 极简签名：最百搭，什么都不抢 ---------------- */
const MINIMAL = [
  {
    id: 'corner-br',
    name: '极简·右下',
    desc: '型号 + 参数，右对齐，默认款',
    layout: (c) => {
      const rows = [];
      // 上面已经有「CANON」字标时，型号里的品牌前缀要剥掉，否则一眼就是「CANON Canon EOS R5」
      const cam = c.logo.show ? modelOnly(c) : cameraText(c);
      if (cam) rows.push({ text: cam, size: c.fs * 0.78, weight: 500, spacing: c.fs * 0.06 });
      const sub = subLine(c);
      if (sub) rows.push({ text: sub, size: c.fs * 0.58, opacity: 0.86, spacing: c.fs * 0.08 });
      const x = c.P.x + c.P.w - c.pad;
      let svg = drawRows(rows, { x, lastY: bottom(c), anchor: 'end', fill: c.main, lineH: 1.62 });
      if (c.logo.show && rows.length) {
        const top = stackUp(rows, bottom(c), 1.62)[0];
        svg += logoMark({ x, y: top - c.fs * 1.5, size: c.fs * 0.62, anchor: 'end', fill: c.main, name: c.brandName });
      }
      return svg;
    },
  },
  {
    id: 'corner-bl',
    name: '极简·左下',
    desc: '左对齐，横构图更稳',
    layout: (c) => {
      const rows = [];
      const cam = c.logo.show ? modelOnly(c) : cameraText(c);
      if (cam) rows.push({ text: cam, size: c.fs * 0.78, weight: 500, spacing: c.fs * 0.06 });
      const sub = subLine(c);
      if (sub) rows.push({ text: sub, size: c.fs * 0.58, opacity: 0.86, spacing: c.fs * 0.08 });
      const x = c.P.x + c.pad;
      let svg = drawRows(rows, { x, lastY: bottom(c), fill: c.main, lineH: 1.62 });
      if (c.logo.show && rows.length) {
        const top = stackUp(rows, bottom(c), 1.62)[0];
        svg += logoMark({ x, y: top - c.fs * 1.5, size: c.fs * 0.62, fill: c.main, name: c.brandName });
      }
      return svg;
    },
  },
  {
    id: 'corner-bracket',
    name: '取景框角',
    desc: '左下角括线，像相机对焦框',
    // 括线是围着型号画的：没有型号就只剩两条线，所以必须有相机信息
    needs: ['camera'],
    layout: (c) => {
      const size = c.fs * 0.7;
      const cam = cameraText(c);
      const rows = [];
      if (cam) rows.push({ text: cam, size, weight: 500, spacing: c.fs * 0.05 });
      const sub = cam ? subLine(c) : '';
      if (sub) rows.push({ text: sub, size, opacity: 0.84, spacing: c.fs * 0.05 });
      if (!rows.length) return '';
      const x = c.P.x + c.pad;
      const yb = bottom(c);
      const ys = stackUp(rows, yb, 1.55);
      const sw = hair(c);
      const x0 = x - c.fs * 0.5;
      const y0 = ys[0] - size * 1.15;
      const arm = c.fs * 0.55;
      const bracket =
        `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${sw.toFixed(2)}" height="${(yb - y0 + size * 0.4).toFixed(1)}" fill="${c.main}" fill-opacity="0.75"/>` +
        `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${arm.toFixed(1)}" height="${sw.toFixed(2)}" fill="${c.main}" fill-opacity="0.75"/>` +
        `<rect x="${x0.toFixed(1)}" y="${(yb + size * 0.4).toFixed(1)}" width="${arm.toFixed(1)}" height="${sw.toFixed(2)}" fill="${c.main}" fill-opacity="0.75"/>`;
      return bracket + drawRows(rows, { x, lastY: yb, fill: c.main, lineH: 1.55 });
    },
  },
  {
    id: 'minimal-time',
    name: '极简·时间戳',
    desc: '只有一行时间，克制到极致',
    // 只排这三项（时间优先，没有就退到地点/型号）；勾了光圈快门它也不显示
    uses: ['time', 'location', 'camera'],
    layout: (c) => {
      const text = timeText(c) || metaLine(c) || cameraText(c);
      if (!text) return '';
      const x = c.P.x + c.P.w - c.pad;
      const y = bottom(c);
      return (
        `<circle cx="${(x - estWidth(text, c.fs * 0.6) - c.fs * 0.7).toFixed(1)}" cy="${(y - c.fs * 0.2).toFixed(1)}" r="${(c.fs * 0.1).toFixed(1)}" fill="${c.main}" fill-opacity="0.9"/>` +
        t({ x, y, text, size: c.fs * 0.6, anchor: 'end', fill: c.main, spacing: c.fs * 0.08, shadow: true })
      );
    },
  },
  {
    id: 'tag-line',
    name: '细线标签',
    desc: '上下细线夹一行说明，居中',
    layout: (c) => {
      // 优先时间地点，其次参数，最后才是型号（副行已排除型号，这里要单独兜底，否则只勾型号时是空的）
      const text = metaLine(c) || subLine(c) || cameraText(c);
      if (!text) return '';
      const size = c.fs * 0.56;
      const cx = c.P.x + c.P.w / 2;
      const y = bottom(c);
      const w = estWidth(text, size) + c.fs * 1.6;
      const sw = hair(c);
      return (
        `<rect x="${(cx - w / 2).toFixed(1)}" y="${(y - size * 1.75).toFixed(1)}" width="${w.toFixed(1)}" height="${sw.toFixed(2)}" fill="${c.main}" fill-opacity="0.55"/>` +
        t({ x: cx, y, text, size, anchor: 'middle', fill: c.main, spacing: c.fs * 0.1, shadow: true }) +
        `<rect x="${(cx - w / 2).toFixed(1)}" y="${(y + c.fs * 0.5).toFixed(1)}" width="${w.toFixed(1)}" height="${sw.toFixed(2)}" fill="${c.main}" fill-opacity="0.55"/>`
      );
    },
  },
];

/* ---------------- 杂志 / 画报：字距拉开的大写标题 ---------------- */
const EDITORIAL = [
  {
    id: 'magazine-right',
    name: '杂志右栏',
    desc: '大写标题 + 竖细线，设计感',
    layout: (c) => {
      // 大写标题里重复品牌（CANON / CANON EOS R5 叠着写）最掉价，有字标就只留型号
      const cam = ((c.logo.show ? modelOnly(c) : cameraText(c)) || '').toUpperCase();
      const rows = [];
      if (cam) rows.push({ text: cam, size: c.fs * 0.64, weight: 500, spacing: c.fs * 0.14 });
      const sub = subLine(c);
      if (sub) rows.push({ text: sub, size: c.fs * 0.53, opacity: 0.8, spacing: c.fs * 0.06 });
      if (!rows.length) return '';
      const x = c.P.x + c.P.w - c.pad;
      const ys = stackUp(rows, bottom(c), 1.7);
      const top = ys[0] - rows[0].size * 1.05;
      const width = Math.max(...rows.map((r) => estWidth(r.text, r.size))) + c.fs * 0.3;
      const svg =
        `<rect x="${(x - width - c.fs * 0.55).toFixed(1)}" y="${top.toFixed(1)}" width="${hair(c).toFixed(2)}" height="${(bottom(c) - top + c.fs * 0.3).toFixed(1)}" fill="${c.main}" fill-opacity="0.5"/>` +
        drawRows(rows, { x, lastY: bottom(c), anchor: 'end', fill: c.main, lineH: 1.7 });
      return c.logo.show
        ? svg + logoMark({ x, y: top - c.fs * 0.95, size: c.fs * 0.56, anchor: 'end', fill: c.main, name: c.brandName })
        : svg;
    },
  },
  {
    id: 'magazine-top',
    name: '画报抬头',
    desc: '左上大写标题 + 细线',
    layout: (c) => {
      const x = c.P.x + c.pad;
      const cam = ((c.logo.show ? modelOnly(c) : cameraText(c)) || '').toUpperCase();
      const rows = [];
      if (cam) rows.push({ text: cam, size: c.fs * 0.58, weight: 500, spacing: c.fs * 0.16 });
      const sub = subLine(c);
      if (sub) rows.push({ text: sub, size: c.fs * 0.5, opacity: 0.78, spacing: c.fs * 0.05 });
      if (!rows.length) return '';
      const y = c.P.y + c.pad + rows[0].size * 0.85;
      const width = Math.max(...rows.map((r) => estWidth(r.text, r.size)), c.fs * 3);
      const svg =
        drawRows(rows, { x, lastY: y, fill: c.main, lineH: 1.75 }) +
        `<rect x="${x.toFixed(1)}" y="${(y + c.fs * 0.44).toFixed(1)}" width="${width.toFixed(1)}" height="${hair(c).toFixed(2)}" fill="${c.main}" fill-opacity="0.55"/>`;
      return c.logo.show
        ? svg + logoMark({ x: c.P.x + c.P.w - c.pad, y, size: c.fs * 0.56, anchor: 'end', fill: c.main, name: c.brandName })
        : svg;
    },
  },
  {
    id: 'serif-caption',
    name: '衬线说明',
    desc: '衬线斜体型号 + 字距参数',
    layout: (c) => {
      const rows = [];
      const cam = cameraText(c);
      if (cam) rows.push({ text: cam, size: c.fs * 0.9, font: SERIF, italic: true, spacing: c.fs * 0.02 });
      const sub = subLine(c);
      if (sub) rows.push({ text: sub, size: c.fs * 0.5, opacity: 0.8, spacing: c.fs * 0.16 });
      return drawRows(rows, { x: c.P.x + c.P.w / 2, lastY: bottom(c), anchor: 'middle', fill: c.main, lineH: 1.85 });
    },
  },
  {
    id: 'brand-block',
    name: '品牌落款',
    desc: '居中字标 + 型号小字',
    // 落款只有品牌 + 型号，参数/时间地点一律不排
    uses: ['camera'],
    layout: (c) => {
      const rows = [];
      const cam = modelOnly(c) || cameraText(c);
      if (cam) rows.push({ text: cam, size: c.fs * 0.5, opacity: 0.85, spacing: c.fs * 0.14 });
      const hasLogo = c.logo.show && Boolean(c.brandName);
      const y = bottom(c);
      const svg = rows.length ? drawRows(rows, { x: c.P.x + c.P.w / 2, lastY: y, anchor: 'middle', fill: c.main, lineH: 1.9 }) : '';
      return hasLogo
        ? logoMark({ x: c.P.x + c.P.w / 2, y: y - (rows.length ? rows[0].size * 1.6 : 0), size: c.fs * 0.88, anchor: 'middle', fill: c.main, name: c.brandName }) + svg
        : svg;
    },
  },
  {
    id: 'vertical-city',
    name: '竖排城市',
    desc: '右侧逐字竖排，日式海报感',
    // 竖排只适合地名和短型号：时间/参数竖起来读不懂，所以不排
    uses: ['location', 'camera'],
    layout: (c) => {
      // 竖排只放地名：把「2026-10-01 18:20 · 上海」整串竖起来会变成一根读不懂的柱子
      const place = c.lines.find((l) => l.key === 'location')?.text || '';
      const text = (place || modelOnly(c) || cameraText(c)).replace(/[·\s]+/g, '').slice(0, 12);
      if (!text) return '';
      const chars = [...text];
      const size = c.fs * 0.78;
      const step = size * 1.18;
      const x = c.P.x + c.P.w - c.pad;
      const y0 = bottom(c) - (chars.length - 1) * step;
      return chars
        .map((ch, i) => t({ x, y: y0 + i * step, text: ch, size, anchor: 'middle', fill: c.main, shadow: true }))
        .join('');
    },
  },
];

/* ---------------- 图形化：色块、胶片、卡片、徽标 ---------------- */
const GRAPHIC = [
  {
    id: 'cinema-bar',
    name: '电影字幕',
    desc: '底部黑条居中，像片尾字幕',
    layout: (c) => {
      const h = Math.max(c.fs * 2.7, c.P.h * 0.078);
      const y0 = c.P.y + c.P.h - h;
      const rows = [];
      const cam = cameraText(c);
      if (cam) rows.push({ text: cam, size: c.fs * 0.68, weight: 500, spacing: c.fs * 0.1 });
      const sub = subLine(c);
      if (sub) rows.push({ text: sub, size: c.fs * 0.54, opacity: 0.8, spacing: c.fs * 0.06 });
      const ys = stackBaselines(y0 + h / 2, rows.map((r) => r.size), 1.5);
      const cx = c.P.x + c.P.w / 2;
      return (
        `<rect x="${c.P.x}" y="${y0.toFixed(1)}" width="${c.P.w}" height="${h.toFixed(1)}" fill="#000000" fill-opacity="0.8"/>` +
        rows
          .map((r, i) =>
            t({ x: cx, y: ys[i], text: r.text, size: r.size, anchor: 'middle', fill: PAPER, weight: r.weight ?? 400, opacity: r.opacity ?? 1, spacing: r.spacing || 0, shadow: false })
          )
          .join('')
      );
    },
  },
  {
    id: 'film-date',
    name: '胶片日期',
    desc: '橙红日期戳，90 年代胶片味',
    // 主体是日期戳：没有时间/地点就什么都不画（以前会静默生成一张原图）
    uses: ['time', 'location', 'camera'],
    needs: ['time', 'location'],
    layout: (c) => {
      const date = timeText(c) || metaLine(c);
      if (!date) return '';
      const x = c.P.x + c.P.w - c.pad;
      const y = bottom(c);
      const rows = [];
      if (cameraText(c)) rows.push({ text: cameraText(c), size: c.fs * 0.5, opacity: 0.8, spacing: c.fs * 0.1 });
      return (
        (rows.length ? drawRows(rows, { x, lastY: y - c.fs * 1.15, anchor: 'end', fill: c.main, lineH: 1.5 }) : '') +
        t({ x, y, text: date, size: c.fs * 0.62, anchor: 'end', fill: '#ff8a3d', font: MONO, spacing: c.fs * 0.14 })
      );
    },
  },
  {
    id: 'param-grid',
    name: '参数三格',
    desc: '白色圆角卡片，光圈/快门/ISO',
    // 卡片就是参数卡：型号当标题，参数当正文，时间地点不排
    uses: ['camera', 'aperture', 'shutter', 'iso'],
    layout: (c) => {
      const cols = [
        { label: '光圈', value: c.lines.find((l) => l.key === 'aperture')?.text },
        { label: '快门', value: c.lines.find((l) => l.key === 'shutter')?.text },
        { label: 'ISO', value: c.lines.find((l) => l.key === 'iso')?.text },
      ].filter((v) => v.value);
      const cam = modelOnly(c) || cameraText(c);
      if (!cols.length && !cam) return '';
      const w = c.fs * (cols.length ? Math.max(7.6, cols.length * 2.9) : 6.4);
      const h = c.fs * (cols.length ? 3.1 : 1.9);
      const x = c.P.x + c.P.w - c.pad - w;
      const y = bottom(c) + c.fs * 0.55 - h;
      const r = c.fs * 0.34;
      let svg = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r.toFixed(1)}" fill="${PAPER}" fill-opacity="0.9"/>`;
      if (cam) {
        svg += t({ x: x + c.fs * 0.6, y: y + c.fs * 0.92, text: cam, size: c.fs * 0.5, weight: 500, fill: INK, opacity: 0.72, spacing: c.fs * 0.1, shadow: false });
      }
      const cw = (w - c.fs * 0.6) / Math.max(1, cols.length);
      cols.forEach((col, i) => {
        const cx = x + c.fs * 0.6 + cw * i;
        svg += t({ x: cx, y: y + h - c.fs * 0.72, text: col.value, size: c.fs * 0.66, weight: 500, fill: INK, shadow: false });
        svg += t({ x: cx, y: y + c.fs * (cam ? 1.55 : 1.2), text: col.label, size: c.fs * 0.38, fill: INK, opacity: 0.55, spacing: c.fs * 0.1, shadow: false });
      });
      return svg;
    },
  },
  {
    id: 'badge-circle',
    name: '圆形徽标',
    desc: '右下圆形细线徽标，内排两行',
    // 徽标里只有两行位置，排不了镜头那种长串
    uses: ['camera', 'aperture', 'shutter', 'iso', 'time', 'location'],
    layout: (c) => {
      const cam = modelOnly(c) || cameraText(c);
      const r = c.fs * 1.9;
      // 圆里可用宽度只有弦长的一小半，按真实字宽截，别用 slice 砍出「1/500」
      const innerW = r * 1.5;
      const vals = pick(c, ['aperture', 'shutter']).join('  ') || metaLine(c);
      const iso = pick(c, ['iso'])[0];
      if (!cam && !vals) return '';
      const rows = [];
      if (cam) rows.push({ text: fitWidth(cam, c.fs * 0.44, innerW), size: c.fs * 0.44, weight: 500, spacing: c.fs * 0.04 });
      if (vals) rows.push({ text: fitWidth(vals, c.fs * 0.34, innerW), size: c.fs * 0.34, opacity: 0.85 });
      if (iso && rows.length < 3) rows.push({ text: iso, size: c.fs * 0.3, opacity: 0.72 });
      const cx = c.P.x + c.P.w - c.pad - r * 0.55;
      const cy = bottom(c) - r * 0.55;
      const ys = stackBaselines(cy, rows.map((v) => v.size), 1.4);
      return (
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${c.main}" stroke-opacity="0.7" stroke-width="${hair(c).toFixed(2)}"/>` +
        rows
          .map((v, i) => t({ x: cx, y: ys[i], text: v.text, size: v.size, anchor: 'middle', fill: c.main, weight: v.weight ?? 400, opacity: v.opacity ?? 1, spacing: v.spacing || 0, shadow: true }))
          .join('')
      );
    },
  },
  {
    id: 'stamp-date',
    name: '印章日期',
    desc: '双线方框 + 日期地点，纪实感',
    // 印章只盖时间和地点，型号/参数不排
    uses: ['time', 'location'],
    needs: ['time', 'location'],
    layout: (c) => {
      const date = timeText(c) || metaLine(c);
      if (!date) return '';
      const loc = c.lines.find((l) => l.key === 'location')?.text || '';
      // 框宽按「字宽 + 字距 + 内边距」算，否则日期会顶到双线框上（字距最容易被漏掉）
      const dateW = estWidth(date, c.fs * 0.52) + [...date].length * c.fs * 0.1;
      const locW = loc ? estWidth(loc, c.fs * 0.38) + [...loc].length * c.fs * 0.06 : 0;
      const w = Math.max(c.fs * 6.2, dateW + c.fs * 1.9, locW + c.fs * 1.9);
      const h = loc ? c.fs * 2.3 : c.fs * 1.5;
      const x = c.P.x + c.P.w - c.pad - w;
      const y = bottom(c) + c.fs * 0.4 - h;
      const sw = hair(c);
      const pad = c.fs * 0.34;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="${c.main}" stroke-opacity="0.62" stroke-width="${sw.toFixed(2)}"/>` +
        `<rect x="${(x + pad).toFixed(1)}" y="${(y + pad).toFixed(1)}" width="${(w - pad * 2).toFixed(1)}" height="${(h - pad * 2).toFixed(1)}" fill="none" stroke="${c.main}" stroke-opacity="0.38" stroke-width="${(sw * 0.6).toFixed(2)}"/>` +
        t({ x: x + w / 2, y: y + (loc ? h * 0.48 : h * 0.62), text: date, size: c.fs * 0.5, anchor: 'middle', fill: c.main, font: MONO, spacing: c.fs * 0.1, shadow: true }) +
        (loc ? t({ x: x + w / 2, y: y + h * 0.78, text: loc, size: c.fs * 0.38, anchor: 'middle', fill: c.main, opacity: 0.8, spacing: c.fs * 0.06, shadow: true }) : '')
      );
    },
  },
];

/* ---------------- 色带 / 信息栏：自带底，白字黑字都稳 ---------------- */
const BAND = [
  {
    id: 'bottom-paper',
    name: '底部白条',
    desc: '白底黑字，参数左、字标右',
    layout: (c) => {
      const h = Math.max(c.fs * 2.9, c.P.h * 0.088);
      const y0 = c.P.y + c.P.h - h;
      const yb = y0 + h / 2;
      const xL = c.P.x + c.pad * 0.8;
      const xR = c.P.x + c.P.w - c.pad * 0.8;
      const left = [];
      const leftSub = paramsLine(c) || cameraText(c);
      const leftMeta = paramsLine(c) ? metaLine(c) : '';
      if (leftSub) left.push({ text: leftSub, size: c.fs * 0.6, weight: 500, spacing: c.fs * 0.05 });
      if (leftMeta) left.push({ text: leftMeta, size: c.fs * 0.48, opacity: 0.6, spacing: c.fs * 0.04 });
      const leftY = stackBaselines(yb, left.map((r) => r.size), 1.5);
      let svg = `<rect x="${c.P.x}" y="${y0.toFixed(1)}" width="${c.P.w}" height="${h.toFixed(1)}" fill="${PAPER}" fill-opacity="0.95"/>`;
      svg += left
        .map((r, i) => t({ x: xL, y: leftY[i], text: r.text, size: r.size, fill: INK, weight: r.weight ?? 400, opacity: r.opacity ?? 1, spacing: r.spacing || 0, shadow: false }))
        .join('');
      // 右侧只放型号：有参数时左边是参数、右边写型号；没有参数时左边已经写了完整型号，右边不再重复
      const right = paramsLine(c) ? modelOnly(c) || '' : '';
      let rx = xR;
      if (c.logo.show) {
        svg += logoMark({ x: xR, y: yb + c.fs * 0.22, size: c.fs * 0.6, anchor: 'end', fill: INK, name: c.brandName });
        rx = xR - logoWidth(c.brandName, c.fs * 0.6) - c.fs * 0.45;
      }
      if (right) svg += t({ x: rx, y: yb + c.fs * 0.22, text: right, size: c.fs * 0.56, weight: 500, anchor: 'end', fill: INK, shadow: false });
      return svg;
    },
  },
  {
    id: 'polaroid-caption',
    name: '拍立得',
    desc: '米白条 + 衬线斜体，手写感',
    layout: (c) => {
      const h = Math.max(c.fs * 3.2, c.P.h * 0.1);
      const y0 = c.P.y + c.P.h - h;
      const rows = [];
      const cam = cameraText(c);
      if (cam) rows.push({ text: cam, size: c.fs * 0.72, font: SERIF, italic: true });
      const sub = metaLine(c) || paramsLine(c);
      if (sub) rows.push({ text: sub, size: c.fs * 0.44, opacity: 0.66, spacing: c.fs * 0.1 });
      const ys = stackBaselines(y0 + h / 2, rows.map((r) => r.size), 1.75);
      const cx = c.P.x + c.P.w / 2;
      return (
        `<rect x="${c.P.x}" y="${y0.toFixed(1)}" width="${c.P.w}" height="${h.toFixed(1)}" fill="#fdfaf3"/>` +
        rows
          .map((r, i) =>
            t({ x: cx, y: ys[i], text: r.text, size: r.size, anchor: 'middle', fill: '#2b2b2b', font: r.font, italic: Boolean(r.font), opacity: r.opacity ?? 1, spacing: r.spacing || 0, shadow: false })
          )
          .join('')
      );
    },
  },
  {
    id: 'dual-tone',
    name: '双色条',
    desc: '左品牌实心块 + 右参数',
    // 左侧只放品牌字标，右侧放参数/时间地点；型号这一项它不排
    uses: ['aperture', 'shutter', 'iso', 'time', 'location'],
    layout: (c) => {
      const h = Math.max(c.fs * 2.2, c.P.h * 0.066);
      const y0 = c.P.y + c.P.h - h;
      const brand = String(c.brandName || '').toUpperCase();
      const blockW = Math.min(c.P.w * 0.42, (c.logo.show ? logoWidth(brand, c.fs * 0.58) : 0) + c.fs * 2);
      const sub = paramsLine(c) || metaLine(c);
      let svg = `<rect x="${c.P.x}" y="${y0.toFixed(1)}" width="${c.P.w}" height="${h.toFixed(1)}" fill="#000000" fill-opacity="0.62"/>`;
      if (c.logo.show && brand) {
        svg += `<rect x="${c.P.x}" y="${y0.toFixed(1)}" width="${blockW.toFixed(1)}" height="${h.toFixed(1)}" fill="#ffffff" fill-opacity="0.94"/>`;
        svg += logoMark({ x: c.P.x + c.fs * 0.7, y: y0 + h / 2 + c.fs * 0.2, size: c.fs * 0.58, fill: INK, name: c.brandName });
      }
      if (sub) {
        svg += t({
          x: c.P.x + (c.logo.show && brand ? blockW + c.fs * 0.8 : c.fs * 0.8),
          y: y0 + h / 2 + c.fs * 0.18,
          text: sub,
          size: c.fs * 0.5,
          fill: PAPER,
          spacing: c.fs * 0.08,
          shadow: false,
        });
      }
      return svg;
    },
  },
  {
    id: 'mono-strip',
    name: '等宽信息条',
    desc: '整宽半透明条，仪表盘风',
    layout: (c) => {
      const h = Math.max(c.fs * 2.1, c.P.h * 0.062);
      const y0 = c.P.y + c.P.h - h;
      // 左：时间地点（没有就型号）；右：只放参数 —— 两边都退到型号会把型号印两遍
      const left = metaLine(c) || cameraText(c);
      const right = paramsLine(c);
      let svg = `<rect x="${c.P.x}" y="${y0.toFixed(1)}" width="${c.P.w}" height="${h.toFixed(1)}" fill="#000000" fill-opacity="0.5"/>`;
      if (left)
        svg += t({ x: c.P.x + c.pad * 0.8, y: y0 + h / 2 + c.fs * 0.17, text: left, size: c.fs * 0.46, fill: PAPER, font: MONO, spacing: c.fs * 0.06, shadow: false });
      if (right)
        svg += t({ x: c.P.x + c.P.w - c.pad * 0.8, y: y0 + h / 2 + c.fs * 0.17, text: right, size: c.fs * 0.46, anchor: 'end', fill: PAPER, font: MONO, spacing: c.fs * 0.06, shadow: false });
      return svg;
    },
  },
  {
    id: 'side-rail',
    name: '侧边信息栏',
    desc: '左侧竖排半透明导轨',
    layout: (c) => {
      const text = [cameraText(c), subLine(c)].filter(Boolean).join('   ');
      if (!text) return '';
      const w = c.fs * 1.9;
      const h = Math.min(c.P.h * 0.72, c.fs * 13);
      const x0 = c.P.x + c.pad * 0.6;
      const y0 = c.P.y + c.P.h - c.pad - h;
      return (
        `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#000000" fill-opacity="0.42"/>` +
        `<g transform="translate(${(x0 + w / 2 + c.fs * 0.16).toFixed(1)},${(y0 + h / 2).toFixed(1)}) rotate(-90)">${t({
          x: 0,
          y: 0,
          text,
          size: c.fs * 0.44,
          anchor: 'middle',
          fill: PAPER,
          spacing: c.fs * 0.12,
          shadow: false,
        })}</g>`
      );
    },
  },
];

/* ---------------- 留白辅助：边框款把字排进相框留白，而不是压在照片上 ---------------- */
/** 底部留白：够高用真留白，不够就退回照片内侧铺一条 */
function bottomBand(c, rows = 2) {
  const h = Math.max(0, c.H - (c.P.y + c.P.h));
  const want = c.fs * (0.8 + rows * 1.05);
  if (h >= want) return { y0: c.P.y + c.P.h, h, inside: false };
  return { y0: c.P.y + c.P.h - want, h: want, inside: true };
}

/** 顶部留白，规则同上 */
function topBand(c) {
  const h = Math.max(0, c.P.y);
  const want = c.fs * 2.1;
  if (h >= want) return { y0: 0, h, inside: false };
  return { y0: c.P.y, h: want, inside: true };
}

/** 相框底色偏亮 → 黑字；偏暗 → 白字。没有相框（frameLight 缺省）按白算 */
const paperFg = (c) => (c.frameLight === false ? '#f4f4f4' : INK);
const paperBg = (c) => c.frameBg || (c.frameLight === false ? '#0b0b0b' : '#ffffff');
const bandRect = (b, c) =>
  `<rect x="${c.P.x}" y="${b.y0.toFixed(1)}" width="${c.P.w}" height="${b.h.toFixed(1)}" fill="${paperBg(c)}" fill-opacity="0.97"/>`;

/* ---------------- 边框款：黑白相框通用（用户点名要的三款） ----------------
 * 这几种样式把字排进「相框留白」里，而不是压在照片上：
 * 底部留白够高就画在留白内；不够高（或没选相框）就自己铺一条同色条。
 * 颜色跟着相框底色走（白框黑字 / 黑框白字），所以一套样式黑白框都能用。
 */
const BORDER = [
  {
    id: 'mat-brand-param',
    name: '边框款·左牌右参',
    desc: '左品牌右参数，黑框白框通用',
    handlesEmpty: true,
    layout: (c) => {
      const b = bottomBand(c, 2);
      const fg = paperFg(c);
      const line = b.inside ? c.pad : c.pad * 0.8;
      const xL = c.P.x + line;
      const xR = c.P.x + c.P.w - line;
      const cy = b.y0 + b.h / 2;
      const camera = cameraText(c);
      const params = pick(c, ['aperture', 'shutter', 'iso']).join('  ');
      const meta = pick(c, ['time', 'location']).join(' · ');
      let svg = b.inside ? bandRect(b, c) : '';
      // 左：字标 + 型号；没有字标就只排型号，别留一块空洞
      const logoSize = c.fs * 0.92;
      let tx = xL;
      if (c.logo.show) {
        svg += logoMark({ x: xL, y: cy + c.fs * 0.32, size: logoSize, fill: fg, name: c.brandName });
        // 字标带 0.16em 字距、粗体大写更宽，必须按 logoWidth 让位，否则型号压在字标尾巴上
        tx = xL + logoWidth(c.brandName, logoSize) + c.fs * 0.5;
      }
      const title = c.logo.show ? modelOnly(c) : camera;
      if (title) svg += t({ x: tx, y: cy + c.fs * 0.32, text: title, size: c.fs * 0.86, weight: 600, fill: fg, shadow: false });
      // 右：参数 + 时间地点，两行右对齐（跟样图一样），整块在带子里居中
      const rows = [
        ...(params ? [{ text: params, size: c.fs * 0.78 }] : []),
        ...(meta ? [{ text: meta, size: c.fs * 0.64, opacity: 0.72 }] : []),
      ];
      const rowY = stackBaselines(cy, rows.map((r) => r.size));
      rows.forEach((r, i) => {
        svg += t({ x: xR, y: rowY[i], text: r.text, size: r.size, anchor: 'end', fill: fg, opacity: r.opacity, shadow: false });
      });
      return svg;
    },
  },
  {
    id: 'mat-title-city',
    name: '边框款·顶语底城',
    desc: '顶部标语 + 底部城市日期，画册感',
    // 画册排版：地名当标题、时间当副题，型号最多顶上去当标题
    uses: ['location', 'time', 'camera'],
    handlesEmpty: true,
    layout: (c) => {
      const top = topBand(c);
      const bot = bottomBand(c, 1);
      const fg = paperFg(c);
      const city = pick(c, ['location'])[0] || modelOnly(c) || '';
      const date = pick(c, ['time'])[0] || '';
      const slogan = c.logo.show ? String(c.brandName || '').toUpperCase() : '';
      let svg = '';
      if (slogan && top.inside) svg += bandRect(top, c);
      if (city && bot.inside) svg += bandRect(bot, c);
      if (slogan)
        svg += t({
          x: c.P.x + c.P.w / 2,
          y: top.y0 + top.h / 2 + c.fs * 0.56 * 0.2,
          text: slogan,
          size: c.fs * 0.56,
          anchor: 'middle',
          fill: fg,
          spacing: c.fs * 0.5,
          font: SERIF,
          shadow: false,
        });
      const rows = [
        ...(city ? [{ text: city, size: c.fs * 0.92, font: SERIF, spacing: c.fs * 0.12 }] : []),
        ...(date ? [{ text: date, size: c.fs * 0.58, font: MONO, spacing: c.fs * 0.08, opacity: 0.72 }] : []),
      ];
      const rowY = stackBaselines(bot.y0 + bot.h / 2, rows.map((r) => r.size), 1.4);
      rows.forEach((r, i) => {
        svg += t({
          x: c.P.x + c.P.w / 2,
          y: rowY[i],
          text: r.text,
          size: r.size,
          anchor: 'middle',
          fill: fg,
          font: r.font,
          spacing: r.spacing,
          opacity: r.opacity,
          shadow: false,
        });
      });
      return svg;
    },
  },
  {
    id: 'mat-split-rule',
    name: '边框款·分割线',
    desc: '留白里一条细线，线上品牌线下参数',
    handlesEmpty: true,
    layout: (c) => {
      const b = bottomBand(c, 2);
      const fg = paperFg(c);
      const line = b.inside ? c.pad : c.pad * 0.8;
      const xL = c.P.x + line;
      const xR = c.P.x + c.P.w - line;
      const yMid = b.y0 + b.h * 0.5;
      const params = pick(c, ['aperture', 'shutter', 'iso']).join('  ');
      const meta = pick(c, ['time', 'location']).join(' · ');
      let svg = b.inside ? bandRect(b, c) : '';
      // 细线：白框用黑线、黑框用白线，压 55% 不抢
      svg += `<rect x="${xL.toFixed(1)}" y="${yMid.toFixed(1)}" width="${(xR - xL).toFixed(1)}" height="${Math.max(1, c.fs * 0.05).toFixed(2)}" fill="${fg}" fill-opacity="0.5"/>`;
      // 线上：品牌（仅在开了字标时写）+ 型号；型号里重复的品牌前缀先剥掉，
      // 否则会排出「Canon Canon EOS R5」这种一眼就露馅的重复。
      const upper = [c.logo.show ? c.brandName : '', modelOnly(c)].filter(Boolean).join('  ');
      if (upper) svg += t({ x: xL, y: yMid - c.fs * 0.42, text: upper, size: c.fs * 0.7, weight: 600, fill: fg, spacing: c.fs * 0.08, shadow: false });
      const lower = params || meta;
      if (lower) svg += t({ x: xR, y: yMid + c.fs * 1.02, text: lower, size: c.fs * 0.66, anchor: 'end', fill: fg, opacity: 0.8, shadow: false });
      return svg;
    },
  },
];

/* ---------------- 只有字标、没有任何文字时的落位 ----------------
 * 以前这种情况会被整条换成「品牌落款」（永远居中），用户选「左下角」却出现在中间，
 * 看起来就是「水印位置设置不生效」。现在按所选样式的落位画，选了哪儿就在哪儿。
 */
const LOGO_SPOTS = {
  'corner-br': 'br',
  'corner-bl': 'bl',
  'corner-bracket': 'bl',
  'minimal-time': 'br',
  'tag-line': 'bc',
  'magazine-right': 'br',
  'magazine-top': 'tl',
  'serif-caption': 'bc',
  'brand-block': 'bc',
  'vertical-city': 'rc',
  'cinema-bar': 'bc',
  'film-date': 'br',
  'param-grid': 'br',
  'badge-circle': 'br',
  'stamp-date': 'br',
  'bottom-paper': 'br',
  'polaroid-caption': 'bc',
  'dual-tone': 'bl',
  'mono-strip': 'bl',
  'side-rail': 'lc',
  'mat-brand-param': 'bl',
  'mat-title-city': 'bc',
  'mat-split-rule': 'bl',
};

/** 某些样式的「字标位」自带底色条，字标颜色得跟着底色走 */
const LOGO_BANDS = {
  'bottom-paper': { at: 'bottom', h: (c) => Math.max(c.fs * 2.9, c.P.h * 0.088), fill: '#ffffff', opacity: 0.95, fg: INK, x: 'right' },
  'polaroid-caption': { at: 'bottom', h: (c) => Math.max(c.fs * 3.2, c.P.h * 0.1), fill: '#fdfaf3', opacity: 1, fg: '#2b2b2b', x: 'center' },
  'cinema-bar': { at: 'bottom', h: (c) => Math.max(c.fs * 2.7, c.P.h * 0.078), fill: '#000000', opacity: 0.8, fg: PAPER, x: 'center' },
  'mono-strip': { at: 'bottom', h: (c) => Math.max(c.fs * 2.1, c.P.h * 0.062), fill: '#000000', opacity: 0.5, fg: PAPER, x: 'left' },
  'dual-tone': { at: 'bottom', h: (c) => Math.max(c.fs * 2.2, c.P.h * 0.066), fill: '#000000', opacity: 0.62, fg: PAPER, x: 'left' },
};

/** 只有字标时按样式落位出图 */
export function logoOnlySvg(c, style) {
  const spot = LOGO_SPOTS[style.id] || 'br';
  const band = LOGO_BANDS[style.id];
  const pad = c.pad;
  const size = c.fs * (band ? 0.9 : 1.0);
  const fill = c.main;
  let svg = '';

  if (band) {
    const h = band.h(c);
    const y0 = band.at === 'top' ? c.P.y : c.P.y + c.P.h - h;
    svg += `<rect x="${c.P.x}" y="${y0.toFixed(1)}" width="${c.P.w}" height="${h.toFixed(1)}" fill="${band.fill}" fill-opacity="${band.opacity}"/>`;
    const y = y0 + h / 2 + size * 0.36;
    let x = c.P.x + c.P.w / 2;
    let anchor = 'middle';
    if (band.x === 'right') {
      x = c.P.x + c.P.w - pad;
      anchor = 'end';
    } else if (band.x === 'left') {
      x = c.P.x + pad;
      anchor = 'start';
    }
    return svg + logoMark({ x, y, size, anchor, fill: band.fg, name: c.brandName });
  }

  const cy = c.P.y + c.P.h - pad; // 底边基准线
  let x = c.P.x + pad;
  let y = cy;
  let anchor = 'start';
  if (spot === 'br' || spot === 'tr') {
    x = c.P.x + c.P.w - pad;
    anchor = 'end';
  }
  if (spot === 'bc' || spot === 'tc') {
    x = c.P.x + c.P.w / 2;
    anchor = 'middle';
  }
  if (spot === 'tl' || spot === 'tr' || spot === 'tc') y = c.P.y + pad + c.fs * 0.9;
  if (spot === 'lc' || spot === 'rc') y = c.P.y + c.P.h / 2;

  svg += logoMark({ x, y, size, anchor, fill, name: c.brandName });
  return svg;
}

export const WATERMARK_STYLES = [...MINIMAL, ...EDITORIAL, ...GRAPHIC, ...BAND, ...BORDER];

/** 样式 id → 定义（未知 id 回落到第一款） */
export function findWatermarkStyle(id) {
  return WATERMARK_STYLES.find((s) => s.id === id) || WATERMARK_STYLES[0];
}
