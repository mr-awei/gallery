// @ts-check
/**
 * 首次安装后的示例图片播种：装完就该看到「图库里有图」，而不是空库 + 一句「请选择文件夹」。
 * 只在默认目录为空时写入，且写一次标记就不再写 —— 用户删光图片后重启不会被塞回来。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT_DIR } from './constants.js';

export function seedSampleImages() {
  const dest = process.env.TUKU_DEFAULT_STORAGE_DIR;
  if (!dest) return;
  const marker = path.join(app.getPath('userData'), '.samples-seeded');
  if (fs.existsSync(marker)) return;
  const src = app.isPackaged
    ? path.join(process.resourcesPath, 'samples')
    : path.join(APP_ROOT_DIR, 'assets', 'samples');
  try {
    let existing = [];
    try {
      existing = fs.readdirSync(dest);
    } catch {
      existing = [];
    }
    // 目录里已经有东西（用户自己的素材）就不掺示例图
    if (!existing.length && fs.existsSync(src)) {
      fs.mkdirSync(dest, { recursive: true });
      let copied = 0;
      for (const f of fs.readdirSync(src)) {
        const from = path.join(src, f);
        if (!fs.statSync(from).isFile()) continue;
        fs.copyFileSync(from, path.join(dest, f));
        copied++;
      }
      console.info('[seed] 已放入示例图片', copied, '张 →', dest);
    }
  } catch (err) {
    console.warn('[seed] 示例图片准备失败：', err?.message || err);
  }
  // 标记照写：即使这次目录非空（用户自有素材），下次也不再尝试
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* 标记写不了就下次再判断一次，不影响启动 */
  }
}
