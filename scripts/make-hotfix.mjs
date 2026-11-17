#!/usr/bin/env node
/**
 * 打一个热更包（zip + 已签名清单），并算出下载地址。
 *
 * 只收 server/** 与 dist/web/**：
 *   web  → 静态托管的增量目录（缺的文件自动回落 asar 里的 dist/web）
 *   server → 由 asar 里的 loader 把裸模块解析回 asar 的 node_modules
 * electron/**、package.json、原生模块一律不收 —— 那些属于「壳」，只能走安装包。
 *
 * 用法：
 *   node scripts/make-hotfix.mjs --notes "修拼图首帧闪回"
 *   node scripts/make-hotfix.mjs --notes "..." --since release-build/hotfix/last-manifest.json
 *   node scripts/make-hotfix.mjs --notes "..." --seq 13 --url https://... --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { fileAllowed, sha256, signManifest } from '../electron/lib/hotfix-manifest.js';
import { SCHEMA_VERSION } from '../server/db/schema-version.js';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const REPO = process.env.HOTFIX_REPO || 'mr-awei/gallery';
/** Gitee 镜像仓库（形如 'mr-awei/gallery'）；设成空串就不写 Gitee 下载地址 */
const GITEE = process.env.HOTFIX_GITEE ?? 'mr-awei/gallery';
const OUT_DIR = path.join(root, 'release-build', 'hotfix');

/** 哪些目录进包（from 是工作区路径，to 是包内路径） */
const ROOTS = [
  { from: 'server', to: 'server', skip: [/hotfix-entry\.js$/, /hotfix-loader\.mjs$/] },
  { from: path.join('dist', 'web'), to: 'web' },
];

/* ------------------------------- 参数解析 ------------------------------- */

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const argAll = (name) => {
  const out = [];
  argv.forEach((v, i) => {
    if (v === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  });
  return out;
};
const dryRun = argv.includes('--dry-run');
const notes = arg('notes', '');
const sincePath = arg('since', '');
const seqArg = Number(arg('seq', '0')) || 0;
const keyPath = arg('key', path.join(root, '.hotfix-private.pem'));

if (!notes && !dryRun) {
  console.error('[hotfix] 必须写 --notes（它会显示在用户的设置页里，说明这次改了什么）');
  process.exit(1);
}

/* ------------------------------- 收集文件 ------------------------------- */

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, base, out);
    else if (ent.isFile()) out.push(path.relative(base, abs).replace(/\\/g, '/'));
  }
  return out;
}

const all = [];
for (const r of ROOTS) {
  const abs = path.join(root, r.from);
  if (!fs.existsSync(abs)) {
    console.error(`[hotfix] 缺少 ${r.from}（先跑 npm run build）`);
    process.exit(1);
  }
  for (const rel of walk(abs)) {
    if (r.skip?.some((re) => re.test(rel))) continue;
    all.push({ path: `${r.to}/${rel}`, abs: path.join(abs, rel) });
  }
}

/** 增量基线：上一次发布的清单（只带改过的文件，其余回落内置版本） */
const baseline = new Map();
let prevSeq = 0;
if (sincePath) {
  const prev = JSON.parse(fs.readFileSync(path.resolve(root, sincePath), 'utf8'));
  prevSeq = Number(prev.seq) || 0;
  for (const f of prev.files || []) baseline.set(f.path, f.sha256);
}

const files = [];
for (const f of all) {
  if (!fileAllowed(f.path)) {
    console.error(`[hotfix] 不允许的文件进了包：${f.path}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(f.abs);
  const hash = sha256(buf);
  // 增量模式下：内容没变就不带；index.html 永远带（它引用着新的哈希资源名）
  const changed = !sincePath || baseline.get(f.path) !== hash || f.path === 'web/index.html';
  if (!changed) continue;
  files.push({ path: f.path, sha256: hash, size: buf.length, abs: f.abs });
}

if (!files.length) {
  console.error('[hotfix] 没有需要发的文件（和基线完全一致）');
  process.exit(2);
}

/* ------------------------------- 清单签名 ------------------------------- */

// seq 必须严格递增：客户端拿它防「重放旧包」，倒退的包会被直接拒装
const seq = seqArg || prevSeq + 1;
// 下载地址同样 Gitee 优先：镜像滞后时该文件还不存在，客户端会自然落到 GitHub
const urls = argAll('url');
if (!urls.length) {
  if (GITEE) urls.push(`https://gitee.com/${GITEE}/raw/hotfix/pack-${seq}.zip`);
  urls.push(`https://github.com/${REPO}/releases/download/hotfix/pack-${seq}.zip`);
}

const manifest = {
  schemaVersion: SCHEMA_VERSION,
  shellVersion: pkg.version,
  seq,
  notes,
  createdAt: new Date().toISOString(),
  files: files
    .map(({ path: p, sha256: h, size }) => ({ path: p, sha256: h, size }))
    .sort((a, b) => a.path.localeCompare(b.path)),
  urls,
};

console.log(`[hotfix] seq #${seq}，壳版本 ${pkg.version}，库版本 v${SCHEMA_VERSION}`);
console.log(`[hotfix] 文件 ${files.length} 个，合计 ${(files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1)} KB`);
for (const f of files) console.log(`  ${f.path}  ${(f.size / 1024).toFixed(1)} KB`);
for (const u of urls) console.log(`  url ${u}`);

if (dryRun) process.exit(0);

let privateKey = '';
try {
  // CI 里私钥走 secret 注入，内容是 PEM 本身就当内容用；给的是路径就按文件读
  const env = process.env.HOTFIX_PRIVATE_KEY || '';
  if (env) privateKey = env.includes('BEGIN') ? env : fs.readFileSync(env, 'utf8');
  else privateKey = fs.readFileSync(keyPath, 'utf8');
} catch {
  console.error(`[hotfix] 读不到私钥（${keyPath} 或 HOTFIX_PRIVATE_KEY）。先跑 node scripts/hotfix-keygen.mjs`);
  process.exit(1);
}
const signed = signManifest(manifest, privateKey);

/* ------------------------------- 打包落盘 ------------------------------- */

const zip = new JSZip();
for (const f of files) zip.file(f.path, fs.readFileSync(f.abs));
// 清单一并放进包里：客户端启动时靠它验签 + 判断版本，不依赖外部文件
zip.file('manifest.json', `${JSON.stringify(signed, null, 2)}\n`);
const buf = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
});

fs.mkdirSync(OUT_DIR, { recursive: true });
const packName = `pack-${seq}.zip`;
fs.writeFileSync(path.join(OUT_DIR, packName), buf);
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(signed, null, 2)}\n`);
// 下次增量用的基线：和发布出去的那份保持一致
fs.writeFileSync(path.join(OUT_DIR, 'last-manifest.json'), `${JSON.stringify(signed, null, 2)}\n`);

console.log(`[hotfix] 已生成 ${path.join(OUT_DIR, packName)}（${(buf.length / 1024).toFixed(1)} KB）`);
console.log('[hotfix] 发布：把 pack 与 manifest.json 传到 hotfix 滚动 Release（manifest.json 用固定文件名）');
