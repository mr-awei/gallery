// @ts-check
/**
 * 插件市场：索引、插件包校验、在线安装与卸载。
 *
 * 安全边界：
 * - 远程下载只走 httpFetch + assertSafeUrl（逐跳校验、拒本机/内网/云元数据），只用 GET，
 *   响应体用 readBodyLimited 边读边限大小，绝不先把整个文件读进内存；
 * - 插件包里的路径逐个校验，拒绝 ../、绝对路径、盘符与非 .js/.json 文件；
 * - 清单走 validateManifest 的能力白名单，入口用 resolvePluginEntry 校验；
 * - 只装到用户插件目录，先写 staging 再原子替换，装完用宿主 findPlugin 复核。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { APP_ROOT } from '../config.js';
import { httpFetch } from '../http.js';
import { readBodyLimited } from './safe-url.js';
import { PLUGIN_PERMISSIONS, resolvePluginEntry, validateManifest } from './plugin-manifest.js';
import { ensureUserPluginDir, findPlugin, listPlugins, PLUGIN_DIRS } from './plugin-host.js';

const MARKET_DIR = path.join(APP_ROOT, 'plugins', '_market');
const MAX_PACKAGE_BYTES = 512 * 1024;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const SAFE_REL = /^[a-zA-Z0-9_./-]+$/;
const ALLOWED_EXT = /\.(m?js|cjs|json)$/i;

let remoteIndex = null;

/** 远程索引只活在内存里：应用重启后回到随包索引，不给持久的 SSRF 目标留后门 */
export function setRemoteMarketIndex(index) {
  remoteIndex = index;
  return index;
}

/**
 * 校验市场索引；字段一律收敛成字符串/白名单数组，不把远程对象的任意字段透传给前端。
 * @param {unknown} raw
 */
export function validateMarketIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('市场索引格式不正确');
  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(obj.plugins)) throw new Error('市场索引缺少 plugins 数组');
  const plugins = obj.plugins.slice(0, 100).map((item) => {
    const p = /** @type {Record<string, unknown>} */ (item || {});
    const permissions = Array.isArray(p.permissions)
      ? p.permissions.map((x) => String(x)).filter((x) => PLUGIN_PERMISSIONS.includes(x))
      : [];
    return {
      id: String(p.id || '').slice(0, 60),
      name: String(p.name || '').slice(0, 80),
      version: String(p.version || '1.0.0').slice(0, 24),
      description: String(p.description || '').slice(0, 400),
      author: String(p.author || '').slice(0, 60),
      tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t).slice(0, 24)).slice(0, 8) : [],
      permissions,
      actions: Array.isArray(p.actions) ? p.actions.map((a) => String(a).slice(0, 30)).slice(0, 20) : ['run'],
      package: String(p.package || '').slice(0, 120),
      downloadUrl: String(p.downloadUrl || '').slice(0, 500),
      source: p.source === 'remote' ? 'remote' : 'builtin',
    };
  }).filter((p) => p.id);
  return {
    version: Number(obj.version) || 1,
    updatedAt: String(obj.updatedAt || '').slice(0, 40),
    plugins,
  };
}

/** 随包索引（打包版也在 asar 内，fs 可直接读） */
export function loadBuiltinMarket() {
  return validateMarketIndex(JSON.parse(fs.readFileSync(path.join(MARKET_DIR, 'index.json'), 'utf8')));
}

/** 索引相对路径必须落在 _market 目录内 */
function marketPackagePath(rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || clean.includes('..') || /^[A-Za-z]:/.test(clean) || !SAFE_REL.test(clean)) {
    throw new Error('市场条目的包名不合法');
  }
  const full = path.resolve(MARKET_DIR, clean);
  if (!full.startsWith(path.resolve(MARKET_DIR) + path.sep)) throw new Error('市场条目的包名越界');
  return full;
}

export function readBuiltinPackage(rel) {
  return fs.readFileSync(marketPackagePath(rel));
}

/** 包内相对路径：拒绝 ../、绝对路径、盘符与二进制/可执行文件 */
function checkRel(raw) {
  const rel = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || rel.startsWith('/') || rel.includes('..') || /^[A-Za-z]:/.test(rel) || !SAFE_REL.test(rel)) {
    throw new Error(`插件包里包含非法路径：${String(raw).slice(0, 80)}`);
  }
  if (!ALLOWED_EXT.test(rel)) throw new Error(`插件包里不允许的文件类型：${rel}`);
  return rel;
}

