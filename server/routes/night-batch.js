// @ts-check
/**
 * AI 夜间批处理接口。
 *
 * GET  /api/night-batch        配置 + 时段判断 + 待办数量 + 当前进度
 * POST /api/night-batch        保存配置（enabled / start / end / tasks）
 * POST /api/night-batch/run    立即跑一轮（不受时段限制，用户显式点的）
 * POST /api/night-batch/stop   停止：当前这一张收尾后不再开始下一项
 */
import { nightBatchStatus, runNightBatch, saveNightBatchConfig, stopNightBatch } from '../lib/night-batch.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/night-batch', (_req, res) => {
    res.json(nightBatchStatus());
  });

  app.post('/api/night-batch', (req, res) => {
    saveNightBatchConfig(req.body || {});
    res.json(nightBatchStatus());
  });

  app.post(
    '/api/night-batch/run',
    asyncRoute(async (_req, res) => {
      const r = await runNightBatch({ reason: 'manual' });
      if (!r.ok) return res.status(400).json({ error: r.message || r.error || '启动失败' });
      res.json({ ...r, status: nightBatchStatus() });
    })
  );

  app.post('/api/night-batch/stop', (_req, res) => {
    res.json({ ...stopNightBatch(), status: nightBatchStatus() });
  });
}
