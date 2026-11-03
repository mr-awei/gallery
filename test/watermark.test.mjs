import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { parseExif } from '../server/lib/exif.js';
import { buildFieldText, detectBrand, logoMark, logoWidth, WATERMARK_FIELDS } from '../server/lib/watermark-meta.js';
import { WATERMARK_STYLES } from '../server/lib/watermark-styles.js';
import { frameDecor, frameGeometry, FRAME_DEFS } from '../server/lib/frame-styles.js';
import { normalizeParams, renderComposite, resolveMainColor, watermarkOptions } from '../server/lib/watermark.js';
import { systemFonts } from '../server/lib/fonts.js';
import { logoOnlySvg } from '../server/lib/watermark-styles.js';

/**
 * 水印 / 相框的核心契约：
 * 1. 23 + 20 款样式必须每款都能排出 SVG（曾经有两款把 block() 的 {svg} 对象直接拼字符串，
 *    结果整段文字变成 "[object Object]" 消失，预览里只剩一个 logo）；
 * 2. 一项信息都没选必须报错，不能生成空白水印；
 * 3. 相框必须真的扩画布，白框四边等宽；
 * 4. EXIF 必须能从 sharp 的 APP1 载荷里解出来（带 "Exif\0\0" 前缀）。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemvault-watermark-'));
const W = 800;
const H = 600;
let plainFile = '';
let exifFile = '';

test('准备测试图片', async () => {
  plainFile = path.join(dir, 'plain.jpg');
  await sharp({ create: { width: W, height: H, channels: 3, background: '#335577' } })
    .jpeg()
    .toFile(plainFile);
  exifFile = path.join(dir, 'exif.jpg');
  await sharp({ create: { width: W, height: H, channels: 3, background: '#446688' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'Hasselblad', Model: 'X2D 100C' },
      IFD2: {
        FNumber: '28/10',
        ExposureTime: '1/250',
        ISOSpeedRatings: '200',
        DateTimeOriginal: '2026:11:02 14:33:07',
      },
    })
    .toFile(exifFile);
});

test('选项表：23 款水印 + 20 款相框 + 信息项 + 品牌', () => {
  const o = watermarkOptions();
  assert.equal(o.watermarks.length, 23);
  assert.equal(o.frames.length, 20);
  assert.ok(o.fields.length >= 6);
  assert.ok(o.brands.length >= 10);
  for (const list of [o.watermarks, o.frames]) {
    const ids = list.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, '样式 id 必须唯一');
  }
  // 需求点名要有的白框、黑框
  assert.ok(o.frames.some((f) => f.id === 'white-even'));
  assert.ok(o.frames.some((f) => f.id === 'black-even'));
  // 默认参数必须是「能直接出图」的一组
  assert.equal(o.defaults.style, 'corner-br');
  assert.ok(o.defaults.fields.length > 0);
});

test('normalizeParams 收敛脏参数', () => {
  const a = normalizeParams({ style: 'corner-br', fields: ['camera', 'bogus'], size: '9', opacity: 0, color: 'x' });
  assert.deepEqual(a.fields, ['camera']);
  assert.equal(a.size, 3);
  assert.equal(a.opacity, 1);
  assert.equal(a.color, 'auto');
  assert.equal(a.saveMode, 'overwrite');
  assert.equal(a.targetDir, '');

  const b = normalizeParams({ saveMode: 'copy', targetDir: 'D:/out', addToLibrary: 1 });
  assert.equal(b.saveMode, 'copy');
  assert.equal(b.targetDir, 'D:/out');
  assert.equal(b.addToLibrary, true);
  assert.equal(b.brand, 'auto');
  assert.equal(b.style, 'none');
});

test('文字颜色：语义色 / 自选十六进制 / 脏值回落', () => {
  const c = (v) => normalizeParams({ style: 'corner-br', color: v }).color;
  assert.equal(c('light'), 'light');
  assert.equal(c('dark'), 'dark');
  assert.equal(c('auto'), 'auto');
  assert.equal(c('#D4AF37'), '#d4af37', '自选色要保留（大写归一为小写）');
  assert.equal(c('#abc'), '#aabbcc', '三位简写补全成六位');
  assert.equal(c('red'), 'auto', '颜色名不接受，回落 auto');
  assert.equal(c('rgba(0,0,0,.5)'), 'auto');
  assert.equal(c('#12345'), 'auto', '位数不对也回落');
});

test('EXIF：sharp 带 "Exif\\0\\0" 前缀也能解出来', async () => {
  const meta = await sharp(exifFile).metadata();
  assert.ok(meta.exif && meta.exif.length > 16);
  assert.equal(meta.exif.toString('latin1', 0, 4), 'Exif');
  const e = parseExif(meta.exif);
  assert.equal(e.make, 'Hasselblad');
  assert.equal(e.model, 'X2D 100C');
  assert.equal(e.aperture, 'f/2.8');
  assert.equal(e.exposure, '1/250s');
  assert.equal(e.iso, 200); // 数值型 EXIF 原样存，格式化交给 buildFieldText
  assert.equal(buildFieldText(e).iso, 'ISO 200');
  assert.ok(e.takenAtText);
});

test('parseExif 对空/垃圾输入返回空对象，不炸', () => {
  assert.deepEqual(parseExif(undefined), {});
  assert.deepEqual(parseExif(Buffer.alloc(0)), {});
  assert.deepEqual(parseExif(Buffer.from('not an exif block at all', 'latin1')), {});
});

test('buildFieldText / detectBrand', () => {
  const fields = buildFieldText({
    make: 'Canon',
    model: 'EOS R5',
    aperture: 'f/1.8',
    exposure: '1/500s',
    iso: 'ISO 100',
    takenAtText: '2026-11-02 14:33',
    location: '31.2°N 121.4°E',
  });
  assert.equal(fields.camera, 'Canon EOS R5');
  assert.equal(fields.aperture, 'f/1.8');
  assert.equal(fields.time, '2026-11-02 14:33');
  assert.equal(fields.location, '31.2°N 121.4°E');
  assert.equal(detectBrand('Canon', 'EOS R5')?.key, 'canon');
  assert.equal(detectBrand('Hasselblad', 'X2D')?.key, 'hasselblad');
  assert.equal(detectBrand('SomeUnknown', 'X'), null);
  assert.equal(buildFieldText({}).camera, '');
});

test('23 款水印排版都返回真实 SVG（不许出现 [object Object]）', () => {
  const lines = [
    { key: 'camera', text: 'Hasselblad X2D 100C' },
    { key: 'aperture', text: 'f/2.8' },
    { key: 'shutter', text: '1/250s' },
    { key: 'iso', text: 'ISO 200' },
    { key: 'time', text: '2026-11-02 14:33' },
  ];
  const c = {
    W,
    H,
    P: { x: 0, y: 0, w: W, h: H },
    lines,
    fs: 26,
    pad: 31,
    main: '#ffffff',
    logo: { show: true },
    brandName: 'HASSELBLAD',
    opts: {},
  };
  for (const s of WATERMARK_STYLES) {
    const out = s.layout(c);
    assert.equal(typeof out, 'string', `${s.id} 必须返回字符串`);
    assert.ok(!out.includes('[object Object]'), `${s.id} 拼进了对象`);
    assert.ok(out.length > 20, `${s.id} 排出来是空的`);
  }
  // 只有 logo、没有文字行时也不能抛异常
  for (const s of WATERMARK_STYLES) {
    assert.doesNotThrow(() => s.layout({ ...c, lines: [] }), `${s.id} 空内容排版崩了`);
  }
});

test('相框几何：白框四边等宽，画布按比例扩边', () => {
  const def = FRAME_DEFS.find((f) => f.id === 'white-even');
  const geo = frameGeometry(def, W, H);
  const b = Math.round(def.b[0] * Math.min(W, H));
  assert.equal(geo.W, W + b * 2);
  assert.equal(geo.H, H + b * 2);
  assert.equal(geo.P.x, b);
  assert.equal(geo.P.y, b);
  assert.equal(geo.P.w, W);
  assert.equal(geo.P.h, H);

  const bottomOnly = frameGeometry(FRAME_DEFS.find((f) => f.id === 'white-wide-bottom'), W, H);
  assert.ok(bottomOnly.H - H > bottomOnly.W - W, '下加宽一定是底部更宽');

  // 投影滤镜的 defs 必须由装饰层自带，否则 url(#fshadow) 指向不存在的滤镜
  const shadow = frameDecor(FRAME_DEFS.find((f) => f.id === 'soft-shadow'), frameGeometry(FRAME_DEFS.find((f) => f.id === 'soft-shadow'), W, H));
  assert.ok(shadow.under.includes('fshadow'));
});

test('错误处理：什么都没选就报错', async () => {
  await assert.rejects(
    () => renderComposite(plainFile, { style: 'none', frame: 'none' }),
    /请先选择一个水印样式或相框样式/
  );
  await assert.rejects(
    () => renderComposite(plainFile, { style: 'corner-br', frame: 'none', fields: [], logo: false }),
    /一项信息都没选/
  );
  // 勾了字段但这张图没有 EXIF：要指出「读不到」，而不是笼统报「没选」
  await assert.rejects(
    () => renderComposite(plainFile, { style: 'corner-br', fields: ['camera'], logo: false }),
    /读不到所选的拍摄信息/
  );
  // 有 logo 但既无 EXIF 也识别不出品牌
  await assert.rejects(
    () => renderComposite(plainFile, { style: 'corner-br', fields: [], logo: true, brand: 'auto' }),
    /识别不出品牌|请手动指定/
  );
});

test('只有品牌 logo 时保留所选样式（不再偷换成居中的品牌落款）', async () => {
  const r = await renderComposite(plainFile, { style: 'bottom-paper', fields: [], logo: true, brand: 'canon' });
  assert.equal(r.style, 'bottom-paper', '用户选的样式必须被尊重');
  assert.equal(r.width, W);
  assert.equal(r.height, H);
  assert.deepEqual(r.fields, []);
});

test('logo-only：选了左下角就画在左边，右下角就画在右边', async () => {
  const mk = (id) => ({ id, name: id, desc: '', layout: () => '' });
  const c = {
    W: 1000,
    H: 800,
    P: { x: 0, y: 0, w: 1000, h: 800 },
    fs: 20,
    pad: 24,
    main: '#ffffff',
    brandName: 'Canon',
    frameLight: true,
    lines: [],
    logo: { show: true },
  };
  /** 取出 svg 里第一个 x 坐标（字标就一个 text 节点） */
  const firstX = (svg) => Number(/<text[^>]*\sx="([\d.]+)"/.exec(svg)?.[1]);
  const bl = firstX(logoOnlySvg(c, mk('corner-bl')));
  const br = firstX(logoOnlySvg(c, mk('corner-br')));
  const mid = firstX(logoOnlySvg(c, mk('brand-block')));
  assert.ok(bl < 100, `left 位置应在左侧，got ${bl}`);
  assert.ok(br > 900, `right 位置应在右侧，got ${br}`);
  assert.ok(Math.abs(mid - 500) < 30, `居中样式应在中间，got ${mid}`);
  // 底条类样式自己带底色，字标必须是深色，否则白字白底看不见
  const banded = logoOnlySvg({ ...c, main: '#ffffff' }, mk('bottom-paper'));
  assert.match(banded, /fill="#141414"/);
});

