/**
 * 写入目录校验。
 *
 * 背景：裁切副本、水印输出、备份导出、Eagle 导出、新建图库这些接口的
 * 目标目录直接来自请求体（用户在界面上选的目录）。正常情况下就是用户自己的文件夹，
 * 但一旦本地 API 被跨站请求/扩展打中，就等于「可以在任意可写目录落文件」。
 *
 * 这里不做「只允许白名单目录」那么严格（导出到任意文件夹是真实需求），
 * 而是挡掉最危险的落点：相对路径、盘符根、Windows/ProgramData 等系统目录、
 * 开机启动目录。既保留正常用法，又不至于被写成开机自启或覆盖系统文件。
 */
import path from 'node:path';

const WINDOWS_SYSTEM_DIRS = ['windows', 'program files', 'program files (x86)', 'programdata'];

/**
 * 校验并归一化一个「将要写入」的目录。
 * @param {string} input
 * @param {string} [label] 错误文案里的称呼，例如「保存位置」
 * @returns {string} 绝对路径
 */
export function assertWritableDir(input, label = '目录') {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error(`请选择${label}`);
  if (raw.includes('\0')) throw new Error(`${label}不合法`);

  // 相对路径会随进程工作目录漂移，写到哪里不可预期
  if (!path.isAbsolute(raw)) {
    throw new Error(`${label}必须是绝对路径（收到：${raw}）`);
  }
  const resolved = path.resolve(raw);
  if (resolved.length > 240) throw new Error(`${label}路径过长`);

  if (process.platform !== 'win32') {
    if (resolved === '/') throw new Error(`不能直接使用根目录（${resolved}）`);
    return resolved;
  }

  const lower = resolved.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  // C:\ 这种盘符根：往里写等于把文件撒在磁盘根
  if (/^[a-z]:$/.test(lower)) throw new Error(`不能直接使用磁盘根目录（${resolved}）`);

  const winDir = String(process.env.SystemRoot || 'C:\\Windows')
    .toLowerCase()
    .replace(/\\+$/, '');
  if (lower === winDir || lower.startsWith(`${winDir}\\`)) {
    throw new Error(`不能写入系统目录（${resolved}）`);
  }
  const programData = String(process.env.ProgramData || 'C:\\ProgramData')
    .toLowerCase()
    .replace(/\\+$/, '');
  if (lower === programData || lower.startsWith(`${programData}\\`)) {
    throw new Error(`不能写入系统目录（${resolved}）`);
  }
  const drive = lower.slice(0, 2); // c:
  for (const name of WINDOWS_SYSTEM_DIRS) {
    const sys = `${drive}\\${name}`;
    if (lower === sys || lower.startsWith(`${sys}\\`)) {
      throw new Error(`不能写入系统目录（${resolved}）`);
    }
  }
  // 开机启动目录：往这里放文件等于获得开机自启能力，是落文件攻击的首选目标
  if (lower.includes('\\start menu\\programs\\startup') || lower.includes('\\startup\\')) {
    throw new Error(`不能写入开机启动目录（${resolved}）`);
  }
  return resolved;
}
