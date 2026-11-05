import fs from 'node:fs';
import sharp from 'sharp';
import { db, getSettings } from './db.js';
import { httpFetch } from './http.js';

/** 内置厂家预设（全部为 OpenAI 兼容接口） */
export const AI_PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    visionModels: [],
    docs: 'https://platform.deepseek.com/api_keys',
    keyHint: 'platform.deepseek.com → API Keys，sk- 开头',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    visionModels: ['gpt-4o-mini', 'gpt-4o'],
    docs: 'https://platform.openai.com/api-keys',
    keyHint: 'platform.openai.com/api-keys，sk- 开头',
  },
  qwen: {
    label: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    visionModels: ['qwen-vl-max-latest', 'qwen-vl-plus-latest'],
    docs: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    keyHint: '阿里云百炼控制台 → API-KEY，sk- 开头；需先开通对应模型服务',
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4.5-air', 'glm-4.6'],
    visionModels: ['glm-4v-flash', 'glm-4v-plus'],
    docs: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyHint: 'open.bigmodel.cn → 用户中心 → API Keys，形如 xxxxx.yyyyy（id.secret 两段都要复制完整）',
  },
  ollama: {
    label: 'Ollama（本地离线）',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5:7b', 'llama3.2'],
    visionModels: ['qwen2.5vl:7b', 'llava'],
    docs: 'https://ollama.com/',
    keyHint: '本地部署无需真实密钥，随便填一个字符（如 ollama）即可',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    visionModels: [],
    docs: '',
    keyHint: '按你的接口方要求填写',
  },
};

function aiConfig() {
  const raw = getSettings().ai || {};
  // 粘贴密钥时常见的首尾空格/换行会导致 401
  return {
    ...raw,
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(raw.apiKey || '').trim(),
    model: String(raw.model || '').trim(),
    visionModel: String(raw.visionModel || '').trim(),
  };
}

/** 把接口的报错翻译成人话 */
function friendlyError(status, body) {
  let remote;
  try {
    const json = JSON.parse(body);
    remote = json?.error?.message || json?.message || json?.msg || '';
  } catch {
    remote = String(body || '').slice(0, 160);
  }
  const tail = remote ? `：${remote}` : '';
  switch (status) {
    case 401:
      return `401 认证失败${tail} —— 通常是 API Key 填错、已过期、或被粘贴进了多余空格/引号`;
    case 403:
      return `403 无权限${tail} —— 该 Key 可能没有此模型的权限，或账户未实名/未开通`;
    case 404:
      return `404 接口不存在${tail} —— Base URL 可能填错（一般应以 /v1 或 /v4 结尾，不带 /chat/completions）`;
    case 429:
      return `429 限流或余额不足${tail}`;
    default:
      return `HTTP ${status}${tail}`;
  }
}

export function aiStatus() {
  const a = aiConfig();
  return {
    enabled: !!a.enabled,
    provider: a.provider || 'custom',
    baseUrl: a.baseUrl || '',
    model: a.model || '',
    visionModel: a.visionModel || '',
    hasKey: !!a.apiKey,
    ready: !!a.enabled && !!a.baseUrl && !!a.apiKey && !!a.model,
  };
}

function assertReady() {
  const st = aiStatus();
  if (!st.ready) throw new Error('AI 未配置：请先在设置页填写 Base URL、API Key 与模型名称');
  return st;
}

function endpoint(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
}

async function request(url, body, timeout = 60000) {
  const a = aiConfig();
  const res = await httpFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${a.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }, { allowPrivate: true }); // 本地 Ollama / 局域网推理服务是正常用法
  const text = await res.text();
  if (!res.ok) throw new Error(friendlyError(res.status, text));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`AI 返回非 JSON：${text.slice(0, 200)}`);
  }
}

export async function chat(messages, options = {}) {
  assertReady();
  const a = aiConfig();
  const data = await request(
    endpoint(a.baseUrl, '/chat/completions'),
    {
      model: options.model || a.model,
      messages,
      temperature: options.temperature ?? 0.3,
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
    },
    options.timeout || 60000
  );
  return data?.choices?.[0]?.message?.content || '';
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json/gi, '```').trim();
  const fence = cleaned.match(/```([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : cleaned;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON');
  return JSON.parse(body.slice(start, end + 1));
}

export async function chatJson(messages, options = {}) {
  const raw = await chat(messages, { ...options, json: true });
  try {
    return extractJson(raw);
  } catch {
    const retry = await chat(messages, { ...options, json: false });
    return extractJson(retry);
  }
}

/** 拉取可用模型列表 */
export async function listModels() {
  const a = aiConfig();
  if (!a.baseUrl) throw new Error('请先填写 Base URL');
  const url = endpoint(a.baseUrl, '/models');
  const res = await httpFetch(
    url,
    {
      headers: a.apiKey ? { Authorization: `Bearer ${a.apiKey}` } : {},
      signal: AbortSignal.timeout(20000),
    },
    { allowPrivate: true }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`拉取模型失败 · ${friendlyError(res.status, text)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('拉取模型失败：接口返回不是 JSON（该厂家可能不开放 /models 接口，可直接手填模型名并点「测试连接」）');
  }
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return list.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
}

