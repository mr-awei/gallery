// @ts-check
// 动作（Actions）：把一串固定操作存成宏，对选区/筛选结果一键重放。
// 对齐 Eagle 4 的「动作」与 Build 22 的 AI Action —— 区别在于这里的 AI 步骤
// 必须真的产出字段值（写到标题/备注/标签），没配 AI 就明确失败，不做「假装处理过」。
import * as lib from '../library.js';
import { db } from '../db.js';
import { addImagesToFolder } from '../folders.js';
import { analyzeImage, aiStatus, visionJson } from '../ai.js';
import { ocrImage, ocrPlatformSupported } from './ocr.js';
import { runPlugin } from './plugin-host.js';
import { matchRules } from './smartfolders.js';
import { logOp } from '../oplog.js';

export const STEP_TYPES = {
  tag: { label: '标签', desc: '批量加/删/替换标签' },
  folder: { label: '归类', desc: '加入指定文件夹' },
  rate: { label: '评分', desc: '统一设置星级' },
  note: { label: '备注', desc: '追加或替换备注' },
  title: { label: '改名', desc: '按模板或前后缀改标题' },
  favorite: { label: '收藏', desc: '标记/取消收藏' },
  ocr: { label: 'OCR', desc: '识别图内文字（可被搜索）' },
  aiDescribe: { label: 'AI 描述', desc: '调用视觉模型生成描述' },
  aiPrompt: { label: 'AI 指令', desc: '按你的指令把结果写进字段' },
  script: { label: '插件脚本', desc: '在独立进程里运行已安装的插件' },
};

const MAX_IDS = 500;

function splitTags(s) {
  return String(s || '')
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function applyTitleTemplate(tpl, row, index) {
  return String(tpl || '')
    .replace(/\{index\}/g, String(index + 1).padStart(2, '0'))
    .replace(/\{keyword\}/g, row.keyword || '')
    .replace(/\{source\}/g, row.source || '')
    .replace(/\{date\}/g, String(row.created_at || '').slice(0, 10))
    .replace(/\{width\}/g, String(row.width || ''))
    .replace(/\{height\}/g, String(row.height || ''))
    .trim();
}

export function listActions() {
  return db
    .prepare('SELECT id, name, icon, steps, conditions, created_at, last_run_at FROM actions ORDER BY id ASC')
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      steps: safeParse(r.steps),
      conditions: parseConditions(r.conditions),
      createdAt: r.created_at,
      lastRunAt: r.last_run_at,
    }));
}

/**
 * 条件解析：与智能文件夹共用一套规则语义，但只支持「一层平坦条件 + combine」。
 * 动作的作用对象本来就是用户选中的那批图，再叠嵌套分组只会让界面和心智都变复杂。
 * @param {unknown} raw
 */
function parseConditions(raw) {
  const empty = { combine: 'and', rules: {} };
  if (!raw) return empty;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!v || typeof v !== 'object') return empty;
    const rules = v.rules && typeof v.rules === 'object' ? v.rules : {};
    return { combine: v.combine === 'or' ? 'or' : 'and', rules };
  } catch {
    return empty;
  }
}

/** 白名单清洗：条件只认智能文件夹那套字段，避免前端塞进来任意 JSON 落库 */
function cleanConditions(raw) {
  const { combine, rules } = parseConditions(raw);
  /** @type {Record<string, unknown>} */
  const out = {};
  if (rules.favorite === 'yes' || rules.favorite === 'no') out.favorite = rules.favorite;
  for (const k of ['minRating', 'minScore', 'minWidth']) {
    const n = Number(rules[k]);
    if (n > 0) out[k] = Math.min(100000, Math.round(n));
  }
  if (['landscape', 'portrait', 'square'].includes(String(rules.orientation))) {
    out.orientation = String(rules.orientation);
  }
  for (const k of ['tagsInclude', 'tagsExclude', 'keywords', 'aiKeywords']) {
    const v = Array.isArray(rules[k]) ? rules[k] : String(rules[k] ?? '').split(/[,，]/);
    const list = v.map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
    if (list.length) out[k] = list;
  }
  // 没有任何生效条件就不存，避免「看起来有条件其实命中全库」
  return Object.keys(out).length ? { combine, rules: out } : { combine: 'and', rules: {} };
}

/** 条件是否有内容（空条件 = 不筛选） */
function hasConditions(cond) {
  return Object.keys(cond.rules || {}).length > 0;
}

