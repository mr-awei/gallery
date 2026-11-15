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
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

/**
 * 插件沙箱（能力白名单的第二道闸）。
 *
 * 上一轮实测 `--permission` 在本机会连 Node 自身 shim 模块都拦掉，不可用，
 * 所以这里用 `module.registerHooks` 在「动态 import」解析阶段拒绝危险模块
 * （静态 import 不受影响，插件的 ESM 入口是动态 import 进来的）。
 *
 * 两道白名单都在这里落地：
 * - 路径：fs 系列模块一律不给，只给一个限制在插件目录内的 readFile（需 fs:read）；
 * - 网络：没声明 net 时连 node:http/https/net/dns 一起拒，并删掉全局 fetch/WebSocket，
 *   避免插件「顺手」把素材元数据发出去。声明了 net 的插件才放行这几个模块。
 */
/** 永远禁止：能绕过父进程直接改库/起进程/读本机文件 */
const ALWAYS_BLOCKED = new Set([
  'node:fs', 'fs',
  'node:fs/promises', 'fs/promises',
  'node:child_process', 'child_process',
  'node:cluster', 'cluster',
  'node:worker_threads', 'worker_threads',
  'node:sqlite', 'node:repl',
  'node:net', 'net',
]);
/** 只有声明了 net 才放行（http 栈最终都要落到 net，但仍单独列出便于阅读） */
const NETWORK_MODULES = new Set([
  'node:http', 'http',
  'node:https', 'https',
  'node:http2', 'http2',
  'node:dns', 'dns',
  'node:tls', 'tls',
  'node:dgram', 'dgram',
]);

/** 父进程递进来的权限要在注册 hook 之前就知道（hook 是模块加载时生效的） */
function bootPermissions() {
  try {
    const raw = JSON.parse(process.argv[2] || '{}');
    return new Set(Array.isArray(raw.permissions) ? raw.permissions.map(String) : []);
  } catch {
    return new Set();
  }
}
const BOOT_PERMISSIONS = bootPermissions();
const ALLOW_NET = BOOT_PERMISSIONS.has('net');

registerHooks({
  resolve(specifier, context, next) {
    const s = String(specifier || '');
    const bare = s.replace(/^node:/, '');
    const blocked =
      ALWAYS_BLOCKED.has(s) ||
      ALWAYS_BLOCKED.has(bare) ||
      (!ALLOW_NET && (NETWORK_MODULES.has(s) || NETWORK_MODULES.has(bare)));
    if (blocked) {
      const why = NETWORK_MODULES.has(s) || NETWORK_MODULES.has(bare) ? '插件未声明 net 权限' : '沙箱限制';
      throw new Error(`插件不允许访问模块：${s}（${why}）`);
    }
    return next(specifier, context);
  },
});

// 没声明 net 的插件连全局网络 API 也拿不到：有的插件不 import http，直接 fetch
if (!ALLOW_NET) {
  for (const key of ['fetch', 'WebSocket', 'EventSource', 'Request', 'Response', 'XMLHttpRequest']) {
    try {
      delete globalThis[key];
    } catch {
      /* 删不掉就算了，模块层的拦截仍在 */
    }
  }
}

/** fs:read 的受限实现：只能读插件自己目录下的文件，路径越界直接抛 */
function pluginReadFile(pluginDir) {
  if (!BOOT_PERMISSIONS.has('fs:read')) return undefined;
  const root = path.resolve(pluginDir || '');
  if (!pluginDir) return undefined;
  return (rel) => {
    const abs = path.resolve(root, String(rel || ''));
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error('只能读插件自己目录下的文件');
    }
    return fs.readFileSync(abs, 'utf8');
  };
}

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
  const { entry, dir, image, args, permissions, action } = payload;
  const mod = await import(pathToFileURL(entry).href);
  const fn = mod?.default || mod?.run;
  if (typeof fn !== 'function') throw new Error('插件没有导出 default/run 函数');
  const logs = [];
  const out = await fn({
    image: image || {},
    args: args || {},
    permissions: permissions || [],
    action: action || 'run',
    // 受限文件读取：只有声明 fs:read 才有，且只能在插件目录内
    readFile: pluginReadFile(dir),
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
