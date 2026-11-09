// @ts-check
/**
 * 开放 API v1：给外部脚本 / 手机 / 第三方工具的一份稳定契约。
 *
 * 与内部 /api/* 的区别：
 *  - 只认 Authorization: Bearer（或 x-api-token），不吃浏览器同源豁免与写操作的 ?token=
 *  - 每条路由显式声明 scope，权限不足 403（不是 401，调用方能分清「没带令牌」和「权限不够」）
 *  - 内置固定窗口限流 + 审计记录
 * 内部接口继续随便演进，外部只依赖这一层 + openapi.json。
 */
import fs from 'node:fs';
import { db, getSettings } from '../db.js';
import * as lib from '../library.js';
import { getActiveLibrary } from '../libraries.js';
import { httpFetch } from '../http.js';
import { requireScope, v1Auth } from '../auth.js';
import { OPENAPI } from '../openapi.js';
import { auditList } from '../lib/api-audit.js';

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
};

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  // 整组统一鉴权：先于任何 v1 路由执行（app.js 的全局 apiAuth 仍在更前面做第一层拦截）
  app.use('/api/v1', v1Auth);

  app.get('/api/v1', requireScope('read'), (_req, res) => {
    res.json({
      ok: true,
      version: 1,
      name: 'TuKu Open API',
      endpoints: Object.keys(OPENAPI.paths),
      docs: '/api/v1/openapi.json',
      scopes: reqScopesHint(),
    });
  });

  app.get('/api/v1/openapi.json', requireScope('read'), (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(OPENAPI);
  });

  app.get('/api/v1/whoami', requireScope('read'), (req, res) => {
    res.json({ ok: true, scopes: req.apiScopes, kind: req.apiTokenKind });
  });

  app.get(
    '/api/v1/status',
    requireScope('read'),
    asyncRoute(async (_req, res) => {
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM images').get()?.n || 0);
      const active = getActiveLibrary() || {};
      res.json({
        ok: true,
        total,
        library: { id: active.id ?? null, name: active.name || '', path: active.root_path || '' },
        time: new Date().toISOString(),
      });
    })
  );

  app.get('/api/v1/audit', requireScope('read'), (req, res) => {
    res.json({ ok: true, items: auditList(clamp(req.query.limit, 1, 500, 50)) });
  });

  app.get(
    '/api/v1/images',
    requireScope('read'),
    asyncRoute(async (req, res) => {
      const limit = clamp(req.query.limit, 1, 100, 50);
      const offset = clamp(req.query.offset, 0, 10_000_000, 0);
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM images').get()?.n || 0);
      const rows = db.prepare('SELECT * FROM images ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
      res.json({ ok: true, total, limit, offset, items: rows.map(lib.toDTO) });
    })
  );

  app.get(
    '/api/v1/search',
    requireScope('read'),
    asyncRoute(async (req, res) => {
      const q = String(req.query.q || '').trim().slice(0, 120);
      if (!q) return res.status(400).json({ error: '缺少搜索词 q' });
      const like = `%${q}%`;
      const rows = db
        .prepare('SELECT * FROM images WHERE title LIKE ? OR tags LIKE ? OR note LIKE ? ORDER BY id DESC LIMIT 100')
        .all(like, like, like);
      res.json({ ok: true, total: rows.length, items: rows.map(lib.toDTO) });
    })
  );

  app.get(
    '/api/v1/images/:id',
    requireScope('read'),
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row) return res.status(404).json({ error: '素材不存在' });
      res.json({ ok: true, item: lib.toDTO(row) });
    })
  );

  app.get(
    '/api/v1/images/:id/file',
    requireScope('read'),
    asyncRoute(async (req, res) => {
      const row = lib.getImage(Number(req.params.id));
      if (!row || !fs.existsSync(row.abs_path)) return res.status(404).json({ error: '文件不存在' });
      // 库数据可能落在 .tuku 点目录下，Express send 默认当隐藏文件回 404
      res.sendFile(row.abs_path, { dotfiles: 'allow' });
    })
  );

  app.post(
    '/api/v1/images/:id/tags',
    requireScope('write'),
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const row = lib.getImage(id);
      if (!row) return res.status(404).json({ error: '素材不存在' });
      const incoming = Array.isArray(req.body?.tags) ? req.body.tags : String(req.body?.tags || '').split(/[,，\s]+/);
      const tags = incoming.map((t) => String(t).trim()).filter(Boolean).slice(0, 40);
      if (!tags.length) return res.status(400).json({ error: '没有标签内容' });
      const current = String(row.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      const next = [...new Set([...current, ...tags])].join(',');
      lib.setTags(id, next);
      res.json({ ok: true, id, tags: next.split(',') });
    })
  );

  app.post(
    '/api/v1/ingest',
    requireScope('ingest'),
    asyncRoute(async (req, res) => {
      const body = req.body || {};
      const title = String(body.title || '').trim().slice(0, 160);
      const tags = String(body.tags || '').slice(0, 200);
      const keyword = String(body.keyword || '开放 API').slice(0, 80);
      const settings = getSettings();
      let buffer;
      let sourceUrl = '';
      if (body.dataUrl) {
        const m = String(body.dataUrl).match(/^data:image\/[a-zA-Z+]+;base64,(.+)$/);
        if (!m) return res.status(400).json({ error: 'dataUrl 不是图片 data URL' });
        buffer = Buffer.from(m[1], 'base64');
      } else if (body.url && /^https?:\/\//i.test(String(body.url))) {
        sourceUrl = String(body.url).slice(0, 1000);
        const r = await httpFetch(sourceUrl, { timeout: 25000, retries: 1 });
        buffer = Buffer.from(await r.arrayBuffer());
      } else {
        return res.status(400).json({ error: '需要 dataUrl 或 http(s) url' });
      }
      if (!buffer.length || buffer.length > 50 * 1024 * 1024) return res.status(400).json({ error: '图片为空或超过 50MB' });
      const r = await lib.ingest(
        { buffer, title, source: 'api', keyword, tags, sourceUrl, copyToStorage: true, skipQuality: true },
        settings
      );
      if (!r.ok) return res.status(400).json({ error: `入库失败：${r.reason || '未知原因'}`, code: 'INGEST_REJECTED' });
      res.json({ ok: true, id: r.id, item: lib.toDTO(lib.getImage(r.id)) });
    })
  );
}

function reqScopesHint() {
  return { read: '只读', write: '读写（隐含 read + ingest）', ingest: '仅投送' };
}
