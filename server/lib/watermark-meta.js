// 水印的「内容层」：可选信息项、品牌识别、SVG 文本小工具。
// 与样式、渲染分开，是为了让样式表只关心排版，测试也能直接断言文字拼接。
export const WATERMARK_FIELDS = [
  { key: 'camera', label: '相机品牌 / 型号', hint: '如 HASSELBLAD X2D 100C' },
  { key: 'lens', label: '镜头', hint: '如 XCD 4/45P' },
  { key: 'aperture', label: '光圈', hint: '如 f/2.8' },
  { key: 'shutter', label: '快门', hint: '如 1/250s' },
  { key: 'iso', label: '感光度', hint: '如 ISO 200' },
  { key: 'time', label: '拍摄时间', hint: '如 2026-11-02 14:33' },
  { key: 'location', label: '拍摄地点', hint: 'EXIF 里的经纬度' },
];

/**
 * 能自动配字标的品牌：相机、手机、无人机/运动相机。
 *
 * 只收「自己能拍」的品牌：做机身/手机/无人机的一律收，纯镜头厂（蔡司、腾龙、
 * 福伦达、三阳）一律不收——水印里出现 ZEISS 会让人以为相机是蔡司出的。
 * 镜头信息另有 `lens` 字段，用户在面板里手填。
 *
 * 顺序有意义——detectBrand 用第一个命中的 match，所以「子品牌」要排在自己的
 * 母品牌之后、宽泛规则之前（例如 Redmi 在 Xiaomi 之后，Honor 在 Huawei 之后）。
 * 手动下拉里按 group 分组显示。
 */
export const LOGO_BRANDS = [
  // ---------------- 相机 ----------------
  { key: 'canon', name: 'Canon', group: '相机', match: /canon/i },
  { key: 'nikon', name: 'NIKON', group: '相机', match: /nikon/i },
  // Xperia 合并进索尼（EXIF 的 make 都是 Sony），型号里带 Xperia 前缀，免得单独拆一个品牌
  { key: 'sony', name: 'SONY', group: '相机', match: /sony|ilce|ilca/i },
  { key: 'fujifilm', name: 'FUJIFILM', group: '相机', match: /fuji/i },
  { key: 'leica', name: 'LEICA', group: '相机', match: /leica/i },
  { key: 'hasselblad', name: 'HASSELBLAD', group: '相机', match: /hasselblad/i },
  { key: 'phaseone', name: 'PHASE ONE', group: '相机', match: /phase\s?one/i },
  { key: 'mamiya', name: 'MAMIYA', group: '相机', match: /mamiya/i },
  { key: 'contax', name: 'CONTAX', group: '相机', match: /contax/i },
  { key: 'bronica', name: 'BRONICA', group: '相机', match: /bronica/i },
  { key: 'rollei', name: 'ROLLEI', group: '相机', match: /rollei/i },
  { key: 'minolta', name: 'MINOLTA', group: '相机', match: /minolta|konica/i },
  { key: 'pentax', name: 'PENTAX', group: '相机', match: /pentax/i },
  // 理光要排在宾得前后都行，但 match 不能重叠：GR 系列的用户量比宾得机身大得多
  { key: 'ricoh', name: 'RICOH', group: '相机', match: /ricoh/i },
  { key: 'olympus', name: 'OM SYSTEM', group: '相机', match: /olympus|om digital/i },
  { key: 'panasonic', name: 'LUMIX', group: '相机', match: /panasonic|lumix/i },
  { key: 'sigma', name: 'SIGMA', group: '相机', match: /sigma/i },
  { key: 'casio', name: 'CASIO', group: '相机', match: /casio/i },
  { key: 'kodak', name: 'KODAK', group: '相机', match: /kodak/i },
  { key: 'polaroid', name: 'POLAROID', group: '相机', match: /polaroid/i },
  { key: 'lomography', name: 'LOMOGRAPHY', group: '相机', match: /lomo|zenit/i },
  { key: 'yashica', name: 'YASHICA', group: '相机', match: /yashica/i },

  // ---------------- 手机 ----------------
  { key: 'apple', name: 'iPhone', group: '手机', match: /apple/i },
  { key: 'samsung', name: 'SAMSUNG', group: '手机', match: /samsung/i },
  { key: 'huawei', name: 'HUAWEI', group: '手机', match: /huawei/i },
  { key: 'honor', name: 'HONOR', group: '手机', match: /honor/i },
  { key: 'xiaomi', name: 'Xiaomi', group: '手机', match: /xiaomi|mi\s?\d/i },
  { key: 'redmi', name: 'Redmi', group: '手机', match: /redmi/i },
  { key: 'oppo', name: 'OPPO', group: '手机', match: /oppo|pccm/i },
  { key: 'iqoo', name: 'iQOO', group: '手机', match: /iqoo/i },
  { key: 'vivo', name: 'vivo', group: '手机', match: /vivo/i },
  { key: 'infinix', name: 'Infinix', group: '手机', match: /infinix/i },
  { key: 'tecno', name: 'TECNO', group: '手机', match: /tecno/i },
  { key: 'lava', name: 'LAVA', group: '手机', match: /lava/i },
  { key: 'oneplus', name: 'OnePlus', group: '手机', match: /oneplus|onetouch/i },
  { key: 'realme', name: 'realme', group: '手机', match: /realme/i },
  { key: 'meizu', name: 'MEIZU', group: '手机', match: /meizu/i },
  { key: 'nubia', name: 'nubia', group: '手机', match: /nubia/i },
  { key: 'zte', name: 'ZTE', group: '手机', match: /\bzte\b/i },
  { key: 'motorola', name: 'MOTOROLA', group: '手机', match: /motorola/i },
  { key: 'nokia', name: 'NOKIA', group: '手机', match: /nokia/i },
  { key: 'google', name: 'Pixel', group: '手机', match: /google|pixel/i },
  { key: 'lg', name: 'LG', group: '手机', match: /\blg\b|lg electronics/i },
  { key: 'htc', name: 'HTC', group: '手机', match: /htc/i },
  { key: 'asus', name: 'ASUS', group: '手机', match: /asus/i },
  { key: 'lenovo', name: 'Lenovo', group: '手机', match: /lenovo/i },
  { key: 'nothing', name: 'Nothing', group: '手机', match: /nothing/i },
  { key: 'sharp', name: 'SHARP', group: '手机', match: /sharp/i },

  // ---------------- 无人机 / 运动相机 ----------------
  { key: 'dji', name: 'DJI', group: '无人机', match: /dji|osmo/i },
  { key: 'insta360', name: 'Insta360', group: '无人机', match: /insta360|arashi/i },
  { key: 'gopro', name: 'GoPro', group: '无人机', match: /gopro/i },
];

