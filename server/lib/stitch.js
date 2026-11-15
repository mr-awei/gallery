// @ts-check
// 图片拼接 / 版面生成
//
// 旧实现只有「固定列数联系表」：等大格子 + contain，4:3 的图塞进 3:4 的格子会留大片白，
// 十几张拼出来像 Excel 表格。现在按社区成熟做法补几种版面（全部纯 sharp 合成，
// 不引依赖、不联网、不跑生成模型——版面是组合优化问题，几何算法比扩散模型可控）：
//
//  grid      固定列数联系表（原行为，contain，核对素材用）
//  justified 整齐行：行高一致、宽度吃满、按原图比例 —— Flickr justified-layout 的规则
//  mosaic    递归二分满版拼贴 —— BRIC(Blocked Recursive Image Composition) 简化版
//  poster    海报：主图占大半，其余缩侧栏，附标题压暗条
//  comic     漫画分格：按张数套分镜模板（主格 + 条格）—— Comic Panel Composer 的思路
//
// 再往上一层是「模板」（lib/stitch-templates.js）：构图由人先定好，主视觉位置、
// 留白、标题压哪一条都是设计决定，算法只负责按每格独立的焦点/缩放把图填进去。
// 上面五种是按图算出来的兜底版式，数量对不上时用；模板是给「发出去要好看」用的。
import fs from 'node:fs';
import sharp from 'sharp';
import * as lib from '../library.js';
import { existingPreviewPath } from '../thumbs.js';
import { detectFocus } from './focus.js';
import { resolveSystemFont } from './fonts.js';
import { templateById, templateBoxes } from './stitch-templates.js';

export const STITCH_MAX = 60;
const MAX_SIDE = 20000;

const LAYOUTS = new Set(['auto', 'grid', 'justified', 'mosaic', 'poster', 'comic', 'seamless', 'stack']);

