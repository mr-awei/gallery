import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { STORAGE_DIR } from './config.js';
import { db, getSettings } from './db.js';
import { getScreenSize, setWallpaper, listMonitors, setWallpapersCom } from './desktop.js';

export const WALLPAPER_DIR = path.join(STORAGE_DIR, 'wallpaper');
if (!fs.existsSync(WALLPAPER_DIR)) fs.mkdirSync(WALLPAPER_DIR, { recursive: true });

export const FILL_STYLES = {
  blur: '模糊同图铺底（推荐）',
  solid: '纯色铺底（取图片主色）',
  black: '纯黑铺底',
};

/**
 * 生成桌面壁纸（contain 完整展示，参考 macOS/iOS「适合」+ 大厂做法）：
 *  - 图片按原始比例等比缩放，完整居中放进屏幕，绝不裁切、绝不拉伸变形、绝不只显示一部分；
 *  - 剩余区域用「模糊同图 / 主色 / 纯黑」填充，形成完整的一张「屏幕分辨率」壁纸；
 *  - 无论图片与屏幕比例差多大，输出文件本身就是屏幕尺寸且图片完整可见，
 *    因此即使系统壁纸模式为「填充」也不会被裁切。
 * @returns {{path:string, generated:boolean, screen:{width:number,height:number}, fit:string}}
 */
export async function buildWallpaper(imageId, style = 'blur', opts = {}) {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(imageId);
  if (!row) throw new Error('图片不存在');
  if (!fs.existsSync(row.abs_path)) throw new Error('图片文件不存在');

  // 目标画布：默认主屏；跨屏模式传入整块虚拟桌面的尺寸，每屏模式传入该屏尺寸
  const screen =
    opts.width && opts.height ? { width: opts.width, height: opts.height } : await getScreenSize();
  const tag = opts.tag ? `${opts.tag}_` : '';

  // 读取真实尺寸（数据库缺失时回退到读文件），顺便识别动图。
  // sharp 默认只解第一帧：以前把 GIF 设成静态壁纸会静默变成一张静帧，
  // 用户以为「动态壁纸坏了」。这里明确拒绝并指路（/live 轮播会用原文件 URL 真正播放）。
  let iw = Number(row.width) || 0;
  let ih = Number(row.height) || 0;
  const suspicious = /\.(gif|webp|png|apng)$/i.test(row.abs_path || '');
  let meta = null;
  if (!iw || !ih || suspicious) {
    try {
      meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
    } catch {
      /* 读不出来就按数据库尺寸继续 */
    }
  }
  if ((Number(meta?.pages) || 1) > 1) {
    throw new Error('这是动图：静态壁纸只会显示第一帧。请改用动态壁纸模式（/live 轮播会播放原动图）');
  }
  if (!iw || !ih) {
    iw = meta?.width || 0;
    ih = meta?.height || 0;
  }
  const cacheName = `wp_${row.id}_${style}_${tag}${screen.width}x${screen.height}.jpg`;
  const outPath = path.join(WALLPAPER_DIR, cacheName);
  if (fs.existsSync(outPath)) {
    return { path: outPath, generated: true, screen, fit: 'contain' };
  }

  // 前景：等比缩放至完整放进屏幕（contain），不裁切、不变形。
  // 中间产物只物化前景一个 buffer；背景层直接用管线参与最终合成，
  // 避免「背景 buffer + 前景 buffer + 合成输出」三份 4K 全屏解码同时驻留内存（≈75MB 峰值）。
  const scale = Math.min(screen.width / (iw || screen.width), screen.height / (ih || screen.height));
  const fgWidth = Math.max(1, Math.round((iw || screen.width) * scale));
  const fgHeight = Math.max(1, Math.round((ih || screen.height) * scale));
  const fg = await sharp(row.abs_path, { failOn: 'none' })
    .rotate()
    .resize(fgWidth, fgHeight, { fit: 'fill' })
    .jpeg({ quality: 94 })
    .toBuffer();

  // 最终管线：背景层（模糊同图 / 主色 / 纯黑）原地 composite 前景，一步写盘
  let out;
  if (style === 'black') {
    out = sharp({
      create: { width: screen.width, height: screen.height, channels: 3, background: { r: 8, g: 8, b: 14 } },
    });
  } else if (style === 'solid') {
    const pixel = await sharp(row.abs_path, { failOn: 'none' })
      .resize(1, 1, { fit: 'cover' })
      .raw()
      .toBuffer();
    const [r, g, b] = [pixel[0] ?? 20, pixel[1] ?? 20, pixel[2] ?? 28];
    out = sharp({
      create: {
        width: screen.width,
        height: screen.height,
        channels: 3,
        background: { r: Math.round(r * 0.5), g: Math.round(g * 0.5), b: Math.round(b * 0.5) },
      },
    });
  } else {
    // 模糊同图：放大铺满后重度模糊并压暗，形成"氛围底"
    out = sharp(row.abs_path, { failOn: 'none' })
      .rotate()
      .resize(screen.width, screen.height, { fit: 'cover' })
      .blur(60)
      .modulate({ brightness: 0.55, saturation: 1.1 });
  }

  await out
    .composite([{ input: fg, gravity: 'center' }])
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toFile(outPath);

  return { path: outPath, generated: true, screen, fit: 'contain' };
}