/** 水印字体：key 存进设置，stack 是真正写进 SVG 的 font-family */
export const WATERMARK_FONTS = [
  { key: 'auto', name: '跟随样式', stack: '' },
  { key: 'sans', name: '无衬线', stack: "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', Arial, sans-serif" },
  { key: 'serif', name: '衬线', stack: "Georgia, 'Times New Roman', 'Songti SC', serif" },
  { key: 'song', name: '宋体', stack: "'SimSun', 'Songti SC', 'STSong', serif" },
  { key: 'hei', name: '黑体', stack: "'Microsoft YaHei', 'SimHei', 'PingFang SC', sans-serif" },
  { key: 'kai', name: '楷体', stack: "'KaiTi', 'STKaiti', 'Kaiti SC', serif" },
  { key: 'mono', name: '等宽', stack: 'Consolas, Menlo, Courier, monospace' },
  { key: 'impact', name: '粗黑标题', stack: "Impact, 'Arial Black', 'Microsoft YaHei', sans-serif" },
];

export const SANS = "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', Arial, sans-serif";
export const SERIF = "Georgia, 'Times New Roman', serif";
export const MONO = "Consolas, 'Courier New', monospace";

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** 文本宽度估算：中日韩字符按 1em，其它按 0.54em（够用来摆背景条） */
export function estWidth(text, size) {
  let w = 0;
  for (const ch of String(text)) {
    w += /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch) ? size : size * 0.54;
  }
  return w;
}

/**
 * 品牌字标的实际占宽（含光圈环与字距）。
 * logoMark 的字距是 0.16em、粗体大写比 estWidth 的 0.54em 宽一圈，
 * 拿 estWidth 去接下一段文字必然压字，所以单独算一份。0.68em/字是实测墨迹宽度。
 */
export function logoWidth(name, size, { ring = true, spacing = 0.16 } = {}) {
  const label = String(name || '').toUpperCase();
  let w = ring ? size * 0.5 : 0;
  for (const ch of label) w += /[\u2E80-\u9FFF]/.test(ch) ? size : size * 0.68;
  return w + label.length * size * spacing;
}