test('边框款：型号不压字标、品牌不重复、黑框白字白框黑字', () => {
  const c = {
    W: 1600,
    H: 1200,
    P: { x: 30, y: 30, w: 1540, h: 1030 },
    fs: 30,
    pad: 36,
    main: '#141414',
    brandName: 'Canon',
    frameLight: true,
    logo: { show: true },
    lines: [{ key: 'camera', text: 'Canon EOS R5' }],
  };
  const style = (id) => WATERMARK_STYLES.find((s) => s.id === id);
  const texts = (svg) =>
    [...svg.matchAll(/<text[^>]*\sx="([\d.]+)"[^>]*>([^<]*)</g)].map((m) => ({ x: Number(m[1]), text: m[2] }));

  const param = style('mat-brand-param').layout(c);
  const logo = texts(param).find((v) => v.text === 'CANON');
  const title = texts(param).find((v) => v.text === 'EOS R5');
  assert.ok(logo && title, `字标与型号都要排出来：${param}`);
  const logoRight = logo.x + logoWidth('Canon', c.fs * 0.92);
  assert.ok(title.x >= logoRight, `型号压在字标上了：title ${title.x} < logo 右边 ${logoRight}`);

  const split = style('mat-split-rule').layout(c);
  assert.doesNotMatch(split, /Canon\s+Canon/, '品牌不能在分割线上重复一次');
  assert.match(split, />Canon\s+EOS R5</);

  // 关掉字标就别再写品牌名，型号也要恢复成完整串
  const noLogo = style('mat-brand-param').layout({ ...c, logo: { show: false } });
  assert.match(noLogo, />Canon EOS R5</);
  assert.doesNotMatch(noLogo, /CANON/);

  // 黑框：底色偏暗 → 白字
  const dark = style('mat-brand-param').layout({ ...c, main: '#f4f4f4', frameLight: false });
  assert.match(dark, /fill="#f4f4f4"/);
  assert.doesNotMatch(dark, /fill="#141414"/);
});

