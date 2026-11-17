// @ts-check
/**
 * 插件清单与路径校验（纯函数，可单测）。
 *
 * 最小插件契约：plugins/<id>/plugin.json + 一个 ESM 入口。
 *
 * 沙箱分两层，都不假装是 OS 级隔离：
 * 1. 进程层：独立子进程 + 超时 + 输出限额，拿不到 db / settings 句柄；
 * 2. 能力层：模块解析阶段拒绝 fs / child_process / 网络套接字等危险模块，
 *    要联网必须声明 `net`，要读插件目录外的文件必须声明 `fs:read`
 *    （且只能通过受限的 readFile 读插件自己目录下的文件）。
 * 剩下能逃逸的只有 Node 内部 binding —— 所以仍然只装信任的插件，设置页照实写。
 */
import path from 'node:path';

export const PLUGIN_PERMISSIONS = Object.freeze(['image:read', 'image:write', 'log', 'net', 'fs:read']);

export const PLUGIN_PATCH_FIELDS = Object.freeze(['tags', 'note', 'rating', 'favorite']);

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;

/** 校验并归一化 plugin.json；任何非法字段都直接抛错，不做「尽力而为」的猜测 */
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plugin.json 必须是对象');
  const id = String(raw.id || '').trim();
  if (!ID_RE.test(id)) throw new Error('插件 id 只能用小写字母/数字/下划线/连字符（2~41 位）');
  const name = String(raw.name || '').trim().slice(0, 80);
  if (!name) throw new Error('插件缺少 name');
  const version = String(raw.version || '1.0.0').trim().slice(0, 24);
  const entry = String(raw.entry || 'index.js').trim();
  const permissions = Array.isArray(raw.permissions) ? raw.permissions.map((p) => String(p).trim()) : [];
  for (const p of permissions) {
    if (!PLUGIN_PERMISSIONS.includes(p)) throw new Error(`未知权限 ${p}`);
  }
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map((a) => String(a).trim()).filter((a) => /^[a-zA-Z0-9_-]{1,30}$/.test(a)).slice(0, 20)
    : ['run'];
  return {
    id,
    name,
    version,
    entry,
    permissions,
    actions: actions.length ? actions : ['run'],
    description: String(raw.description || '').slice(0, 400),
  };
}

/** 入口必须落在插件目录内（防 ../ 逃逸到任意文件） */
export function resolvePluginEntry(dir, entry) {
  const root = path.resolve(dir);
  const abs = path.resolve(root, String(entry || 'index.js'));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('插件入口越出了插件目录');
  if (!/\.(m?js|cjs)$/i.test(abs)) throw new Error('插件入口必须是 .js / .mjs / .cjs');
  return abs;
}

/** 目录名与清单 id 必须一致，避免同 id 插件互相覆盖 */
export function dirMatchesId(dir, id) {
  return path.basename(path.resolve(dir)) === id;
}

/**
 * 从插件返回的 patch 里挑出允许写回的字段（纯函数）。
 * allowed=false（没声明 image:write）时一律返回空：插件想写也不能写。
 */
export function sanitizePatch(raw, allowed) {
  if (!raw || typeof raw !== 'object' || !allowed) return {};
  const out = {};
  for (const k of PLUGIN_PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    const v = raw[k];
    if (k === 'tags') {
      const arr = Array.isArray(v) ? v : String(v).split(/[,，\s]+/);
      out.tags = arr.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
    } else if (k === 'note') out.note = String(v).slice(0, 2000);
    else if (k === 'rating') out.rating = Math.max(0, Math.min(5, Math.round(Number(v) || 0)));
    else if (k === 'favorite') out.favorite = v === true;
  }
  return out;
}
