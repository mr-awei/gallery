import React, { useEffect } from 'react';

/**
 * 裁切参数面板（单张裁切面板与批量裁切台共用一套控件）：
 * 尺寸（输出像素 + 锁比例）/ 比例（1:1、4:3、3:2、16:9 + 横竖切换）/ 焦点检测。
 *
 * 为什么抽出来：以前单张裁切只有一排「1:1 / 4:3 / 16:9」按钮，
 * 批量裁切台却有输出尺寸、预设比例、自动找主体，同一个动作两套界面两套行为。
 */

/**
 * 预设比例只留四个横向基准档，竖版（3:4、9:16）由「竖版」按钮把档位翻面得到 ——
 * 一排塞进 2:3 / 3:4 / 9:16 这类成对档位，按钮会挤成两行，且横竖语义重复。
 */
export const CROP_PRESETS = [
  { key: '1:1', w: 1, h: 1, label: '1:1' },
  { key: '4:3', w: 4, h: 3, label: '4:3' },
  { key: '3:2', w: 3, h: 2, label: '3:2' },
  { key: '16:9', w: 16, h: 9, label: '16:9' },
] as const;

export type CropPresetKey =
  | 'free'
  | 'orig'
  | '1:1'
  | '4:3'
  | '3:2'
  | '16:9'
  // 历史设置里可能存着成对档位（2:3 / 3:4 / 9:16）：按钮不再显示，但比例仍要算得出来
  | '2:3'
  | '3:4'
  | '9:16'
  | 'custom';

/** 预设键 → 宽高比（custom/free/orig 不在表里；含历史档位，保证旧设置能加载） */
const PRESET_WH: Record<string, { w: number; h: number }> = {
  '1:1': { w: 1, h: 1 },
  '4:3': { w: 4, h: 3 },
  '3:2': { w: 3, h: 2 },
  '16:9': { w: 16, h: 9 },
  '2:3': { w: 2, h: 3 },
  '3:4': { w: 3, h: 4 },
  '9:16': { w: 9, h: 16 },
};

export interface CropControlState {
  /** 当前比例档位；free/orig 只有单张裁切会出现 */
  preset: CropPresetKey;
  baseW: number;
  baseH: number;
  /** 竖版：把比例摆成高 > 宽；横版反之 */
  portrait: boolean;
  customW: string;
  customH: string;
  /** 不进行大小调整（保持裁切后的自然像素） */
  noResize: boolean;
  outW: string;
  outH: string;
  /** 改一边另一边按比例跟着算 */
  linkWH: boolean;
  autoFocus: boolean;
}

const isFreeRatio = (p: CropPresetKey) => p === 'free' || p === 'orig';

export function defaultCropControls(preset: CropPresetKey = '4:3'): CropControlState {
  // baseW/baseH 必须跟 preset 对齐，否则从 '1:1' 起步会莫名变成 4:3
  // 默认 4:3 + 竖版 = 3:4（图库里竖图居多）
  const wh = PRESET_WH[preset] || { w: 4, h: 3 };
  return {
    preset,
    baseW: wh.w,
    baseH: wh.h,
    portrait: true,
    customW: '5',
    customH: '4',
    noResize: true,
    outW: '',
    outH: '',
    linkWH: true,
    autoFocus: false,
  };
}

/** 比例（宽:高，数值） */
export function ratioWH(s: CropControlState): { w: number; h: number } {
  let w = s.baseW;
  let h = s.baseH;
  if (s.portrait && w > h) [w, h] = [h, w];
  if (!s.portrait && h > w) [w, h] = [h, w];
  return { w: w > 0 ? w : 1, h: h > 0 ? h : 1 };
}

/** 给 CropOverlay 的比例串：'free' | 'orig' | '2:3' ... */
export function cropRatioStr(s: CropControlState): string {
  if (s.preset === 'free') return 'free';
  if (s.preset === 'orig') return 'orig';
  const r = ratioWH(s);
  return `${r.w}:${r.h}`;
}

/**
 * 焦点检测用的比例串：自由/原比例没有固定画幅，就用当前图片自身的宽高比，
 * 让「按焦点排布」只是把框往主体上凑，而不是强行改画幅。
 */
export function cropFocusRatio(s: CropControlState, imageAspect: number): string {
  if (!isFreeRatio(s.preset)) {
    const r = ratioWH(s);
    return `${r.w}:${r.h}`;
  }
  const a = imageAspect > 0 ? imageAspect : 1;
  return `${Math.round(a * 1000) / 1000}:1`;
}