/** 画布宽高比（宽 / 高）；auto = 由版面自然决定 */
const RATIOS = { auto: 0, '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16, '2:3': 2 / 3 };

function parseColor(input) {
  const s = String(input || '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return '#ffffff';
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** 查询串里的开关：只要不是 '0' / 'false' / 空 就算开 */
function isOn(v) {
  if (v === undefined || v === null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

/** 单张图宽高比（宽 / 高），缺字段时兜 1，避免除零 */
function aspectOf(row) {
  const w = Number(row?.width) || 0;
  const h = Number(row?.height) || 0;
  if (!w || !h) return 1;
  return clamp(w / h, 0.25, 4);
}

/**
 * 自动选版面：只看张数，这是「选几张就出图」的关键。
 * 1~2 张放不满网格 → 海报；3~5 张 → 漫画分镜；6~12 张 → 满版拼贴；
 * 更多 → 整齐行（张数越多越接近联系表）。
 */
function pickAutoLayout(n) {
  if (n <= 2) return 'poster';
  if (n <= 5) return 'comic';
  if (n <= 12) return 'mosaic';
  return 'justified';
}

/* ---------------------------------- 版面几何 ---------------------------------- */

/** 固定列数联系表：等大格子，图片 contain 完整显示 */
function gridBoxes(rows, opts) {
  const n = rows.length;
  const gap = opts.gap;
  const cols = Math.min(clamp(Number(opts.columns) || 4, 1, 10), n);
  const widths = rows.map((r) => Number(r.width) || 0).filter((w) => w > 0).sort((a, b) => a - b);
  const median = widths.length ? widths[Math.floor(widths.length / 2)] : 400;
  const cellOpt = Number(opts.cell);
  const cell = Number.isFinite(cellOpt) && cellOpt >= 80 ? clamp(cellOpt, 80, 1600) : clamp(median, 200, 1200);
  // cell 是「每格最长边」：按第一张的比例推另一边，整张表统一才像联系表。
  // 之前把比例乘上去（横图 2.25 → 格子变成 1:2 竖条），联系表里全是竖长留白
  const a = clamp(aspectOf(rows[0]), 0.4, 2.5);
  const cellW = Math.max(40, Math.round(a >= 1 ? cell : cell * a));
  const cellH = Math.max(40, Math.round(a >= 1 ? cell / a : cell));
  const rowCount = Math.ceil(n / cols);
  const boxes = [];
  for (let i = 0; i < n; i++) {
    boxes.push({
      idx: i,
      x: gap + (i % cols) * (cellW + gap),
      y: gap + Math.floor(i / cols) * (cellH + gap),
      w: cellW,
      h: cellH,
    });
  }
  return { boxes, W: cols * cellW + gap * (cols + 1), H: rowCount * cellH + gap * (rowCount + 1), fit: 'contain' };
}

/**
 * 整齐行：逐行贪心装箱，行内宽度吃满、行高一致。
 * 规则取自 Flickr justified-layout：往行里加图，直到再加一张会让行高低于目标为止。
 */
function justifiedBoxes(rows, opts) {
  const aspects = rows.map(aspectOf);
  const W = opts.W;
  const gap = opts.gap;
  const pad = gap;
  const avail = Math.max(200, W - pad * 2);
  const rowH = clamp(W / 4, 120, 900); // 目标行高 ≈ 一行四张
  const boxes = [];
  let i = 0;
  let y = pad;
  while (i < aspects.length) {
    let count = 0;
    let sum = 0;
    while (i + count < aspects.length) {
      const nh = (avail - gap * count) / (sum + aspects[i + count]);
      if (count > 0 && nh < rowH) break;
      count += 1;
      sum += aspects[i + count - 1];
      if (nh <= rowH) break;
    }
    const h = Math.max(40, (avail - gap * (count - 1)) / sum);
    let x = pad;
    for (let k = 0; k < count; k++) {
      const w = k === count - 1 ? Math.max(40, Math.round(pad + avail - x)) : Math.round(aspects[i + k] * h);
      boxes.push({ idx: i + k, x: Math.round(x), y: Math.round(y), w, h: Math.round(h) });
      x += w + gap;
    }
    y += Math.round(h) + gap;
    i += count;
  }
  return { boxes, W, H: Math.max(1, y - gap + pad), fit: 'cover' };
}

/** 子矩形与一组图片平均比例的差距（对数比，横竖对称） */
function aspectError(rw, rh, meanAspect) {
  if (rw <= 0 || rh <= 0) return 99;
  return Math.abs(Math.log(rw / rh / meanAspect));
}

/**
 * 满版拼贴：矩形递归二分，切点按两侧图片「比例之和」分配面积，
 * 并挑误差更小的切分方向（竖切 / 横切）。叶子节点就是一张图的框，cover 铺满，
 * 整张图没有一条白缝——这是海报级观感的关键。
 */
function mosaicBoxes(rows, opts) {
  const aspects = rows.map(aspectOf);
  const gap = opts.gap;
  const half = gap / 2;
  const pad = Math.round(half);
  const boxes = [];
  const split = (list, x, y, w, h) => {
    if (list.length === 1) {
      boxes.push({ idx: list[0], x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
      return;
    }
    const k = Math.ceil(list.length / 2);
    const A = list.slice(0, k);
    const B = list.slice(k);
    const sumA = A.reduce((s, i) => s + aspects[i], 0);
    const sumB = B.reduce((s, i) => s + aspects[i], 0);
    const frac = sumA / (sumA + sumB || 1);
    const errV = aspectError(w * frac, h, sumA / A.length) + aspectError(w * (1 - frac), h, sumB / B.length);
    const errH = aspectError(w, h * frac, sumA / A.length) + aspectError(w, h * (1 - frac), sumB / B.length);
    if (errV <= errH) {
      const cut = Math.max(1, Math.min(w - 1, Math.round(w * frac)));
      split(A, x, y, cut - half, h);
      split(B, x + cut + half, y, w - cut - half, h);
    } else {
      const cut = Math.max(1, Math.min(h - 1, Math.round(h * frac)));
      split(A, x, y, w, cut - half);
      split(B, x, y + cut + half, w, h - cut - half);
    }
  };
  split(rows.map((_, i) => i), pad, pad, Math.max(200, opts.W - pad * 2), Math.max(200, opts.H - pad * 2));
  return { boxes, W: opts.W, H: opts.H, fit: 'cover' };
}

/**
 * 长图拼接：每张按画布宽等比缩放，纵向紧贴堆叠，画布高度由内容累加决定。
 * 全程零间隙——聊天记录 / 网页截图接长图只有这种排法是对的。
 */
function stackBoxes(rows, opts) {
  const W = Math.max(200, Math.round(opts.W));
  const heights = rows.map((r) => {
    const w = Number(r.width) || 0;
    const h = Number(r.height) || 0;
    const a = w > 0 && h > 0 ? clamp(h / w, 0.02, 20) : 0.66;
    return Math.max(8, Math.round(W * a));
  });
  const H = heights.reduce((s, h) => s + h, 0);
  let y = 0;
  const boxes = heights.map((h, i) => {
    const b = { idx: i, x: 0, y, w: W, h };
    y += h;
    return b;
  });
  return { boxes, W, H: Math.max(8, H), fit: 'cover' };
}

/** 海报：主图占大半版，其余缩成侧栏；1 张整版铺满，2 张左右分 */
function posterBoxes(rows, opts) {
  const n = rows.length;
  const gap = opts.gap;
  const pad = gap;
  const innerW = Math.max(200, opts.W - pad * 2);
  const innerH = Math.max(200, opts.H - pad * 2);
  const boxes = [];
  if (n === 1) {
    boxes.push({ idx: 0, x: pad, y: pad, w: innerW, h: innerH });
    return { boxes, W: opts.W, H: opts.H, fit: 'cover' };
  }
  if (n === 2) {
    const cut = Math.round(innerW * 0.6);
    boxes.push({ idx: 0, x: pad, y: pad, w: cut - gap / 2, h: innerH });
    boxes.push({ idx: 1, x: pad + cut + gap / 2, y: pad, w: innerW - cut - gap / 2, h: innerH });
    return { boxes, W: opts.W, H: opts.H, fit: 'cover' };
  }
  const heroW = Math.round(innerW * (n >= 8 ? 0.58 : 0.64));
  boxes.push({ idx: 0, x: pad, y: pad, w: heroW, h: innerH });
  const rest = n - 1;
  const cols = rest >= 6 ? 2 : 1;
  const rowCount = Math.ceil(rest / cols);
  const cellH = (innerH - gap * (rowCount - 1)) / rowCount;
  for (let r = 0; r < rowCount; r++) {
    // 最后一行可能不满：按实际张数等分整行宽度，否则右下角会空一块白
    const count = Math.min(cols, rest - r * cols);
    const cellW = (innerW - heroW - gap - gap * (count - 1)) / count;
    for (let c = 0; c < count; c++) {
      boxes.push({
        idx: r * cols + c + 1,
        x: Math.round(pad + heroW + gap + c * (cellW + gap)),
        y: Math.round(pad + r * (cellH + gap)),
        w: Math.round(cellW),
        h: Math.round(cellH),
      });
    }
  }
  return { boxes, W: opts.W, H: opts.H, fit: 'cover' };
}

/**
 * 漫画分格：第一格横贯整版当主格，其余按每行最多 3 格往下排；
 * 张数越多主格越矮，把版面让给条格。分镜比例是经验值，用户不必自己算。
 */
function comicBoxes(rows, opts) {
  const n = rows.length;
  const gap = opts.gap;
  const pad = gap;
  const innerW = Math.max(200, opts.W - pad * 2);
  const innerH = Math.max(200, opts.H - pad * 2);
  const boxes = [];
  const done = (fit = 'cover') => ({ boxes, W: opts.W, H: opts.H, fit });
  if (n === 1) {
    boxes.push({ idx: 0, x: pad, y: pad, w: innerW, h: innerH });
    return done();
  }
  if (n === 2) {
    const cut = Math.round(innerW * 0.58);
    boxes.push({ idx: 0, x: pad, y: pad, w: cut - gap / 2, h: innerH });
    boxes.push({ idx: 1, x: pad + cut + gap / 2, y: pad, w: innerW - cut - gap / 2, h: innerH });
    return done();
  }
  const remain = n - 1;
  const perRow = Math.min(3, remain);
  const rowCount = Math.ceil(remain / perRow);
  const heroH = Math.max(120, Math.round(innerH * (rowCount <= 1 ? 0.52 : 0.42)));
  boxes.push({ idx: 0, x: pad, y: pad, w: innerW, h: heroH });
  const restH = innerH - heroH - gap * rowCount;
  const cellH = Math.max(60, Math.round(restH / rowCount));
  for (let i = 0; i < remain; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const count = Math.min(perRow, remain - row * perRow);
    const cellW = Math.max(60, (innerW - gap * (count - 1)) / count);
    boxes.push({
      idx: i + 1,
      x: Math.round(pad + col * (cellW + gap)),
      y: Math.round(pad + heroH + gap + row * (cellH + gap)),
      w: Math.round(cellW),
      h: cellH,
    });
  }
  return done();
}

/** 把自然高度压到目标比例：海报/漫画之外的两版式也允许指定画布比例 */
function squeezeTo(geo, targetH) {
  if (!targetH) return geo;
  const s = targetH / geo.H;
  if (!Number.isFinite(s) || s <= 0.05) return geo;
  return {
    ...geo,
    H: targetH,
    boxes: geo.boxes.map((b) => ({ ...b, y: Math.round(b.y * s), h: Math.max(24, Math.round(b.h * s)) })),
  };
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] || c));
}

/** 标题压暗条：海报/漫画才叠，联系表叠字会挡素材 */
function titleSvg(W, H, title, pad) {
  const fs = Math.max(20, Math.round(Math.min(W, H) * 0.055));
  const band = Math.round(fs * 3.4);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".62"/>` +
      `</linearGradient></defs>` +
      `<rect x="0" y="${Math.max(0, H - band)}" width="${W}" height="${band}" fill="url(#g)"/>` +
      `<text x="${pad}" y="${Math.round(H - fs * 0.75)}" font-family="sans-serif" font-size="${fs}" ` +
      `font-weight="600" fill="#fff">${escapeXml(title)}</text></svg>`
  );
}

/**
 * 取一张图的可用像素源。
 *
 * 默认**原图优先**：拼图是成品输出，缩略图最长边只有几百像素，放大会明显发虚。
 * RAW（CR2/NEF/ARW）/PSD 之类 sharp 解不开，会自然落到预览图再落到缩略图。
 * small=true 走反方向（缩略图优先）——模糊铺底、色块取样用它就够，读原图纯属浪费。
 */
function sourcesFor(row, { small = false } = {}) {
  const list = [];
  const push = (p) => {
    if (p && !list.includes(p)) list.push(p);
  };
  let preview = null;
  try {
    preview = existingPreviewPath(row.id, Number(row.fs_mtime) || 0);
  } catch {
    /* 没有预览图就少一档 */
  }
  const thumb = row.thumb && fs.existsSync(row.thumb) ? row.thumb : null;
  if (small) {
    push(thumb);
    push(preview);
    push(row.abs_path);
  } else {
    push(row.abs_path);
    push(preview);
    push(thumb);
  }
  return list;
}

/** 按方块尺寸解码一张图；源解不开就换下一个源，全失败返回 null（该格留空） */
async function decodeForStitch(row, box, fit, bg) {
  for (const src of sourcesFor(row)) {
    try {
      return await sharp(src, { failOn: 'none' })
        .rotate()
        .resize({ width: Math.max(4, box.w), height: Math.max(4, box.h), fit, background: bg, position: 'centre' })
        .flatten({ background: bg })
        .toBuffer();
    } catch {
      /* 换下一个源 */
    }
  }
  return null;
}

/* ------------------------------- 模板渲染 ------------------------------- */

/** 源图旋转后的尺寸（EXIF 方向 5~8 时宽高互换，裁切坐标基于旋转后图像） */
async function orientedSize(src) {
  const m = await sharp(src, { failOn: 'none' }).metadata();
  let w = Number(m.width) || 0;
  let h = Number(m.height) || 0;
  const o = Number(m.orientation) || 1;
  if (o >= 5 && o <= 8) [w, h] = [h, w];
  return { w, h };
}

/**
 * 归一化焦点 + 缩放 → 源图上的裁切窗口（像素）。
 *
 * z = 1 是「刚好盖住格子」（cover 居中），往上推是放大。往下不再卡在 1：
 * 一直缩到 `zMin`（整张图刚好塞进格子的那一点）都允许，此时图比格子小，
 * 多出来的是背景色而不是空白，所以 mode 会是 'fit'。
 * 再往下没有任何意义（图只会更小），后端直接夹在 zMin，前端也用同一个 zMin 提示用户。
 */
/** 某张图在某格里的缩放下限：再缩图片就比格子还小，只会更糊 */
export function cropZMin(sw, sh, box) {
  if (!(sw > 0 && sh > 0 && box?.w > 0 && box?.h > 0)) return 1;
  const coverK = Math.max(box.w / sw, box.h / sh);
  return Math.min(box.w / sw, box.h / sh) / coverK;
}

export function cropWindow(sw, sh, box, crop) {
  const coverK = Math.max(box.w / sw, box.h / sh); // 盖满格子的缩放比
  const fitK = Math.min(box.w / sw, box.h / sh); // 整图塞进格子的缩放比
  const zMin = fitK / coverK; // 缩放下限：再缩图片就比格子还小，只会更糊
  const rawZ = Number(crop?.z);
  const z = clamp(Number.isFinite(rawZ) && rawZ > 0 ? rawZ : 1, zMin, 4);
  const k = coverK * z; // 源图 → 画布的实际缩放比
  const fx = clamp(Number.isFinite(Number(crop?.fx)) ? Number(crop.fx) : 0.5, 0, 1);
  const fy = clamp(Number.isFinite(Number(crop?.fy)) ? Number(crop.fy) : 0.5, 0, 1);

  if (sw * k >= box.w && sh * k >= box.h) {
    // 图仍盖得住格子：裁一块按框比例铺满（z=1 就是原来的 cover 居中）
    const cw = clamp(box.w / k, 8, sw);
    const ch = clamp(box.h / k, 8, sh);
    const left = clamp(fx * sw - cw / 2, 0, Math.max(0, sw - cw));
    const top = clamp(fy * sh - ch / 2, 0, Math.max(0, sh - ch));
    return {
      mode: 'crop',
      left: Math.round(left),
      top: Math.round(top),
      width: Math.max(1, Math.min(Math.round(cw), Math.round(sw - left))),
      height: Math.max(1, Math.min(Math.round(ch), Math.round(sh - top))),
      z,
      zMin,
    };
  }

  // 缩到图比格子小：能完整看到的那部分原样摆进去，空出来的地方铺背景
  const cw = Math.min(sw, Math.max(8, box.w / k));
  const ch = Math.min(sh, Math.max(8, box.h / k));
  const left = clamp(fx * sw - cw / 2, 0, Math.max(0, sw - cw));
  const top = clamp(fy * sh - ch / 2, 0, Math.max(0, sh - ch));
  const dw = Math.max(1, Math.round(cw * k));
  const dh = Math.max(1, Math.round(ch * k));
  // 比格子窄的那一边允许在格子里挪，但不许挪出格子
  const dx = clamp(box.w / 2 - fx * dw, Math.min(0, box.w - dw), Math.max(0, box.w - dw));
  const dy = clamp(box.h / 2 - fy * dh, Math.min(0, box.h - dh), Math.max(0, box.h - dh));
  return {
    mode: 'fit',
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(cw),
    height: Math.round(ch),
    dx: Math.round(dx),
    dy: Math.round(dy),
    dw,
    dh,
    z,
    zMin,
  };
}

/** 解析 crops 参数：'0.5,0.5,1;0.4,0.3,1.8'；返回 null 表示不指定（居中） */
export function parseCrops(raw, n) {
  const s = String(raw || '').trim();
  if (!s || s === 'auto') return null;
  const list = s.split(';').map((part) => {
    const [fx, fy, z] = part.split(',').map((v) => Number(v));
    return {
      fx: Number.isFinite(fx) ? clamp(fx, 0, 1) : 0.5,
      fy: Number.isFinite(fy) ? clamp(fy, 0, 1) : 0.5,
      // 下界留到 cropWindow 按每格算（不同格子的 zMin 不一样），这里只挡明显离谱的值
      z: Number.isFinite(z) ? clamp(z, 0.1, 4) : 1,
    };
  });
  while (list.length < n) list.push({ fx: 0.5, fy: 0.5, z: 1 });
  return list.slice(0, n);
}

/** 自动构图：用现成的显著度检测给每格找主体位置（用户点「自动构图」才跑） */
async function autoCrops(rows, boxes) {
  const out = rows.map(() => ({ fx: 0.5, fy: 0.5, z: 1 }));
  await Promise.all(
    boxes.map(async (b) => {
      const row = rows[b.idx];
      if (!row) return;
      for (const src of sourcesFor(row)) {
        try {
          const r = await detectFocus(src, { ratioW: b.w, ratioH: b.h });
          // 用检测出的窗口中心（而不是质心）：那才是算法认为该裁的位置
          out[b.idx] = {
            fx: clamp(r.rect.x + r.rect.w / 2, 0, 1),
            fy: clamp(r.rect.y + r.rect.h / 2, 0, 1),
            z: 1.02,
          };
          return;
        } catch {
          /* 这个源解不开就换下一个 */
        }
      }
    })
  );
  return out;
}

function roundMaskSvg(w, h, r) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`
  );
}

/** 一格：按焦点/缩放裁切 → 铺满格子 → 圆角 */
async function shapedTile(row, box, crop, opt) {
  // 圆角按画布短边算是「印刷品」的口径；小格子再收一档，免得被削成圆形
  const radius = Math.max(0, Math.min(Math.round(opt.radius || 0), Math.round(Math.min(box.w, box.h) / 3)));
  for (const src of sourcesFor(row)) {
    try {
      const { w: sw, h: sh } = await orientedSize(src);
      if (!(sw >= 8 && sh >= 8)) continue;
      const rect = cropWindow(sw, sh, box, crop);
      const srcRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      let buf;
      if (rect.mode === 'fit') {
        // 整图摆进格子：先按源窗口取图缩到目标尺寸，再贴到背景画布上
        const piece = await sharp(src, { failOn: 'none' })
          .rotate()
          .extract(srcRect)
          .resize(rect.dw, rect.dh, { fit: 'fill' })
          .png()
          .toBuffer();
        buf = await sharp({
          create: { width: box.w, height: box.h, channels: 4, background: opt.bg },
        })
          .composite([{ input: piece, left: rect.dx, top: rect.dy }])
          .png()
          .toBuffer();
      } else {
        buf = await sharp(src, { failOn: 'none' })
          .rotate()
          .extract(srcRect)
          .resize(box.w, box.h, { fit: 'fill' })
          .flatten({ background: opt.bg })
          .png()
          .toBuffer();
      }
      if (radius > 0) {
        const mask = await sharp(roundMaskSvg(box.w, box.h, radius)).png().toBuffer();
        buf = await sharp(buf).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
      }
      // 描边必须跟着格子一起合成：整层统一画的话，重叠构图里主图的框线会切过上面那张图
      const bw = Math.max(0, Math.round(opt.border || 0));
      if (bw > 0) {
        const inset = bw / 2;
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}">` +
          `<rect x="${inset}" y="${inset}" width="${Math.max(1, box.w - bw)}" height="${Math.max(1, box.h - bw)}" ` +
          `rx="${Math.max(0, radius - inset)}" ry="${Math.max(0, radius - inset)}" fill="none" ` +
          `stroke="#fff" stroke-opacity="0.82" stroke-width="${bw}"/></svg>`;
        buf = await sharp(buf).composite([{ input: await sharp(Buffer.from(svg)).png().toBuffer() }]).png().toBuffer();
      }
      return buf;
    } catch {
      /* 换下一个源（RAW/PSD 靠预览图兜底） */
    }
  }
  return null;
}

/** 每格下方的柔和投影：一张整画布 SVG，模糊一次就够，不必逐格处理 */
function shadowSvg(W, H, boxes, radiusPx, strength) {
  const short = Math.min(W, H);
  const dy = Math.max(2, Math.round(short * 0.005));
  const blur = Math.max(2, Math.round(short * 0.009));
  const rects = boxes
    .map(
      (b) =>
        `<rect x="${b.x}" y="${b.y + dy}" width="${b.w}" height="${b.h}" rx="${radiusPx}" ry="${radiusPx}" fill="#000"/>`
    )
    .join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<filter id="s" x="-10%" y="-10%" width="120%" height="130%"><feGaussianBlur stdDeviation="${blur}"/></filter>` +
      `<g filter="url(#s)" opacity="${clamp(strength, 0, 1) * 0.55}">${rects}</g></svg>`
  );
}

/** 估文字宽度：CJK 按 1em、其余按 0.56em（只是为了自动缩字号，不必精确测量） */
function estTextWidth(text, size, tracking) {
  let w = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) || 0;
    w += (code > 0x2e80 ? 1 : 0.56) * size + tracking * size;
  }
  return w;
}

/**
 * 海报文字层：底部压暗带 + 标题 + 副标题 + 演职员式小字。
 * 字全部走 SVG，不依赖本机字体文件；宽度超出就自动缩字号，不换行（标题短）。
 *
 * style 是用户改过的排版：font 字体族（本机字体名）、size 标题字号倍率、color 标题颜色。
 * 只覆盖标题——副标题/署名跟着模板走，免得三个字号一起飘。
 */
function posterTextSvg(W, H, tpl, text, style = {}) {
  const short = Math.min(W, H);
  const FALLBACK_FONT = 'Segoe UI, Microsoft YaHei, Noto Sans SC, sans-serif';
  // 用户选的本机字体（key 形如 sys:Microsoft YaHei）：只认清单里真实存在的家族名，
  // 认不出就退回默认栈——写进 SVG 的字体名如果本机没有，会掉到衬线/豆腐块
  const sysFont = String(style.font || '').trim() ? resolveSystemFont(String(style.font).trim()) : null;
  const fontFamily = sysFont ? sysFont.stack : FALLBACK_FONT;
  const sizeScale = clamp(Number(style.size) || 1, 0.4, 2.5);
  const userColor = String(style.color || '').trim();
  const titleColor = /^#[0-9a-fA-F]{3,8}$/.test(userColor) ? userColor : null;
  const parts = [];
  if (tpl.band) {
    const bandH = Math.round(H * tpl.band);
    parts.push(
      `<defs><linearGradient id="band" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="#000" stop-opacity="0"/>` +
        `<stop offset="0.5" stop-color="#000" stop-opacity="0.62"/>` +
        `<stop offset="1" stop-color="#000" stop-opacity="1"/></linearGradient></defs>` +
        `<rect x="0" y="${H - bandH}" width="${W}" height="${bandH}" fill="url(#band)"/>`
    );
  }
  const line = (spec, raw, fallback, opt = {}) => {
    const value = String(raw || '').trim() || fallback;
    if (!value) return '';
    const scale = Number(opt.scale) || 1;
    const tracking = Number(spec.tracking) || 0;
    const baseSize = (Number(spec.size) || 0.03) * short * scale;
    const trackingPx = (baseSize * tracking) / 2;
    let size = baseSize;
    const body = spec.upper ? value.toUpperCase() : value;
    const maxW = W * (spec.align === 'left' ? 0.86 : 0.9);
    // 太宽就缩字号，最多缩到 45%：再小就成噪点了
    while (size > baseSize * 0.45 && estTextWidth(body, size, tracking) > maxW) size -= 2;
    const weight = Number(spec.weight) || 500;
    const fill = opt.color || spec.color || '#fff';
    const x = spec.align === 'left' ? Math.round(W * 0.07) : W / 2;
    const anchor = spec.align === 'left' ? 'start' : 'middle';
    const y = Math.round((Number(spec.y) || 0.9) * H);
    const lines = String(body).split(/\s*\|\s*|\n/).filter(Boolean);
    if (lines.length <= 1) {
      return (
        `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${fontFamily}" ` +
          `font-size="${Math.round(size)}" font-weight="${weight}" letter-spacing="${trackingPx.toFixed(1)}" ` +
          `fill="${fill}">${escapeXml(body)}</text>`
      );
    }
    // 多行（署名条）：行距 1.35，逐行下移
    return lines
      .map((ln, i) => {
        const ly = Math.round(y + i * size * 1.35);
        return (
          `<text x="${x}" y="${ly}" text-anchor="${anchor}" font-family="${fontFamily}" ` +
          `font-size="${Math.round(size)}" font-weight="${weight}" letter-spacing="${trackingPx.toFixed(1)}" ` +
          `fill="${fill}">${escapeXml(ln)}</text>`
        );
      })
      .join('');
  };
  if (tpl.masthead) {
    const m = tpl.masthead;
    parts.push(
      `<text x="${W / 2}" y="${Math.round((Number(m.y) || 0.06) * H)}" text-anchor="middle" ` +
        `font-family="${fontFamily}" font-size="${Math.round((Number(m.size) || 0.05) * short * sizeScale)}" ` +
        `font-weight="${Number(m.weight) || 700}" letter-spacing="${((Number(m.tracking) || 0.2) * (Number(m.size) || 0.05) * short * sizeScale) / 2}" ` +
        `fill="${titleColor || m.color || '#fff'}">${escapeXml(m.upper ? String(text.title || '').toUpperCase() : text.title || '')}</text>`
    );
  }
  if (tpl.title) parts.push(line(tpl.title, text.title, '', { scale: sizeScale, color: titleColor }));
  if (tpl.sub) parts.push(line(tpl.sub, text.sub, ''));
  if (tpl.billing) parts.push(line(tpl.billing, text.billing, ''));
  if (!parts.length) return null;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`);
}

/** 胶片齿孔：上下两条白点，纯装饰，让「胶片」这个名字站得住 */
function sprocketSvg(W, H) {
  const short = Math.min(W, H);
  const hole = Math.max(3, Math.round(short * 0.012));
  const step = hole * 3;
  const rows = [Math.round(short * 0.012), H - Math.round(short * 0.012) - hole];
  const rects = [];
  for (const y of rows) {
    for (let x = hole; x < W - hole; x += step) {
      rects.push(`<rect x="${x}" y="${y}" width="${hole}" height="${hole}" rx="${hole / 3}" fill="#fff" fill-opacity="0.78"/>`);
    }
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects.join('')}</svg>`);
}