test('品牌型号清单：主要品牌都有常见型号，且与品牌表对齐', () => {
  const o = watermarkOptions();
  for (const b of o.brands) assert.ok(Array.isArray(b.models), `${b.key} 的 models 必须是数组（没有型号就给空数组）`);
  const need = ['canon', 'nikon', 'sony', 'fujifilm', 'leica', 'apple', 'samsung', 'huawei', 'xiaomi', 'dji', 'gopro'];
  for (const k of need) {
    const b = o.brands.find((x) => x.key === k);
    assert.ok(b, `品牌表里没有 ${k}`);
    assert.ok(b.models.length >= 5, `${k} 至少要有 5 个常见型号，现在 ${b.models.length} 个`);
  }
  for (const b of o.brands) {
    assert.equal(new Set(b.models).size, b.models.length, `${b.key} 的型号有重复，搜索列表里会叠成两行`);
    for (const m of b.models) {
      // 型号只写本体，渲染时拼「品牌 + 型号」；带了前缀会印成「SONY SONY A7 IV」
      assert.ok(
        !m.toUpperCase().startsWith(`${b.name.toUpperCase()} `),
        `${b.key} 的型号带了品牌前缀：${m}`
      );
    }
  }
  // 纯镜头厂不收录：蔡司/腾龙/福伦达/三阳都不要，水印上只能出现真正拍这张图的机身品牌
  for (const k of ['zeiss', 'tamron', 'voigtlander', 'samyang']) {
    assert.equal(o.brands.find((b) => b.key === k), undefined, `${k} 是纯镜头厂，不该出现在品牌清单里`);
  }
  // 老预设里可能还存着这些 key：送进来必须回落 auto，不能拼出「ZEISS X2D」这种机身
  assert.equal(normalizeParams({ brand: 'zeiss' }).brand, 'auto');
  assert.equal(normalizeParams({ brand: 'canon' }).brand, 'canon');
});

