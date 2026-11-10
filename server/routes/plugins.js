// @ts-check
/**
 * 插件 / 脚本宿主路由：清单发现、试运行、插件市场、在线安装与卸载。
 * 执行放在独立子进程里（见 lib/plugin-host.js），这里只做参数校验与结果转发。
 */
import express from 'express';
import { openFolder } from '../desktop.js';
import { PLUGIN_PERMISSIONS } from '../lib/plugin-manifest.js';
import {
  ensureUserPluginDir,
  listPlugins,
  runPlugin,
  setPluginEnabled,
} from '../lib/plugin-host.js';
import {
  downloadPluginPackage,
  installPluginPackage,
  loadBuiltinMarket,
  marketView,
  parsePluginPackage,
  readBuiltinPackage,
  setRemoteMarketIndex,
  uninstallPlugin,
  validateMarketIndex,
} from '../lib/plugin-market.js';

const publicView = (p) => ({
  id: p.id,
  name: p.name,
  version: p.version,
  description: p.description,
  permissions: p.permissions,
  actions: p.actions,
  builtin: p.builtin,
  enabled: p.enabled !== false,
});

/** 安装失败一律给明确原因，不静默吞掉 */
function fail(res, err, status = 400) {
  return res.status(status).json({ error: String(err?.message || err).slice(0, 300) });
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/plugins', (_req, res) => {
    res.json({ ok: true, plugins: listPlugins().map(publicView), permissions: PLUGIN_PERMISSIONS });
  });

  /** 启用 / 停用：不解包、不卸载，只记库级开关；停用后执行直接拒绝 */
  app.patch('/api/plugins/:id', (req, res) => {
    try {
      const enabled = req.body?.enabled !== false;
      const r = setPluginEnabled(req.params.id, enabled);
      res.json({ ok: true, ...r });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/plugins/market', (_req, res) => {
    try {
      res.json({ ok: true, ...marketView(), permissions: PLUGIN_PERMISSIONS });
    } catch (err) {
      fail(res, err);
    }
  });

  // 自定义索引地址：下载后逐条校验，只存内存，重启回到随包索引
  app.post(
    '/api/plugins/market/refresh',
    asyncRoute(async (req, res) => {
      try {
        const url = String(req.body?.url || '').trim().slice(0, 500);
        if (!url) return fail(res, new Error('请填写市场索引地址'));
        const { buf } = await downloadPluginPackage(url);
        const index = validateMarketIndex(JSON.parse(buf.toString('utf8')));
        setRemoteMarketIndex(index);
        res.json({ ok: true, ...marketView(), permissions: PLUGIN_PERMISSIONS });
      } catch (err) {
        return fail(res, err);
      }
    })
  );

  app.post('/api/plugins/market/reset', (_req, res) => {
    setRemoteMarketIndex(null);
    res.json({ ok: true, ...marketView() });
  });

  /** 按 id 或 url 取包 → 校验 → 安装 */
  const installFrom = async (buf, filename) => {
    const parsed = await parsePluginPackage(buf, filename);
    return installPluginPackage(parsed);
  };

  app.post(
    '/api/plugins/install',
    asyncRoute(async (req, res) => {
      try {
        const body = req.body || {};
        const url = String(body.url || '').trim().slice(0, 500);
        const id = String(body.id || '').trim().slice(0, 60);
        if (url) {
          const { buf, filename } = await downloadPluginPackage(url);
          return res.json(await installFrom(buf, filename));
        }
        if (!id) return fail(res, new Error('请提供插件 id 或插件包地址'));
        const item = marketView().plugins.find((p) => p.id === id) || loadBuiltinMarket().plugins.find((p) => p.id === id);
        if (!item) return fail(res, new Error(`市场里没有这个插件：${id}`));
        if (item.package) return res.json(await installFrom(readBuiltinPackage(item.package), item.package));
        if (item.downloadUrl) {
          const { buf, filename } = await downloadPluginPackage(item.downloadUrl);
          return res.json(await installFrom(buf, filename));
        }
        return fail(res, new Error(`市场条目 ${id} 没有可安装的包`));
      } catch (err) {
        return fail(res, err);
      }
    })
  );

  // 本地拖入 / 选择的插件包：二进制走 raw body，不经过 JSON 解析器
  app.post(
    '/api/plugins/install/upload',
    express.raw({ type: '*/*', limit: '1mb' }),
    asyncRoute(async (req, res) => {
      try {
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const filename = String(req.query?.filename || '').trim().slice(0, 200);
        if (!buf.length) return fail(res, new Error('插件包内容为空'));
        return res.json(await installFrom(buf, filename));
      } catch (err) {
        return fail(res, err);
      }
    })
  );

  app.delete(
    '/api/plugins/:id',
    asyncRoute(async (req, res) => {
      try {
        res.json(await uninstallPlugin(String(req.params.id)));
      } catch (err) {
        return fail(res, err);
      }
    })
  );

  // 没有单条查询接口：列表已返回全部字段，多一个「只读一条」既没人调用，
  // 又和列表的返回值必须永远保持一致，纯粹是维护负担。

  app.post(
    '/api/plugins/:id/run',
    asyncRoute(async (req, res) => {
      const body = req.body || {};
      const imageId = Number(body.imageId) || null;
      const r = await runPlugin({
        id: String(req.params.id),
        action: String(body.action || 'run'),
        imageId,
        args: body.args,
      });
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json({ ok: true, ...r });
    })
  );

  app.post(
    '/api/plugins/open-folder',
    asyncRoute(async (_req, res) => {
      const dir = await ensureUserPluginDir();
      await openFolder(dir);
      res.json({ ok: true, dir });
    })
  );
}
