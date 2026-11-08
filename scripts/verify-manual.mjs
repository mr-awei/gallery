/**
 * 手动验证脚本的登记检查（接入 npm run verify）。
 *
 * scripts/manual 下这些脚本需要本机 dev server / agent-browser / 真实图库数据，
 * 不能在 CI 里自动执行；但「脚本被删了、语法坏了、前提没人记得」同样是回归。
 * verify 至少保证：清单齐全、每个脚本能被 Node 解析、运行前提与命令都在输出里可见。
 * 真正的交互验证仍按输出的命令手工跑，结果不会伪装成自动通过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manualDir = path.join(root, 'scripts', 'manual');

/** 文件名 → 用途 / 为什么不能自动跑 */
const REGISTRY = {
  'verify-browse.mjs': '浏览页交互（需 dev 页面 + agent-browser）',
  'verify-filterbar.mjs': '筛选栏交互（需 dev 页面 + agent-browser）',
  'verify-live.mjs': '动态壁纸配置（需桌面端 + 本机视频文件）',
  'verify-tidy-ui.mjs': '整理页 UI（需 dev 页面 + 真实库数据）',
  'verify-tidy.mjs': '整理后端断言（依赖真实图库样本数据）',
  'verify-tray-ui.mjs': '托盘与自绘提示窗（需桌面端窗口）',
  'test-clip-align.mjs': 'CLIP 图文对齐抽查（需已下载模型）',
  'test-clip-proj.mjs': 'CLIP 投影抽查（需已下载模型）',
  'test-clip-text.mjs': 'CLIP 文本塔抽查（需已下载模型）',
  'test-psd.mjs': 'PSD 解析抽查（需样本文件）',
};

let bad = 0;
for (const [file, desc] of Object.entries(REGISTRY)) {
  const full = path.join(manualDir, file);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ ${file} 缺失：${desc}`);
    bad++;
    continue;
  }
  const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`  ✗ ${file} 语法检查失败：${String(r.stderr || '').trim().split('\n')[0]}`);
    bad++;
    continue;
  }
  console.log(`  ✓ ${file} — ${desc}`);
}

// 新加进来的脚本必须登记，否则又变成「谁都不会执行」的孤儿
const known = new Set([...Object.keys(REGISTRY), '_cap.mjs', 'gen-extension-icons.mjs']);
for (const f of fs.readdirSync(manualDir).filter((f) => f.endsWith('.mjs'))) {
  if (!known.has(f)) {
    console.warn(`  ! ${f} 未登记到 scripts/verify-manual.mjs 的 REGISTRY`);
  }
}

if (!fs.existsSync(path.join(manualDir, 'README.md'))) {
  console.error('  ✗ README.md 缺失：手工验证的运行前提没有说明');
  bad++;
}

// 真正实跑可自动化的无头脚本（不依赖 dev 页面 / agent-browser / 真实图库数据）。
// 其余 GUI / 需真实样本的脚本仍只做登记 + 语法检查，结果按 README 手工验证。
const AUTO_RUN = ['test-psd.mjs'];
console.log('\n  实跑无头脚本：');
for (const f of AUTO_RUN) {
  const full = path.join(manualDir, f);
  if (!fs.existsSync(full)) {
    console.warn(`  ! ${f} 不存在，跳过实跑`);
    continue;
  }
  const r = spawnSync(process.execPath, [full], { encoding: 'utf8', cwd: root });
  const out = String(r.stdout || '').trim().split('\n').slice(-3).join(' ｜ ');
  if (r.status === 0) console.log(`  ✓ ${f} 实跑通过（${out}）`);
  else {
    console.error(`  ✗ ${f} 实跑失败（退出码 ${r.status}）：${String(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
    bad++;
  }
}

console.log(`  手动运行：node scripts/manual/<脚本名>（先起 dev 页面；GUI 脚本另需 agent-browser）`);
if (bad) {
  console.error(`[verify:manual] ${bad} 项异常`);
  process.exit(1);
}
console.log(`[verify:manual] ${Object.keys(REGISTRY).length} 个脚本登记齐全且语法正常；已实跑 ${AUTO_RUN.length} 个无头脚本；交互结果需按说明手工验证`);