test('型号：手选的型号盖过 EXIF，没品牌时只写型号', async () => {
  // EXIF 是 Hasselblad X2D 100C，但用户手选了 SONY A7 IV → 以手选为准
  const r = await renderComposite(exifFile, {
    style: 'corner-br',
    fields: ['camera'],
    logo: true,
    brand: 'sony',
    model: 'A7 IV',
  });
  assert.deepEqual(r.fields, [{ key: 'camera', text: 'SONY A7 IV' }]);

  // 品牌 auto：跟着 EXIF 出的品牌 + 手填型号
  const r2 = await renderComposite(exifFile, { style: 'corner-br', fields: ['camera'], logo: false, model: 'X2D 100C' });
  assert.deepEqual(r2.fields, [{ key: 'camera', text: 'HASSELBLAD X2D 100C' }]);

  // 图里没有任何 EXIF（截图/导出图）：只写型号，不许拼出「undefined X100VI」
  const r3 = await renderComposite(plainFile, { style: 'corner-br', fields: ['camera'], logo: false, model: 'X100VI' });
  assert.deepEqual(r3.fields, [{ key: 'camera', text: 'X100VI' }]);

  // 脏值：控制字符去掉、空白收敛、超长截断
  assert.equal(normalizeParams({ model: '  A7\u0000  IV  ' }).model, 'A7 IV');
  assert.equal(normalizeParams({ model: 'x'.repeat(200) }).model.length, 60);
  assert.equal(normalizeParams({}).model, '', '没填型号时保持空串，表示「用 EXIF」');
});

