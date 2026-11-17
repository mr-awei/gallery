import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { authOf, collectRoutes, groupOf, renderMarkdown } from '../server/lib/api-docs.js';

/**
 * API 参考是「从真实路由表自省」出来的，所以这里测的是三件事：
 * 1. 只列接口（中间件、静态首页不算）；
 * 2. 分组与鉴权口径对得上；
 * 3. Markdown 不漏接口 —— 一旦漏了，导出的文档就会骗人。
 */

function makeApp() {
  const app = express();
  app.get('/', (req, res) => res.end());
  app.use((req, res, next) => next());
  app.get('/api/images', (req, res) => res.end());
  app.post('/api/images/:id/tags', (req, res) => res.end());
  app.delete('/api/lan/token', (req, res) => res.end());
  app.get('/api/v1/images', (req, res) => res.end());
  app.get('/api/docs.md', (req, res) => res.end());
  app.get('/live', (req, res) => res.end());
  return app;
}

test('collectRoutes 只收真实路由，跳过中间件与前端首页', () => {
  const routes = collectRoutes(makeApp());
  const keys = routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(keys.includes('GET /api/images'), '普通 GET 要列出来');
  assert.ok(keys.includes('POST /api/images/:id/tags'), '带路径参数的 POST 要列出来');
  assert.ok(!keys.includes('GET /'), '静态首页不是接口');
  assert.equal(routes.filter((r) => r.path === '/api/images').length, 1, '同一路径不同方法各占一行');
});

test('分组按最长前缀命中，v1 / lan / live 不会被吞', () => {
  assert.equal(groupOf('/api/v1/images').key, 'v1');
  assert.equal(groupOf('/api/images').key, 'images');
  assert.equal(groupOf('/api/lan/token').key, 'ext');
  assert.equal(groupOf('/api/settings').key, 'library');
  assert.equal(groupOf('/api/docs.md').key, 'data', '.md 扩展名也要归到数据与维护');
  assert.equal(groupOf('/live').key, 'wallpaper');
  assert.equal(groupOf('/nope').key, 'other');
});

test('鉴权口径：v1 带 scope、lan 用局域网令牌、其余本机令牌', () => {
  assert.equal(authOf('/api/v1/images'), 'Bearer 令牌 + scope');
  assert.equal(authOf('/api/lan/token'), '局域网令牌');
  assert.equal(authOf('/api/images'), '本机令牌');
  assert.equal(authOf('/live'), '无');
});

test('Markdown 每个接口都出现一次，且带分组标题', () => {
  const routes = collectRoutes(makeApp());
  const md = renderMarkdown(routes, { baseUrl: 'http://127.0.0.1:3001' });
  for (const r of routes) {
    assert.equal(md.split(`\`${r.path}\``).length - 1 >= 1, true, `${r.path} 应出现在文档里`);
  }
  assert.match(md, /## 开放 API（v1）/);
  assert.match(md, /\| GET \| `\/api\/images` \| 本机令牌 \|/);
  assert.match(md, /接口总数：/);
});
