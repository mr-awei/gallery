#!/usr/bin/env node
/**
 * 图库 · MCP Server（stdio 传输）
 * ------------------------------------------------------------
 * 把壁纸 / 图库操作暴露成 MCP 工具，让任意 MCP 客户端（Claude Desktop、
 * CodeBuddy、Cursor 等）直接驱动本机图库，例如：
 *   - "换张演唱会的 live 图"        → set_wallpaper_by_query
 *   - "切到有山的壁纸"             → set_wallpaper_by_query
 *   - "看看当前壁纸"              → current_wallpaper
 *   - "把收藏里评分高的导出来"     → 组合 list_favorites + ...
 *
 * 运行：node server/mcp-server.mjs   （默认连接 http://127.0.0.1:3001）
 * 端口可用环境变量 TUKU_MCP_PORT / TUKU_MCP_BASE 覆盖。
 *
 * 协议：JSON-RPC 2.0 over stdio，**每条消息一行 JSON**（MCP stdio 传输规范）。
 * 注意：这里是 MCP，不是 LSP —— 不存在 Content-Length 帧，用 LSP 的帧格式解析会一条都读不出来。
 * 设计为零依赖，仅用 Node 内置 fetch。
 */
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.TUKU_MCP_BASE || `http://127.0.0.1:${process.env.TUKU_MCP_PORT || 3001}`).replace(
  /\/+$/,
  ''
);

/**
 * 本地 API 已开启鉴权（见 server/auth.js）。令牌解析顺序：
 * 环境变量 TUKU_API_TOKEN → 应用用户数据目录/.api-token（打包桌面版）→ 项目根/.api-token（开发模式）。
 */
function resolveApiToken() {
  if (process.env.TUKU_API_TOKEN) return process.env.TUKU_API_TOKEN;
  const candidates = [];
  if (process.env.TUKU_USER_DATA) candidates.push(path.join(process.env.TUKU_USER_DATA, '.api-token'));
  const home = os.homedir();
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '图库', '.api-token'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', '图库', '.api-token'));
  } else {
    candidates.push(path.join(home, '.config', '图库', '.api-token'));
  }
  candidates.push(fileURLToPath(new URL('../.api-token', import.meta.url)));
  for (const f of candidates) {
    try {
      const t = fs.readFileSync(f, 'utf8').trim();
      if (t) return t;
    } catch {
      /* 尝试下一个位置 */
    }
  }
  return '';
}
const API_TOKEN = resolveApiToken();

/* ------------------------------- MCP 帧读写 ------------------------------- */
// MCP stdio：一条消息 = 一行 JSON，以 \n 分隔（同 JSON Lines）。
// 旧实现照搬 LSP 的 Content-Length 头，而客户端发来的正文里没有这个头，
// parseMessages 一个包都解不出来 → 对所有 MCP 客户端都没有响应。

/** 只允许写协议消息到 stdout，避免别处的 console.log 污染管道 */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inBuf += chunk;
  let idx;
  while ((idx = inBuf.indexOf('\n')) !== -1) {
    const line = inBuf.slice(0, idx).replace(/\r$/, '').trim();
    inBuf = inBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 非法行直接跳过，不影响后续消息
    }
    // handle 是异步的：单个请求出错不能拖垮整个 stdio 循环
    handle(msg).catch((e) => process.stderr.write(`[tuku-mcp] handle error: ${e?.stack || e}\n`));
  }
});
process.stdin.on('end', () => process.exit(0));

/* ------------------------------- 工具实现 ------------------------------- */

