// @ts-check
/**
 * 崩溃捕获与转储清理。minidump 只落本地 userData/CrashReports，不上传（隐私优先）；
 * 配合日志可定位白屏 / 闪退。
 */
import { app, crashReporter } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export function initCrashReporting() {
  try {
    // 不自动上传；转储只留在本机
    crashReporter.start({ uploadToServer: false, compress: true });
  } catch {
    /* 部分平台不支持，忽略 */
  }
}

/** 清掉 7 天前的崩溃转储：崩溃信息既不出去，也不该无限占磁盘 */
export function cleanupCrashDumps(maxAgeDays = 7) {
  try {
    const dir = app.getPath('crashDumps');
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    const walk = (d, depth = 0) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(p, depth + 1);
          try {
            if (!fs.readdirSync(p).length) fs.rmdirSync(p);
          } catch {
            /* 非空/被占用 */
          }
          continue;
        }
        try {
          if (fs.statSync(p).mtimeMs < cutoff) {
            fs.unlinkSync(p);
            removed += 1;
          }
        } catch {
          /* 单个文件失败不影响其它 */
        }
      }
    };
    walk(dir);
    if (removed) console.info(`[crash] 已清理 ${removed} 个 ${maxAgeDays} 天前的崩溃转储`);
  } catch (err) {
    console.warn('[crash] 清理崩溃转储失败：', err?.message || err);
  }
}
