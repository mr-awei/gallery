// 数据出口：备份 / 恢复 / 元数据导出 / Eagle 迁移
import {
  backupLibrary,
  backupPreview,
  exportMetadataCsv,
  exportMetadataJson,
  importEagleLibrary,
  restoreLibrary,
} from '../lib/transfer.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/transfer/preview', (_req, res) => {
    try {
      res.json(backupPreview());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* 备份到指定文件夹（桌面端由主进程选目录后把路径传进来） */
  app.post(
    '/api/transfer/backup',
    asyncRoute(async (req, res) => {
      const r = backupLibrary({
        targetDir: req.body?.targetDir,
        includeThumbs: req.body?.includeThumbs !== false,
      });
      res.json(r);
    })
  );

  /* 元数据清单：JSON / CSV（不依赖软件也能打开，是最基础的「数据出口」） */
  app.get('/api/transfer/metadata.json', (req, res) => {
    const data = exportMetadataJson();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="gemvault-library.json"; filename*=UTF-8''${encodeURIComponent('图库元数据.json')}`);
    res.send(JSON.stringify(data, null, 2));
  });

  app.get('/api/transfer/metadata.csv', (req, res) => {
    const csv = exportMetadataCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="gemvault-images.csv"; filename*=UTF-8''${encodeURIComponent('图库素材清单.csv')}`);
    res.send(csv);
  });

  /* 从备份恢复成一个新库（不动当前库） */
  app.post(
    '/api/transfer/restore',
    asyncRoute(async (req, res) => {
      const r = restoreLibrary({
        sourceDir: req.body?.sourceDir,
        name: req.body?.name,
        rootPath: req.body?.rootPath,
      });
      res.json(r);
    })
  );

  /* 从 Eagle .library 迁移 */
  app.post(
    '/api/transfer/import-eagle',
    asyncRoute(async (req, res) => {
      const r = await importEagleLibrary({
        srcDir: req.body?.srcDir,
        name: req.body?.name,
        rootPath: req.body?.rootPath,
        limit: req.body?.limit,
      });
      res.json(r);
    })
  );
}