function safeParse(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('动作至少要包含一个步骤');
  return steps.slice(0, 12).map((s) => {
    const type = String(s?.type || '');
    if (!STEP_TYPES[type]) throw new Error(`未知的步骤类型：${type || '(空)'}`);
    if (type === 'script' && !/^[a-z0-9][a-z0-9_-]{1,40}$/.test(String(s?.pluginId || ''))) {
      throw new Error('脚本步骤缺少合法的插件 id');
    }
    return { ...s, type };
  });
}

export function saveAction({ id, name, icon = '', steps, conditions }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('动作名称不能为空');
  const valid = validateSteps(steps);
  const condJson = conditions === undefined ? null : JSON.stringify(cleanConditions(conditions));
  const now = new Date().toISOString();
  if (id) {
    // conditions 未传时保留原值：老前端 / 只改名字的调用不该把条件清空
    const prev = condJson === null ? db.prepare('SELECT conditions FROM actions WHERE id = ?').get(Number(id))?.conditions ?? '' : condJson;
    db.prepare('UPDATE actions SET name = ?, icon = ?, steps = ?, conditions = ? WHERE id = ?').run(
      cleanName,
      String(icon || ''),
      JSON.stringify(valid),
      String(prev),
      Number(id)
    );
    return { ok: true, id: Number(id) };
  }
  const info = db
    .prepare('INSERT INTO actions (name, icon, steps, conditions, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(cleanName, String(icon || ''), JSON.stringify(valid), condJson || '', now);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function deleteAction(id) {
  db.prepare('DELETE FROM actions WHERE id = ?').run(Number(id));
  return { ok: true };
}

async function applyStep(step, row, index, ai) {
  switch (step.type) {
    case 'tag': {
      const tags = splitTags(step.tags);
      if (!tags.length) return '没有标签内容，跳过';
      const cur = splitTags(row.tags);
      let next;
      if (step.mode === 'remove') next = cur.filter((t) => !tags.includes(t));
      else if (step.mode === 'replace') next = tags;
      else next = [...new Set([...cur, ...tags])];
      lib.setTags(row.id, next.join(','));
      return `标签 -> ${next.join(',') || '（空）'}`;
    }
    case 'folder': {
      const fid = Number(step.folderId);
      if (!fid) return '没有选择文件夹，跳过';
      addImagesToFolder(fid, [row.id]);
      return '已加入文件夹';
    }
    case 'rate': {
      const n = Math.max(0, Math.min(5, Number(step.rating) || 0));
      lib.setRating(row.id, n);
      return `评分 -> ${n}`;
    }
    case 'note': {
      const text = String(step.text || '');
      if (!text) return '备注为空，跳过';
      const next = step.mode === 'append' && row.note ? `${row.note}\n${text}` : text;
      lib.setNote(row.id, next);
      return '备注已更新';
    }
    case 'title': {
      let next = String(step.text || '').trim();
      if (step.mode === 'template') next = applyTitleTemplate(step.template || '{keyword}', row, index);
      else if (step.mode === 'prefix') next = `${next}${row.title || ''}`;
      else if (step.mode === 'suffix') next = `${row.title || ''}${next}`;
      if (!next) return '标题为空，跳过';
      lib.renameTitle(row.id, next);
      return `标题 -> ${next}`;
    }
    case 'favorite': {
      lib.setFavorite(row.id, step.value !== false);
      return step.value === false ? '已取消收藏' : '已收藏';
    }
    case 'ocr': {
      if (!ocrPlatformSupported()) throw new Error('系统 OCR 仅 Windows 可用');
      const r = await ocrImage(row.abs_path);
      if (!r.ok) throw new Error(r.error);
      db.prepare(
        `INSERT INTO image_ocr (image_id, text, lang, engine, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(image_id) DO UPDATE SET text = excluded.text, lang = excluded.lang,
           engine = excluded.engine, created_at = excluded.created_at`
      ).run(row.id, r.text, r.lang, r.engine, new Date().toISOString());
      return `识别到 ${r.text.length} 字`;
    }
    case 'aiDescribe': {
      if (!ai.enabled) throw new Error('未配置 AI，无法执行 AI 步骤');
      const r = await analyzeImage(row.id);
      return `描述：${String(r.description || '').slice(0, 30)}…`;
    }
    case 'aiPrompt': {
      if (!ai.enabled) throw new Error('未配置 AI，无法执行 AI 步骤');
      const instruction = String(step.instruction || '').trim();
      if (!instruction) throw new Error('AI 指令为空');
      const target = String(step.target || 'note');
      const r = await visionJson(
        row.id,
        instruction,
        '严格返回 JSON：{"value":"处理结果"}，value 里只放最终要写入的纯文本，不要解释。',
        { timeout: 90000 }
      );
      const value = String(r?.value ?? '').trim();
      if (!value) throw new Error('AI 没有返回可写入的内容');
      if (target === 'title') lib.renameTitle(row.id, value);
      else if (target === 'tags') lib.setTags(row.id, [...new Set([...splitTags(row.tags), ...splitTags(value)])].join(','));
      else lib.setNote(row.id, value);
      return `AI 写入 ${target}：${value.slice(0, 30)}`;
    }
    case 'script': {
      // 插件跑在独立子进程；失败必须抛出来，让这张素材如实标记为失败
      const r = await runPlugin({
        id: String(step.pluginId || ''),
        action: String(step.action || 'run'),
        imageId: row.id,
        args: step.args,
      });
      if (!r.ok) throw new Error(r.error || '插件执行失败');
      const detail = (r.logs || []).join('；') || (r.applied?.length ? `已写入 ${r.applied.join('/')}` : '已执行');
      return `${r.plugin}：${detail}`;
    }
    default:
      return '未知步骤';
  }
}

function folderName(id) {
  const r = db.prepare('SELECT name FROM folders WHERE id = ?').get(Number(id));
  return r?.name || `#${id}`;
}

function folderIdsOf(imageId) {
  return db
    .prepare('SELECT folder_id FROM image_folders WHERE image_id = ?')
    .all(imageId)
    .map((r) => Number(r.folder_id));
}

/**
 * 逐图预演（dryRun）：确定性步骤算出「改什么、从什么改成什么」，
 * AI / OCR / 插件这类会调模型或外部进程的步骤如实标注「无法预演」——
 * 预演不写库、不调模型，只是把同一套计算跑一遍取结果。
 */
function previewSteps(steps, row, index) {
  return steps.map((step) => {
    const label = STEP_TYPES[step.type].label;
    /** @type {{field:string, before:string, after:string}[]} */
    const diffs = [];
    let willSkip = '';
    let unknown = '';
    switch (step.type) {
      case 'tag': {
        const tags = splitTags(step.tags);
        if (!tags.length) {
          willSkip = '没有标签内容';
          break;
        }
        const cur = splitTags(row.tags);
        let next;
        if (step.mode === 'remove') next = cur.filter((t) => !tags.includes(t));
        else if (step.mode === 'replace') next = tags;
        else next = [...new Set([...cur, ...tags])];
        diffs.push({ field: '标签', before: cur.join(', ') || '（空）', after: next.join(', ') || '（空）' });
        break;
      }
      case 'folder': {
        if (!Number(step.folderId)) {
          willSkip = '没有选择文件夹';
          break;
        }
        diffs.push({ field: '文件夹', before: '—', after: `+ ${folderName(step.folderId)}` });
        break;
      }
      case 'rate': {
        const n = Math.max(0, Math.min(5, Number(step.rating) || 0));
        diffs.push({ field: '评分', before: String(Number(row.rating) || 0), after: String(n) });
        break;
      }
      case 'note': {
        const text = String(step.text || '');
        if (!text) {
          willSkip = '备注为空';
          break;
        }
        const next = step.mode === 'append' && row.note ? `${row.note}\n${text}` : text;
        diffs.push({ field: '备注', before: row.note || '（空）', after: next });
        break;
      }
      case 'title': {
        let next = String(step.text || '').trim();
        if (step.mode === 'template') next = applyTitleTemplate(step.template || '{keyword}', row, index);
        else if (step.mode === 'prefix') next = `${next}${row.title || ''}`;
        else if (step.mode === 'suffix') next = `${row.title || ''}${next}`;
        if (!next) {
          willSkip = '标题为空';
          break;
        }
        diffs.push({ field: '标题', before: row.title || '（空）', after: next });
        break;
      }
      case 'favorite': {
        diffs.push({
          field: '收藏',
          before: Number(row.favorite) ? '已收藏' : '未收藏',
          after: step.value === false ? '未收藏' : '已收藏',
        });
        break;
      }
      case 'ocr':
        unknown = '执行时识别图内文字，结果取决于图片内容';
        break;
      case 'aiDescribe':
        unknown = '执行时调用视觉模型生成描述，结果无法预演';
        break;
      case 'aiPrompt':
        unknown = `执行时按指令调用模型并写入「${String(step.target || 'note')}」，结果无法预演`;
        break;
      case 'script':
        unknown = `执行时在独立进程运行插件 ${String(step.pluginId || '')}，结果无法预演`;
        break;
      default:
        unknown = '无法预演';
    }
    return { type: step.type, label, diffs, willSkip, unknown };
  });
}

/** 撤销所需的「最小反悔信息」：只记会被动作改到的字段与新增的文件夹 */
function snapshotOf(row) {
  return {
    id: Number(row.id),
    title: row.title || '',
    tags: row.tags || '',
    note: row.note || '',
    rating: Number(row.rating) || 0,
    favorite: Number(row.favorite) ? 1 : 0,
    folders: folderIdsOf(row.id),
  };
}

/**
 * 执行动作。
 * - dryRun=true：只对每张图算出「将改什么」，不写库、不调模型
 * - 条件（conditions）：不命中的图直接跳过，并在结果里如实标注
 * - 真正执行后写一条 op_log，撤销时按快照恢复（批量操作因此可一键回滚）
 */
export async function runAction(actionId, ids, { dryRun = false } = {}) {
  const act = db.prepare('SELECT * FROM actions WHERE id = ?').get(Number(actionId));
  if (!act) throw new Error('动作不存在');
  const steps = validateSteps(safeParse(act.steps));
  const cond = parseConditions(act.conditions);
  const filtered = hasConditions(cond);
  const list = (Array.isArray(ids) ? ids : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, MAX_IDS);
  if (!list.length) throw new Error('没有选择任何素材');

  const st = aiStatus();
  const ai = { enabled: Boolean(st?.ready) };
  const items = [];
  const snaps = [];
  let okCount = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < list.length; i++) {
    const row = lib.getImage(list[i]);
    if (!row) {
      failed++;
      items.push({ id: list[i], ok: false, error: '图片不存在', logs: [] });
      continue;
    }
    if (filtered && !matchRules(row, cond.rules, cond.combine === 'or' ? 'OR' : 'AND')) {
      skipped++;
      items.push({ id: row.id, ok: true, skipped: '条件不匹配', logs: [] });
      continue;
    }
    if (dryRun) {
      items.push({ id: row.id, ok: true, willRun: true, preview: previewSteps(steps, row, i), logs: [] });
      okCount++;
      continue;
    }

    const snap = snapshotOf(row);
    const logs = [];
    let stepError = '';
    for (const step of steps) {
      try {
        logs.push(`${STEP_TYPES[step.type].label}：${await applyStep(step, lib.getImage(row.id) || row, i, ai)}`);
      } catch (err) {
        stepError = `${STEP_TYPES[step.type].label} 失败：${err.message}`;
        break;
      }
    }
    snaps.push(snap);
    if (stepError) {
      failed++;
      items.push({ id: row.id, ok: false, error: stepError, logs });
    } else {
      okCount++;
      items.push({ id: row.id, ok: true, logs });
    }
  }

  const after = dryRun ? [] : snaps.filter((s) => s);
  if (!dryRun && after.length) {
    // 记录「新增了哪些文件夹」，撤销时只摘掉这些，不动用户执行前已有的归属
    const rows = after.map((s) => {
      const now = folderIdsOf(s.id);
      return { ...s, addedFolders: now.filter((f) => !s.folders.includes(f)) };
    });
    logOp({
      op: 'action',
      summary: `动作「${act.name}」作用于 ${rows.length} 张${skipped ? `（跳过 ${skipped} 张条件不匹配）` : ''}`,
      payload: { actionId: act.id, name: act.name, rows },
    });
    db.prepare('UPDATE actions SET last_run_at = ? WHERE id = ?').run(new Date().toISOString(), act.id);
  }

  return {
    ok: okCount > 0,
    dryRun: !!dryRun,
    action: { id: act.id, name: act.name, conditions: cond },
    total: list.length,
    okCount,
    skipped,
    failed,
    items: items.slice(0, 200),
  };
}
