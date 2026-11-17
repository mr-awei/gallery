/**
 * 导出为 HTML 网页画廊（Eagle 的「Export as HTML」）。
 *
 * 为什么整份内嵌而不是链接回本机接口：
 * 导出的 html 要能发给别人、能离线打开、能丢进静态服务器。如果 src 指向
 * http://127.0.0.1:3001/api/...，别人打开是空白，自己关掉客户端也是空白。
 * 所以缩略图统一转成 base64 内联；单张按 480px / q=72 压过，控制在几十 KB。
 *
 * 纯渲染逻辑在 lib/gallery-html.js（可单测），这里只做取数 + 缩略图内嵌。
 */
import sharp from 'sharp';
import { db } from './db.js';
import { existingThumbPath, mtimeOf } from './thumbs.js';
import { renderGalleryHtml } from './lib/gallery-html.js';

export { escapeHtml, safeFileName, formatSize, formatDate, renderGalleryHtml } from './lib/gallery-html.js';

export const MAX_ITEMS = 500;
const EMBED_WIDTH = 480;
const EMBED_QUALITY = 72;

/** 取一张内嵌缩略图（data URL）；没有缩略图且原文件解不开时返回 '' */
async function embedThumb(row) {
  // 带上 mtime：按 id 命名的缓存可能是旧库残留，导出的画廊不能出现别人的图
  const cached = existingThumbPath(row.id, mtimeOf(row.abs_path));
  try {
    // 缓存缩略图是 640px / q80，直接塞进去体积偏大，统一再压一档
    const buf = cached
      ? await sharp(cached, { failOn: 'none' })
          .resize({ width: EMBED_WIDTH, withoutEnlargement: true })
          .jpeg({ quality: EMBED_QUALITY })
          .toBuffer()
      : await sharp(row.abs_path, { failOn: 'none' })
          .rotate()
          .resize({ width: EMBED_WIDTH, withoutEnlargement: true })
          .jpeg({ quality: EMBED_QUALITY })
          .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

const SELECT_COLS =
  'id, title, tags, width, height, abs_path, source_url, media_kind, size_bytes, created_at, fs_mtime, cover_ver, source';

function rowsByIds(ids) {
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return [];
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM images WHERE id IN (${uniq.map(() => '?').join(',')})`)
    .all(...uniq);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // 保持调用方给的顺序（选择顺序 / 搜索结果顺序）
  return uniq.map((id) => byId.get(id)).filter(Boolean);
}

function rowsByFolder(folderId, limit) {
  const folder = db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId);
  if (!folder) return [];
  return db
    .prepare(
      `SELECT ${SELECT_COLS} FROM images
        WHERE id IN (
          SELECT f.image_id FROM image_folders f JOIN folders d ON d.id = f.folder_id WHERE d.path LIKE ?
        )
        ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(folder.path + '%', limit);
}

function rowsLatest(limit) {
  return db.prepare(`SELECT ${SELECT_COLS} FROM images ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit);
}

/**
 * 拉取要导出的行。
 * scope: 'folder' 当前文件夹（含子夹） / 'all' 全库最新 / 传 ids 时按 ids（选择或当前筛选）
 */
export function collectRows({ scope = 'all', folderId = null, ids = [], maxItems = 200 } = {}) {
  const limit = Math.min(MAX_ITEMS, Math.max(1, Math.round(Number(maxItems) || 200)));
  const idList = Array.isArray(ids) ? ids : [];
  if (idList.length) return rowsByIds(idList).slice(0, limit);
  if (scope === 'folder' && folderId) return rowsByFolder(Number(folderId), limit);
  return rowsLatest(limit);
}

/** 拉行 → 内嵌缩略图 → 渲染 */
export async function buildGalleryHtml(params = {}) {
  const rows = collectRows(params);
  // 串行 4 路：只有缺缩略图的行才会真解码，批量并发解码会跟正在用的界面抢 CPU
  const items = [];
  const queue = [...rows];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const thumb = await embedThumb(row);
      items.push({
        id: row.id,
        title: row.title || '',
        tags: row.tags
          ? String(row.tags)
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        width: row.width,
        height: row.height,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at,
        mediaKind: row.media_kind || 'image',
        sourceUrl: row.source_url || '',
        thumb,
        src: thumb,
      });
    }
  });
  await Promise.all(workers);
  // 并发取图会打乱顺序，按原始行序还原
  const order = new Map(rows.map((r, i) => [r.id, i]));
  items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return {
    html: renderGalleryHtml(items, params),
    count: items.length,
    withThumb: items.filter((i) => i.thumb).length,
  };
}
