// @ts-check
/**
 * 更新的「延后安装」策略（纯函数，主进程 updater.js 与单测共用）。
 *
 * 场景：用户在「新版本已就绪」的提示里选「下次打开时安装」。
 * 这意味着下次启动必须先把这个版本装掉——不装就没法用（直接退出），
 * 所以需要一份跨启动的记账：deferred.json 里记下「要装哪个版本」。
 *
 * 三种判定：
 *  - none    没有记账（或记账坏了）→ 正常流程
 *  - pending 记账版本比当前版本新 → 本次启动必须安装
 *  - done    当前版本已经 ≥ 记账版本（上次其实装成了）→ 清掉记账
 */

/**
 * 比较版本号：按 . 与 - 切段，数字逐段比，非数字段按 0 处理。
 * 只用于「谁更新」的判断，不追求 semver 的预发布语义。
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((seg) => {
        const n = Number.parseInt(seg, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const x = parse(a);
  const y = parse(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p > q) return 1;
    if (p < q) return -1;
  }
  return 0;
}

/**
 * @param {string} deferredVersion 记账里的目标版本
 * @param {string} currentVersion 当前运行版本
 * @returns {'none' | 'pending' | 'done'}
 */
export function deferralVerdict(deferredVersion, currentVersion) {
  const want = String(deferredVersion || '').trim();
  if (!want || !/\d/.test(want)) return 'none';
  return compareVersions(want, currentVersion) > 0 ? 'pending' : 'done';
}
