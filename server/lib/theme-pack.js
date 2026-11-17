// @ts-check
/**
 * 创意工坊 / 主题包（.tuku-pack）格式与校验。
 *
 * 一个包就是一个 JSON 文件：主题变量覆盖 + 壁纸设置子集 + 少量内嵌图片。
 * 不放社区 / 在线商店（产品决策未定），导出的是普通文件，靠微信/网盘/邮件分享，
 * 本机工坊目录负责收集已经导入过的包。
 *
 * 安全：包是别人给的文件，所有 CSS 值都过白名单正则，禁止 url() / var() / 分号
 * / 花括号，避免「导入一个主题」变成样式注入；图片只收常见位图 data URL。
 */
export const PACK_KIND = 'tuku.theme-pack';
export const PACK_VERSION = 1;
export const MAX_ASSETS = 4;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** 允许被主题包覆盖的 CSS 变量：只开放配色 / 圆角 / 缩放，不碰布局关键量 */
export const ALLOWED_VARS = [
  '--accent', '--accent-2', '--bg', '--bg-soft', '--panel', '--border',
  '--text', '--muted', '--ok', '--warn', '--err', '--radius', '--gradient',
];
/**
 * 允许带进包的壁纸设置键。绝不包含凭据、本机绝对路径、可信目录、
 * allowLocalUrl（会放开本地网页）与运行态游标/图片 id —— 那些跨机器既无效又危险。
 */
export const ALLOWED_SETTING_KEYS = ['wallpaperFill', 'wallpaperMode', 'screensaver'];
export const ALLOWED_LIVE_KEYS = [
  'enabled', 'mode', 'intervalSec', 'kenBurns', 'scope', 'minScore', 'params',
  'mute', 'volume', 'shaderPreset', 'shaderSource', 'audioSource', 'interactive',
  'pauseOnGpu', 'gpuThreshold', 'pauseApps', 'pauseOnBattery', 'pauseOnFullscreen',
  'clickThrough',
];
export const ALLOWED_AUTO_KEYS = [
  'enabled', 'mode', 'atTime', 'weekday', 'dayOfMonth', 'minutes', 'scope',
  'order', 'minScore', 'perMonitorDifferent', 'useAiFit', 'useTimeAware',
  'feedbackToKb', 'autoEnhance',
];

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LENGTH = /^\d{1,4}(?:\.\d{1,3})?(?:px|rem|%)$/;
const GRADIENT = /^(?:linear|radial)-gradient\([a-z0-9#,%.()\s/-]{1,200}\)$/i;
const SAFE_NAME = /^[\p{L}\p{N}._()\- ]{1,80}$/u;
/** 字体名只能是可读的字体栈；分号/花括号/url()/尖括号一律拒绝（--ui-font 会被 setProperty 直接写入） */
const SAFE_FONT = /^[\p{L}\p{N} ,.'"_-]{0,120}$/u;
const ASSET_NAME = /^[\w.\-() ]{1,80}\.(?:png|jpe?g|webp|gif)$/i;
const ASSET_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

export function safeCssValue(key, value) {
  const v = String(value ?? '').trim().slice(0, 240);
  if (!ALLOWED_VARS.includes(key)) return null;
  if (COLOR.test(v) || LENGTH.test(v) || v === 'none' || GRADIENT.test(v)) return v;
  return null;
}

function cleanVars(raw) {
  const out = {};
  const skipped = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { out, skipped };
  for (const [k, v] of Object.entries(raw)) {
    const safe = safeCssValue(k, v);
    if (safe === null) skipped.push(k);
    else out[k] = safe;
    if (Object.keys(out).length >= ALLOWED_VARS.length) break;
  }
  return { out, skipped };
}

function cleanAssets(raw) {
  const out = [];
  const skipped = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const a of list) {
    if (out.length >= MAX_ASSETS) break;
    const name = String(a?.name || '').trim();
    const m = ASSET_URL.exec(String(a?.dataUrl || ''));
    if (!ASSET_NAME.test(name) || !m) {
      skipped.push(name || '(无名图片)');
      continue;
    }
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
      skipped.push(name);
      continue;
    }
    out.push({ name, dataUrl: `data:image/${m[1]};base64,${m[2]}` });
  }
  return { out, skipped };
}

/** 从当前设置里挑出可分享的壁纸子集 */
export function pickWallpaperSettings(settings) {
  const out = {};
  for (const k of ALLOWED_SETTING_KEYS) {
    if (settings && settings[k] !== undefined) out[k] = settings[k];
  }
  const live = settings?.liveWallpaper;
  if (live && typeof live === 'object') {
    const sub = {};
    for (const k of ALLOWED_LIVE_KEYS) {
      if (live[k] !== undefined) sub[k] = live[k];
    }
    if (Object.keys(sub).length) out.liveWallpaper = sub;
  }
  const auto = settings?.autoWallpaper;
  if (auto && typeof auto === 'object') {
    const sub = {};
    for (const k of ALLOWED_AUTO_KEYS) {
      if (auto[k] !== undefined) sub[k] = auto[k];
    }
    if (Object.keys(sub).length) out.autoWallpaper = sub;
  }
  return out;
}

/** 构造一个包（导出时用），顺便把不合规字段剔掉并记进 skipped */
export function buildThemePack(input = {}) {
  const { out: vars, skipped: badVars } = cleanVars(input.theme?.variables);
  const { out: assets, skipped: badAssets } = cleanAssets(input.assets);
  let settings = {};
  let badSettings = [];
  if (input.settings && typeof input.settings === 'object') {
    settings = pickWallpaperSettings(input.settings);
    badSettings = Object.keys(input.settings).filter((k) => !(k in settings));
  }
  return {
    pack: {
      kind: PACK_KIND,
      version: PACK_VERSION,
      id: String(input.id || `pack-${Date.now()}`).replace(/[^\w.-]/g, '').slice(0, 60) || `pack-${Date.now()}`,
      name: SAFE_NAME.test(String(input.name || '').trim()) ? String(input.name).trim() : '未命名主题',
      author: SAFE_NAME.test(String(input.author || '').trim())
        ? String(input.author).trim().slice(0, 80)
        : '',
      createdAt: new Date().toISOString(),
      theme: {
        base: input.theme?.base === 'dark' ? 'dark' : 'light',
        variables: vars,
        fontFamily: SAFE_FONT.test(String(input.theme?.fontFamily || '').trim())
          ? String(input.theme?.fontFamily || '').trim().slice(0, 120)
          : '',
      },
      settings,
      assets,
    },
    skipped: [...badVars.map((k) => `变量 ${k}`), ...badAssets.map((n) => `图片 ${n}`), ...badSettings.map((k) => `设置 ${k}`)],
  };
}

/** 解析别人给的包：kind/version 必须匹配，其余字段逐项清洗 */
export function parseThemePack(textOrObject) {
  let raw = textOrObject;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: '不是合法的 JSON 主题包' };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '主题包内容为空' };
  if (raw.kind !== PACK_KIND) return { error: `不是图库主题包（kind=${String(raw.kind).slice(0, 40)}）` };
  if (Number(raw.version) > PACK_VERSION) return { error: `主题包版本 ${raw.version} 高于当前支持的 ${PACK_VERSION}，请升级应用` };
  const built = buildThemePack({
    id: raw.id,
    name: raw.name,
    author: raw.author,
    theme: raw.theme,
    settings: raw.settings,
    assets: raw.assets,
  });
  return { pack: built.pack, skipped: built.skipped };
}

/** 导入时只挑出能直接落到设置里的键 */
export function settingsPatchOf(pack) {
  return pickWallpaperSettings(pack?.settings || {});
}
