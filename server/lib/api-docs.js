// @ts-check
/**
 * API 参考：直接从 Express 已注册的路由表生成，而不是另写一份文档。
 *
 * 之前的问题：只有 /api/v1 的 11 个接口有 OpenAPI，其余 380+ 个内部接口
 * （图片列表、整理、AI、维护、扩展……）没有任何清单，写脚本 / 接扩展的人只能
 * 去 grep 源码。手写文档必然和代码漂移，所以这里改为「运行时自省」：
 * 路由注册完，向 app.router.stack 要一遍，分组、鉴权口径都在本文件里定。
 */

/** 分组规则：按前缀从长到短匹配，第一条命中为准 */
export const GROUPS = [
  {
    key: 'v1',
    label: '开放 API（v1）',
    prefixes: ['/api/v1'],
    note: '给脚本 / 插件 / 外部程序的稳定接口，需要 Bearer 令牌与对应 scope（见 /api/v1/openapi.json）',
  },
  {
    key: 'images',
    label: '图片与检索',
    prefixes: ['/api/images', '/api/search', '/api/similar', '/api/dupes', '/api/stacks', '/api/thumbs'],
    note: '列表分页、单张详情、相似 / 重复查找、堆叠与缩略图',
  },
  {
    key: 'library',
    label: '资源库与导入',
    prefixes: [
      '/api/library',
      '/api/libraries',
      '/api/import',
      '/api/sources',
      '/api/crawl',
      '/api/events',
      '/api/system',
      '/api/health',
      '/api/hardware',
      '/api/platform',
      '/api/live',
      '/api/settings',
    ],
    note: '多资源库切换、扫描导入、采集、SSE 事件流与系统能力',
  },
  {
    key: 'organize',
    label: '整理与分类',
    prefixes: [
      '/api/folders',
      '/api/tags',
      '/api/keywords',
      '/api/smart-folders',
      '/api/saved-filters',
      '/api/organize',
      '/api/bookmarks',
      '/api/playlists',
      '/api/kb',
      '/api/collections',
    ],
    note: '文件夹、标签、关键词、智能文件夹、筛选、清单与知识库',
  },
  {
    key: 'edit',
    label: '编辑与标注',
    prefixes: [
      '/api/edit',
      '/api/annotations',
      '/api/comments',
      '/api/notes',
      '/api/watermark',
      '/api/undo',
      '/api/ops',
      '/api/enhance',
      '/api/ocr',
    ],
    note: '非破坏编辑、标注、批注、水印、增强、撤销栈',
  },
  {
    key: 'ai',
    label: 'AI 与识别',
    prefixes: ['/api/ai', '/api/face', '/api/models', '/api/clip', '/api/reverse'],
    note: '模型管理、向量索引、人脸与人物、以图搜图、本地推理任务',
  },
  {
    key: 'wallpaper',
    label: '壁纸',
    prefixes: ['/api/wallpaper', '/api/pref', '/api/privacy', '/live'],
    note: '壁纸盘点评分、桌面设置、隐私相关的本地开关',
  },
  {
    key: 'data',
    label: '数据与维护',
    prefixes: [
      '/api/export',
      '/api/transfer',
      '/api/maintenance',
      '/api/network',
      '/api/tidy',
      '/api/jobs',
      '/api/trash',
      '/api/stats',
      '/api/docs',
    ],
    note: '导出、备份还原、一致性对账、回收站、后台任务与统计',
  },
  {
    key: 'ext',
    label: '扩展与集成',
    prefixes: [
      '/api/extension',
      '/api/plugins',
      '/api/workshop',
      '/api/lan',
      '/api/sync',
      '/api/actions',
      '/api/timeline',
      '/api/geo',
      '/api/download',
      '/api/usage',
    ],
    note: '浏览器扩展、插件、局域网共享、同步、右键动作、时间线',
  },
  { key: 'other', label: '其它', prefixes: [], note: '' },
];

/**
 * 从 Express 应用上取出所有已注册的 (方法, 路径)。
 *
 * Express 5 把 Router 挂在 app.router 上（4.x 是 app._router），两处都试一遍；
 * 只认有 route 的层 —— 中间件（app.use）不是接口，列进来只会变成噪音。
 *
 * @param {any} app
 */