/** 模糊铺底：把主图放大模糊当背景，留白处不再是死白，宣传图都这么做 */
async function backdropBuffer(row, W, H) {
  for (const src of sourcesFor(row, { small: true })) {
    try {
      return await sharp(src, { failOn: 'none' })
        .rotate()
        .resize(W, H, { fit: 'cover', position: 'attention' })
        .blur(Math.max(8, Math.round(Math.min(W, H) * 0.02)))
        .modulate({ brightness: 0.62, saturation: 1.08 })
        .flatten({ background: '#000' })
        .png()
        .toBuffer();
    } catch {
      /* 换下一个源 */
    }
  }
  return null;
}

/**
 * 模板路线：按模板的构图摆放，每格独立裁切。
 * @param {any[]} rows
 * @param {import('./stitch-templates.js').Template} tpl
 * @param {any} opts
 */
async function buildTemplateStitch(rows, tpl, opts) {
  const W = clamp(Math.round(Number(opts.outWidth) || 2400), 600, 6000);
  // 无缝：把留白、缝隙、圆角、描边、投影、模糊底全部归零，只留贴边排列
  const seamless = opts.seamless === undefined ? Boolean(tpl.seamless) : isOn(opts.seamless);
  const gapRaw = Number(opts.gap);
  // gap 留空交给 templateBoxes 走模板默认（有 tpl.gap 用它，否则画布宽 0.9%）
  const gap = seamless ? 0 : Number.isFinite(gapRaw) ? clamp(gapRaw, 0, 120) : undefined;
  let geo = templateBoxes(tpl, W, rows.length, { gap, seamless });
  geo = { ...geo, ...scaleGeo({ W: geo.W, H: geo.H, boxes: geo.boxes }, Math.min(1, MAX_SIDE / Math.max(geo.W, geo.H))) };
  // 有文字带的海报用纯黑底：图上渐隐进黑时，底色偏灰会露一条硬边
  const bg = parseColor(opts.bg || tpl.bg || (tpl.band ? '#000000' : ''));
  const radiusCss = Number.isFinite(Number(opts.radius)) ? Number(opts.radius) : tpl.radius || 0;
  const radiusPx = seamless ? 0 : Math.round(clamp(radiusCss, 0, 0.08) * Math.min(geo.W, geo.H));
  const shadowAmt = seamless ? 0 : Number.isFinite(Number(opts.shadow)) ? clamp(Number(opts.shadow), 0, 1) : tpl.shadow || 0;
  const borderOn = seamless
    ? false
    : opts.border === undefined
      ? Boolean(tpl.border)
      : isOn(opts.border);
  const useBackdrop = seamless ? false : opts.backdrop === undefined ? Boolean(tpl.backdrop) : isOn(opts.backdrop);

  let crops = parseCrops(opts.crops, rows.length);
  if (!crops && String(opts.crops || '').trim() === 'auto') crops = await autoCrops(rows, geo.boxes);
  if (!crops) crops = rows.map(() => ({ fx: 0.5, fy: 0.5, z: 1 }));

  const composites = [];
  if (useBackdrop) {
    const bd = await backdropBuffer(rows[0], geo.W, geo.H);
    if (bd) composites.push({ input: bd, left: 0, top: 0 });
  }
  if (shadowAmt > 0 && geo.boxes.length) {
    try {
      composites.push({ input: await sharp(shadowSvg(geo.W, geo.H, geo.boxes, radiusPx, shadowAmt)).png().toBuffer(), left: 0, top: 0 });
    } catch (err) {
      console.warn('[stitch] 投影渲染失败，已跳过：', err?.message || err);
    }
  }

  const borderPx = borderOn ? Math.max(1, Math.round(Math.min(geo.W, geo.H) * 0.0012)) : 0;
  let tiles = 0;
  for (const b of geo.boxes) {
    const row = rows[b.idx];
    if (!row) continue;
    // 重叠构图里主图不描边：框线会被上层小图切断，看着像画坏了
    const slotBorder = !tpl.borderSlots || tpl.borderSlots.includes(b.idx) ? borderPx : 0;
    const buf = await shapedTile(row, b, crops[b.idx] || crops[0], { radius: radiusPx, bg, border: slotBorder });
    if (buf) {
      composites.push({ input: buf, left: b.x, top: b.y });
      tiles += 1;
    }
  }
  if (!tiles) throw new Error('这些素材都无法解码成图片（视频/3D/字体不能拼接）');

  if (tpl.sprocket) {
    try {
      composites.push({ input: await sharp(sprocketSvg(geo.W, geo.H)).png().toBuffer(), left: 0, top: 0 });
    } catch (err) {
      console.warn('[stitch] 齿孔渲染失败，已跳过：', err?.message || err);
    }
  }
  const textLayer = posterTextSvg(
    geo.W,
    geo.H,
    tpl,
    {
      title: opts.title,
      sub: opts.subtitle,
      billing: opts.billing,
    },
    // 字体 / 标题字号倍率 / 标题颜色：用户没改就全走模板默认
    { font: opts.font, size: opts.titleScale, color: opts.titleColor }
  );
  if (textLayer) {
    try {
      composites.push({ input: await sharp(textLayer).png().toBuffer(), left: 0, top: 0 });
    } catch (err) {
      console.warn('[stitch] 文字层渲染失败，已跳过：', err?.message || err);
    }
  }

  const format = ['jpeg', 'png', 'webp'].includes(String(opts.format)) ? String(opts.format) : 'jpeg';
  const quality = clamp(Number(opts.quality) || 90, 40, 100);
  let pipe = sharp({
    create: { width: geo.W, height: geo.H, channels: 4, background: bg },
  }).composite(composites);
  if (format === 'png') pipe = pipe.png({ compressionLevel: 9 });
  else if (format === 'webp') pipe = pipe.webp({ quality });
  else pipe = pipe.jpeg({ quality, mozjpeg: true });
  const buffer = await pipe.toBuffer();
  return {
    buffer,
    mime: format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg',
    ext: format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpg',
    width: geo.W,
    height: geo.H,
    count: tiles,
    skipped: rows.length - tiles,
    layout: `template:${tpl.id}`,
    template: tpl.id,
  };
}

