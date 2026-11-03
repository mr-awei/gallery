// 动作（Actions）：把一串固定操作存成宏，对选区/筛选结果一键重放。
// 对齐 Eagle 4 的「动作」与 Build 22 的 AI Action —— 区别在于这里的 AI 步骤
// 必须真的产出字段值（写到标题/备注/标签），没配 AI 就明确失败，不做「假装处理过」。
import * as lib from '../library.js';
import { db } from '../db.js';
import { addImagesToFolder } from '../folders.js';
import { analyzeImage, aiStatus, visionJson } from '../ai.js';
import { ocrImage, ocrPlatformSupported } from './ocr.js';

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
    .prepare('SELECT id, name, icon, steps, created_at, last_run_at FROM actions ORDER BY id ASC')
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      steps: safeParse(r.steps),
      createdAt: r.created_at,
      lastRunAt: r.last_run_at,
    }));
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
    return { ...s, type };
  });
}

export function saveAction({ id, name, icon = '', steps }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('动作名称不能为空');
  const valid = validateSteps(steps);
  const now = new Date().toISOString();
  if (id) {
    db.prepare('UPDATE actions SET name = ?, icon = ?, steps = ? WHERE id = ?').run(
      cleanName,
      String(icon || ''),
      JSON.stringify(valid),
      Number(id)
    );
    return { ok: true, id: Number(id) };
  }
  const info = db
    .prepare('INSERT INTO actions (name, icon, steps, created_at) VALUES (?, ?, ?, ?)')
    .run(cleanName, String(icon || ''), JSON.stringify(valid), now);
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
    default:
      return '未知步骤';
  }
}

export async function runAction(actionId, ids) {
  const act = db.prepare('SELECT * FROM actions WHERE id = ?').get(Number(actionId));
  if (!act) throw new Error('动作不存在');
  const steps = validateSteps(safeParse(act.steps));
  const list = (Array.isArray(ids) ? ids : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, MAX_IDS);
  if (!list.length) throw new Error('没有选择任何素材');

  const st = aiStatus();
  const ai = { enabled: Boolean(st?.ready) };
  const items = [];
  let okCount = 0;
  for (let i = 0; i < list.length; i++) {
    const row = lib.getImage(list[i]);
    if (!row) {
      items.push({ id: list[i], ok: false, error: '图片不存在', logs: [] });
      continue;
    }
    const logs = [];
    let failed = '';
    for (const step of steps) {
      try {
        logs.push(`${STEP_TYPES[step.type].label}：${await applyStep(step, lib.getImage(row.id) || row, i, ai)}`);
      } catch (err) {
        failed = `${STEP_TYPES[step.type].label} 失败：${err.message}`;
        break;
      }
    }
    if (failed) items.push({ id: row.id, ok: false, error: failed, logs });
    else {
      okCount += 1;
      items.push({ id: row.id, ok: true, logs });
    }
  }
  db.prepare('UPDATE actions SET last_run_at = ? WHERE id = ?').run(new Date().toISOString(), act.id);
  return {
    ok: okCount > 0,
    action: { id: act.id, name: act.name },
    total: list.length,
    okCount,
    failed: list.length - okCount,
    items: items.slice(0, 200),
  };
}
