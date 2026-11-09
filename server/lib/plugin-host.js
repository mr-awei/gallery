// @ts-check
/**
 * 插件宿主：清单发现 + 独立进程执行 + 按权限回写。
 *
 * 为什么不用 node:vm：vm 不是安全边界（原型逃逸屡见不鲜），而且插件本来就需要
 * 完整 ESM 语法。这里用「独立进程 + 只递普通数据 + 能力白名单」：
 * 子进程拿不到 db / settings / 网络封装，只能返回 patch，父进程校验后再写库。
 * 这不是 OS 级沙箱——只装信任的插件，设置页会如实写明。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, DATA_DIR } from '../config.js';
import { getSettings, saveSettings } from '../db.js';
import * as lib from '../library.js';
import { dirMatchesId, resolvePluginEntry, sanitizePatch, validateManifest } from './plugin-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 打包后 asarUnpack 的文件真实落在 app.asar.unpacked 下；插件子进程用
 * ELECTRON_RUN_AS_NODE 启动，没有 asar 的 fs 补丁，必须给它真实文件路径。
 * 开发模式下路径里没有 app.asar，原样返回。
 */
function realFile(p) {
  const unpacked = p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  if (unpacked !== p && fs.existsSync(unpacked)) return unpacked;
  return p;
}

const RUNTIME = realFile(path.resolve(__dirname, '..', 'plugin-runtime.js'));
/** 内置插件随包分发；用户插件放用户数据目录，升级应用不会覆盖 */
export const PLUGIN_DIRS = [path.join(APP_ROOT, 'plugins'), path.join(DATA_DIR, 'plugins')];
const OUTPUT_PREFIX = '__TUKU_PLUGIN__';
const MAX_ARGS = 16 * 1024;
const MAX_OUTPUT = 128 * 1024;
const DEFAULT_TIMEOUT = 5000;

function inspectDir(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('.')) continue;
    const dir = path.join(root, name.name);
    const manifestFile = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestFile)) continue;
    try {
      const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
      if (!dirMatchesId(dir, manifest.id)) throw new Error('目录名必须与插件 id 一致');
      const entry = realFile(resolvePluginEntry(dir, manifest.entry));
      if (!fs.existsSync(entry)) throw new Error('入口文件不存在');
      found.push({ ...manifest, entry, dir: realFile(dir), builtin: root === PLUGIN_DIRS[0] });
    } catch (err) {
      console.warn(`[plugins] 跳过 ${dir}：${err?.message || err}`);
    }
  }
  return found;
}

/** 已停用的插件 id（库级设置，随库走；默认全开） */
export function disabledPluginIds() {
  const list = getSettings().plugins?.disabled;
  return Array.isArray(list) ? list.map((s) => String(s)) : [];
}

export function isPluginEnabled(id) {
  return !disabledPluginIds().includes(String(id));
}

/** 启用 / 停用插件；不需要重启应用，下次执行即生效 */
export function setPluginEnabled(id, enabled) {
  const pid = String(id || '');
  if (!pid) throw new Error('插件 id 不能为空');
  if (!findPlugin(pid)) throw new Error(`插件不存在：${pid}`);
  const cur = new Set(disabledPluginIds());
  if (enabled) cur.delete(pid);
  else cur.add(pid);
  saveSettings({ plugins: { disabled: [...cur] } });
  return { id: pid, enabled: !!enabled, disabled: [...cur] };
}

/** 列出可用插件；用户目录里的同 id 插件覆盖内置版本 */
export function listPlugins() {
  const map = new Map();
  for (const root of PLUGIN_DIRS) for (const p of inspectDir(root)) map.set(p.id, p);
  // entry/dir 是宿主执行时要用的内部字段；对外输出由 routes/plugins.js 过滤掉
  const disabled = new Set(disabledPluginIds());
  return [...map.values()].map((p) => ({ ...p, enabled: !disabled.has(p.id) }));
}

export function findPlugin(id) {
  return listPlugins().find((p) => p.id === id) || null;
}

