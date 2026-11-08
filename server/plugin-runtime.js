/**
 * 插件子进程入口。由 server/lib/plugin-host.js 用 child_process.fork 拉起。
 *
 * 这里刻意不 import 任何服务端模块（db / library / config 都不进子进程）：
 * 插件只拿到一份「素材快照 + 参数」，返回一份 patch；能不能写库、写哪些字段，
 * 全由父进程按 manifest 声明的权限决定。
 *
 * 插件导出：export default async function run({ image, args, permissions, action, log })
 * 返回 { logs?: string[], patch?: { tags?, note?, rating?, favorite? }, result?: unknown }
 */
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

/**
 * 插件沙箱（能力白名单的第二道闸）。
 * 上一轮实测 `--permission` 在本机会连 Node 自身 shim 模块都拦掉，不可用；
 * 这里改用 `module.registerHooks` 在「动态 import」解析阶段就拒绝危险模块，
 * 静态 import（如本运行时的 node:url）不受影响。
 * 目标：插件可读写普通数据、发网络请求（受父进程权限约束），但拿不到
 * 文件系统 / 子进程 / 网络原始套接字 / 数据库句柄，避免读到库外文件。
 */
const BLOCKED_MODULES = new Set([
  'node:fs', 'fs',
  'node:fs/promises', 'fs/promises',
  'node:child_process', 'child_process',
  'node:net', 'net',
  'node:dns', 'dns',
  'node:cluster', 'cluster',
  'node:worker_threads', 'worker_threads',
  'node:sqlite', 'node:repl',
]);
registerHooks({
  resolve(specifier, context, next) {
    const s = String(specifier || '');
    const bare = s.replace(/^node:/, '');
    if (BLOCKED_MODULES.has(s) || BLOCKED_MODULES.has(bare)) {
      throw new Error(`插件不允许访问模块：${s}（沙箱限制）`);
    }
    return next(specifier, context);
  },
});

// 结果走 stdout 的单行 JSON：child_process.spawn 与 fork 都能用，
// 也不需要 Electron 的 IPC channel（服务端本身可能跑在 utilityProcess 里）。
const send = (msg) => {
  process.stdout.write(`__TUKU_PLUGIN__${JSON.stringify(msg)}\n`);
};

function parsePayload(argv) {
  const raw = argv[2];
  if (!raw) throw new Error('缺少插件执行参数');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('插件执行参数不是合法 JSON');
  }
}

async function main() {
  const payload = parsePayload(process.argv);
  const { entry, image, args, permissions, action } = payload;
  const mod = await import(pathToFileURL(entry).href);
  const fn = mod?.default || mod?.run;
  if (typeof fn !== 'function') throw new Error('插件没有导出 default/run 函数');
  const logs = [];
  const out = await fn({
    image: image || {},
    args: args || {},
    permissions: permissions || [],
    action: action || 'run',
    log: (msg) => {
      if (permissions?.includes('log')) logs.push(String(msg).slice(0, 500));
    },
  });
  const result = out && typeof out === 'object' ? out : {};
  // 输出限额在父进程再校验一次，这里先截断数组，避免 IPC 塞进巨量日志
  const allLogs = [...logs, ...(Array.isArray(result.logs) ? result.logs : [])]
    .slice(0, 50)
    .map((l) => String(l).slice(0, 500));
  send({
    type: 'result',
    value: {
      logs: allLogs,
      patch: result.patch && typeof result.patch === 'object' ? result.patch : {},
      result: result.result ?? null,
    },
  });
}

main().catch((err) => {
  send({ type: 'error', message: String(err?.message || err).slice(0, 500) });
  process.exitCode = 1;
});