/** 输出像素：不调整尺寸时为 null（保持裁切后的自然尺寸） */
export function cropOutputSize(s: CropControlState): { w: number; h: number } | null {
  if (s.noResize) return null;
  const r = ratioWH(s);
  const w = Math.round(Number(s.outW) || 0);
  const h = Math.round(Number(s.outH) || 0);
  if (w >= 16 && h >= 16) return { w, h };
  if (w >= 16) return { w, h: Math.max(16, Math.round((w * r.h) / r.w)) };
  if (h >= 16) return { w: Math.max(16, Math.round((h * r.w) / r.h)), h };
  return null;
}

interface Props {
  value: CropControlState;
  onChange: (patch: Partial<CropControlState>) => void;
  disabled?: boolean;
  /** 允许「自由 / 原比例」：单张裁切用；批量裁切每张都得落到同一画幅，不开放 */
  allowFree?: boolean;
  /** 输出尺寸提示（单张按实际选框算，批量按比例算，不传则用 cropOutputSize） */
  outputHint?: React.ReactNode;
  /** 焦点检测进行中 */
  busy?: boolean;
  onFocus: () => void;
  onCenter: () => void;
  centerLabel?: string;
  focusLabel?: string;
}

export default function CropSettings({
  value: s,
  onChange,
  disabled,
  allowFree,
  outputHint,
  busy,
  onFocus,
  onCenter,
  centerLabel = '全部居中',
  focusLabel = '按焦点排布',
}: Props) {
  const ratioStr = cropRatioStr(s);
  const free = isFreeRatio(s.preset);
  const square = s.baseW === s.baseH; // 1:1：横竖按钮无意义
  const out = cropOutputSize(s);

  // 锁定长宽时，改比例自动换算另一边
  useEffect(() => {
    if (!s.linkWH || free) return;
    const w = Number(s.outW);
    if (w > 0) {
      const r = ratioWH(s);
      const h = String(Math.round((w * r.h) / r.w));
      if (h !== s.outH) onChange({ outH: h });
    }
    // 只在比例变化时重算，避免用户手改高度被立刻改回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioStr, free]);

  const applyCustom = (w: string, h: string) => {
    const nw = Number(w);
    const nh = Number(h);
    if (nw > 0 && nh > 0) {
      // 自定义比例按输入的字面方向（5:4 就是横的），别被「竖版」反过来
      onChange({ preset: 'custom', baseW: nw, baseH: nh, portrait: nw <= nh });
    }
  };

  return (
    <>
      <div className="cs-sec">
        <div className="cs-sec-title">尺寸</div>
        <div className="cs-wh">
          <label>
            <span>宽</span>
            <input
              className="input"
              inputMode="numeric"
              value={s.noResize ? '' : s.outW}
              placeholder="原尺寸"
              disabled={disabled || s.noResize}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d]/g, '');
                const patch: Partial<CropControlState> = { outW: v };
                if (s.linkWH && !free) {
                  const n = Number(v);
                  if (n > 0) {
                    const r = ratioWH(s);
                    patch.outH = String(Math.round((n * r.h) / r.w));
                  }
                }
                onChange(patch);
              }}
            />
          </label>
          <button
            className={`cs-link${s.linkWH ? ' on' : ''}`}
            onClick={() => onChange({ linkWH: !s.linkWH })}
            title={s.linkWH ? '已锁定比例：改一边另一边跟着算' : '已解锁：宽高各自输入'}
            disabled={disabled || free}
            type="button"
          >
            {s.linkWH ? '🔗' : '⛓'}
          </button>
          <label>
            <span>高</span>
            <input
              className="input"
              inputMode="numeric"
              value={s.noResize ? '' : s.outH}
              placeholder="原尺寸"
              disabled={disabled || s.noResize}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d]/g, '');
                const patch: Partial<CropControlState> = { outH: v };
                if (s.linkWH && !free) {
                  const n = Number(v);
                  if (n > 0) {
                    const r = ratioWH(s);
                    patch.outW = String(Math.round((n * r.w) / r.h));
                  }
                }
                onChange(patch);
              }}
            />
          </label>
        </div>
        <label className="lb-radio cs-check">
          <input
            type="checkbox"
            checked={s.noResize}
            disabled={disabled}
            onChange={(e) => onChange({ noResize: e.target.checked })}
          />
          <span>不进行大小调整</span>
        </label>
        <p className="cs-tip">
          {outputHint ?? (out ? `输出 ${out.w} × ${out.h} px` : '保持裁切后的自然像素尺寸')}
        </p>
      </div>

      <div className="cs-sec">
        <div className="cs-sec-title">比例</div>
        <div className="cs-presets">
          {CROP_PRESETS.map((p) => {
            // 文案跟着方向翻面：竖版时 4:3 档读作 3:4、16:9 档读作 9:16。
            // 否则会出现「我点的明明是 16:9，怎么出来一张竖图」的困惑。
            const flipped = s.portrait && p.w !== p.h;
            const label = flipped ? `${p.h}:${p.w}` : p.label;
            return (
              <button
                key={p.key}
                className={`btn sm${s.preset === p.key ? ' primary' : ''}`}
                disabled={disabled}
                title={`按 ${label} 比例裁切（居中最大区域，可再拖动调整；方向由下面的竖版/横版决定）`}
                // 不碰 portrait：批量裁 500 张竖图时，先点「竖版」再换比例不该被弹回横版。
                // 档位按钮只负责宽高比，方向是独立的开关。
                onClick={() => onChange({ preset: p.key, baseW: p.w, baseH: p.h })}
              >
                {label}
              </button>
            );
          })}
          <button
            className={`btn sm${s.preset === 'custom' ? ' primary' : ''}`}
            disabled={disabled}
            onClick={() => applyCustom(s.customW, s.customH)}
          >
            自定义
          </button>
        </div>
        {/* 横竖紧跟在比例后面：选完宽高比，下一件事就是定方向 */}
        <div className="cs-orient">
          <button
            className={`btn sm${s.portrait ? ' primary' : ''}`}
            disabled={disabled || free || square}
            title={square ? '方图没有横竖之分' : '把当前比例翻成竖版（4:3 → 3:4、16:9 → 9:16）'}
            onClick={() => onChange({ portrait: true })}
          >
            竖版
          </button>
          <button
            className={`btn sm${!s.portrait ? ' primary' : ''}`}
            disabled={disabled || free || square}
            title={square ? '方图没有横竖之分' : '把当前比例翻成横版（3:4 → 4:3、9:16 → 16:9）'}
            onClick={() => onChange({ portrait: false })}
          >
            横版
          </button>
        </div>
        {allowFree && (
          <div className="cs-presets">
            <button
              className={`btn sm${s.preset === 'free' ? ' primary' : ''}`}
              disabled={disabled}
              onClick={() => onChange({ preset: 'free' })}
              title="自由裁切：拖动选框四边四角任意调整"
            >
              自由
            </button>
            <button
              className={`btn sm${s.preset === 'orig' ? ' primary' : ''}`}
              disabled={disabled}
              onClick={() => onChange({ preset: 'orig' })}
              title="保持原图比例自由裁切"
            >
              原比例
            </button>
          </div>
        )}
        <div className="cs-custom">
          <input
            className="input"
            inputMode="decimal"
            value={s.customW}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d.]/g, '');
              onChange({ customW: v });
              if (s.preset === 'custom') applyCustom(v, s.customH);
            }}
          />
          <span>:</span>
          <input
            className="input"
            inputMode="decimal"
            value={s.customH}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d.]/g, '');
              onChange({ customH: v });
              if (s.preset === 'custom') applyCustom(s.customW, v);
            }}
          />
        </div>
        <p className="cs-tip">
          {s.preset === 'free'
            ? '自由裁切：拖动选框四边四角任意调整'
            : s.preset === 'orig'
              ? '原比例：拖动改变大小，画幅不变'
              : `当前 ${ratioStr}`}
        </p>
      </div>

      <div className="cs-sec">
        <div className="cs-sec-title">焦点</div>
        <label className="lb-radio cs-check">
          <input
            type="checkbox"
            checked={s.autoFocus}
            disabled={disabled}
            onChange={(e) => onChange({ autoFocus: e.target.checked })}
          />
          <span>自动检测图像焦点</span>
        </label>
        <p className="cs-tip">按轮廓 + 肤色 + 饱和度找主体，把人脸/主体放进框内；勾选后改比例也会重新检测。</p>
        <div className="cs-actions">
          <button className="btn sm" disabled={disabled || busy} onClick={onCenter}>
            {centerLabel}
          </button>
          <button className="btn sm" disabled={disabled || busy} onClick={onFocus}>
            {busy ? '检测中…' : focusLabel}
          </button>
        </div>
      </div>
    </>
  );
}
