/**
 * /api/v1 的 OpenAPI 3.0 文档。以 JS 对象随包发布（而不是 json 文件），
 * 避免打包时漏掉静态资源，也保证 /api/v1/openapi.json 与路由实现同处一仓。
 */
const json = (schema, description) => ({ description, content: { 'application/json': { schema } } });
const error = { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' } } };
const ok = { type: 'object', properties: { ok: { type: 'boolean' } } };
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: '素材 id',
  schema: { type: 'integer', minimum: 1 },
};
const bearer = [{ BearerAuth: [] }];

export const OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: '图库 TuKu 开放 API',
    version: '1.0.0',
    description:
      '本机图库服务的稳定只读/写入接口。所有请求必须带 Authorization: Bearer <token>；' +
      '令牌权限分 read / write / ingest 三级，权限不足返回 403。' +
      '额外令牌可在用户数据目录 api-tokens.json 配置，或用 TUKU_API_SCOPE_TOKENS 环境变量注入 JSON。' +
      '默认每分钟每令牌 120 次请求，超限返回 429。',
  },
  servers: [{ url: 'http://127.0.0.1:3001', description: '本机服务（桌面端端口由应用动态分配）' }],
  tags: [
    { name: 'meta', description: '元信息 / 鉴权自查' },
    { name: 'images', description: '素材读写' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          '主令牌（.api-token）拥有 read+write+ingest；api-tokens.json 中的令牌按声明的 scope 授权。' +
          '注意：/api/v1 不接受 ?token= 与浏览器同源豁免，写操作一律用请求头。',
      },
    },
    schemas: {
      Error: error,
      Image: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          mediaKind: { type: 'string', example: 'image' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string' } },
          url: { type: 'string' },
          thumbUrl: { type: 'string' },
        },
      },
    },
  },
  security: bearer,
  paths: {
    '/api/v1': {
      get: {
        tags: ['meta'],
        summary: '接口目录与版本',
        responses: { 200: json(ok, '版本与可用端点'), 401: json(error, '缺少令牌') },
      },
    },
    '/api/v1/openapi.json': {
      get: {
        tags: ['meta'],
        summary: '本文档',
        responses: { 200: { description: 'OpenAPI 3.0 JSON', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/api/v1/whoami': {
      get: {
        tags: ['meta'],
        summary: '当前令牌的权限',
        responses: { 200: json({ type: 'object', properties: { scopes: { type: 'array', items: { type: 'string' } } } }, 'scopes') },
      },
    },
    '/api/v1/status': {
      get: {
        tags: ['meta'],
        summary: '图库状态（总数 / 当前资源库）',
        responses: { 200: json(ok, '状态') },
      },
    },
    '/api/v1/audit': {
      get: {
        tags: ['meta'],
        summary: '最近调用审计（不含令牌明文）',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } }],
        responses: { 200: json({ type: 'array', items: { type: 'object' } }, '审计记录') },
      },
    },
    '/api/v1/images': {
      get: {
        tags: ['images'],
        summary: '分页列举素材',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, minimum: 1, maximum: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
        ],
        responses: {
          200: json(
            {
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Image' } },
                total: { type: 'integer' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
              },
            },
            '一页素材'
          ),
          403: json(error, '令牌没有 read 权限'),
        },
      },
    },
    '/api/v1/images/{id}': {
      get: {
        tags: ['images'],
        summary: '单个素材详情',
        parameters: [idParam],
        responses: { 200: json({ $ref: '#/components/schemas/Image' }, '素材'), 404: json(error, '不存在') },
      },
    },
    '/api/v1/images/{id}/file': {
      get: {
        tags: ['images'],
        summary: '下载素材原文件',
        parameters: [idParam],
        responses: { 200: { description: '原文件二进制流' }, 404: json(error, '文件不存在') },
      },
    },
    '/api/v1/images/{id}/tags': {
      post: {
        tags: ['images'],
        summary: '追加标签（需要 write）',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } } },
        },
        responses: { 200: json(ok, '已写入'), 403: json(error, '令牌没有 write 权限') },
      },
    },
    '/api/v1/search': {
      get: {
        tags: ['images'],
        summary: '按标题 / 标签 / 备注搜索',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: json(ok, '结果') },
      },
    },
    '/api/v1/ingest': {
      post: {
        tags: ['images'],
        summary: '投送一张图入库（需要 ingest）',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  dataUrl: { type: 'string', description: 'data:image/...;base64,...' },
                  url: { type: 'string', description: '要下载的 http(s) 图片地址' },
                  title: { type: 'string' },
                  tags: { type: 'string' },
                  keyword: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: json(ok, '入库结果'), 400: json(error, '参数不合法'), 403: json(error, '令牌没有 ingest 权限') },
      },
    },
  },
};
