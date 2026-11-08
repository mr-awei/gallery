/**
 * 插件 / 脚本宿主路由：清单发现、试运行、打开用户插件目录。
 * 执行放在独立子进程里（见 lib/plugin-host.js），这里只做参数校验与结果转发。
 */
import { openFolder } from '../desktop.js';
import { PLUGIN_PERMISSIONS } from '../lib/plugin-manifest.js';
import { ensureUserPluginDir, findPlugin, listPlugins, runPlugin } from '../lib/plugin-host.js';

const publicView = (p) => ({
  id: p.id,
  name: p.name,
  version: p.version,
  description: p.description,
  permissions: p.permissions,
  actions: p.actions,
  builtin: p.builtin,
});

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/plugins', (_req, res) => {
    res.json({ ok: true, plugins: listPlugins().map(publicView), permissions: PLUGIN_PERMISSIONS });
  });

  app.get('/api/plugins/:id', (req, res) => {
    const p = findPlugin(String(req.params.id));
    if (!p) return res.status(404).json({ error: '插件不存在' });
    res.json({ ok: true, plugin: publicView(p) });
  });

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