test('拍摄地点：手动填写优先于 EXIF，脏值被清理', async () => {
  assert.equal(normalizeParams({ location: '  上海 · 外滩\u0000 ' }).location, '上海 · 外滩');
  assert.equal(normalizeParams({ location: 'x'.repeat(200) }).location.length, 80, '地点要截断，别让超长文本撑爆排版');

  const r = await renderComposite(plainFile, { style: 'corner-br', fields: ['location'], logo: false, location: '上海 · 外滩' });
  assert.deepEqual(r.fields, [{ key: 'location', text: '上海 · 外滩' }], '手填地点必须真的进画面');
  assert.ok(r.data.length > 1000);
  // 不填地点、原图又没 EXIF 地点 → 依旧按「读不到」拒绝，不能画一行空白
  await assert.rejects(
    () => renderComposite(plainFile, { style: 'corner-br', fields: ['location'], logo: false }),
    /读不到所选的拍摄信息/
  );
});

test('本机字体：sys:<家族名> 通过白名单，未知家族回落 auto', async () => {
  const list = systemFonts();
  assert.ok(list.length > 0, '本机至少能扫出一种字体');
  assert.ok(list.every((f) => f.key.startsWith('sys:') && f.name && f.group), '字体条目要带 key/name/group');
  const key = list[0].key;
  assert.equal(normalizeParams({ font: key }).font, key);
  assert.equal(normalizeParams({ font: 'sys:根本不存在的字体' }).font, 'auto', '伪造的家族名不能进 SVG');
  const r = await renderComposite(exifFile, { style: 'corner-br', fields: ['camera'], logo: false, font: key });
  assert.ok(r.data.length > 1000, '换成系统字体也要能出图');
});

test('读取 EXIF 出图：字段齐全、尺寸不变', async () => {
  const r = await renderComposite(exifFile, {
    style: 'corner-br',
    fields: ['camera', 'aperture', 'shutter', 'iso', 'time'],
    logo: true,
    brand: 'auto',
  });
  assert.equal(r.width, W);
  assert.equal(r.height, H);
  const keys = r.fields.map((f) => f.key);
  assert.deepEqual(keys, ['camera', 'aperture', 'shutter', 'iso', 'time']);
  assert.equal(r.fields[0].text, 'Hasselblad X2D 100C');
  assert.equal(r.brandName, 'HASSELBLAD');
  assert.ok(r.data.length > 1000);
});

test('resolveMainColor：自选色优先，light/dark 说了算，auto 跟样式走', () => {
  assert.equal(resolveMainColor('#d4af37', 'corner-br'), '#d4af37');
  assert.equal(resolveMainColor('light', 'bottom-paper'), '#ffffff', '显式选白字不能被浅底样式吃掉');
  assert.equal(resolveMainColor('dark', 'corner-br'), '#141414');
  assert.equal(resolveMainColor('auto', 'corner-br'), '#ffffff');
  assert.equal(resolveMainColor('auto', 'bottom-paper'), '#141414');
  assert.equal(resolveMainColor('auto', 'polaroid-caption'), '#141414');
});

test('自选色能跑完整条出图链路', async () => {
  const r = await renderComposite(exifFile, { style: 'corner-br', fields: ['camera'], logo: false, color: '#d4af37' });
  assert.equal(r.width, W);
  assert.ok(r.data.length > 1000);
});

test('只加相框也会扩画布，且允许没有文字', async () => {
  const r = await renderComposite(exifFile, { style: 'none', frame: 'black-even', fields: [] });
  const b = Math.round(FRAME_DEFS.find((f) => f.id === 'black-even').b[0] * Math.min(W, H));
  assert.equal(r.width, W + b * 2);
  assert.equal(r.height, H + b * 2);
  assert.equal(r.style, null);
  assert.equal(r.frame, 'black-even');
});

test('水印 + 相框叠加，字号随画幅缩放', async () => {
  const r = await renderComposite(exifFile, { style: 'corner-br', frame: 'white-even', fields: ['camera'], logo: true, size: 2 });
  assert.ok(r.width > W && r.height > H);
  const meta = await sharp(r.data).metadata();
  assert.equal(meta.width, r.width);
  assert.equal(meta.height, r.height);
});

