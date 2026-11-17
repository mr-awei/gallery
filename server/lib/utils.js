// @ts-check
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
/**
 * 有限并发执行异步任务（next 指针派发；JS 单线程，各任务对共享计数器的修改天然安全）。
 * importer / bulk-import / eagle-export 以前各抄了一份，其中 bulk-import 漏了定义，
 * 目录里一旦有 RAW/PSD/视频就会整批扫描中断 —— 统一收到这里。
 */
export async function mapLimit(list, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      await fn(list[i], i);
    }
  });
  await Promise.all(workers);
}

export function aiDescText(id) {
  const row = db.prepare('SELECT description FROM ai_desc WHERE image_id = ?').get(id);
  return row ? row.description : '';
}
