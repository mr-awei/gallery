// @ts-check
import { promises as fs } from 'node:fs';

/**
 * 把下好的文件从占位路径挪到用户真正选的位置。
 *
 * 为什么要挪：`will-download` 里必须同步给一个保存路径，否则 Chromium 会自己再弹
 * 一个「另存为」（标题是网址、文件名空白），跟我们的对话框叠成两个框。而保存路径
 * 一旦定下，下完就改不动了（`setSavePath` 只影响 `getSavePath()`），所以先写到
 * 占位路径，下完再挪成用户选的文件名。
 *
 * 同一分区直接 rename；跨分区（EXDEV）退化成复制后删除。
 *
 * @param {string} from 占位路径
 * @param {string} to 目标路径
 * @returns {Promise<string>} 文件实际落地的路径
 */
export async function moveDownloaded(from, to) {
  if (from === to) return to;
  try {
    await fs.rename(from, to);
    return to;
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await discardDownloaded(from);
    return to;
  }
}

/**
 * 丢掉占位文件（用户取消、下载中断时用）。
 * 文件可能还被 Chromium 攥着，重试几次；实在删不掉也不算错，它在系统临时目录里。
 *
 * @param {string} filePath 占位路径
 * @returns {Promise<void>}
 */
export async function discardDownloaded(filePath) {
  for (const target of [filePath, `${filePath}.crdownload`]) {
    for (let i = 0; i < 5; i += 1) {
      try {
        await fs.unlink(target);
        break;
      } catch (err) {
        const code = /** @type {any} */ (err)?.code;
        if (code === 'ENOENT') break; // 本来就没有，收工
        if (i === 4) break; // 还攥着，交给系统临时目录清理
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}