export async function testConnection() {
  const st = assertReady();
  let models = [];
  try {
    models = await listModels();
  } catch {
    /* 部分接口不开放 /models */
  }
  const content = await chat([{ role: 'user', content: '回复两个字：正常' }], { timeout: 30000 });
  return { ok: true, model: st.model, models, reply: String(content).slice(0, 60) };
}

/** 把图片压缩后转 base64 data url（控制 token 消耗） */
async function toDataUrl(imagePath, maxSize = 768) {
  const buf = await sharp(imagePath, { failOn: 'none' })
    .rotate()
    .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const VISION_SCHEMA = `输出严格 JSON（不要输出其他内容）：
{
  "subject": "画面主体（人物/多人/非人物/动物/风景/其他）",
  "scene": "场景简述（演出/写真/活动/街拍/日常/风景/其他）",
  "description": "60 字以内的客观描述",
  "issues": ["作为壁纸可能让人不满意的点，如：模糊、噪点多、分辨率低、有水印或平台 Logo、构图歪、截取不全、色调暗沉、主体不符预期、重复画面"],
  "quality": 0-100 的整数综合画质分
}`;

/**
 * 画面主体的身份信息：标签 + 采集关键词（关键词每次采集必有，是最可靠的身份来源）。
 * 放在 JSON 格式之前，让模型先知道「这是谁」，再要求它按此描述。
 */
function buildIdentityNote(row) {
  const tags = String(row.tags || '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kw = String(row.keyword || '').replace(/[·\s]+/g, ' ').trim();
  if (!tags.length && !kw) return '';
  const parts = [];
  if (kw) parts.push(`采集关键词「${kw}」`);
  if (tags.length) parts.push(`已有标签「${tags.join('、')}」`);
  return [
    `这张图片的${parts.join('和')}。`,
    '其中的文字（人名、主题）就是画面主体的可信身份，必须遵守：',
    '1. description 与 subject 必须直接用这个名字称呼主体，例如关键词是「某人 演唱会」时写「某人在演唱会舞台上演唱」。',
    '2. 严禁无视已知身份，输出「一位女性」「一名歌手」这类模糊称呼。',
    '3. 除关键词/标签中已给出的人名外，不得编造其他人名；服装、场景等细节仍按画面客观描述。',
    '',
    '',
  ].join('\n');
}

/**
 * 通用视觉问答：给一张图 + 自定义提示（要求返回 JSON），返回解析后的对象。
 * 供壁纸适配度、构图评估等上层能力复用，避免每个功能各写一遍视觉调用。
 */
export async function visionJson(imageId, instruction, schemaHint, options = {}) {
  assertReady();
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(imageId);
  if (!row) throw new Error('图片不存在');
  const file = row.thumb && fs.existsSync(row.thumb) ? row.thumb : row.abs_path;
  if (!fs.existsSync(file)) throw new Error('图片文件不存在');
  const a = aiConfig();
  const model = options.model || a.visionModel || a.model;
  const dataUrl = await toDataUrl(file);
  const prompt = [instruction, '', buildIdentityNote(row), schemaHint].filter(Boolean).join('\n');
  return await chatJson(
    [
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ],
    { model, timeout: options.timeout || 60000 }
  );
}

/** AI 看图：生成描述与可能的不满意点，缓存到 ai_desc */
export async function analyzeImage(imageId) {
  assertReady();
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(imageId);
  if (!row) throw new Error('图片不存在');
  const file = row.thumb && fs.existsSync(row.thumb) ? row.thumb : row.abs_path;
  if (!fs.existsSync(file)) throw new Error('图片文件不存在');
  const a = aiConfig();
  const model = a.visionModel || a.model;
  const dataUrl = await toDataUrl(file);
  // 身份信息（关键词/标签）放最前，JSON 格式要求放最后——先知道「这是谁」再谈输出格式
  const prompt = ['你是一个图片库的审核助手。请观察这张图片。', '', buildIdentityNote(row), VISION_SCHEMA]
    .filter(Boolean)
    .join('\n');

  const result = await chatJson(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    { model, timeout: 90000 }
  );

  const description = [result.subject, result.scene, result.description].filter(Boolean).join(' · ');
  const issues = Array.isArray(result.issues) ? result.issues : [];
  const quality = Number(result.quality) || 0;

  db.prepare(
    `INSERT INTO ai_desc(image_id, description, issues, quality, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET
       description = excluded.description, issues = excluded.issues,
       quality = excluded.quality, model = excluded.model, created_at = excluded.created_at`
  ).run(imageId, description, issues.join(','), quality, model, new Date().toISOString());

  return { imageId, description, issues, quality, model };
}

export function getAiDesc(imageId) {
  const row = db.prepare('SELECT * FROM ai_desc WHERE image_id = ?').get(imageId);
  if (!row) return null;
  return {
    imageId: row.image_id,
    description: row.description,
    issues: row.issues ? row.issues.split(',').filter(Boolean) : [],
    quality: row.quality,
    model: row.model,
  };
}
