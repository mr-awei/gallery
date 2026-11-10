// @ts-check
// 下载中心路由：统一列出 / 下载 / 取消 / 删除 / 校验所有模型（从各模块状态聚合，不重复实现下载）
import { installModel, cancelModel, removeModel, verifyModel, listModels } from '../lib/model-registry.js';
import { logOp } from '../oplog.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/models', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...listModels() });
  });

  app.post(
    '/api/models/:id/install',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id || '');
      const r = await installModel(id);
      if (r.ok) logOp({ op: 'model-install', summary: id });
      res.status(r.ok ? 200 : 400).json(r);
    })
  );

  app.post(
    '/api/models/:id/cancel',
    asyncRoute(async (req, res) => {
      const r = cancelModel(String(req.params.id || ''));
      res.status(r.ok ? 200 : 400).json(r);
    })
  );

  app.delete(
    '/api/models/:id',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id || '');
      try {
        const r = await removeModel(id);
        if (r.ok) logOp({ op: 'model-remove', summary: id });
        res.status(r.ok ? 200 : 400).json(r);
      } catch (err) {
        // 文件被占用是 Windows 上最常见的失败：如实回原因，别只说「删除失败」
        res.status(500).json({ ok: false, error: String(err?.message || err) });
      }
    })
  );

  app.post(
    '/api/models/:id/verify',
    asyncRoute(async (req, res) => {
      const r = await verifyModel(String(req.params.id || ''));
      res.status(r.ok ? 200 : 400).json(r);
    })
  );
}
