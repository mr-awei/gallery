// @ts-check
/**
 * 下载去重器：同一个 URL 在窗口期内重复出现，只认第一个。
 *
 * 为什么需要：保存框是「点一下 → 建一个下载项 → 暂停 → 弹另存为」，
 * 连点/双击会在第一个框还没出现前再建一个下载项，于是叠出两个「另存为」。
 * 下载项是按 URL 建的，所以在建项这一刻拦掉重复最靠得住（渲染层、多个窗口、
 * 快捷键等所有入口都覆盖得到）。
 */
export function createDownloadDedupe(windowMs = 1500) {
  /** @type {Map<string, number>} */
  const recent = new Map();
  return {
    /**
     * 登记一次下载请求。
     * @param {string} url 下载项 URL（拦截键，需含 token 等全部参数）
     * @param {number} [now] 时间戳，便于测试
     * @returns {boolean} true=放行，false=窗口期内重复，应取消
     */
    accept(url, now = Date.now()) {
      if (!url) return true;
      // 顺手清过期记录，Map 不随下载次数无限增长
      for (const [k, at] of recent) if (now - at > windowMs) recent.delete(k);
      if (recent.has(url)) return false;
      recent.set(url, now);
      return true;
    },
    get size() {
      return recent.size;
    },
  };
}
