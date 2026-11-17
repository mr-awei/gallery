// @ts-check
/**
 * 路径相关的纯函数（只依赖 node:path，便于 node --test 直接加载）。
 */
import path from 'node:path';

/**
 * 一组目录的最深公共父目录。
 *
 * 用途：老库里 folders.anchor_path 全是空串（实测 120 个夹子一个都没有），
 * 「打开当前文件夹」只能靠子树里图片的实际落盘位置反推。
 * Windows 盘符与目录名大小写不敏感，比较时统一小写，输出保留第一个目录的原始大小写。
 *
 * @param {string[]} dirs
 * @returns {string} 没有公共部分时返回 path.sep（根）
 */
export function commonDirOf(dirs) {
  const list = (dirs || []).map((d) => path.resolve(String(d)));
  if (!list.length) return path.sep;
  let parts = list[0].split(path.sep);
  for (const d of list.slice(1)) {
    const p = d.split(path.sep);
    let i = 0;
    while (i < parts.length && i < p.length && parts[i].toLowerCase() === p[i].toLowerCase()) i += 1;
    parts = parts.slice(0, i);
    if (!parts.length) break;
  }
  const joined = parts.join(path.sep) || path.sep;
  // "E:\a" 与 "E:\b" 的公共部分是盘符 "E:"，补上分隔符才是可用的根路径
  return /^[a-zA-Z]:$/.test(joined) ? joined + path.sep : joined;
}