function checkFiles(files) {
  const keys = Object.keys(files);
  if (!keys.length || keys.length > MAX_FILES) throw new Error(`插件包文件数量不合法（${keys.length}）`);
  const out = {};
  let total = 0;
  for (const key of keys) {
    const rel = checkRel(key);
    const content = String(files[key] ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`插件包里的 ${rel} 过大`);
    total += bytes;
    if (total > MAX_PACKAGE_BYTES) throw new Error('插件包总体积过大');
    out[rel] = content;
  }
  return out;
}

/**
 * 解析插件包：.zip（标准目录结构）或 .tuku-plugin（单文件 JSON）。
 * @param {Buffer} buf
 * @param {string} [filename]
 */
export async function parsePluginPackage(buf, filename = '') {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('插件包为空');
  if (buf.length > MAX_PACKAGE_BYTES) throw new Error('插件包过大');
  const isZip = /\.zip$/i.test(filename) || (buf[0] === 0x50 && buf[1] === 0x4b);

  let files;
  if (isZip) {
    const zip = await JSZip.loadAsync(buf);
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    if (entries.length > MAX_FILES) throw new Error(`插件包文件过多（${entries.length}）`);
    const raw = {};
    for (const entry of entries) raw[entry.name] = await entry.async('string');
    files = checkFiles(raw);
  } else {
    let pkg;
    try {
      pkg = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      throw new Error('插件包不是合法的 JSON（.tuku-plugin）或 ZIP', { cause: err });
    }
    if (pkg?.format !== 'tuku-plugin/1') throw new Error('不是受支持的插件包格式（tuku-plugin/1）');
    if (!pkg.files || typeof pkg.files !== 'object') throw new Error('插件包缺少 files');
    files = checkFiles({ ...pkg.files, 'plugin.json': JSON.stringify(pkg.manifest || {}) });
  }

  if (!files['plugin.json']) throw new Error('插件包缺少 plugin.json');
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(files['plugin.json']));
  } catch (err) {
    throw new Error(`插件清单不合法：${err?.message || err}`, { cause: err });
  }
  const entryAbs = resolvePluginEntry('/__tuku_plugin__', manifest.entry);
  const entryRel = path.relative(path.resolve('/__tuku_plugin__'), entryAbs).replace(/\\/g, '/');
  if (!files[entryRel]) throw new Error(`插件入口文件不存在：${manifest.entry}`);
  return { manifest, files };
}

/**
 * 在线下载（只 GET、逐跳地址校验、限体积）。
 * @param {string} url
 */
export async function downloadPluginPackage(url) {
  const res = await httpFetch(String(url), { method: 'GET', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = await readBodyLimited(res, MAX_PACKAGE_BYTES);
  return { buf, filename: new URL(String(url)).pathname };
}

/** 把校验过的包原子地装进用户插件目录 */
export async function installPluginPackage({ manifest, files }) {
  const userDir = await ensureUserPluginDir();
  const target = path.join(userDir, manifest.id);
  let staging = path.join(userDir, `.staging-${manifest.id}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await fsp.mkdir(staging, { recursive: true });
    await fsp.writeFile(path.join(staging, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await fsp.writeFile(path.join(staging, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
    for (const [rel, content] of Object.entries(files)) {
      if (rel === 'plugin.json') continue;
      const dest = path.join(staging, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, content, 'utf8');
    }
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(staging, target);
    staging = '';
  } finally {
    if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  const found = findPlugin(manifest.id);
  if (!found) throw new Error('安装完成但宿主没有发现插件，请检查插件包内容');
  return {
    ok: true,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    permissions: manifest.permissions,
    actions: manifest.actions,
    builtin: false,
  };
}

/** 卸载：只允许删用户目录里的插件；删完宿主立刻不再返回（findPlugin 每次读盘） */
export async function uninstallPlugin(id) {
  const plugin = findPlugin(String(id || ''));
  if (!plugin) throw new Error('插件不存在');
  if (plugin.builtin) throw new Error('内置插件不能卸载');
  const root = path.resolve(PLUGIN_DIRS[1]);
  const dir = path.resolve(plugin.dir);
  if (!dir.startsWith(root + path.sep)) throw new Error('只能卸载用户插件目录里的插件');
  await fsp.rm(dir, { recursive: true, force: true });
  return { ok: true, id: plugin.id, restoredBuiltin: !!findPlugin(plugin.id) };
}

/** 市场视图：索引 + 已安装状态，权限声明原样回显给前端 */
export function marketView() {
  const index = remoteIndex || loadBuiltinMarket();
  const installed = new Map(listPlugins().map((p) => [p.id, p]));
  return {
    ...index,
    remote: !!remoteIndex,
    plugins: index.plugins.map((p) => ({
      ...p,
      installed: installed.has(p.id),
      installedVersion: installed.get(p.id)?.version || '',
      installedBuiltin: !!installed.get(p.id)?.builtin,
    })),
  };
}
