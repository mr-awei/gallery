// @ts-check
// 20 款相框（纯数据 + SVG 装饰，不含 IO）
//
// 审美按专业修图软件（美图秀秀 / 美图设计室）的相框重做：
//   · 边宽只用 1%~6% 三档：贴边、标准、卡纸；越宽越要配哑光底色，白到发光反而廉价
//   · 内线一律「1px 级 + 低透明度」，不做粗黑框、不做四角 L 标
//   · 留白分布只保留三种经典比例：均匀 / 下加宽（画册页）/ 拍立得
//   · 圆角、投影、齿孔这些「有质感」的装饰各留一到两款，不堆叠
//
// borders 用「短边的比例」表示，所以横竖图都能得到视觉等宽的边框。
// radius：照片圆角（短边比例），由 watermark.js 在合成前给照片做圆角遮罩。

export const FRAME_DEFS = [
  /* 贴边：只切一圈，视觉上几乎看不出框，适合社媒 */
  { id: 'edge-white', name: '极细白边', desc: '1% 白边，几乎不占画面', bg: '#ffffff', b: [0.01, 0.01, 0.01, 0.01] },
  { id: 'edge-black', name: '极细黑边', desc: '1% 黑边，收紧构图', bg: '#0d0d0d', b: [0.01, 0.01, 0.01, 0.01] },

  /* 标准：3.2% 均匀，最耐看的一档 */
  { id: 'white-even', name: '白框·标准', desc: '纸白细框，百搭', bg: '#ffffff', b: [0.032, 0.032, 0.032, 0.032] },
  { id: 'black-even', name: '黑框·标准', desc: '哑黑细框，压高光', bg: '#111111', b: [0.032, 0.032, 0.032, 0.032] },

  /* 内线：白框黑线 / 黑框白线，线压 45% 不抢 */
  { id: 'white-hairline', name: '白框·内细线', desc: '白边内侧一道极细黑线', bg: '#ffffff', b: [0.042, 0.042, 0.042, 0.042], line: { color: '#111111', gap: 0.012, width: 0.0012, opacity: 0.45 } },
  { id: 'black-hairline', name: '黑框·内细线', desc: '黑边内侧一道极细白线', bg: '#111111', b: [0.042, 0.042, 0.042, 0.042], line: { color: '#ffffff', gap: 0.012, width: 0.0012, opacity: 0.42 } },
  { id: 'double-white', name: '双层细线', desc: '白边 + 两道灰线，克制', bg: '#ffffff', b: [0.05, 0.05, 0.05, 0.05], line: { color: '#9a9a9a', gap: 0.014, width: 0.001, opacity: 0.55, double: 0.02 } },
  { id: 'gold-hairline', name: '香槟金线', desc: '白边 + 金线，轻奢感', bg: '#ffffff', b: [0.038, 0.038, 0.038, 0.038], line: { color: '#b08d57', gap: 0.013, width: 0.0014, opacity: 0.75 } },

  /* 卡纸：宽边 + 哑光底色 */
  { id: 'mat-cream', name: '米白卡纸', desc: '6% 米白，展览画册风', bg: '#f7f2e7', b: [0.06, 0.06, 0.06, 0.06] },
  { id: 'mat-gray', name: '高级灰', desc: '4.5% 中灰，低调不抢色', bg: '#4c4c4c', b: [0.045, 0.045, 0.045, 0.045] },
  { id: 'mat-ink', name: '墨黑卡纸', desc: '6% 墨黑，暗调作品', bg: '#141414', b: [0.06, 0.06, 0.06, 0.06] },

  /* 留白：下加宽 / 拍立得 */
  { id: 'white-wide-bottom', name: '画册页', desc: '底部留白，可写字', bg: '#ffffff', b: [0.024, 0.024, 0.095, 0.024] },
  { id: 'black-wide-bottom', name: '电影条', desc: '黑底宽下边，字幕感', bg: '#0d0d0d', b: [0.024, 0.024, 0.095, 0.024] },
  { id: 'polaroid', name: '拍立得', desc: '上窄下宽，经典宝丽来', bg: '#fdfcf7', b: [0.028, 0.028, 0.135, 0.028] },
  { id: 'polaroid-mini', name: '迷你拍立得', desc: '留白更少的轻量版', bg: '#fdfcf7', b: [0.024, 0.024, 0.082, 0.024] },
  { id: 'postcard', name: '明信片', desc: '下边留白 + 细分割线', bg: '#fdfbf5', b: [0.03, 0.03, 0.1, 0.03], line: { color: '#2b2b2b', gap: 0.024, width: 0.0008, opacity: 0.28, bottomOnly: true } },

  /* 质感：胶片 / 投影 / 圆角 */
  { id: 'film-sprocket', name: '胶片齿孔', desc: '上下齿孔，胶片味', bg: '#0f0f0f', b: [0.058, 0.02, 0.058, 0.02], decor: 'sprocket' },
  { id: 'film-matte', name: '电影遮幅', desc: '上下黑遮幅，宽画幅感', bg: '#000000', b: [0.062, 0.018, 0.062, 0.018] },
  { id: 'soft-shadow', name: '投影白框', desc: '白边 + 照片投影，翻拍感', bg: '#ffffff', b: [0.045, 0.045, 0.045, 0.045], decor: 'shadow' },
  { id: 'rounded-white', name: '圆角白边', desc: '圆角照片 + 白边，App 感', bg: '#ffffff', b: [0.03, 0.03, 0.03, 0.03], radius: 0.02 },
];

