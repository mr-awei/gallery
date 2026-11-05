/**
 * 水印预设：把整套排版参数存成一条，随时套回来；也能导出成 JSON 发给别人。
 *
 * 存哪：settings.watermarkPresets（跨库共享，见 server/db.js 的 GLOBAL_SETTING_KEYS）。
 * 为什么不用单独的表：预设就是十几条参数，不需要查询/索引，放进设置省掉一套增删改查。
 *
 * 这份文件只管「形状」：挑参数、清洗导入的文件、按名字合并。渲染一律走服务端
 * normalizeParams，所以这里宽松一些（脏值丢掉、缺值补默认），不会把面板搞崩。
 */
import type { WatermarkParams } from '../api';
import type { WatermarkPreset, WatermarkPresetParams } from '../types';

/** 导出文件的标识：导入时先认这个，避免把随便一个 JSON 当预设灌进来 */
export const PRESET_KIND = 'tuku.watermark-presets';
export const PRESET_VERSION = 1;

const str = (v: unknown, max: number, dflt = ''): string => {
  const s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
  return (s || dflt).slice(0, max);
};

const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

/** 从面板当前参数里摘出要存的那些（saveMode / targetDir 属于「这次怎么存」，不进预设） */
export function pickPresetParams(p: WatermarkParams): WatermarkPresetParams {
  return {
    style: str(p.style, 40, 'corner-br'),
    frame: str(p.frame, 40, 'none'),
    fields: Array.isArray(p.fields) ? p.fields.map((f) => String(f)).slice(0, 12) : [],
    logo: bool(p.logo, true),
    brand: str(p.brand, 40, 'auto'),
    model: str(p.model, 60),
    size: num(p.size, 0.5, 3, 1),
    opacity: num(p.opacity, 0.15, 1, 1),
    color: str(p.color, 40, 'auto'),
    font: str(p.font, 80, 'auto'),
    location: str(p.location, 80),
    // 三级选择器的选择结果：套用预设后要能还原「省/市/区」这三个下拉，
    // 只存拼好的字符串就得让用户重选一遍
    place: {
      province: str(p.place?.province, 20),
      city: str(p.place?.city, 20),
      district: str(p.place?.district, 20),
      detail: str(p.place?.detail, 40),
    },
  };
}

/** 清洗一条预设（导入的文件、库里读到的旧数据都走这里）；不合规就返回 null */
export function sanitizePreset(raw: unknown): WatermarkPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 40);
  if (!name) return null;
  const params = r.params && typeof r.params === 'object' ? (r.params as Record<string, unknown>) : {};
  const picked = pickPresetParams(params as WatermarkParams);
  // 一条「什么都没存」的预设套上去等于复位，没必要留着
  if (picked.style === 'none' && picked.frame === 'none') return null;
  return {
    id: str(r.id, 64) || newPresetId(),
    name,
    params: picked,
    at: num(r.at, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
}

export function newPresetId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function makePreset(name: string, params: WatermarkParams): WatermarkPreset | null {
  return sanitizePreset({ id: newPresetId(), name, params: pickPresetParams(params), at: Date.now() });
}

/** 读进来的 JSON：认 { kind, version, presets } 也认裸数组；顺手统计被丢掉几条 */
export function parsePresetFile(raw: unknown): { presets: WatermarkPreset[]; skipped: number } {
  let list: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    // 只认后缀：早先导出的文件 kind 前缀不同，但结构完全一样，不该因此拒收
    if (obj.kind && !String(obj.kind).endsWith('.watermark-presets')) {
      throw new Error('这不是水印预设文件（kind 不匹配）');
    }
    list = obj.presets;
  }
  if (!Array.isArray(list)) throw new Error('预设文件格式不对：里面没有 presets 数组');
  const presets: WatermarkPreset[] = [];
  let skipped = 0;
  for (const item of list) {
    const p = sanitizePreset(item);
    if (p) presets.push(p);
    else skipped += 1;
  }
  return { presets, skipped };
}

export function presetFileText(presets: WatermarkPreset[]): string {
  return JSON.stringify(
    { kind: PRESET_KIND, version: PRESET_VERSION, exportedAt: new Date().toISOString(), presets },
    null,
    2
  );
}

/**
 * 合并导入的预设：同名（不分大小写）覆盖原条目、保留原 id，其余追加。
 * 这样反复导入同一份文件不会越导越多，也不会把用户改过名的旧条目丢掉。
 */
export function mergePresets(
  current: WatermarkPreset[],
  incoming: WatermarkPreset[]
): { presets: WatermarkPreset[]; added: number; replaced: number } {
  const next = [...current];
  let added = 0;
  let replaced = 0;
  for (const p of incoming) {
    const i = next.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (i >= 0) {
      next[i] = { ...p, id: next[i].id };
      replaced += 1;
    } else {
      next.push(p);
      added += 1;
    }
  }
  return { presets: next, added, replaced };
}
