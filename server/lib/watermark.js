// 水印 / 相框：把 SVG 排版叠到照片上，再走和裁切/调色同一条写回链路。
//
// 单张与批量共用 renderComposite()：批量只是循环调它，参数完全一致，
// 不会出现「预览好看、导出变形」的两套逻辑。
import fs from 'node:fs';
import sharp from 'sharp';
import { getImage } from '../library.js';
import { persistEdit } from './edit.js';
import { parseExif } from './exif.js';
import { resolveSystemFont, systemFonts } from './fonts.js';
import { buildFieldText, DEFS, detectBrand, LOGO_BRANDS, WATERMARK_FIELDS, WATERMARK_FONTS } from './watermark-meta.js';
import { modelsForBrand } from './brand-models.js';
import { findWatermarkStyle, logoOnlySvg, WATERMARK_STYLES } from './watermark-styles.js';
import { findFrame, FRAME_DEFS, frameDecor, frameGeometry } from './frame-styles.js';

export const WATERMARK_DEFAULTS = {
  style: 'corner-br',
  frame: 'none',
  fields: ['camera', 'aperture', 'shutter', 'iso'],
  logo: true,
  brand: 'auto',
  model: '',
  size: 1,
  opacity: 1,
  color: 'auto',
  font: 'auto',
  location: '',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 文字颜色：auto / light / dark 三个语义值，或 #rrggbb 自定义色。
 * 只认标准六位十六进制（三位简写也补全），其余一律回落到 auto，
 * 免得脏参数把任意字符串塞进 SVG 的 fill 属性里。
 */
function normalizeColor(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'light' || s === 'dark' || s === 'auto') return s;
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return 'auto';
}

