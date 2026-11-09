// @ts-check
/**
 * 素材目录遍历的唯一排除表。
 *
 * 扫描（bulk-import 的流式 walk）、监听（importer 的 fs.watch）、以及任何
 * 「拿到一个名字/路径，判断它该不该被吸进库」的地方，都必须问这一份。
 *
 * 为什么集中：以前 importer.js 和 bulk-import.js 各有一份几乎相同的 Set，
 * 改一处漏一处 —— 加 .tuku（库数据目录，默认就建在素材文件夹里）时
 * 就差点漏掉真正干活的那一份，扫描会把库自己的缩略图当成新素材再吸一遍。
 */

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'app',
  'dist',
  'storage',
  'trash',
  'data',
  'thumbs',
  // 库数据目录：gallery.db + 整库缩略图。扫进来就是自己吃自己
  '.tuku',
  // 旧版本用过这个名字，老库里还留着；继续跳过，否则升级后第一次扫描
  // 会把老库自己的缩略图当成新素材再吸一遍
  '.gemvault',
  '.codebuddy',
  'system volume information',
  '$recycle.bin',
]);

/**
 * 目录名该不该跳过。
 * .library 也算：那是 Eagle 式资产目录，*.info 里放的是库内图片的副本，
 * 由「导入到库」自己登记，扫描再吸一遍就是同一张照片两份记录。
 */
export function shouldSkipDir(name) {
  const lower = String(name || '').toLowerCase();
  return SKIP_DIRS.has(lower) || lower.endsWith('.library');
}

/**
 * 整条路径里任意一段命中排除表就算不该入库。
 * fs.watch 给的相对路径、DB 里的相对目录都走这个判断。
 */
export function isSkippedPath(full) {
  return String(full || '')
    .toLowerCase()
    .split(/[\\/]+/)
    .some((seg) => seg !== '' && shouldSkipDir(seg));
}
