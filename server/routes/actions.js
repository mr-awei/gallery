// @ts-check
// 动作（Actions）路由
import { db } from '../db.js';
import { deleteAction, listActions, runAction, saveAction, STEP_TYPES } from '../lib/actions.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/actions', (_req, res) => {
    res.json({ ok: true, types: STEP_TYPES, actions: listActions() });
  });

  app.post('/api/actions', (req, res) => {
    try {
      res.json(saveAction(req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/actions/:id', (req, res) => {
    try {
      res.json(saveAction({ ...(req.body || {}), id: Number(req.params.id) }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/actions/:id', (req, res) => {
    res.json(deleteAction(req.params.id));
  });

  app.post(
    '/api/actions/:id/run',
    asyncRoute(async (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const dryRun = req.body?.dryRun === true || req.body?.dryRun === 'true';
      const r = await runAction(req.params.id, ids, { dryRun });
      res.json(r);
    })
  );

  /* 试运行：只回每一步要做什么，方便前端确认（不写库） */
  /* 注：动作步骤清单已由 GET /api/actions 一并返回（steps 里带 type/label），
     单独的 preview 接口与它完全重复，已移除，避免「后端有、前端没接」的幽灵接口。 */

  /* 选区信息（动作面板显示「将对 N 张执行」） */
  app.post('/api/actions/count', (req, res) => {
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    let exist = 0;
    // 全选可能有几万个 id：逐条 getImage 会同步阻塞服务，按 500 个一批 COUNT 即可
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      exist += Number(
        db.prepare(`SELECT COUNT(*) AS c FROM images WHERE id IN (${chunk.map(() => '?').join(',')})`).get(...chunk)?.c || 0
      );
    }
    res.json({ ok: true, count: exist });
  });
}