/** 成品过大时整体缩放（内存保护）：坐标按同一比例缩，版面不变 */
function scaleGeo(geo, k) {
  if (!(k > 0) || k >= 1) return geo;
  const r = (v) => Math.round(v * k);
  return {
    ...geo,
    W: Math.max(200, r(geo.W)),
    H: Math.max(200, r(geo.H)),
    boxes: geo.boxes.map((b) => ({ ...b, x: r(b.x), y: r(b.y), w: Math.max(4, r(b.w)), h: Math.max(4, r(b.h)) })),
  };
}

/**
 * 纯几何：给定各图宽高与参数，算出画布尺寸和每张图的框（不碰文件，便于单测）。
 * @param {{width?:number, height?:number}[]} rows
 */
export function layoutGeometry(rows, opts = {}) {
  const layoutOpt = String(opts.layout || 'auto');
  const layout = layoutOpt !== 'auto' && LAYOUTS.has(layoutOpt) ? layoutOpt : pickAutoLayout(rows.length);
  const gapRaw = Number(opts.gap);
  // 无缝 / 长图拼接本身就不该有缝，哪怕调用方还传着间距
  const noGap = layout === 'seamless' || layout === 'stack' || isOn(opts.seamless);
  const gap = noGap ? 0 : Number.isFinite(gapRaw) ? clamp(gapRaw, 0, 120) : 12;
  const ratioKey = Object.prototype.hasOwnProperty.call(RATIOS, String(opts.ratio)) ? String(opts.ratio) : 'auto';
  const W = clamp(Math.round(Number(opts.outWidth) || 2400), 600, 6000);
  // 未指定比例时给一个 4:3 默认画布：海报/漫画/满版都需要一个确定的矩形
  const targetH = RATIOS[ratioKey] ? Math.round(W / RATIOS[ratioKey]) : Math.round(W * 0.75);
  const geoOpts = { gap, W, H: targetH, columns: opts.columns, cell: opts.cell };

  let geo;
  if (layout === 'grid') geo = gridBoxes(rows, geoOpts);
  else if (layout === 'justified') geo = squeezeTo(justifiedBoxes(rows, geoOpts), RATIOS[ratioKey] ? targetH : 0);
  else if (layout === 'mosaic') geo = mosaicBoxes(rows, geoOpts);
  else if (layout === 'seamless') geo = mosaicBoxes(rows, { ...geoOpts, gap: 0 });
  else if (layout === 'stack') geo = stackBoxes(rows, geoOpts);
  else if (layout === 'poster') geo = posterBoxes(rows, geoOpts);
  else geo = comicBoxes(rows, geoOpts);
  geo = scaleGeo(geo, Math.min(1, MAX_SIDE / Math.max(geo.W, geo.H)));
  return { ...geo, layout, ratio: ratioKey, gap };
}

