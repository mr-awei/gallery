// @ts-check
// 素材检查类接口：EXIF、PDF 页数、版本历史、多区域裁切
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as lib from '../library.js';
import { parseExif } from '../lib/exif.js';
import { listVersions, restoreVersion, versionFile } from '../lib/versions.js';
import { cropImage } from '../lib/edit.js';
import { assertWritableDir } from '../lib/safe-path.js';

/** 数 PDF 页数：不引入 pdfjs，直接看 PDF 结构里的 /Type /Page 对象与 /Count。
 *  对象流（ObjStm）压缩过的 PDF 数不准，这时返回 pages=0 让前端只给页码跳转、不显示总数。 */
export function countPdfPages(absPath) {
  let pages = 0;
  let declared = 0;
  /** 句柄必须在 finally 里关：fstatSync/readSync 任一抛错时，
   *  以前会跳过 closeSync，Windows 上这个 PDF 就一直被占用（删不掉、改不了名），
   *  而外层 catch 又把错误吞掉，用户完全看不到原因。 */
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const size = fs.fstatSync(fd).size;
    const headLen = Math.min(size, 6 * 1024 * 1024);
    const buf = Buffer.alloc(headLen);
    fs.readSync(fd, buf, 0, headLen, 0);
    let tail = Buffer.alloc(0);
    if (size > headLen) {
      const tailLen = Math.min(size - headLen, 2 * 1024 * 1024);
      tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    }
    const text = buf.toString('latin1') + '\n' + tail.toString('latin1');
    pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    // 交叉引用表里的 /Count 常等于页数；有 ObjStm 时至少能给出这个估计值
    const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    declared = counts.length ? Math.max(...counts) : 0;
  } catch {
    /* 读不出来就当未知 */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 句柄已失效：忽略，保留原始结果 */
      }
    }
  }
  const n = pages || declared;
  return { pages: Number.isFinite(n) && n > 0 && n < 20000 ? n : 0, exact: pages > 0 };
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /* EXIF + 基础元信息（检查器用） */
  app.get(
    '/api/images/:id/exif',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '图片不存在' });
      const out = { ok: true, width: row.width, height: row.height, format: '', exif: {} };
      try {
        const meta = await sharp(row.abs_path, { failOn: 'none' }).metadata();
        out.format = meta.format || '';
        out.space = meta.space || '';
        out.density = meta.density || 0;
        out.hasAlpha = Boolean(meta.hasAlpha);
        out.pages = meta.pages || 1;
        out.exif = parseExif(meta.exif);
      } catch (err) {
        out.error = '读不出元信息';
      }
      res.json(out);
    })
  );

  /* PDF 页数（查看器显示总页数 / 页码跳转） */
  app.get(
    '/api/images/:id/pdf-info',
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '图片不存在' });
      if (path.extname(row.abs_path).toLowerCase() !== '.pdf') {
        return res.status(400).json({ error: '不是 PDF 文件' });
      }
      const info = countPdfPages(row.abs_path);
      res.json({ ok: true, ...info, size: row.size_bytes });
    })
  );

  /* 版本历史列表（当前版本 + 所有历史备份） */
  app.get('/api/images/:id/versions', (req, res) => {
    try {
      res.json({ ok: true, ...listVersions(Number(req.params.id)) });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  /* 某个版本的图片本体（历史预览） */
  app.get('/api/images/:id/versions/:vid/preview', (req, res) => {
    const v = versionFile(req.params.id, req.params.vid);
    if (!v) return res.status(404).json({ error: '版本文件不存在' });
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 版本备份同样可能在点目录下（如 .tuku/versions）
    res.sendFile(path.resolve(v.file), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.post(
    '/api/images/:id/versions/:vid/restore',
    asyncRoute(async (req, res) => {
      const r = await restoreVersion(req.params.id, req.params.vid);
      res.json(r);
    })
  );

  /* 一图多区域裁切：对同一张图保存多个框，逐框另存副本（原图不动）。
   * regions: [{x,y,w,h}] 归一化坐标；每个框一个输出文件，可一并入库。 */
  app.post(
    '/api/images/:id/crop-regions',
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const regions = (Array.isArray(req.body?.regions) ? req.body.regions : [])
        .map((r) => ({
          x: Math.min(1, Math.max(0, Number(r.x) || 0)),
          y: Math.min(1, Math.max(0, Number(r.y) || 0)),
          w: Math.min(1, Math.max(0.01, Number(r.w) || 0)),
          h: Math.min(1, Math.max(0.01, Number(r.h) || 0)),
        }))
        .filter((r) => r.w > 0.01 && r.h > 0.01)
        .slice(0, 24);
      if (!regions.length) return res.status(400).json({ error: '至少需要一个裁切框' });
      const targetDir = assertWritableDir(req.body?.targetDir, '保存位置');
      if (!targetDir) return res.status(400).json({ error: '请先选择保存位置' });
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const addToLibrary = Boolean(req.body?.addToLibrary);
      const out = [];
      for (const rect of regions) {
        try {
          const r = await cropImage(id, { ratio: 'free', rect, saveMode: 'copy', targetDir, addToLibrary });
          out.push({ ok: true, rect, ...r });
        } catch (err) {
          out.push({ ok: false, rect, error: err.message });
        }
      }
      res.json({ ok: out.some((r) => r.ok), count: out.length, results: out });
    })
  );
}