test('品牌字标：光圈环不许压在字上（左/中/右对齐都要留缝）', async () => {
  // 曾经用 estWidth（0.54em/字、不含 0.16em 字距）算环的位置，比真字窄一大截：
  // 右对齐时环压在 C 上、居中对齐时干脆落在字中间。这里直接栅格化量墨迹，
  // 环和第一个字母之间必须有肉眼可见的空隙。
  const size = 60;
  for (const anchor of ['start', 'middle', 'end']) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="900" height="200" fill="#ffffff"/>` +
      `${logoMark({ x: 450, y: 120, size, anchor, fill: '#000000', name: 'Canon' })}</svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
    const ink = [];
    for (let x = 0; x < info.width; x += 1) {
      let n = 0;
      for (let y = 0; y < info.height; y += 1) if (data[y * info.width + x] < 128) n += 1;
      ink.push(n);
    }
    let i = ink.findIndex((v) => v > 0);
    assert.ok(i >= 0, `${anchor}：一个字标都没画出来`);
    while (i < ink.length && ink[i] > 0) i += 1; // 第一段墨迹 = 光圈环
    let gap = 0;
    while (i < ink.length && ink[i] === 0) {
      gap += 1;
      i += 1;
    }
    assert.ok(gap >= size * 0.12, `${anchor}：光圈环贴在字上，空隙只有 ${gap}px`);
  }
});

test('信息项键名与样式 id 都是稳定值', () => {
  assert.deepEqual(
    WATERMARK_FIELDS.map((f) => f.key),
    ['camera', 'lens', 'aperture', 'shutter', 'iso', 'time', 'location']
  );
  assert.equal(WATERMARK_STYLES[0].id, 'corner-br');
});

test('型号不会印两遍：主行写了型号，副行就不再重复', () => {
  const cam = (text) => ({ key: 'camera', text });
  const params = [
    { key: 'aperture', text: 'f/2.8' },
    { key: 'shutter', text: '1/500s' },
    { key: 'iso', text: 'ISO 400' },
  ];
  const meta = [
    { key: 'time', text: '2026:10:01 18:20:00' },
    { key: 'location', text: '杭州 · 西湖区' },
  ];
  // 用户截图里的重复：副行退到「其它信息」兜底时把相机型号又拼了一遍
  const cases = [
    ['只有型号', [cam('Canon EOS R5')]],
    ['型号 + 参数', [cam('Canon EOS R5'), ...params]],
    ['型号 + 时间地点', [cam('Canon EOS R5'), ...meta]],
  ];
  for (const [label, lines] of cases) {
    const ctx = {
      W,
      H,
      P: { x: 0, y: 0, w: W, h: H },
      lines,
      fs: 24,
      pad: 28,
      main: '#ffffff',
      mT: 0,
      mR: 0,
      mB: 0,
      mL: 0,
      frameLight: false,
      frameBg: '',
      logo: { show: true },
      brandName: 'Canon',
      opts: { fields: lines.map((l) => l.key) },
    };
    for (const s of WATERMARK_STYLES) {
      const out = s.layout(ctx);
      const svg = typeof out === 'string' ? out : (out && out.svg) || '';
      const n = (svg.match(/EOS R5/g) || []).length;
      assert.ok(n <= 1, `${label} / ${s.name}(${s.id})：型号印了 ${n} 遍，上下重复`);
    }
  }
});

test('样式能力：声明能排哪些信息，选错了要能告诉用户', () => {
  const o = watermarkOptions();
  const get = (id) => o.watermarks.find((w) => w.id === id);
  for (const w of o.watermarks) {
    assert.ok(Array.isArray(w.uses), `${w.id} 缺 uses`);
    assert.ok(Array.isArray(w.needs), `${w.id} 缺 needs`);
  }
  // 日期戳：主体是时间/地点，没有就排不出来
  assert.ok(get('film-date').needs.includes('time'));
  assert.ok(get('stamp-date').needs.includes('location'));
  assert.deepEqual([...get('brand-block').uses], ['camera'], '落款只排品牌型号');
  assert.deepEqual([...get('param-grid').uses].sort(), ['aperture', 'camera', 'iso', 'shutter']);
  assert.deepEqual([...get('corner-bracket').needs], ['camera'], '取景框是围着型号画的');
  // 没声明 = 勾了什么都排
  assert.deepEqual(get('corner-br').uses, []);
});

