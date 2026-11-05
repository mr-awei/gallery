import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertWritableDir } from './safe-path.js';
import { db, getSettings } from '../db.js';
import { getActiveLibrary } from '../libraries.js';
import { hiddenFolderPaths, hiddenImagesClause } from './privacy.js';

/**
 * 导出成 Eagle 4 的 `.library`（反向互通）。
 *
 * 结构（Eagle 4 实际读的那套）：
 *   <Name>.library/
 *     metadata.json                     { folders: [{id,name,parent}], smartFolders, tagsGroups, ... }
 *     images/<13位id>.info/metadata.json
 *     images/<13位id>.info/<原文件名>.<ext>
 *
 * 只做「能原样搬走」的部分：原图、文件夹层级、标签、星级、备注、来源、时间、主色板。
 * 缩略图不复制 —— Eagle 首次打开会自己生成，硬塞进去反而容易出现尺寸不匹配。
 */

const CONCURRENCY = 8;

/** 13 位、字母开头：Eagle 的 id 形态；确定性生成方便重复导出时目录对齐 */
function eagleId(prefix, n) {
  return (prefix + Number(n).toString(36).toUpperCase().padStart(12, '0')).slice(0, 13);
}

function safeName(raw, fallback = 'item') {
  const s = String(raw || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/[\s.]+$/g, '')
    .trim();
  return (s || fallback).slice(0, 80);
}

function toMs(iso, fallback = Date.now()) {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : fallback;
}

async function mapLimit(list, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
}

/**
 * @param {{ destDir: string, name?: string }} opts
 * destDir 是「放 .library 的父目录」；最终产物是 destDir/<库名>.library
 */
export async function exportEagleLibrary({ destDir, name } = {}) {
  const dest = assertWritableDir(destDir, '导出目录');
  if (!dest) throw new Error('请选择导出目录');
  if (!fs.existsSync(dest)) throw new Error('导出目录不存在，请重新选择');

  const lib = getActiveLibrary();
  const libName = safeName(name || lib?.name || 'TuKu', 'TuKu');
  const target = path.join(dest, `${libName}.library`);
  // 只在空目录里建：Eagle 库里同名素材会被覆盖，宁可让用户换个地方
  if (fs.existsSync(target)) {
    const left = fs.readdirSync(target);
    if (left.length) throw new Error(`目标已存在且不为空：${target}\n换个空文件夹，或先删掉它`);
  }

  // 隐私空间：锁着未解锁的文件夹连同素材都不导出（导出也不能成为绕过密码的后门）
  const hidden = hiddenImagesClause();
  const lockSql = hidden ? ` AND ${hidden.sql}` : '';
  const lockParams = hidden ? hidden.params : [];

  // 隐私夹的子孙也要排掉（祖先被锁、子夹本身没密码，靠 path 前缀判断）
  const hiddenPrefixes = hiddenFolderPaths();
  const visibleFolders = db
    .prepare('SELECT id, name, parent_id, path FROM folders ORDER BY path ASC')
    .all()
    .filter((f) => !hiddenPrefixes.some((pre) => String(f.path).startsWith(pre)));
  const folderIdMap = new Map(visibleFolders.map((f) => [f.id, eagleId('F', f.id)]));

  const imgs = db
    .prepare(`SELECT * FROM images WHERE abs_path <> ''${lockSql}`)
    .all(...lockParams);

  // 一次取全量「图 ↔ 夹」映射，避免每张图一次查询（万级库会变成 N+1）
  const membership = new Map();
  const rels = db.prepare('SELECT image_id, folder_id FROM image_folders').all();
  for (const r of rels) {
    const arr = membership.get(r.image_id);
    if (arr) arr.push(r.folder_id);
    else membership.set(r.image_id, [r.folder_id]);
  }

  fs.mkdirSync(path.join(target, 'images'), { recursive: true });

  const now = Date.now();
  fs.writeFileSync(
    path.join(target, 'metadata.json'),
    JSON.stringify(
      {
        folders: visibleFolders.map((f) => ({
          id: folderIdMap.get(f.id),
          name: f.name,
          parent: f.parent_id != null && folderIdMap.has(f.parent_id) ? folderIdMap.get(f.parent_id) : null,
          children: [],
        })),
        smartFolders: [],
        tagsGroups: [],
        modificationTime: now,
        creationTime: now,
        applicationVersion: '4.0.0',
        description: `由 TuKu 导出（${lib?.name || '当前库'}）`,
        name: libName,
      },
      null,
      2
    ),
    'utf8'
  );

  let exported = 0;
  let missing = 0;
  const errors = [];

  await mapLimit(imgs, CONCURRENCY, async (row) => {
    const src = String(row.abs_path || '');
    const ext = path.extname(src).replace(/^\./, '').toLowerCase() || 'jpg';
    const base = safeName(row.title || path.parse(src).name, `image_${row.id}`);
    const eid = eagleId('I', row.id);
    const infoDir = path.join(target, 'images', `${eid}.info`);
    try {
      await fsp.mkdir(infoDir, { recursive: true });
      await fsp.copyFile(src, path.join(infoDir, `${base}.${ext}`));
    } catch {
      missing += 1;
      if (errors.length < 8) errors.push(`${row.title || row.id}: 原文件读不到`);
      return;
    }

    const tags = String(row.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const folderIds = (membership.get(row.id) || [])
      .map((fid) => folderIdMap.get(fid))
      .filter(Boolean);
    let palette = [];
    try {
      const p = JSON.parse(row.palette || '[]');
      if (Array.isArray(p)) palette = p;
    } catch {
      // 主色板坏了不影响素材本身
    }

    const meta = {
      id: eid,
      name: base,
      size: Number(row.size_bytes) || 0,
      btime: toMs(row.created_at, now),
      mtime: toMs(row.updated_at || row.created_at, now),
      ext,
      tags,
      folders: folderIds,
      isDeleted: false,
      url: row.source_url || '',
      annotation: row.note || '',
      width: Number(row.width) || 0,
      height: Number(row.height) || 0,
      star: Math.max(0, Math.min(5, Number(row.rating) || 0)),
      palette,
    };
    try {
      await fsp.writeFile(path.join(infoDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
      exported += 1;
    } catch {
      missing += 1;
      if (errors.length < 8) errors.push(`${base}: metadata 写入失败`);
    }
  });

  return {
    ok: true,
    dir: target,
    exported,
    missing,
    folders: visibleFolders.length,
    errors,
    note: '在 Eagle 里「文件 → 打开资源库」选这个 .library 即可；缩略图由 Eagle 首次打开时自动生成',
  };
}

/** 供设置页展示：当前库可导出的规模（不含隐私夹） */
export function eagleExportPreview() {
  const hidden = hiddenImagesClause();
  const lockSql = hidden ? ` AND ${hidden.sql}` : '';
  const params = hidden ? hidden.params : [];
  const images = db.prepare(`SELECT COUNT(*) AS c FROM images WHERE abs_path <> ''${lockSql}`).get(...params).c;
  const folders = db.prepare('SELECT COUNT(*) AS c FROM folders').get().c;
  const settings = getSettings();
  return { images, folders, storageDir: settings.storageDir || '' };
}
