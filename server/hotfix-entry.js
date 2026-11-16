/**
 * 热更叠加层的启动 shim（随安装包发布，永远在 asar 里）。
 *
 * 只做两件事，顺序不能换：先注册解析钩子，再**动态** import 叠加层入口。
 * 用静态 import 会被提升到模块求值最前面，钩子还没装上就开始解析叠加层里的裸模块，
 * 结果就是「明明装了热更却起不来」。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const target = process.env.TUKU_HOTFIX_ENTRY || '';
if (!target) {
  console.error('[hotfix] 缺少 TUKU_HOTFIX_ENTRY，无法启动叠加层服务');
  process.exit(1);
}
register('./hotfix-loader.mjs', import.meta.url);
await import(pathToFileURL(target).href);
