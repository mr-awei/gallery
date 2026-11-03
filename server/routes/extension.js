/**
 * 浏览器扩展的「在哪 / 怎么装」入口。
 *
 * 痛点：扩展一直躺在仓库 extension/ 里，但打包时没被带出去，界面上也没有任何入口，
 * 连开发者本人都不知道它存在。这里给出可查询的目录 + 一键打开 + 打包下载，
 * 设置页直接照着三步装。
 */
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFolder } from '../desktop.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 打包后 extraResources 落在 resources/extension；开发时是仓库里的 extension/ */
export function findExtensionDir() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'extension') : '',
    path.resolve(here, '../..', 'app.asar.unpacked', 'extension'),
    path.resolve(here, '../..', 'extension'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
    } catch {
      /* asar 内或权限问题：试下一个 */
    }
  }
  return '';
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Chrome 扩展 ID = 公钥 sha256 前 16 字节按 0-9a-f 映射成 a-p；固定 key 就是固定 ID */
function extensionIdFromKey(key) {
  if (!key) return '';
  try {
    const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest();
    return [...digest.subarray(0, 16)]
      .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
      .join('');
  } catch {
    return '';
  }
}

export function register(app, { asyncRoute }) {
  app.get('/api/extension/info', (_req, res) => {
    const dir = findExtensionDir();
    const manifest = dir ? readManifest(dir) : null;
    res.json({
      ok: !!manifest,
      dir,
      version: manifest?.version || '',
      name: manifest?.name || '图库采集助手',
      id: extensionIdFromKey(manifest?.key),
      exists: !!manifest,
    });
  });

  app.post('/api/extension/open', (_req, res) => {
    const dir = findExtensionDir();
    if (!dir) return res.status(404).json({ error: '没找到扩展目录（开发时应在仓库 extension/ 下）' });
    openFolder(dir);
    res.json({ ok: true, dir });
  });

  /** 打包成 zip：装不上「加载已解压」的环境（或想拷到另一台机器）直接下载解压 */
  app.get(
    '/api/extension/download',
    asyncRoute(async (_req, res) => {
      const dir = findExtensionDir();
      if (!dir) return res.status(404).json({ error: '没找到扩展目录' });
      const manifest = readManifest(dir);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="gemvault-extension.zip"; filename*=UTF-8''${encodeURIComponent(
          `图库采集助手_${manifest?.version || '1.0.0'}.zip`
        )}`
      );
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        if (!res.headersSent) res.status(500).end(err.message);
        else res.destroy(err);
      });
      archive.pipe(res);
      archive.directory(dir, false);
      await archive.finalize();
    })
  );
}
