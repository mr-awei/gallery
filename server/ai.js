import fs from 'node:fs';
import sharp from 'sharp';
import { db, getSettings, saveSettings } from './db.js';
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
  // 模型套件：providers 里可以并存多家（省得换供应商就重填），activeId 指向当前生效的那家。
  // 顶层字段仍然保留，既兼容只填过一份配置的老用户，也让「激活」变成一次显式覆盖。
  const active = Array.isArray(raw.providers) ? raw.providers.find((p) => p && p.id === raw.activeId) : null;
  const merged = active ? { ...raw, ...active } : raw;
  // 粘贴密钥时常见的首尾空格/换行会导致 401
  return {
    ...merged,
    baseUrl: String(merged.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(merged.apiKey || '').trim(),
    model: String(merged.model || '').trim(),
    visionModel: String(merged.visionModel || '').trim(),
  };
}

/* ------------------------------- 模型套件 -------------------------------- */
/* 目标：多家供应商并存，按需切换；密钥只在本地库外共享配置里，接口只回掩码。 */

const PROVIDER_FIELDS = ['label', 'provider', 'baseUrl', 'apiKey', 'model', 'visionModel'];

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 8 ? '****' : `****${k.slice(-4)}`;
}

function publicProvider(p, activeId) {
  return {
    id: p.id,
    label: String(p.label || p.provider || p.id),
    provider: String(p.provider || 'custom'),
    baseUrl: String(p.baseUrl || ''),
    model: String(p.model || ''),
    visionModel: String(p.visionModel || ''),
    hasKey: !!p.apiKey,
    keyMask: maskKey(p.apiKey),
    active: p.id === activeId,
  };
}

export function listProviders() {
  const raw = getSettings().ai || {};
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  return {
    activeId: String(raw.activeId || ''),
    providers: providers.map((p) => publicProvider(p, raw.activeId)),
    // 顶层那份「未命名配置」也展示出来，否则老用户会以为配置丢了
    legacy: raw.baseUrl || raw.apiKey ? publicProvider({ id: '', ...pickLegacy(raw) }, raw.activeId) : null,
  };
}

function pickLegacy(raw) {
  const out = {};
  for (const f of PROVIDER_FIELDS) if (raw[f]) out[f] = raw[f];
  out.label = out.label || '当前配置';
  return out;
}

/**
 * 新增或更新一家供应商（id 相同即更新；不传 id 则新建）。
 * 只覆盖传进来的字段，避免「改个模型名把密钥清空」。
 */
export function upsertProvider(input = {}) {
  const raw = getSettings().ai || {};
  const list = Array.isArray(raw.providers) ? [...raw.providers] : [];
  const id = String(input.id || '').trim() || `p_${Date.now().toString(36)}`;
  const idx = list.findIndex((p) => p && p.id === id);
  const base = idx >= 0 ? list[idx] : { id };
  const next = { ...base, id };
  for (const f of PROVIDER_FIELDS) {
    if (input[f] !== undefined) next[f] = String(input[f] ?? '').trim();
  }
  if (!next.label) next.label = next.provider || id;
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  saveSettings({ ai: { providers: list } });
  return listProviders();
}

export function removeProvider(id) {
  const raw = getSettings().ai || {};
  const list = (Array.isArray(raw.providers) ? raw.providers : []).filter((p) => p && p.id !== String(id));
  const patch = { providers: list };
  // 删掉正在用的那家：清掉 activeId，回到顶层配置，避免 aiStatus 指向已删除的对象
  if (String(raw.activeId) === String(id)) patch.activeId = '';
  saveSettings({ ai: patch });
  return listProviders();
}

/** 激活某一家：把它的字段写到顶层，所有既有调用点（aiStatus / 打标 / 描述）无需改动 */
export function activateProvider(id) {
  const raw = getSettings().ai || {};
  const target = (Array.isArray(raw.providers) ? raw.providers : []).find((p) => p && p.id === String(id));
  if (!target) throw new Error(`供应商不存在：${id}`);
  const patch = { activeId: String(id) };
  for (const f of PROVIDER_FIELDS) if (target[f] !== undefined) patch[f] = target[f];
  saveSettings({ ai: patch });
  return aiStatus();
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
  "tags": ["3-5 个简短中文标签，客观描述主体/场景/色调，每个不超过 8 个字，不要人名、不要带逗号"],
  "issues": ["作为壁纸可能让人不满意的点，如：模糊、噪点多、分辨率低、有水印或平台 Logo、构图歪、截取不全、色调暗沉、主体不符预期、重复画面"],
  "quality": 0-100 的整数综合画质分
}`;

/**
 * AI 产出的标签要收口：模型可能给出一长串、带分隔符或重复的词，
 * 直接拼进 images.tags 会污染标签体系（还会被 item_tags 倒排表放大）。
 * 这里限数量、限长度、去标点、去重，且不覆盖用户已有标签。
 */
function normalizeAiTags(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const t = String(v ?? '')
      .replace(/[,，;；/|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12)
      .trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

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
  const aiTags = normalizeAiTags(result.tags);

  // 「AI 看图打标」要真的写标签：以前只落 ai_desc 描述，界面叫打标却拿不到任何标签。
  // 追加合并、不覆盖用户已有标签；images.tags 的触发器会自动同步 item_tags 倒排表。
  // 允许用设置关掉（aiAutoTags=false），避免在不希望 AI 改标签的库里悄悄写入。
  let writtenTags = 0;
  if (aiTags.length && getSettings().aiAutoTags !== false) {
    const existing = String(row.tags || '')
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const merged = existing.slice();
    for (const t of aiTags) {
      if (!merged.some((x) => x.toLowerCase() === t.toLowerCase())) merged.push(t);
    }
    writtenTags = merged.length - existing.length;
    if (writtenTags > 0) {
      db.prepare('UPDATE images SET tags = ? WHERE id = ?').run(merged.join(','), imageId);
    }
  }

  db.prepare(
    `INSERT INTO ai_desc(image_id, description, issues, quality, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET
       description = excluded.description, issues = excluded.issues,
       quality = excluded.quality, model = excluded.model, created_at = excluded.created_at`
  ).run(imageId, description, issues.join(','), quality, model, new Date().toISOString());

  return { imageId, description, issues, quality, model, tags: aiTags, tagsWritten: writtenTags };
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
