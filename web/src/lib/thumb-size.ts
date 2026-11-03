/**
 * 图库缩略图尺寸：滑块（无极）与五档预设共用同一套数值。
 *
 * 列宽 px 直接决定瀑布流/网格的列数，所以档位不是「缩放百分比」而是真实列宽。
 * 默认 250 = 「中小」，与旧版默认完全一致 —— 老用户升级后画面不会突然变大变小。
 */
export const THUMB_MIN = 140;
export const THUMB_MAX = 640;
export const THUMB_DEFAULT = 250;

export interface ThumbPreset {
  key: string;
  label: string;
  width: number;
}

/**
 * 五档预设：小 / 中小 / 中 / 中大 / 大。
 * 「大」给到 640，宽屏下一屏大约两三列，用来挑细节够用。
 */
export const THUMB_PRESETS: ThumbPreset[] = [
  { key: 'xs', label: '小', width: 170 },
  { key: 'sm', label: '中小', width: THUMB_DEFAULT },
  { key: 'md', label: '中', width: 340 },
  { key: 'lg', label: '中大', width: 450 },
  { key: 'xl', label: '大', width: 640 },
];

/** 当前列宽落在哪一档（滑块拖到档位附近也算，避免差 1px 就显示「自定义」） */
export function thumbPresetOf(width: number): ThumbPreset | null {
  return THUMB_PRESETS.find((p) => Math.abs(p.width - width) <= 8) ?? null;
}

/** 把任意输入收进合法区间；非法值回落到默认档 */
export function clampThumbWidth(v: number): number {
  if (!Number.isFinite(v)) return THUMB_DEFAULT;
  return Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(v)));
}
