// @ts-check
/**
 * 人脸识别接口：模型安装 / 全库扫描 / 人物列表与编辑 / 人脸裁切图。
 *
 * 目录式设计（/api/face/*）而不是散进 tidy：人脸是一套独立的数据与任务，
 * 混进「整理」会让原本只处理相似图的接口长出第二套语义。
 */
import * as face from '../face.js';
import * as lib from '../library.js';
import { db } from '../db.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/face/status', (_req, res) => res.json(face.faceStatus()));

  app.post('/api/face/install', (_req, res) => res.json(face.startFaceInstall()));
  app.post('/api/face/install/cancel', (_req, res) => res.json({ ok: face.cancelFaceInstall() }));

  app.post(
    '/api/face/scan',
    asyncRoute(async (req, res) => {
      const out = face.startFaceScan({
        limit: Number(req.body?.limit) || 0,
        force: req.body?.force === true || req.body?.force === 'true',
        minCos: Number(req.body?.minCos) || 0,
      });
      if (!out.ok) return res.status(400).json({ error: out.message });
      res.json(out);
    })
  );
  app.post('/api/face/scan/cancel', (_req, res) => res.json({ ok: face.cancelFaceScan() }));

  app.get('/api/face/persons', (req, res) => {
    const minCount = Math.max(1, Number(req.query.minCount) || 1);
    const q = String(req.query.q || '');
    // 默认只给「封面够清晰」的人物：只有糊脸的人物多是误检，别占满第一屏；
    // all=1 时不筛，用户能看全
    const sharpOnly = req.query.all !== '1';
    // total 让前端知道「列表被 limit 截断了」，否则第 501 个人物静默消失且界面毫无提示；
    // q 让下拉框能在上千人物里按名字/编号查，而不是只给前 100 个
    const total = face.countPersons({ minCount, q, sharpOnly });
    res.json({
      persons: face.listPersons({
        limit: Number(req.query.limit) || 200,
        offset: Number(req.query.offset) || 0,
        minCount,
        q,
        sharpOnly,
      }),
      total,
      allTotal: sharpOnly ? face.countPersons({ minCount, q }) : total,
    });
  });

  // 单个人物：灯箱里点「人物 #123」跳人物页时，先拿到这个人本身
  app.get('/api/face/persons/:id', (req, res) => {
    const person = face.getPerson(Number(req.params.id));
    if (!person) return res.status(404).json({ error: '人物不存在' });
    res.json(person);
  });

  // 存量质量重算 + 重选封面（老数据没有质量分、封面是「第一张脸」时代选的）
  app.post(
    '/api/face/quality/cleanup',
    asyncRoute(async (_req, res) => {
      res.json(face.startQualityCleanup());
    })
  );
  app.post('/api/face/quality/cancel', (_req, res) => res.json({ ok: face.cancelQualityCleanup() }));

  // 只用库里已有的特征重新聚类：清掉「一堆后脑勺凑成一个人」这类历史误分，不解码图片
  app.post(
    '/api/face/rebuild',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true, started: true, ...face.faceStatus() });
      face.startPersonRebuild().catch((err) => console.warn('[face] 重建人物失败：', err?.message || err));
    })
  );
  app.post('/api/face/rebuild/cancel', (_req, res) => res.json({ ok: face.cancelPersonRebuild() }));

  // 必须排在 /api/face/persons/:id 之前，否则 merge 会被当成 id
  app.post(
    '/api/face/persons/merge',
    asyncRoute(async (req, res) => {
      const fromId = Number(req.body?.fromId);
      const toId = Number(req.body?.toId);
      if (!fromId || !toId) return res.status(400).json({ error: '需要 fromId 与 toId' });
      res.json(face.mergePersons(fromId, toId));
    })
  );

  app.patch(
    '/api/face/persons/:id',
    asyncRoute(async (req, res) => {
      res.json(face.renamePerson(Number(req.params.id), req.body?.name));
    })
  );

  // 手动指定封面：自动挑的封面再准也有「用户就是想要那张」的需求，
  // 没有这个入口时只能删人重建，代价太大
  app.post(
    '/api/face/persons/:id/cover',
    asyncRoute(async (req, res) => {
      const imageId = Number(req.body?.imageId);
      if (!imageId) return res.status(400).json({ error: '需要 imageId' });
      res.json(face.setPersonCover(Number(req.params.id), imageId));
    })
  );

  // 某个人的图，直接给列表 DTO：前端点开就能进灯箱，不必再按 id 二次查询
  app.get(
    '/api/face/persons/:id/items',
    asyncRoute(async (req, res) => {
      const personId = Number(req.params.id);
      const rows = face.personImages(personId, {
        limit: Number(req.query.limit) || 500,
        offset: Number(req.query.offset) || 0,
      });
      // 与 personImages 的过滤条件保持一致，否则「只显示了 40 / 60」里那 20 张永远加载不出来
      const total =
        Number(
          db.prepare('SELECT COUNT(DISTINCT image_id) AS c FROM faces WHERE person_id = ? AND hidden <> 1').get(personId)?.c
        ) || 0;
      const ids = rows.map((r) => r.imageId);
      if (!ids.length) return res.json({ items: [], total });
      // 保持「按人脸分数排序」的顺序，SQL 的 IN 不保证顺序，所以用 Map 回填
      const marks = ids.map(() => '?').join(',');
      const map = new Map(db.prepare(`SELECT * FROM images WHERE id IN (${marks})`).all(...ids).map((r) => [Number(r.id), r]));
      res.json({ items: ids.map((id) => map.get(id)).filter(Boolean).map((row) => lib.toDTO(row)), total });
    })
  );

  app.delete(
    '/api/face/persons/:id',
    asyncRoute(async (req, res) => {
      res.json(face.deletePerson(Number(req.params.id)));
    })
  );

  // 灯箱侧栏：这张图里有谁
  app.get(
    '/api/images/:id/faces',
    asyncRoute(async (req, res) => {
      res.json({ faces: face.facesOfImage(Number(req.params.id)) });
    })
  );

  // 人脸裁切图：尺寸小、内容不变，可以长缓存
  app.get(
    '/api/face/crop/:faceId',
    asyncRoute(async (req, res) => {
      const buf = await face.faceCrop(Number(req.params.faceId), Number(req.query.size) || 192);
      res.set('Cache-Control', 'private, max-age=604800');
      res.type('image/jpeg').send(buf);
    })
  );

  app.post(
    '/api/face/faces/:id/person',
    asyncRoute(async (req, res) => {
      const personId = req.body?.personId == null ? null : Number(req.body.personId);
      res.json(face.reassignFace(Number(req.params.id), personId));
    })
  );

  // 手动保留 / 排除一张低质量脸（不删记录，可反悔）
  app.post(
    '/api/face/faces/:id/hidden',
    asyncRoute(async (req, res) => {
      res.json(face.setFaceHidden(Number(req.params.id), req.body?.hidden === true || req.body?.hidden === 'true'));
    })
  );

  app.delete(
    '/api/face/faces/:id',
    asyncRoute(async (req, res) => {
      res.json(face.deleteFace(Number(req.params.id)));
    })
  );

  app.post(
    '/api/face/reset',
    asyncRoute(async (_req, res) => {
      res.json(face.resetFaces());
    })
  );
}
