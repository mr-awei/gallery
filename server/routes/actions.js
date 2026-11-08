// 动作（Actions）路由
import * as lib from '../library.js';
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
      const r = await runAction(req.params.id, ids);
      res.json(r);
    })
  );

  /* 试运行：只回每一步要做什么，方便前端确认（不写库） */
  app.get('/api/actions/:id/preview', (req, res) => {
    const act = listActions().find((a) => a.id === Number(req.params.id));
    if (!act) return res.status(404).json({ error: '动作不存在' });
    res.json({
      ok: true,
      action: act,
      steps: act.steps.map((s) => ({ type: s.type, label: STEP_TYPES[s.type]?.label || s.type, config: s })),
    });
  });

  /* 选区信息（动作面板显示「将对 N 张执行」） */
  app.post('/api/actions/count', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const exist = ids.map((n) => lib.getImage(Number(n))).filter(Boolean).length;
    res.json({ ok: true, count: exist });
  });
}