/**
 * 构图台用的版面坐标：和真正出图走同一套几何（模板走 templateBoxes、算法版式走 layoutGeometry），
 * 所以「前端拖的那个框」就是「服务端裁的那块」，不存在两套坐标慢慢对不上。
 * @param {{width?:number, height?:number}[]} rows
 */
export function planGeometry(rows, opts = {}) {
  const tpl = templateById(String(opts.template || ''));
  let geo;
  if (tpl && rows.length >= tpl.min && rows.length <= tpl.max) {
    const W = clamp(Math.round(Number(opts.outWidth) || 2400), 600, 6000);
    // gap 留空 = 走模板默认缝；无缝模板或勾了无缝一律零缝（与 buildTemplateStitch 同规则）
    const seamless = opts.seamless === undefined ? Boolean(tpl.seamless) : isOn(opts.seamless);
    const gapRaw = Number(opts.gap);
    const gap = seamless ? 0 : Number.isFinite(gapRaw) ? clamp(gapRaw, 0, 120) : undefined;
    geo = templateBoxes(tpl, W, rows.length, { gap, seamless });
  } else {
    geo = layoutGeometry(rows, opts);
  }
  // 缩放下限必须在「像素框 × 素材像素」这一套单位里算：
  // 归一化后的 w/h 分别除过 W/H，乘同一个 1000 会把比例算错（横图进方格的 zMin 会算成 0.67）
  const zMin = geo.boxes.map((b) => {
    const row = rows[b.idx] || rows[0] || {};
    return cropZMin(Number(row.width) || 1600, Number(row.height) || 1200, b);
  });
  return { template: tpl, W: geo.W, H: geo.H, ratio: geo.W / geo.H, boxes: geo.boxes, zMin };
}

