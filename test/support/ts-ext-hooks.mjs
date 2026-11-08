import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Vite 允许 `from './tone'` 而 Node 的 ESM 不允许省略扩展名。
 * 源码按前端规范去掉 .ts 后缀后，测试进程通过这个 resolve hook 补回 .ts，
 * 这样「一套源码」既能被 Vite 打包，也能被 node --test 直接导入。
 * 只对确实存在的 .ts 文件生效，其它说明符原样交给 Node 解析。
 */
export async function resolve(specifier, context, nextResolve) {
  if (/^\.{1,2}\//.test(specifier) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    try {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (fs.existsSync(fileURLToPath(candidate))) {
        // 交给 Node 默认解析：它会按 .ts 扩展名自动启用 type stripping，
        // 自己返回 format:'module' 反而会把 TS 当成普通 JS 解析而报语法错。
        return nextResolve(`${specifier}.ts`, context);
      }
    } catch {
      /* 不是 file: URL 或路径非法，交回默认解析 */
    }
  }
  return nextResolve(specifier, context);
}