test('只勾型号却选了日期戳：明确报错，不再静默交出一张原图', async () => {
  const params = { style: 'film-date', fields: ['camera'], model: 'X100VI' };
  await assert.rejects(
    () => renderComposite(plainFile, params),
    /拍摄时间|拍摄地点/,
    '没有时间地点时应当报错，而不是返回原图'
  );
  // 预览走 allowEmpty：不画水印层，但要把原因写进 note（面板红条会显示）
  const p = await renderComposite(plainFile, params, { allowEmpty: true });
  assert.ok(p.note && /拍摄时间/.test(p.note), `note 应说明原因，实际：${p.note}`);
  // 补上地点就能正常排出来
  const ok = await renderComposite(plainFile, { ...params, fields: ['camera', 'location'], location: '杭州 · 西湖区' });
  assert.ok(ok.data.length > 0);
});

test('品牌只收「自己能拍」的：纯镜头厂不进清单，且每个品牌都有型号可选', () => {
  const o = watermarkOptions();
  // 纯镜头厂印在水印上会让人以为相机是它出的（「ZEISS X2D」就是错的），一律不收
  const lensOnly = ['zeiss', 'tamron', 'voigtlander', 'samyang', 'rokinon', 'sigma-lens'];
  for (const k of lensOnly) {
    assert.ok(!o.brands.some((b) => b.key === k), `${k} 只做镜头，不该出现在品牌清单里`);
  }
  assert.ok(!o.brands.some((b) => b.group === '镜头'), '不该再有「镜头」分组');
  const groups = new Set(['相机', '手机', '无人机']);
  for (const b of o.brands) {
    assert.ok(groups.has(b.group), `${b.key} 的分组「${b.group}」不该存在`);
  }
  // 能进清单就必须有型号可选，否则用户还得手打（这是上一轮被投诉的点）
  const empty = o.brands.filter((b) => !b.models.length);
  assert.equal(empty.length, 0, `这些品牌没有型号，用户只能手打：${empty.map((b) => b.key).join(',')}`);
  const total = o.brands.reduce((n, b) => n + b.models.length, 0);
  assert.ok(total >= 800, `型号总量 ${total} 太少，用户还是要手动输入`);
});

test('型号表是当季的：头部必须是最新旗舰，不能只有一年前的机器', () => {
  const latest = {
    apple: ['18 Pro Max', '18 Pro', '18', 'Duo'],
    samsung: ['S26 Ultra', 'S26+', 'Z Fold8 Ultra', 'Z Flip8'],
    huawei: ['Mate 90 Pro Max', 'Mate 80 Pro Max', 'Pura 90'],
    xiaomi: ['18 Pro Max', '18 Pro'],
    oppo: ['Find X10 Pro Max', 'Find X10'],
    vivo: ['X400 Pro'],
    honor: ['Magic8 Pro', 'Magic8 Pro Air'],
    oneplus: ['16'],
    google: ['11 Pro XL'],
  };
  const brands = watermarkOptions().brands;
  for (const [key, names] of Object.entries(latest)) {
    const b = brands.find((x) => x.key === key);
    assert.ok(b, `${key} 不在品牌清单里`);
    for (const n of names) {
      assert.ok(b.models.includes(n), `${key} 的型号表缺少当季机型「${n}」——型号表又落后了`);
    }
  }
  // 下拉默认把数组前面的列出来：新机排在最前，老机排后面
  assert.equal(brands.find((b) => b.key === 'apple').models[0], '18 Pro Max', '苹果机型没按从新到旧排');
  assert.equal(brands.find((b) => b.key === 'samsung').models[0], 'S26 Ultra', '三星机型没按从新到旧排');
  // 同一品牌里不许有重复（重复会让下拉出现两行一样的）
  for (const b of brands) {
    assert.equal(new Set(b.models).size, b.models.length, `${b.key} 的型号有重复`);
  }
});


test('清理临时文件', () => {
  fs.rmSync(dir, { recursive: true, force: true });
});
