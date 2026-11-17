/**
 * electron-builder afterPack：产物级瘦身。
 *
 * 为什么要单独一步：打包体积里最能省的一块是 onnxruntime-node 的预编译二进制，
 * npm 包一次带齐 win32/darwin/linux 的 x64+arm64 五套（约 208MB），而我们每个安装包
 * 只会用其中一套。按目标平台/架构留下对应目录，其余直接删掉 —— 这是「按平台裁剪」，
 * 不能写进 package.json 的 files 负模式，因为那会连 macOS / Linux 构建一起裁错。
 *
 * 同时兜一道底：three / xlsx / mammoth / onnxruntime-web 只服务前端构建，
 * 已经在 dependencies 里移除、files 里排除，万一依赖收集又把它们带回来，这里再删一次。
 */
const fs = require('node:fs');
const path = require('node:path');

// electron-builder 的 Arch 枚举
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

/** 纯前端依赖：产物里出现就删（包体大、服务端不用） */
const WEB_ONLY = ['onnxruntime-web', 'three', 'xlsx', 'mammoth', 'codepage'];

/**
 * Chromium 自带 55 种界面语言包（合计约 48MB），应用界面只有中文、没有多语言切换。
 * 只留简繁中文与英文，其余删掉 —— Electron 找不到对应 pak 会回落到 en-US，不会崩。
 */
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);

function rm(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    // 被安全软件占住时不值得让整次打包失败：少省几十 MB 远好过没有产物
    console.warn(`[after-pack] 删除失败（忽略）${target}：${err?.message || err}`);
  }
}

/** 只保留当前平台/架构的 onnxruntime 原生库 */
function pruneOnnxRuntime(unpackedModules, platform, arch) {
  const binRoot = path.join(unpackedModules, 'onnxruntime-node', 'bin', 'napi-v3');
  if (!fs.existsSync(binRoot)) return 0;
  let removed = 0;
  for (const plat of fs.readdirSync(binRoot)) {
    const platDir = path.join(binRoot, plat);
    if (plat !== platform) {
      rm(platDir);
      removed += 1;
      continue;
    }
    // universal 包要同时留 x64 与 arm64
    if (arch === 'universal') continue;
    for (const item of fs.readdirSync(platDir)) {
      if (item === arch) continue;
      rm(path.join(platDir, item));
      removed += 1;
    }
  }
  return removed;
}

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
  const arch = ARCH_NAMES[context.arch] || 'x64';
  const resources = path.join(context.appOutDir, 'resources');
  const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules');

  if (fs.existsSync(unpackedModules)) {
    const removedDirs = pruneOnnxRuntime(unpackedModules, platform, arch);
    for (const pkg of WEB_ONLY) rm(path.join(unpackedModules, pkg));
    console.info(
      `[after-pack] ${platform}/${arch}：onnxruntime 裁掉 ${removedDirs} 个无关平台目录，` +
        `并清理 ${WEB_ONLY.length} 个纯前端包`
    );
  }

  const asar = path.join(resources, 'app.asar');
  if (fs.existsSync(asar)) {
    console.info(`[after-pack] app.asar ${(fs.statSync(asar).size / 1048576).toFixed(1)} MB`);
  }

  // 界面语言包：只留中文与英文
  const localesDir = path.join(context.appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    let dropped = 0;
    for (const file of fs.readdirSync(localesDir)) {
      if (KEEP_LOCALES.has(file)) continue;
      rm(path.join(localesDir, file));
      dropped += 1;
    }
    console.info(`[after-pack] 语言包裁掉 ${dropped} 个（保留简体/繁体中文与英文）`);
  }
};