async function api(path, method = 'GET', body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const TOOLS = [
  {
    name: 'search_images',
    description:
      '用自然语言在图库里搜图（AI 语义搜索：会理解"演唱会""有山""红色礼服"等含义并匹配）。返回命中图片的 id 与标题。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言描述，如 "演唱会舞台" "有山景的写真" "红色礼服" "微笑近照"' },
        limit: { type: 'number', description: '返回数量上限，默认 12' },
      },
      required: ['query'],
    },
    async run({ query, limit = 12 }) {
      const r = await api('/api/search/ai', 'POST', { query, limit });
      return r.items.map((i) => ({ id: i.id, title: i.title, width: i.width, height: i.height }));
    },
  },
  {
    name: 'set_wallpaper',
    description: '把指定图片设为桌面壁纸（竖图会自动合成完整居中、不裁切）。',
    inputSchema: {
      type: 'object',
      properties: { imageId: { type: 'number', description: '图片 id（可从 search_images 获得）' } },
      required: ['imageId'],
    },
    async run({ imageId }) {
      const r = await api(`/api/images/${imageId}/wallpaper`, 'POST', {});
      return { ok: true, imageId, screen: r.screen, fit: r.fit };
    },
  },
  {
    name: 'set_wallpaper_by_query',
    description:
      '按自然语言描述搜图并把最匹配的一张设为桌面壁纸。例如"换张演唱会的 live 图""切到有山的壁纸""来张红色礼服的"。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想要的壁纸描述' },
        favoriteOnly: { type: 'boolean', description: '是否只在收藏里挑，默认 false' },
      },
      required: ['query'],
    },
    async run({ query, favoriteOnly = false }) {
      const r = await api('/api/search/ai', 'POST', { query, limit: 12 });
      if (!r.items.length) return { ok: false, reason: '没有匹配的图片' };
      const pick = favoriteOnly ? r.items.find((i) => i.favorite) || r.items[0] : r.items[0];
      const w = await api(`/api/images/${pick.id}/wallpaper`, 'POST', {});
      return { ok: true, imageId: pick.id, title: pick.title, screen: w.screen, fit: w.fit };
    },
  },
  {
    name: 'next_wallpaper',
    description: '立刻换下一张壁纸（按当前自动切换设置的范围/分数随机挑选）。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const r = await api('/api/wallpaper/now', 'POST', {});
      return { ok: true, imageId: r.imageId, title: r.title };
    },
  },
  {
    name: 'current_wallpaper',
    description: '查询当前桌面壁纸是哪张图。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      return await api('/api/wallpaper/current');
    },
  },
  {
    name: 'favorite_current',
    description: '把当前壁纸加入收藏（喜欢）。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      return await api('/api/wallpaper/current/favorite', 'POST', {});
    },
  },
  {
    name: 'dislike_current',
    description: '不喜欢当前壁纸：排除它并立刻换一张。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      return await api('/api/wallpaper/current/dislike', 'POST', {});
    },
  },
  {
    name: 'list_favorites',
    description: '列出收藏的图片（可限定数量）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '数量上限，默认 30' } },
    },
    async run({ limit = 30 } = {}) {
      const r = await api(`/api/images?favorite=yes&sort=rating&pageSize=${limit}`);
      return r.items.map((i) => ({ id: i.id, title: i.title, rating: i.rating, width: i.width, height: i.height }));
    },
  },
  {
    name: 'list_smart_folders',
    description: '列出所有智能文件夹（按条件自动归类的虚拟文件夹）。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      return await api('/api/smart-folders');
    },
  },
  {
    name: 'apply_smart_folder',
    description: '把某个智能文件夹的"自动标签"同步到它命中的所有图片（文件夹标签继承）。',
    inputSchema: {
      type: 'object',
      properties: { folderId: { type: 'number', description: '智能文件夹 id（见 list_smart_folders）' } },
      required: ['folderId'],
    },
    async run({ folderId }) {
      return await api(`/api/smart-folders/${folderId}/apply-tags`, 'POST', {});
    },
  },
  {
    name: 'get_library_stats',
    description: '查询图库统计：总图片数、收藏数、按来源/分辨率分布等。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      return await api('/api/stats');
    },
  },
];

/* ------------------------------- JSON-RPC 处理 ------------------------------- */

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method } = msg;

  // 通知类：无需响应
  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tuku-gallery', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) {
      send({ jsonrpc: '2.0', id, result: textResult(`未知工具：${msg.params?.name}`, true) });
      return;
    }
    try {
      const out = await tool.run(msg.params?.arguments || {});
      send({ jsonrpc: '2.0', id, result: textResult(out) });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: textResult(`调用失败：${err.message}`, true) });
    }
    return;
  }

  // 其它方法：返回 method not found
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// 防止崩溃导致宿主异常
process.on('uncaughtException', (e) => {
  process.stderr.write(`[tuku-mcp] uncaught: ${e?.stack || e}\n`);
});
