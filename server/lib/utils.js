// 库内通用小工具：标签逗号串拆合、JSON 容错解析、AI 描述读取（从 library.js 拆出）
import { db } from '../db.js';


export function splitTags(s) {
  return String(s || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}
export function joinTags(arr) {
  return Array.isArray(arr) ? arr.map((t) => String(t).trim()).filter(Boolean).join(',') : '';
}
export function safeParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}
export function aiDescText(id) {
  const row = db.prepare('SELECT description FROM ai_desc WHERE image_id = ?').get(id);
  return row ? row.description : '';
}