/** #rrggbb 的相对亮度（0..1），只用来判断「白底还是黑底」 */
function bgLuma(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * 文字主色。
 * - 自选色（#rrggbb）优先：用户明确挑了颜色就按他挑的画，不再猜深浅；
 * - light / dark：显式要白字或黑字；
 * - auto：有相框就跟相框底色走（白框黑字 / 黑框白字，比按样式猜准）；
 *   没相框时再看样式 —— 纸质/拍立得这类浅底样式用深色，其余用白色。
 */
export function resolveMainColor(color, styleId, frameBg = '') {
  if (/^#[0-9a-f]{6}$/.test(String(color))) return color;
  if (color === 'light') return '#ffffff';
  if (color === 'dark') return '#141414';
  const luma = bgLuma(frameBg);
  if (luma !== null) return luma > 0.55 ? '#141414' : '#f4f4f4';
  const lightPaper = ['bottom-paper', 'polaroid-caption'].includes(styleId);
  return lightPaper ? '#141414' : '#ffffff';
}

/** 选项表：前端一次拉走，样式名不再硬编码在页面里 */
export function watermarkOptions() {
  return {
    fields: WATERMARK_FIELDS,
    // uses/needs：这款样式能排哪些信息、至少要有哪一项。前端据此标出「不含所选信息」，
    // 免得用户选了「胶片日期」却只勾了型号，预览里什么都没有还以为坏了。
    watermarks: WATERMARK_STYLES.map(({ id, name, desc, uses, needs }) => ({
      id,
      name,
      desc,
      uses: uses ? [...uses] : [],
      needs: needs ? [...needs] : [],
    })),
    frames: FRAME_DEFS.map(({ id, name, desc }) => ({ id, name, desc })),
    // 型号清单跟着品牌一起下发（机型名不放在前端硬编码，两边对不上就会出现「选不到的型号」）
    brands: LOGO_BRANDS.map(({ key, name, group }) => ({ key, name, group, models: modelsForBrand(key) })),
    fonts: WATERMARK_FONTS.map(({ key, name }) => ({ key, name })),
    // 本机装的所有字体（解析字体文件的 name 表得到家族名），前端按中/西文分组
    systemFonts: systemFonts().map(({ key, name, group }) => ({ key, name, group })),
    defaults: WATERMARK_DEFAULTS,
  };
}

function svgDoc(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${DEFS}${body}</svg>`;
}

/** 给照片做圆角遮罩：radius 是短边比例，圆角外保留相框底色 */
async function roundPhoto(buf, w, h, radius) {
  const r = Math.max(0, Math.min(w, h) * Number(radius || 0));
  if (!r) return buf;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r.toFixed(1)}" ry="${r.toFixed(1)}" fill="#ffffff"/></svg>`
  );
  return sharp(buf).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/** 参数归一化：脏数据（字符串数字、缺失字段）在这里就收敛掉 */
export function normalizeParams(input = {}) {
  const style = String(input.style || 'none');
  const frame = String(input.frame || 'none');
  const fields = Array.isArray(input.fields) ? input.fields.map(String) : [];
  const valid = fields.filter((k) => WATERMARK_FIELDS.some((f) => f.key === k));
  return {
    style,
    frame,
    fields: valid,
    logo: input.logo === undefined ? WATERMARK_DEFAULTS.logo : Boolean(input.logo),
    // 品牌只认清单里的 key：老预设里可能存着已下架的纯镜头厂（zeiss/tamron…），
    // 一律回落 auto，否则字标会印成「ZEISS X2D」这种不存在的机身
    brand: LOGO_BRANDS.some((b) => b.key === input.brand) ? String(input.brand) : 'auto',
    // 手选/手写的型号：会拼在品牌名后面覆盖 EXIF（EXIF 常常没有，或是 ILCE-7M4 这种机器名）
    model: String(input.model || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60),
    size: clamp(Number(input.size) || 1, 0.5, 3),
    opacity: clamp(Number(input.opacity) || 1, 0.15, 1),
    color: normalizeColor(input.color),
    // 字体：内置的 8 种（跟随样式的衬线/等宽等）或本机任意已装字体（sys:<家族名>）
    font: WATERMARK_FONTS.some((f) => f.key === input.font) || resolveSystemFont(input.font) ? String(input.font) : 'auto',
    // 自定义拍摄地点：EXIF 一般没有地点，让用户自己写（清空则不覆盖 EXIF 里的值）
    location: String(input.location || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80),
    saveMode: input.saveMode === 'copy' ? 'copy' : 'overwrite',
    targetDir: input.targetDir ? String(input.targetDir) : '',
    addToLibrary: Boolean(input.addToLibrary),
  };
}

const FIELD_LABEL = Object.fromEntries(WATERMARK_FIELDS.map((f) => [f.key, f.label]));
const fieldLabels = (keys) => keys.map((k) => FIELD_LABEL[k] || k).join(' / ');

/**
 * 「选了这款样式却没有水印」的原因。
 * 有些样式天生只吃某几项信息（胶片日期只盖时间/地点、参数卡片不排时间），
 * 以前这类组合会静默交出一张原图，用户只会觉得「水印没生效」。
 */
function styleGapReason(style, lines, params, brandDef) {
  if (!style || !lines.length) return '';
  const have = new Set(lines.map((l) => l.key));
  if (style.needs?.length) {
    // needs 是「至少要有其中一项」：一个都没有就排不出东西
    if (!style.needs.some((k) => have.has(k))) {
      return `「${style.name}」要显示${fieldLabels(style.needs)}，这张图读不到这些信息：换一款样式，或换一张带这些信息的图`;
    }
    return '';
  }
  if (!style.uses?.length) return '';
  if (style.uses.some((k) => have.has(k))) return '';
  if (params.logo && brandDef) return ''; // 还有字标可画，不算空
  const missing = lines.map((l) => l.key).filter((k) => !style.uses.includes(k));
  return `「${style.name}」不排${fieldLabels(missing)}：它只显示${fieldLabels(style.uses)}。换一款样式，或改勾它支持的信息`;
}

/**
 * 合成一张：返回 { data, width, height, fields, brandName, tag }
 * 抛错文案直接给用户看（「一项信息都没选」这类必须说清楚）
 */
export async function renderComposite(absPath, rawParams = {}, { allowEmpty = false } = {}) {
  const params = normalizeParams(rawParams);
  const meta = await sharp(absPath, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) throw new Error('无法读取这张图的尺寸（文件可能损坏）');

  const exif = parseExif(meta.exif);
  const filled = buildFieldText(exif);
  // 用户自己写的拍摄地点优先于 EXIF（大多数相机根本没有地点信息）
  if (params.location) filled.location = params.location;
  const brandDef = params.brand !== 'auto' ? LOGO_BRANDS.find((b) => b.key === params.brand) : detectBrand(exif.make, exif.model);
  // 手选的品牌/型号盖过 EXIF：截图、导出图、手机美颜图根本没有型号信息，
  // 而「SONY A7 IV」才是水印上要写的字。品牌没选（auto）又认不出来时就只写型号。
  if (params.model) filled.camera = [brandDef?.name || exif.make || '', params.model].filter(Boolean).join(' ');
  const lines = params.fields.filter((k) => filled[k]).map((k) => ({ key: k, text: filled[k] }));
  const styleId = params.style === 'none' ? null : params.style;
  const frameDef = findFrame(params.frame);
  let style = styleId ? findWatermarkStyle(styleId) : null;

  if (!style && !frameDef) throw new Error('请先选择一个水印样式或相框样式');

  // 错误处理：一项信息都没选（也没开 logo）直接拒绝，不生成一张没内容的图。
  // 预览例外（allowEmpty）：预览的意义就是「看着调」，一张空白的图比一句报错有用得多，
  // 所以预览时宁可只显示原图，由前端把原因挂在下方的红条里。
  let note = '';
  const emptyReason = (() => {
    if (!style || lines.length > 0) return '';
    if (!params.logo) {
      return params.fields.length > 0
        ? '这张图读不到所选的拍摄信息（可能是截图或导出图）：换勾一项，或打开「品牌 logo」'
        : '一项信息都没选：请至少勾选一个要显示的拍摄信息，或打开「品牌 logo」';
    }
    if (!brandDef) {
      return '这张图没有拍摄信息，也识别不出品牌：请手动指定一个品牌 logo，或勾选其它信息';
    }
    return '';
  })() || styleGapReason(style, lines, params, brandDef);

  if (emptyReason) {
    if (!allowEmpty) throw new Error(emptyReason);
    // 预览：不画水印层，只把原图（含相框）显示出来
    style = null;
    note = emptyReason;
  }

  // 只有 logo 没有文字：保持用户选的样式，把字标摆到该样式的位置。
  // （以前统一换成「品牌落款」，选了「左下角」却出现在正中间，看起来就是位置不生效）
  const logoOnly = Boolean(style && lines.length === 0);

  // 先按 EXIF 方向摆正，否则竖拍的图水印会跟着转 90°
  const rotated = await sharp(absPath, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
  const rw = rotated.info.width;
  const rh = rotated.info.height;

  const geo = frameDef ? frameGeometry(frameDef, rw, rh) : { W: rw, H: rh, P: { x: 0, y: 0, w: rw, h: rh } };
  const { W, H, P } = geo;
  const deco = frameDef ? frameDecor(frameDef, geo) : { under: '', over: '' };
  // 圆角相框：照片先按圆角遮罩裁一次，圆角外露出的就是相框底色
  const photo = frameDef?.radius ? await roundPhoto(rotated.data, rw, rh, frameDef.radius) : rotated.data;

  const layers = [];
  if (deco.under) layers.push({ input: Buffer.from(svgDoc(W, H, deco.under)), left: 0, top: 0 });
  layers.push({ input: photo, left: P.x, top: P.y });
  if (deco.over) layers.push({ input: Buffer.from(svgDoc(W, H, deco.over)), left: 0, top: 0 });

  let brandName = '';
  if (style) {
    // 基准字号按面积开方缩放：只看短边的话，宽幅图的水印会小到看不清
    const diag = Math.sqrt(P.w * P.h);
    const fs = clamp(diag * 0.024, 13, diag * 0.05) * params.size;
    const main = resolveMainColor(params.color, style.id, frameDef?.bg);
    const c = {
      W,
      H,
      P,
      lines,
      fs,
      pad: fs * 1.2,
      main,
      // 四边留白：边框款样式要把字排进留白里，照片本身不动
      mT: P.y,
      mR: W - (P.x + P.w),
      mB: H - (P.y + P.h),
      mL: P.x,
      frameLight: frameDef ? (bgLuma(frameDef.bg) ?? 1) > 0.55 : true,
      // 边框款样式在照片内侧铺条时，条色要跟相框底色一模一样，否则接缝一眼可见
      frameBg: frameDef?.bg || '',
      logo: { show: params.logo && Boolean(brandDef) },
      brandName: brandDef?.name || exif.make || '',
      opts: params,
    };
    brandName = c.brandName;
    // 样式返回字符串；有样式会顺手把 block() 的 {svg} 直接返回，这里兜一层免得渲染出 "[object Object]"
    // 只有字标没有文字时：按该样式自己的落位画，不再偷换成居中落款。
    // 边框款样式本来就把字标排进留白里（handlesEmpty），交给它自己排版更准。
    const laid = logoOnly && !style.handlesEmpty ? logoOnlySvg(c, style) : style.layout(c);
    let body = typeof laid === 'string' ? laid : laid?.svg || '';
    // 字体统一替换：各款样式各自写死了 font-family（衬线/等宽是为了风格），
    // 用户在「微调 → 字体」里指定过就整体覆盖，一处生效比改 22 个样式表可靠。
    // sys:<家族名> 是本机系统字体，已经过白名单校验，取不到就保持样式自带的字体。
    const sys = resolveSystemFont(params.font);
    const stack = sys ? sys.stack : params.font === 'auto' ? '' : WATERMARK_FONTS.find((f) => f.key === params.font)?.stack || '';
    if (stack) body = body.replace(/font-family="[^"]*"/g, `font-family="${stack}"`);
    if (!body.trim()) {
      // 兜底：样式自己声明过，但仍然排不出内容（日期戳没日期这类）。
      // 静默交出一张原图是最坏的结果 —— 用户会以为功能坏了。
      const msg = `「${style.name}」排不出内容：换一款样式，或改勾它支持的信息（${fieldLabels(style.uses || []) || '品牌落款'}）`;
      if (!allowEmpty) throw new Error(msg);
      note = msg;
      brandName = '';
    } else {
      layers.push({ input: Buffer.from(svgDoc(W, H, `<g opacity="${params.opacity}">${body}</g>`)), left: 0, top: 0 });
    }
  }

  const base = sharp({
    create: {
      width: W,
      height: H,
      channels: 4,
      background: frameDef ? frameDef.bg : { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  let pipeline = base.composite(layers);
  const fmt = String(meta.format || 'jpeg');
  if (fmt === 'png') pipeline = pipeline.png({ compressionLevel: 9 });
  else if (fmt === 'webp') pipeline = pipeline.webp({ quality: 95 });
  else if (fmt === 'avif') pipeline = pipeline.avif({ quality: 60 });
  else pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
  const data = await pipeline.toBuffer();

  const tag = frameDef ? (style ? '水印相框' : '相框') : '水印';
  return { data, width: W, height: H, fields: lines, brandName, tag, note, style: style?.id || null, frame: frameDef?.id || null };
}

/** 单张：合成 + 写回（覆盖原图留撤销备份，或另存副本） */
export async function watermarkImage(id, rawParams = {}) {
  const row = getImage(id);
  if (!row) throw new Error('图片不存在');
  if (!row.abs_path) throw new Error('这张素材没有原文件');
  if (!fs.existsSync(row.abs_path)) throw new Error('本地文件不存在，可能被移动或删除了');
  const params = normalizeParams(rawParams);
  if (params.style === 'none' && params.frame === 'none') throw new Error('请先选择一个水印样式或相框样式');
  const r = await renderComposite(row.abs_path, params);
  const opts = { saveMode: params.saveMode, targetDir: params.targetDir, addToLibrary: params.addToLibrary };
  const out = await persistEdit(id, row, r.data, { width: r.width, height: r.height }, opts, r.tag);
  return {
    ...out,
    note: [out.note, r.note].filter(Boolean).join(' · '),
    width: r.width,
    height: r.height,
    fields: r.fields.map((f) => f.key),
    brand: r.brandName,
  };
}

/** 预览：长边压到 1400 以内，前端调参时高频请求也不至于太重 */
export async function previewWatermark(id, rawParams = {}) {
  const row = getImage(id);
  if (!row) throw new Error('图片不存在');
  if (!row.abs_path || !fs.existsSync(row.abs_path)) throw new Error('本地文件不存在');
  // 预览不因「没有可显示的信息」而失败：把原图给出去，前端叠加原因提示，
  // 用户能看着照片决定换哪一项，而不是对着一个黑框猜
  const r = await renderComposite(row.abs_path, rawParams, { allowEmpty: true });
  const data = await sharp(r.data)
    .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84 })
    .toBuffer();
  // 只有「真的没画出水印」才需要解释；换了排版（品牌落款）属于正常出图，不必打扰
  return { data, width: r.width, height: r.height, note: r.style ? '' : r.note || '' };
}
