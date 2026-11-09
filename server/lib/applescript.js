// @ts-check
/**
 * macOS 侧的 AppleScript 拼装（纯函数，可单测）。
 *
 * 为什么单独成文件：以前把路径直接塞进 `POSIX file "<路径>"`，路径里一旦有双引号
 * 或反斜杠，轻则脚本语法错误、重则被拼出额外语句（AppleScript 注入）。
 * 这里统一做转义，桌面层只负责调用 osascript。
 */

/** 把任意字符串转成可安全放进 AppleScript 双引号字面量的形式 */
export function escapeAppleScriptString(input) {
  return String(input ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

/** 把 POSIX 路径包成 AppleScript 的 file 引用 */
export function posixFileExpr(p) {
  return `POSIX file "${escapeAppleScriptString(p)}"`;
}

/** 设置桌面壁纸（macOS） */
export function setWallpaperScript(p) {
  return `tell application "Finder" to set desktop picture to ${posixFileExpr(p)}`;
}

/** 移到废纸篓（macOS） */
export function trashFileScript(p) {
  return `tell application "Finder" to delete ${posixFileExpr(p)}`;
}
