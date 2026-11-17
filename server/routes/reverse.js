// @ts-check
// 全网以图搜图：引擎清单、国际网络体检、多引擎并发检索
import * as lib from '../library.js';
import { bestPhotoForPerson } from '../face.js';
import { checkGlobalNetwork, decorateEngines, searchAll } from '../lib/reverse-engines.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* 引擎清单 + 国际网络体检（前端据此提示「国外引擎这次用不了」） */
  app.get(
    '/api/reverse/engines',
    asyncRoute(async (req, res) => {
      const network = await checkGlobalNetwork({ force: String(req.query.refresh || '') === '1' });
      res.json({ ok: true, engines: decorateEngines(network), network });
    })
  );

  /* 执行搜图：imageId 或 personId（人物取「最清晰最完整」的那张） */
  app.post(
    '/api/reverse/search',
    asyncRoute(async (req, res) => {
      const imageId = Number(req.body?.imageId || 0);
      const personId = Number(req.body?.personId || 0);
      const engines = Array.isArray(req.body?.engines) ? req.body.engines.map(String) : [];

      /** @type {any} */
      let row = null;
      let picked = null;
      if (personId) {
        picked = bestPhotoForPerson(personId);
        if (!picked) return res.status(404).json({ error: '这个人还没有可用的人脸照片' });
        row = lib.getImage(picked.imageId);
      } else if (imageId) {
        row = lib.getImage(imageId);
      }
      if (!row) return res.status(404).json({ error: '图片不存在' });
      if (!engines.length) return res.status(400).json({ error: '至少要选一个搜图引擎' });

      // 采集来的图带着原始网页地址时，Lens / TinEye 可以直接按地址搜，不用上传也不用剪贴板
      const r = await searchAll(row.abs_path, engines, { sourceUrl: row.source_url || '' });
      res.json({
        ok: true,
        image: { id: Number(row.id), title: row.title || '', width: Number(row.width) || 0, height: Number(row.height) || 0 },
        personId: personId || null,
        picked: picked ? { faceId: picked.faceId, imageId: picked.imageId, quality: picked.quality, facePx: picked.facePx } : null,
        bytes: r.bytes,
        results: r.results,
      });
    })
  );
}