/** 壁纸模式 */
export const WALLPAPER_MODES = {
  single: '主屏一张（默认）',
  span: '跨屏合成一张（多屏无缝）',
  'per-monitor': '每个屏幕不同图片',
};

/** 多屏拼成的整块虚拟桌面尺寸 */
function spanBounds(monitors) {
  const minX = Math.min(...monitors.map((m) => m.x));
  const minY = Math.min(...monitors.map((m) => m.y));
  const maxX = Math.max(...monitors.map((m) => m.x + m.width));
  const maxY = Math.max(...monitors.map((m) => m.y + m.height));
  return { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * 设为桌面壁纸（竖图自动合成，完整展示）。
 * mode: single 单屏 / span 跨屏合成 / per-monitor 每屏不同图
 * opts.ids 为每屏预选的图片 id（per-monitor 用），缺省则各屏用同一张
 */
export async function applyWallpaper(imageId, opts = {}) {
  const settings = getSettings();
  const style = settings.wallpaperFill || 'blur';
  const mode = opts.mode || settings.wallpaperMode || 'single';

  // 单屏模式不需要读显示器，省一次 PowerShell
  const monitors = mode === 'single' ? [] : await listMonitors();

  if (mode === 'span' && monitors.length > 1) {
    const span = spanBounds(monitors);
    const result = await buildWallpaper(imageId, style, { width: span.width, height: span.height, tag: 'span' });
    await setWallpapersCom([{ monitorId: '', path: result.path }], 5); // 5 = 跨屏
    return { ...result, mode, monitorCount: monitors.length };
  }

  if (mode === 'per-monitor' && monitors.length > 1) {
    const ids = Array.isArray(opts.ids) ? opts.ids : [];
    const assignments = [];
    const screens = [];
    for (let i = 0; i < monitors.length; i++) {
      const id = ids[i] || ids[0] || imageId;
      const m = monitors[i];
      const r = await buildWallpaper(id, style, { width: m.width, height: m.height, tag: `m${i}` });
      assignments.push({ monitorId: m.id, path: r.path });
      screens.push({ monitorId: m.id, width: m.width, height: m.height, imageId: id, path: r.path });
    }
    await setWallpapersCom(assignments, 3); // 3 = 适应（不裁切）
    return { path: assignments[0].path, generated: true, mode, monitorCount: monitors.length, screens };
  }

  const result = await buildWallpaper(imageId, style);
  await setWallpaper(result.path);
  return { ...result, mode: 'single', monitorCount: monitors.length };
}
