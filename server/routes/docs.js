// @ts-check
// API 参考：/api/docs 返回结构化路由清单，/api/docs.md 返回可直接存盘的 Markdown
import { GROUPS, collectRoutes, renderMarkdown } from '../lib/api-docs.js';

export function register(app) {
  /**
   * 路由清单（界面「设置 → API 参考」用它渲染）。
   * 每次请求现算：路由是静态注册的，成本只是遍历一遍 stack，
   * 但换来「接口改了清单自动跟着变」，不会像手写文档一样过期。
   */
  app.get('/api/docs', (req, res) => {
    const all = collectRoutes(app);
    const q = String(req.query.q || '').trim().toLowerCase();
    const group = String(req.query.group || '').trim();
    const routes = all.filter(
      (r) => (!group || r.group === group) && (!q || r.path.toLowerCase().includes(q) || r.method.toLowerCase().includes(q))
    );
    res.json({
      ok: true,
      total: all.length,
      groups: GROUPS.map((g) => ({
        key: g.key,
        label: g.label,
        note: g.note || '',
        count: all.filter((r) => r.group === g.key).length,
      })).filter((g) => g.count > 0),
      routes,
    });
  });

  /** Markdown 全文：给「存一份 / 贴进 issue / 离线看」的人，内容与 /api/docs 同源 */
  app.get('/api/docs.md', (req, res) => {
    const host = String(req.headers.host || '127.0.0.1:3001');
    const md = renderMarkdown(collectRoutes(app), { baseUrl: `http://${host}` });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tuku-api.md"');
    res.send(md);
  });
}