/** 单行文字：阴影/描边/字距/字体都能调 */
export function t({
  x,
  y,
  text,
  size,
  fill = '#ffffff',
  anchor = 'start',
  weight = 400,
  opacity = 1,
  shadow = false,
  stroke = null,
  spacing = 0,
  italic = false,
  font = SANS,
}) {
  const attrs = [
    `x="${Number(x).toFixed(1)}"`,
    `y="${Number(y).toFixed(1)}"`,
    `font-family="${font}"`,
    `font-size="${Number(size).toFixed(1)}"`,
    `fill="${fill}"`,
    `fill-opacity="${opacity}"`,
    `text-anchor="${anchor}"`,
    weight ? `font-weight="${weight}"` : '',
    spacing ? `letter-spacing="${Number(spacing).toFixed(2)}"` : '',
    italic ? 'font-style="italic"' : '',
    stroke ? `stroke="${stroke.c}" stroke-width="${Number(stroke.w).toFixed(2)}" stroke-opacity="${stroke.o ?? 1}" paint-order="stroke"` : '',
    shadow ? 'filter="url(#ts)"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<text ${attrs}>${esc(text)}</text>`;
}

/** 品牌字标：大写字距 + 一个小光圈环（纯排版，不含任何商标图形） */
export function logoMark({ x, y, size, anchor = 'start', fill = '#ffffff', opacity = 1, name, ring = true }) {
  const ringR = size * 0.13;
  const gap = ring ? size * 0.5 : 0;
  const tx = anchor === 'end' ? x : x + gap;
  const label = String(name || '').toUpperCase();
  const text = t({ x: tx, y, text: label, size, fill, anchor, weight: 700, opacity, spacing: size * 0.16 });
  if (!ring) return text;
  // 光圈环要摆在字**前面**，宽度必须按字标自己的口径算：
  // 以前用 estWidth（0.54em/字，还不含 0.16em 字距），比真字窄一大截，
  // 于是右对齐时环压在字上、居中对齐时干脆落在字中间（CANON 上套个圈就是这么来的）。
  // 末字后面的 0.16em 字距渲染器也会留（anchor=end/middle 时字整体左移），一起算进去。
  const textW = logoWidth(label, size, { ring: false });
  const trail = size * 0.16;
  const ringX =
    anchor === 'start'
      ? x
      : x - (anchor === 'middle' ? textW / 2 + trail / 2 : textW + trail) - ringR - size * 0.3;
  return `${text}<circle cx="${ringX.toFixed(1)}" cy="${(y - size * 0.3).toFixed(1)}" r="${ringR.toFixed(1)}" fill="none" stroke="${fill}" stroke-opacity="${opacity}" stroke-width="${(size * 0.06).toFixed(2)}"/>`;
}

/** 多行文本块：返回 { svg, height }；rows 里可逐行覆盖样式 */
export function block(c, rows, o = {}) {
  const { x, y, anchor = 'start', lineH = 1.32, fill, shadow = true, opacity = 1, stroke = null } = o;
  const parts = [];
  let cursor = y;
  for (const r of rows) {
    parts.push(
      t({
        x: r.x ?? x,
        y: cursor,
        text: r.text,
        size: r.size,
        fill: r.fill || fill || c.main,
        anchor: r.anchor || anchor,
        weight: r.weight ?? 400,
        opacity: r.opacity ?? opacity,
        shadow: r.shadow ?? shadow,
        stroke: r.stroke ?? stroke,
        spacing: r.spacing || 0,
        italic: Boolean(r.italic),
        font: r.font || SANS,
      })
    );
    cursor += r.size * (r.lineH || lineH);
  }
  return { svg: parts.join(''), height: cursor - y };
}

export const joinedText = (c, sep = ' · ') => c.lines.map((l) => l.text).join(sep);

export const DEFS = `
<defs>
  <!-- 两层投影：紧贴的一圈保证字在白衬衫/天空上也能看清，外圈只负责柔和不脏 -->
  <filter id="ts" x="-40%" y="-60%" width="180%" height="240%">
    <feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="#000000" flood-opacity="0.55" result="s1"/>
    <feDropShadow in="s1" dx="0" dy="2" stdDeviation="3.6" flood-color="#000000" flood-opacity="0.34"/>
  </filter>
  <linearGradient id="gBottom" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0.72"/>
  </linearGradient>
  <linearGradient id="gTop" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#000000" stop-opacity="0.6"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="gSide" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#000000" stop-opacity="0.5"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
  </linearGradient>
</defs>`;

/** 按 EXIF 的 make 猜品牌；猜不到就返回 null */
export function detectBrand(make, model) {
  const s = `${make || ''} ${model || ''}`;
  return LOGO_BRANDS.find((b) => b.match.test(s)) || null;
}

/** 把 EXIF 拍平成「可显示字段 → 文本」，空值一律不出现在水印里 */
export function buildFieldText(exif = {}) {
  return {
    camera: exif.camera || [exif.make, exif.model].filter(Boolean).join(' '),
    lens: exif.lens || '',
    aperture: exif.aperture || '',
    shutter: exif.exposure || '',
    iso: exif.iso ? `ISO ${exif.iso}` : '',
    time: exif.takenAtText || '',
    location: exif.location || '',
  };
}