/**
 * @param {{ids?:number[], template?:string, crops?:string, subtitle?:string, billing?:string,
 *          layout?:string, ratio?:string, outWidth?:number, columns?:number,
 *          gap?:number, bg?:string, cell?:number, format?:string, quality?:number,
 *          title?:string, radius?:number, shadow?:number, border?:string|number|boolean,
 *          backdrop?:string|number|boolean, seamless?:string|number|boolean,
 *          font?:string, titleScale?:number|string, titleColor?:string}} opts
 */
export async function buildStitch(opts = {}) {
  const ids = (Array.isArray(opts.ids) ? opts.ids : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(0, STITCH_MAX);
  if (!ids.length) throw new Error('没有选择任何素材');

  const rows = ids.map((id) => lib.getImage(id)).filter(Boolean);
  if (!rows.length) throw new Error('选中的素材都不存在');

  // 模板路线：张数对得上才用模板（模板的构图是定死的，少一张就留空）
  const tpl = templateById(String(opts.template || ''));
  if (tpl && rows.length >= tpl.min && rows.length <= tpl.max) return buildTemplateStitch(rows, tpl, opts);

  const gapRaw = Number(opts.gap);
  const gap = isOn(opts.seamless) || String(opts.layout) === 'seamless' ? 0 : Number.isFinite(gapRaw) ? clamp(gapRaw, 0, 120) : 12;
  const bg = parseColor(opts.bg);
  const format = ['jpeg', 'png', 'webp'].includes(String(opts.format)) ? String(opts.format) : 'jpeg';
  const quality = clamp(Number(opts.quality) || 90, 40, 100);
  const title = String(opts.title || '').slice(0, 60);

  const { layout, ...geo } = layoutGeometry(rows, opts);

  // 算法版式也能逐格调：传了 crops 就走裁切路径，没传保持原来的 fit 渲染
  const crops = parseCrops(opts.crops, rows.length);
  const radius = Math.max(0, Math.round(Number(opts.radius) || 0));
  const composites = [];
  let tiles = 0;
  for (const b of geo.boxes) {
    const row = rows[b.idx];
    if (!row) continue;
    const buf = crops
      ? await shapedTile(row, b, crops[b.idx] || { fx: 0.5, fy: 0.5, z: 1 }, { radius, bg, border: opts.border })
      : await decodeForStitch(row, b, geo.fit, bg);
    if (buf) {
      composites.push({ input: buf, left: b.x, top: b.y });
      tiles += 1;
    }
  }
  if (!tiles) throw new Error('这些素材都无法解码成图片（视频/3D/字体不能拼接）');

  // 标题只叠在海报/漫画上：联系表叠字会挡住素材本身
  if (title && (layout === 'poster' || layout === 'comic')) {
    try {
      const svg = await sharp(titleSvg(geo.W, geo.H, title, Math.round(gap + 8))).png().toBuffer();
      composites.push({ input: svg, left: 0, top: 0 });
    } catch (err) {
      console.warn('[stitch] 标题渲染失败，已跳过：', err?.message || err);
    }
  }

  let pipe = sharp({ create: { width: geo.W, height: geo.H, channels: 4, background: bg } }).composite(composites);
  if (format === 'png') pipe = pipe.png({ compressionLevel: 9 });
  else if (format === 'webp') pipe = pipe.webp({ quality });
  else pipe = pipe.jpeg({ quality, mozjpeg: true });
  const buffer = await pipe.toBuffer();
  return {
    buffer,
    mime: format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg',
    ext: format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpg',
    width: geo.W,
    height: geo.H,
    count: tiles,
    skipped: rows.length - tiles,
    layout,
  };
}

/**
 * 自动构图建议：把「算法认为该裁哪里」变成具体数值返回给前端。
 * 只返回 crops=auto 时的效果不够用——用户还要在这个基础上继续手调，
 * 所以这里直接把 fx/fy/z 解出来，前端拿到就是可编辑的初值。
 * @param {number[]} ids
 * @param {string} template
 */
export async function suggestCrops(ids, template, outWidth = 1200) {
  const tpl = templateById(String(template || ''));
  if (!tpl) throw new Error('未知模板');
  const rows = (Array.isArray(ids) ? ids : [])
    .map((id) => lib.getImage(Number(id)))
    .filter(Boolean)
    .slice(0, STITCH_MAX);
  if (!rows.length) throw new Error('没有可用素材');
  if (rows.length < tpl.min || rows.length > tpl.max) throw new Error('张数与模板不匹配');
  const W = clamp(Math.round(Number(outWidth) || 1200), 400, 6000);
  // 不传 gap：走模板默认，检测用的框和真正出图的框才对得上
  const geo = templateBoxes(tpl, W, rows.length);
  return autoCrops(rows, geo.boxes);
}

/** 手工脚本/单测用：直接给行数据渲染某个模板（不经数据库、不经 HTTP） */
export { buildTemplateStitch as renderTemplate };
