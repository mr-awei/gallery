// 画质增强路由：内置标准档位、AI 超分、Swin2SR、cugan、matting、线上服务测试（从 app.js 拆出）
import * as ai from '../ai.js';
import * as aiUpscale from '../ai-upscale.js';
import * as enhanceJob from '../enhance-job.js';
import * as lib from '../library.js';
import * as srDeep from '../sr-deep.js';
import { db, getSettings } from '../db.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;
let upscaleChecking = false;

  app.get(
    '/api/enhance/standards',
    (_req, res) => {
      res.json({
        standards: Object.entries(lib.ENHANCE_STANDARDS).map(([key, v]) => ({ key, label: v.label })),
        config: getSettings().enhance || {},
      });
    }
  );

  app.get(
    '/api/enhance/candidates',
    asyncRoute(async (req, res) => {
      const standard = String(req.query.standard || getSettings().enhance?.standard || '1080p');
      const items = lib.listBelowStandard(standard);
      // 尺寸会随增强变化，禁止任何缓存
      res.set('Cache-Control', 'no-store');
      // count 是真实总数（items 可能因上限被截断）
      res.json({ standard, count: lib.countBelowStandard(standard), items });
    })
  );

  app.get(
    '/api/enhance/models',
    (_req, res) => {
      const cfg = getSettings().enhance || {};
      const ai = aiUpscale.aiStatus();
      const aiUsable = ai.installed && ai.usable !== false;
      res.json({
        builtin: lib.ENHANCE_MODELS,
        remote: cfg.remoteServices || [],
        // 内置 Real-ESRGAN 模型 + 社区模型（未安装的会标注，可在设置页一键安装）
        ai: [
          ...ai.models.map((m) => ({ ...m, available: aiUsable })),
          ...ai.community.map((m) => ({ ...m, available: aiUsable && m.installed })),
          ...ai.cugan.models.map((name) => ({
            id: `cugan:${name}`,
            name,
            label: `Real-CUGAN · ${name}`,
            desc: '带降噪档位，适合噪点重的图（两级流程自动使用）',
            maxScale: 4,
            available: aiUsable && ai.cugan.installed,
          })),
          // 第二档：Transformer 系（高画质·慢），首次使用自动下载模型
          ...srDeep.srStatus().models.map((m) => ({
            id: m.id,
            name: m.repo,
            label: m.label,
            desc: `${m.desc}（高画质·慢${m.downloaded ? '' : '，首次使用需下载'}）`,
            maxScale: m.scale,
            available: true,
          })),
        ],
        aiInstalled: ai.installed,
        cugan: ai.cugan,
      });
    }
  );

  // AI 超分运行库状态 / 安装 / 自检
  app.get('/api/ai/upscale/status', (_req, res) => {
    const st = aiUpscale.aiStatus();
    // 已安装但还没自检过 → 后台补一次自检（记录显卡名与可用性）
    if (st.installed && st.usable === null && !upscaleChecking) {
      upscaleChecking = true;
      aiUpscale.selfTest().finally(() => {
        upscaleChecking = false;
      });
    }
    res.json(st);
  });

  // 安装社区模型（param + bin，各几 MB）
  app.post(
    '/api/ai/upscale/install-model',
    asyncRoute(async (req, res) => {
      const modelId = String(req.body?.id || '');
      if (!modelId) return res.status(400).json({ error: '缺少模型 id' });
      res.json({ ok: true, ...(await aiUpscale.installCommunityModel(modelId)) });
    })
  );

  // Transformer 超分（Swin2SR）状态与模型下载 / 预热
  app.get('/api/ai/sr/status', (_req, res) => res.json(srDeep.srStatus()));
  app.post(
    '/api/ai/sr/load',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, ...(await srDeep.loadSrModel(String(req.body?.id || ''))) });
    })
  );

  // 安装 Real-CUGAN 运行库（两级增强的降噪前置引擎）
  app.post(
    '/api/ai/upscale/install-cugan',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...(await aiUpscale.installCuganRuntime()) });
    })
  );

  app.post(
    '/api/ai/upscale/install',
    asyncRoute(async (_req, res) => {
      const st = aiUpscale.aiStatus();
      if (st.downloading) return res.json({ ok: true, ...st });
      // 后台安装，前端轮询状态
      aiUpscale.installRuntime().catch((err) => console.error('[ai] 安装失败', err.message));
      res.json({ ok: true, ...aiUpscale.aiStatus() });
    })
  );

  app.post(
    '/api/ai/upscale/selftest',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, ...(await aiUpscale.selfTest()) });
    })
  );

  // 线上服务连通性测试（用合成小图跑完整流程，不动真实图片）
  app.post(
    '/api/enhance/remote/test',
    asyncRoute(async (req, res) => {
      res.json(await lib.testRemoteService(req.body?.service || req.body || {}));
    })
  );

  // 增强后台任务（AI 单张耗时较长，批量异步 + 轮询）
  app.get('/api/enhance/job', (_req, res) => res.json(enhanceJob.jobStatus()));

  app.post(
    '/api/enhance/job/start',
    asyncRoute(async (req, res) => {
      const ids = (req.body?.ids || []).map(Number).filter(Boolean);
      const model = String(req.body?.model || getSettings().enhance?.model || 'sharp-standard');
      const standard = req.body?.standard;
      res.json({ ok: true, ...enhanceJob.startJob(ids, model, standard) });
    })
  );

  app.post('/api/enhance/job/cancel', (_req, res) => res.json({ ok: true, ...enhanceJob.cancelJob() }));

  app.post(
    '/api/enhance/:id',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const model = String(req.body?.model || '');
      try {
        const settings = getSettings().enhance || {};
        let item;
        if (model.startsWith('remote:')) {
          const svc = (settings.remoteServices || []).find((s) => `remote:${s.id}` === model);
          if (!svc) return res.status(400).json({ error: '指定的线上服务不存在' });
          item = await lib.enhanceImageRemote(id, svc);
        } else {
          item = await lib.enhanceImage(id, model || settings.model || 'sharp-standard', {
            standard: req.body?.standard,
          });
        }
        res.json({ ok: true, item });
      } catch (err) {
        res.status(500).json({ error: err.message || '增强失败' });
      }
    })
  );

  app.post(
    '/api/enhance/batch',
    asyncRoute(async (req, res) => {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      const model = String(req.body?.model || getSettings().enhance?.model || 'sharp-standard');
      const standard = req.body?.standard;
      const results = [];
      let success = 0;
      for (const id of ids) {
        try {
          const settings = getSettings().enhance || {};
          let item;
          if (model.startsWith('remote:')) {
            const svc = (settings.remoteServices || []).find((s) => `remote:${s.id}` === model);
            if (!svc) throw new Error('线上服务不存在');
            item = await lib.enhanceImageRemote(id, svc);
          } else {
            item = await lib.enhanceImage(id, model, { standard });
          }
          results.push({ id, ok: true, item });
          success++;
        } catch (err) {
          results.push({ id, ok: false, error: String((err && err.message) || err) });
        }
      }
      res.json({ ok: true, success, total: ids.length, results });
    })
  );

  app.post(
    '/api/images/batch',
    asyncRoute(async (req, res) => {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      const action = req.body.action;
      let affected = 0;
      for (const id of ids) {
        if (!lib.getImage(id)) continue;
        if (action === 'favorite') lib.setFavorite(id, true);
        else if (action === 'unfavorite') lib.setFavorite(id, false);
        else if (action === 'delete') await lib.removeImage(id);
        else if (action === 'addTag' && req.body.tag) {
          const row = lib.getImage(id);
          const tags = row.tags ? row.tags.split(',').filter(Boolean) : [];
          const tag = String(req.body.tag).trim();
          if (tag && !tags.includes(tag)) lib.setTags(id, [...tags, tag]);
        }
        affected++;
      }
      res.json({ ok: true, affected });
    })
  );
}
