import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getThumbDir } from './db.js';

/**
 * 缩略图按 id 分桶存储：thumbs/<id%256 的两位 hex>/<id>.jpg
 * 单目录百万文件会让 NTFS 枚举/删除性能崩塌（删库 rmSync 递归也是）；
 * 256 桶 × 4k 文件是单层目录的甜点区。
 * 旧库已有平铺文件：读路径先查桶再回退平铺（不迁移，写路径一律分桶，自然过渡）。
 */

export function thumbBucketDir(id) {
  return path.join(getThumbDir(), (Number(id) % 256).toString(16).padStart(2, '0'));
}

export function thumbPathFor(id) {
  return path.join(thumbBucketDir(id), `${id}.jpg`);
}

export function legacyThumbPath(id) {
  return path.join(getThumbDir(), `${id}.jpg`);
}

/** 该图的缩略图当前实际路径（桶内优先，回退旧平铺；都没有返回 ''） */
export function existingThumbPath(id) {
  const bucketed = thumbPathFor(id);
  if (fs.existsSync(bucketed)) return bucketed;
  const legacy = legacyThumbPath(id);
  return fs.existsSync(legacy) ? legacy : '';
}

export async function ensureThumbDirFor(id) {
  return fsp.mkdir(thumbBucketDir(id), { recursive: true });
}

/** 删除某图所有可能存在的缩略图文件（桶内 + 旧平铺 + DB 记录的其它路径），全部幂等 */
export async function removeThumbFiles(id, extraPath = '') {
  const candidates = new Set([thumbPathFor(id), legacyThumbPath(id)]);
  if (extraPath) candidates.add(extraPath);
  await Promise.all(
    [...candidates].map((p) =>
      fsp.rm(p, { force: true }).catch(() => {})
    )
  );
}