export function collectRoutes(app) {
  const stack = app?.router?.stack || app?._router?.stack || [];
  /** @type {{ method: string, path: string, group: string, label: string, auth: string }[]} */
  const out = [];
  const seen = new Set();
  for (const layer of stack) {
    const route = layer?.route;
    // `/` 是前端静态首页，不是接口；列进来只会占一行噪音
    if (!route || !route.path || route.path === '/') continue;
    const methods = Object.keys(route.methods || {}).filter((m) => route.methods[m] && m !== '_all');
    for (const method of methods) {
      const upper = method.toUpperCase();
      const key = `${upper} ${route.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groupOf(String(route.path));
      out.push({
        method: upper,
        path: String(route.path),
        group: group.key,
        label: group.label,
        auth: authOf(String(route.path)),
      });
    }
  }
  out.sort((a, b) => (a.group === b.group ? a.path.localeCompare(b.path) || a.method.localeCompare(b.method) : GROUPS.findIndex((g) => g.key === a.group) - GROUPS.findIndex((g) => g.key === b.group)));
  return out;
}

/** 路径归到哪个分组（前缀最长匹配） */
export function groupOf(path) {
  let best = GROUPS[GROUPS.length - 1];
  let bestLen = -1;
  for (const g of GROUPS) {
    for (const p of g.prefixes) {
      // 前缀后必须是路径分隔符或扩展名：/api/docs 要能认下 /api/docs.md，
      // 但不能把 /api/docsx 也吞进去
      if ((path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}.`)) && p.length > bestLen) {
        best = g;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/**
 * 鉴权口径（不猜具体 scope，只说明「要带什么」）：
 * - /api/v1：Bearer 令牌 + scope
 * - /api/lan：局域网分享令牌（?token= 只允许 GET）
 * - 其余 /api/*：本机令牌（桌面端由前端自动带上，脚本从 .api-token 读）
 */
export function authOf(path) {
  if (path.startsWith('/api/v1')) return 'Bearer 令牌 + scope';
  if (path.startsWith('/api/lan')) return '局域网令牌';
  if (path.startsWith('/api/')) return '本机令牌';
  return '无';
}

/**
 * 把路由里的参数占位换成能直接跑的值。
 * `/api/images/:id/thumb` → `/api/images/1/thumb`，`*` 换成示例相对路径。
 */
export function samplePath(path) {
  return String(path)
    .replace(/:([A-Za-z0-9_]+)/g, (_m, name) => {
      const n = String(name).toLowerCase();
      if (n === 'name' || n === 'tag' || n === 'key' || n === 'q') return 'demo';
      if (n === 'token') return '<lan-token>';
      if (n === 'file' || n === 'filename' || n === 'path') return 'demo.jpg';
      return '1';
    })
    .replace(/\*/g, 'demo.jpg');
}

/** 写操作给一个可解析的空对象，并提醒字段要按接口填 */
const BODY_HINT = '{"": "按这个接口的实际字段填"}';

/**
 * 生成三条可直接复制的调用示例（curl / JavaScript / Python）。
 * 之前在设置里只能复制 curl，写脚本的人还得自己翻译成 fetch 或 requests；
 * 示例一律用「占位符 + 真实路径」，不猜业务字段（猜错比没有更误导）。
 *
 * @param {{ method: string, path: string, auth: string }} route
 * @param {string} [baseUrl]
 * @returns {{ path: string, curl: string, js: string, py: string }}
 */
export function examplesOf(route, baseUrl = 'http://127.0.0.1:3001') {
  const url = `${baseUrl}${samplePath(route.path)}`;
  const isWrite = route.method !== 'GET' && route.method !== 'HEAD';
  const needAuth = route.auth !== '无';
  const authLine = route.auth === '局域网令牌' ? 'Bearer <lan-token>' : 'Bearer <token>';

  const curl = [
    `curl -X ${route.method} "${url}"`,
    ...(needAuth ? [`-H "Authorization: ${authLine}"`] : []),
    ...(isWrite ? [`-H "Content-Type: application/json"`, `-d '${BODY_HINT}'`] : []),
  ].join(' \\\n  ');

  const js = [
    `const token = process.env.TUKU_TOKEN; // 数据目录下 .api-token`,
    `const res = await fetch('${url}', {`,
    `  method: '${route.method}',`,
    ...(needAuth ? [`  headers: { Authorization: \`Bearer \${token}\`${isWrite ? ', \'Content-Type\': \'application/json\'' : ''} },`] : []),
    ...(isWrite ? [`  body: JSON.stringify(${BODY_HINT}),`] : []),
    `});`,
    `console.log(res.status, await res.json());`,
  ].join('\n');

  const py = [
    `import os, requests`,
    ``,
    `token = os.environ.get("TUKU_TOKEN", "")`,
    `res = requests.${route.method.toLowerCase()}(`,
    `    "${url}",`,
    ...(needAuth ? [`    headers={"Authorization": f"Bearer {token}"},`] : []),
    ...(isWrite ? [`    json=${BODY_HINT},`] : []),
    `    timeout=30,`,
    `)`,
    `print(res.status_code, res.text[:200])`,
  ].join('\n');

  return { path: samplePath(route.path), curl, js, py };
}

/**
 * 每组挑三条「有代表性」的接口给完整示例：一条列表 GET、一条带路径参数的 GET、
 * 一条写操作。405 条全给示例会让文档变成上万行噪音，人根本不会看。
 *
 * @param {{ method: string, path: string, auth: string }[]} list
 * @param {string} [baseUrl]
 */
function groupExamples(list, baseUrl) {
  const pickGet = list.find((r) => r.method === 'GET' && !r.path.includes(':') && !r.path.includes('*'));
  const pickParam = list.find((r) => r.method === 'GET' && (r.path.includes(':') || r.path.includes('*')));
  const pickWrite = list.find((r) => r.method !== 'GET');
  const chosen = [pickGet, pickParam, pickWrite].filter(Boolean);
  if (!chosen.length) return [];
  const out = ['### 调用示例', ''];
  for (const r of chosen) {
    const ex = examplesOf(r, baseUrl);
    out.push(`**${r.method} ${r.path}**`, '');
    out.push('```bash');
    out.push(ex.curl);
    out.push('```', '');
  }
  out.push(
    '> 令牌在数据目录的 `.api-token` 里（桌面版由界面自动带上，脚本里自己读一次塞进 `Authorization`）。',
    '> 路径里的 `:id` 这类参数在示例中已换成 `1`，实际请求时替换成真实 id；请求体字段请对照该接口的实现或界面上的操作。',
    ''
  );
  return out;
}

/**
 * 生成 Markdown 版参考。给「想存一份 / 贴进 issue / 离线看」的人，
 * 内容与 /api/docs 同源，不会出现「文档说有、接口已经删了」。
 *
 * @param {{ method: string, path: string, group: string, label: string, auth: string }[]} routes
 * @param {{ version?: string, baseUrl?: string }} [meta]
 */
export function renderMarkdown(routes, meta = {}) {
  const lines = [];
  lines.push('# 图库 HTTP API 参考');
  lines.push('');
  lines.push('> 本文档由服务端根据**实际注册的路由**生成，不是手写的，因此不会与代码漂移。');
  if (meta.version) lines.push(`> 版本：${meta.version}`);
  if (meta.baseUrl) lines.push(`> 本机地址：${meta.baseUrl}`);
  lines.push(`> 接口总数：${routes.length}`);
  lines.push('');
  lines.push('## 鉴权');
  lines.push('');
  lines.push('- 本机接口（`/api/*`）：请求头 `Authorization: Bearer <token>`，令牌见数据目录下的 `.api-token`。');
  lines.push('');
  lines.push('```bash');
  lines.push('# 首次调用前把令牌读进环境变量（bash / zsh；PowerShell 用 $env:TUKU_TOKEN = Get-Content .api-token）');
  lines.push('export TUKU_TOKEN=$(cat .api-token)');
  lines.push('curl -H "Authorization: Bearer $TUKU_TOKEN" http://127.0.0.1:3001/api/health');
  lines.push('```');
  lines.push('');
  lines.push('- 局域网接口（`/api/lan/*`）：分享链接里的局域网令牌，`?token=` 只允许 `GET`。');
  lines.push('- 开放 API（`/api/v1/*`）：Bearer 令牌 + scope，完整 schema 见 `GET /api/v1/openapi.json`。');
  lines.push('');
  lines.push('## 通用约定');
  lines.push('');
  lines.push('- 响应均为 JSON；失败时形如 `{ "error": "人能看懂的说明" }`，HTTP 状态码有意义。');
  lines.push('- 分页参数：`?offset=&limit=`（部分接口为 `?page=`），返回里带 `total`。');
  lines.push('- 路径参数用 `:name` 表示，实际请求换成具体 id。');
  lines.push('');
  for (const g of GROUPS) {
    const list = routes.filter((r) => r.group === g.key);
    if (!list.length) continue;
    lines.push(`## ${g.label}（${list.length}）`);
    lines.push('');
    if (g.note) {
      lines.push(`_${g.note}_`);
      lines.push('');
    }
    lines.push('| 方法 | 路径 | 鉴权 |');
    lines.push('| --- | --- | --- |');
    for (const r of list) lines.push(`| ${r.method} | \`${r.path}\` | ${r.auth} |`);
    lines.push('');
    lines.push(...groupExamples(list, meta.baseUrl));
    lines.push('');
  }
  return lines.join('\n');
}