/** 相框装饰共用的 SVG defs（阴影滤镜），只被 frameDecor 引用 */
export const FRAME_SVG_DEFS = `
<defs>
  <filter id="fshadow" x="-25%" y="-25%" width="150%" height="150%">
    <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.3"/>
  </filter>
</defs>`;

export function findFrame(id) {
  if (!id || id === 'none') return null;
  return FRAME_DEFS.find((f) => f.id === id) || null;
}

/** 由原图尺寸 + 边框比例算出画布与照片位置 */
export function frameGeometry(def, w, h) {
  const m = Math.min(w, h);
  const [t, r, b, l] = def.b.map((v) => Math.round(v * m));
  return { W: w + l + r, H: h + t + b, P: { x: l, y: t, w, h } };
}

/**
 * 装饰层：返回 { under, over }
 * - under 在照片下面（阴影）
 * - over 在照片上面（内线、齿孔）
 */
export function frameDecor(def, geo) {
  const { H, P } = geo;
  const min = Math.min(P.w, P.h);
  const out = { under: '', over: '' };

  if (def.line) {
    const gap = def.line.gap * min;
    const w = Math.max(1, def.line.width * min);
    const x = P.x - gap;
    const y = P.y - gap;
    const ww = P.w + gap * 2;
    const hh = P.h + gap * 2;
    const op = def.line.opacity ?? 1;
    // 同一元素不能出现两个 stroke-opacity，双重线用不同透明度时按次重建
    const strokeOf = (o) => `fill="none" stroke="${def.line.color}" stroke-width="${w.toFixed(2)}" stroke-opacity="${o}"`;
    const stroke = strokeOf(op);
    if (def.line.bottomOnly) {
      // 只在下边画一条：明信片的「手写分割线」
      out.over += `<rect x="${x.toFixed(1)}" y="${(y + hh).toFixed(1)}" width="${ww.toFixed(1)}" height="${Math.max(1, w * 0.6).toFixed(2)}" fill="${def.line.color}" fill-opacity="${op}"/>`;
    } else {
      out.over += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ww.toFixed(1)}" height="${hh.toFixed(1)}" ${stroke}/>`;
      if (def.line.double) {
        const g2 = def.line.double * min;
        out.over += `<rect x="${(x - g2).toFixed(1)}" y="${(y - g2).toFixed(1)}" width="${(ww + g2 * 2).toFixed(1)}" height="${(hh + g2 * 2).toFixed(1)}" ${strokeOf((op * 0.7).toFixed(2))}/>`;
      }
    }
  }

  if (def.decor === 'shadow') {
    // 滤镜 defs 必须跟 with 一起塞进这一层，否则 url(#fshadow) 指向不存在的滤镜 = 没有阴影
    out.under += `${FRAME_SVG_DEFS}<g filter="url(#fshadow)"><rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" fill="#000000"/></g>`;
  }

  if (def.decor === 'sprocket') {
    // 上下齿孔：白底小圆角方块，等间距排布
    const bandH = P.y;
    const size = Math.max(4, bandH * 0.4);
    const step = size * 2.2;
    const yTop = (P.y - size) / 2;
    const yBottom = P.y + P.h + (H - P.y - P.h - size) / 2;
    let svg = '';
    for (let x = P.x + step * 0.35; x < P.x + P.w - size; x += step) {
      svg += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" rx="${(size * 0.24).toFixed(1)}" fill="#efefef" fill-opacity="0.92"/>`;
      svg += `<rect x="${x.toFixed(1)}" y="${yBottom.toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" rx="${(size * 0.24).toFixed(1)}" fill="#efefef" fill-opacity="0.92"/>`;
    }
    out.over += svg;
  }

  return out;
}
