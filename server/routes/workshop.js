/**
 * 创意工坊（本地）：主题包 .tuku-pack 的导出 / 导入 / 收集。
 * 不做在线社区：导出的就是一个普通 JSON 文件，随便用网盘/聊天工具发给别人。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { getSettings, saveSettings } from '../db.js';
import {
  buildThemePack,
  parseThemePack,
  settingsPatchOf,
} from '../lib/theme-pack.js';

const WORKSHOP_DIR = path.join(DATA_DIR, 'workshop');
const PACK_EXT = '.tuku-pack';

function safeId(raw) {
  const id = String(raw || '').replace(/[^\w.-]/g, '').slice(0, 60);
  return id && !id.includes('..') ? id : null;
}

function packFile(id) {
  return path.join(WORKSHOP_DIR, `${id}${PACK_EXT}`);
}

async function ensureDir() {
  await fsp.mkdir(WORKSHOP_DIR, { recursive: true });
}

/** 列表只回元数据，不把内嵌图片的 base64 拉出来 */
function brief(pack, file) {
  return {
    id: pack.id,
    name: pack.name,
    author: pack.author,
    createdAt: pack.createdAt,
    base: pack.theme?.base,
    varCount: Object.keys(pack.theme?.variables || {}).length,
    settingKeys: Object.keys(pack.settings || {}),
    assetNames: (pack.assets || []).map((a) => a.name),
    file,
  };
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get(
    '/api/workshop/packs',
    asyncRoute(async (_req, res) => {
      await ensureDir();
      const items = [];
      for (const name of await fsp.readdir(WORKSHOP_DIR)) {
        if (!name.endsWith(PACK_EXT)) continue;
        try {
          const pack = JSON.parse(await fsp.readFile(path.join(WORKSHOP_DIR, name), 'utf8'));
          items.push(brief(pack, name));
        } catch (err) {
          console.warn(`[workshop] 跳过损坏的包 ${name}：${err?.message || err}`);
        }
      }
      items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.json({ ok: true, items, dir: WORKSHOP_DIR });
    })
  );

  /** 导出：主题变量由前端传（服务端拿不到运行时 CSS），壁纸设置从当前设置里挑白名单子集 */
  app.post(
    '/api/workshop/export',
    asyncRoute(async (req, res) => {
      const body = req.body || {};
      const built = buildThemePack({
        id: body.id,
        name: body.name,
        author: body.author,
        theme: body.theme || { base: 'light', variables: {} },
        settings: body.includeSettings === false ? {} : getSettings(),
        assets: body.assets || [],
      });
      await ensureDir();
      const file = packFile(built.pack.id);
      await fsp.writeFile(file, JSON.stringify(built.pack, null, 2), 'utf8');
      res.json({ ok: true, pack: built.pack, file, skipped: built.skipped });
    })
  );

  /** 导入：校验 → 落到工坊目录 → 图片还原到磁盘 → 壁纸设置写回（只写白名单键） */
  app.post(
    '/api/workshop/import',
    asyncRoute(async (req, res) => {
      const parsed = parseThemePack(req.body?.data ?? req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const pack = parsed.pack;
      await ensureDir();
      const file = packFile(pack.id);
      await fsp.writeFile(file, JSON.stringify(pack, null, 2), 'utf8');

      const assetPaths = [];
      if (pack.assets.length) {
        const dir = path.join(WORKSHOP_DIR, 'assets', pack.id);
        await fsp.mkdir(dir, { recursive: true });
        for (const a of pack.assets) {
          const b64 = String(a.dataUrl).split(',')[1] || '';
          const target = path.join(dir, a.name);
          await fsp.writeFile(target, Buffer.from(b64, 'base64'));
          assetPaths.push(target);
        }
      }
      const patch = settingsPatchOf(pack);
      if (Object.keys(patch).length) saveSettings(patch);
      res.json({
        ok: true,
        pack: brief(pack, path.basename(file)),
        theme: pack.theme,
        file,
        assetPaths,
        appliedSettings: Object.keys(patch),
        skipped: parsed.skipped,
      });
    })
  );

  /** 重新应用已收集的包：从本地文件读，不改包内容 */
  app.post(
    '/api/workshop/apply',
    asyncRoute(async (req, res) => {
      const id = safeId(req.body?.id);
      const file = id && packFile(id);
      if (!file || !fs.existsSync(file)) return res.status(404).json({ error: '主题包不存在' });
      const parsed = parseThemePack(await fsp.readFile(file, 'utf8'));
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const patch = settingsPatchOf(parsed.pack);
      if (Object.keys(patch).length) saveSettings(patch);
      res.json({
        ok: true,
        theme: parsed.pack.theme,
        appliedSettings: Object.keys(patch),
        skipped: parsed.skipped,
      });
    })
  );

  /** 下载已收集的包（分享给别人） */
  app.get(
    '/api/workshop/packs/:id/file',
    asyncRoute(async (req, res) => {
      const id = safeId(req.params.id);
      const file = id && packFile(id);
      if (!file || !fs.existsSync(file)) return res.status(404).json({ error: '主题包不存在' });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${id}${PACK_EXT}"`);
      res.send(await fsp.readFile(file, 'utf8'));
    })
  );

  app.delete(
    '/api/workshop/packs/:id',
    asyncRoute(async (req, res) => {
      const id = safeId(req.params.id);
      const file = id && packFile(id);
      if (!file || !fs.existsSync(file)) return res.status(404).json({ error: '主题包不存在' });
      await fsp.unlink(file);
      res.json({ ok: true });
    })
  );
}
