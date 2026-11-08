/**
 * 主进程侧的设置快照。
 *
 * 服务端搬进独立进程后，主进程不能再直接读 SQLite（同库两连接会互相锁），
 * 但窗口白名单、开机自启、代理、动态壁纸这些系统能力都要设置值，
 * 所以由服务进程在 ready 与每次设置变更时推一份快照过来，主进程只读这份。
 *
 * 注意：这是**异步最终一致**的（几十毫秒）。对 storageDir / 代理 / 自启足够；
 * 不要用它做「保存后立刻读回校验」这类强一致逻辑。
 */
let cache = {};

/** 服务端推来的完整快照 */
export function setSettingsCache(next) {
  cache = next && typeof next === 'object' ? next : {};
  return cache;
}

export function getSettingsSnapshot() {
  return cache;
}

/** 局部更新（例如只有 storageDir 变了） */
export function mergeSettingsCache(patch) {
  if (patch && typeof patch === 'object') cache = { ...cache, ...patch };
  return cache;
}