/** 应用 patch：只允许追加标签 / 改备注 / 评分 / 收藏，绝不动文件与路径 */
export function applyPluginPatch(imageId, patch) {
  const applied = [];
  if (!imageId) return applied;
  const row = lib.getImage(imageId);
  if (!row) return applied;
  if (patch.tags?.length) {
    const cur = String(row.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    lib.setTags(imageId, [...new Set([...cur, ...patch.tags])].join(','));
    applied.push('tags');
  }
  if (patch.note !== undefined) {
    lib.setNote(imageId, patch.note);
    applied.push('note');
  }
  if (patch.rating !== undefined) {
    lib.setRating(imageId, patch.rating);
    applied.push('rating');
  }
  if (patch.favorite !== undefined) {
    lib.setFavorite(imageId, patch.favorite);
    applied.push('favorite');
  }
  return applied;
}

function imageSnapshot(row, canRead) {
  if (!row) return {};
  if (!canRead) return { id: row.id };
  return {
    id: row.id,
    title: row.title || '',
    tags: row.tags || '',
    note: row.note || '',
    rating: Number(row.rating) || 0,
    favorite: row.favorite === 1,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    mediaKind: row.media_kind || 'image',
  };
}

/**
 * 执行一次插件。父进程负责超时、输出限额、权限过滤与回写。
 * 返回 { ok, logs, patch, applied, result }，失败一定带 error，不静默吞掉。
 * @param {{id?:string, action?:string, imageId?:number|null, args?:object}} [opts]
 */
export async function runPlugin({ id, action = 'run', imageId = null, args = {} } = {}) {
  const plugin = findPlugin(String(id || ''));
  if (!plugin) return { ok: false, error: `插件不存在：${id || '(空)'}` };
  if (!isPluginEnabled(plugin.id)) return { ok: false, error: `插件「${plugin.name}」已停用，请先在设置里启用` };
  if (!plugin.actions.includes(String(action))) return { ok: false, error: `插件不支持动作 ${action}` };
  let payload;
  try {
    payload = JSON.stringify({
      entry: plugin.entry,
      action: String(action),
      permissions: plugin.permissions,
      image: imageSnapshot(imageId ? lib.getImage(imageId) : null, plugin.permissions.includes('image:read')),
      args: args && typeof args === 'object' ? args : {},
    });
  } catch (err) {
    return { ok: false, error: `参数无法序列化：${err?.message || err}` };
  }
  if (payload.length > MAX_ARGS) return { ok: false, error: '插件参数过大' };

  const value = await new Promise((resolve) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    // 服务端可能跑在 Electron 的 utilityProcess 里，execPath 是 electron.exe；
    // ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式执行，纯 node 环境下该变量无副作用。
    const child = spawn(process.execPath, [RUNTIME, payload], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, error: `插件执行超时（${DEFAULT_TIMEOUT}ms）` });
    }, DEFAULT_TIMEOUT);
    child.stdout?.on('data', (b) => {
      stdout += String(b);
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT);
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出 */
        }
        finish({ ok: false, error: '插件输出过大' });
      }
    });
    child.stderr?.on('data', (b) => {
      stderr = (stderr + String(b)).slice(-4000);
    });
    child.on('error', (err) => finish({ ok: false, error: `无法启动插件进程：${err?.message || err}` }));
    child.on('close', (code) => {
      if (done) return;
      const line = stdout.split('\n').find((l) => l.startsWith(OUTPUT_PREFIX));
      if (!line) {
        finish({ ok: false, error: `插件没有返回结果（退出码 ${code}）${stderr ? `：${stderr.trim().slice(0, 300)}` : ''}` });
        return;
      }
      try {
        const msg = JSON.parse(line.slice(OUTPUT_PREFIX.length));
        if (msg.type === 'error') finish({ ok: false, error: msg.message || '插件执行失败' });
        else finish({ ok: true, value: msg.value || {} });
      } catch (err) {
        finish({ ok: false, error: `插件返回了非法 JSON：${err?.message || err}` });
      }
    });
  });
  if (!value.ok) return value;

  const raw = value.value || {};
  const patch = sanitizePatch(raw.patch, plugin.permissions.includes('image:write'));
  let applied;
  try {
    applied = applyPluginPatch(imageId, patch);
  } catch (err) {
    return { ok: false, error: `插件结果写库失败：${err?.message || err}` };
  }
  return {
    ok: true,
    plugin: plugin.id,
    action,
    logs: Array.isArray(raw.logs) ? raw.logs.slice(0, 50) : [],
    patch,
    applied,
    result: raw.result ?? null,
    denied: !plugin.permissions.includes('image:write') && Object.keys(raw.patch || {}).length > 0,
  };
}

/** 用户插件目录（设置页「打开插件目录」用） */
export async function ensureUserPluginDir() {
  const dir = PLUGIN_DIRS[1];
  await fsp.mkdir(dir, { recursive: true });
  // 用户插件目录不在项目根下，Node 向上找不到根 package.json 的 "type":"module"，
  // 会把 .js 入口当成 CommonJS 而报 export 语法错误；这里补一份声明。
  try {
    await fsp.writeFile(path.join(dir, 'package.json'), '{"private":true,"type":"module"}\n', { flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') console.warn('[plugins] 无法写入用户插件目录声明：', err?.message || err);
  }
  return dir;
}
