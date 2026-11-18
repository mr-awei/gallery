import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type {
  AdjustParams,
  ColorGradeParams,
  GradeZone,
  GradeZoneKey,
  HueBandKey,
  MixBandKey,
  MixTab,
} from '../types';
import {
  COLOR_GRADE_DEFAULTS,
  COLOR_MIXER_DEFAULTS,
  CURVES_DEFAULTS,
  GRADE_ZONES,
  HUE_BANDS,
  HUE_SAT_DEFAULTS,
  MIX_BANDS,
  MIX_TABS,
  makeColorGrade,
  makeColorMixer,
} from '../types';
import ColorWheel from './ColorWheel';
import CurveEditor from './CurveEditor';
import { IconRotateCcw, IconRotateCw, IconWand } from './Icons';
import i18n from '../i18n';

/** 每个色相通道的中心 hue（PS 风格：选中某通道时滑块轨道显示该通道范围内的色相） */
const HUE_BAND_CENTER: Record<HueBandKey, number> = {
  master: -1, // master 显示完整彩虹
  red: 0,
  yellow: 60,
  green: 120,
  cyan: 180,
  blue: 240,
  magenta: 300,
};

/** 生成色相滑块轨道渐变：master → 完整彩虹；单通道 → 该通道 ±35° 的范围 */
function hueTrackGradient(channel: HueBandKey, colorize: boolean) {
  if (channel === 'master') {
    return colorize
      ? 'linear-gradient(90deg,hsl(0,85%,55%),hsl(60,85%,55%),hsl(120,85%,55%),hsl(180,85%,55%),hsl(240,85%,55%),hsl(300,85%,55%),hsl(360,85%,55%))'
      : 'linear-gradient(90deg,hsl(145,85%,55%),hsl(325,85%,55%))';
  }
  const center = HUE_BAND_CENTER[channel] ?? 0;
  const start = (center - 35 + 360) % 360;
  const end = (center + 35) % 360;
  return `linear-gradient(90deg,hsl(${start},85%,55%),hsl(${center},85%,55%),hsl(${end},85%,55%))`;
}

type NumericKey = Exclude<keyof AdjustParams, 'curves' | 'hueSat' | 'colorMixer' | 'colorGrade'>;

interface SliderDef {
  key: NumericKey;
  label: string;
  min?: number;
  /** 滑块强调色（白平衡轨道给出冷暖/绿品红的方向暗示） */
  accent?: string;
}

/** 分组顺序参考 Camera Raw 的「基本」面板：白平衡 → 影调 → 色彩 → 细节 → 曲线 */
const GROUPS: { title: string; wb?: boolean; sliders: SliderDef[] }[] = [
  {
    title: i18n.t('k49fce4d0'),
    wb: true,
    sliders: [
      { key: 'temperature', label: i18n.t('k15544d7a'), accent: 'linear-gradient(90deg,#5b9dff,#c9d4e6,#ffb357)' },
      { key: 'tint', label: i18n.t('ke27fa2b1'), accent: 'linear-gradient(90deg,#4ade80,#c9d4e6,#e879f9)' },
    ],
  },
  {
    title: i18n.t('k22f17027'),
    sliders: [
      { key: 'exposure', label: i18n.t('k131f6f6b') },
      { key: 'contrast', label: i18n.t('kadc0d88f') },
      { key: 'highlights', label: i18n.t('k57b026b7') },
      { key: 'shadows', label: i18n.t('k803205e3') },
      { key: 'whites', label: i18n.t('k2fc96b27') },
      { key: 'blacks', label: i18n.t('k9d2d1f62') },
    ],
  },
  {
    title: i18n.t('k88b1d5ce'),
    sliders: [
      { key: 'saturation', label: i18n.t('kbd05021d') },
      { key: 'vibrance', label: i18n.t('k2fcb9a85') },
      { key: 'hue', label: i18n.t('k8b232299') },
    ],
  },
];

/** 细节组放在混色器/颜色分级之后（Camera Raw 面板顺序：基本 → 曲线 → 混色器 → 颜色分级 → 细节） */
const DETAIL_SLIDERS: SliderDef[] = [
  { key: 'clarity', label: i18n.t('k48f1cd8c'), min: 0 },
  { key: 'sharpen', label: i18n.t('kab3312d7'), min: 0 },
];

export interface WbSample {
  r: number;
  g: number;
  b: number;
}

const toHex = (v: number) => v.toString(16).padStart(2, '0');
const sampleHex = (s: WbSample) => `#${toHex(s.r)}${toHex(s.g)}${toHex(s.b)}`;

interface Props {
  value: AdjustParams;
  onChange: (p: AdjustParams) => void;
  disabled?: boolean;
  /** 白平衡吸管：父组件在图上接管一次点击，取色后回写 temperature/tint */
  onPickWhite?: () => void;
  picking?: boolean;
  /** 自动白平衡：父组件统计预览像素（中性像素 + 白点估计）后回写 */
  onAutoWhite?: () => void;
  /** 全自动调色：父组件读像素，一次性给出白平衡/曝光/主曲线/影调/色彩（含肤色保护） */
  onAutoTone?: () => void;
  /** 撤销 / 重做：父组件持有调色参数的历史栈（Ctrl+Z / Ctrl+Y 同一套） */
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** 最近一次吸管取样值（显示具体 RGB，便于判断吸得对不对） */
  sample?: WbSample | null;
  onClearSample?: () => void;
}

/** 键盘操作面板的入口（像素蛋糕同款：Ctrl+数字定位、Tab 上下切换、上下键微调） */
export interface AdjustPanelHandle {
  /** 聚焦第 i 个滑杆（0 起，按面板视觉顺序）；越界返回 false */
  focusSlider: (i: number) => boolean;
  /** 上下切换滑杆 */
  stepSlider: (dir: 1 | -1) => void;
  /** 微调当前滑杆（mult=10 即 Shift 倍数） */
  nudge: (dir: 1 | -1, mult: number) => void;
  /** 当前聚焦的滑杆 key（没聚焦在滑杆上则为 null） */
  activeKey: () => string | null;
}

/**
 * Camera Raw 调色面板（单张与批量共用）。
 * 滑块双击归零；白平衡组带吸管与取样读数；底部是四通道曲线。
 */
function AdjustPanelInner(
  {
    value,
    onChange,
    disabled,
    onPickWhite,
    picking,
    onAutoWhite,
    onAutoTone,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    sample,
    onClearSample,
  }: Props,
  ref: React.Ref<AdjustPanelHandle>,
) {
  const set = (k: NumericKey, v: number) => onChange({ ...value, [k]: v });

  // PS「色相/饱和度」：当前通道（着色时锁死全图）
  const [channel, setChannel] = useState<HueBandKey>('master');
  const hs = value.hueSat || HUE_SAT_DEFAULTS;
  const band = hs.bands[channel] || { h: 0, s: 0, l: 0 };
  const colorize = hs.colorize;

  const patchHs = (patch: Partial<typeof hs>) => onChange({ ...value, hueSat: { ...hs, ...patch } });
  const patchBand = (patch: Partial<typeof band>) =>
    patchHs({ bands: { ...hs.bands, [channel]: { ...band, ...patch } } });
  const resetChannel = () => {
    if (colorize) {
      patchHs({ colorizeHue: HUE_SAT_DEFAULTS.colorizeHue, colorizeSat: HUE_SAT_DEFAULTS.colorizeSat, colorizeLight: 0 });
    } else {
      patchBand({ h: 0, s: 0, l: 0 });
    }
  };
  const dirty = (key: HueBandKey) => {
    const b = hs.bands[key];
    return !!b && !!(b.h || b.s || b.l);
  };

  const hueValue = colorize ? hs.colorizeHue : band.h;
  const satValue = colorize ? hs.colorizeSat : band.s;
  const lightValue = colorize ? hs.colorizeLight : band.l;
  const setHue = (v: number) => (colorize ? patchHs({ colorizeHue: v }) : patchBand({ h: v }));
  const setSat = (v: number) => (colorize ? patchHs({ colorizeSat: v }) : patchBand({ s: v }));
  const setLight = (v: number) => (colorize ? patchHs({ colorizeLight: v }) : patchBand({ l: v }));

  /* ---------------- Camera Raw 混色器：8 色带 × 三页签 ---------------- */
  const [mixTab, setMixTab] = useState<MixTab>('hue');
  const cm = value.colorMixer || COLOR_MIXER_DEFAULTS;
  const mixProp: 'h' | 's' | 'l' = mixTab === 'hue' ? 'h' : mixTab === 'sat' ? 's' : 'l';
  const setMix = (key: MixBandKey, v: number) => {
    const cur = cm.bands[key] || { h: 0, s: 0, l: 0 };
    onChange({ ...value, colorMixer: { ...cm, bands: { ...cm.bands, [key]: { ...cur, [mixProp]: v } } } });
  };
  const mixDirty = (key: MixBandKey) => {
    const b = cm.bands[key];
    return !!b && !!(b.h || b.s || b.l);
  };

  /* ---------------- Camera Raw 颜色分级：四区 + 混合/平衡 ---------------- */
  const [zoneKey, setZoneKey] = useState<GradeZoneKey>('shadows');
  const cg = value.colorGrade || COLOR_GRADE_DEFAULTS;
  const zone: GradeZone = cg.zones[zoneKey] || { hue: 0, sat: 0, lum: 0 };
  const patchGrade = (patch: Partial<ColorGradeParams>) => onChange({ ...value, colorGrade: { ...cg, ...patch } });
  const patchZone = (patch: Partial<GradeZone>) =>
    patchGrade({ zones: { ...cg.zones, [zoneKey]: { ...zone, ...patch } } });
  const zoneDirty = (key: GradeZoneKey) => {
    const z = cg.zones[key];
    return !!z && !!(z.sat || z.lum);
  };

  /* ---------------- 键盘操作（像素蛋糕同款）：滑杆注册表 ---------------- */
  // 顺序即面板里从上到下的视觉顺序，Ctrl+1~9 与 Tab 都按它走
  const sliderDefs = useMemo<SliderDef[]>(
    () => [...GROUPS.flatMap((g) => g.sliders), ...DETAIL_SLIDERS],
    [],
  );
  const sliderRefs = useRef<Partial<Record<string, HTMLInputElement | null>>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focusSlider(i) {
        const def = sliderDefs[i];
        const el = def ? sliderRefs.current[def.key] : null;
        if (!el || el.disabled) return false;
        el.focus();
        el.select?.();
        return true;
      },
      stepSlider(dir) {
        if (!sliderDefs.length) return;
        const cur = sliderDefs.findIndex((d) => d.key === focusKey);
        // 没聚焦就从第一个（向后退则最后一个）开始，循环着走
        const next = cur < 0 ? (dir > 0 ? 0 : sliderDefs.length - 1) : (cur + dir + sliderDefs.length) % sliderDefs.length;
        sliderRefs.current[sliderDefs[next].key]?.focus();
      },
      nudge(dir, mult) {
        const def = sliderDefs.find((d) => d.key === focusKey);
        if (!def) return;
        const min = def.min ?? -100;
        const cur = Number(value[def.key]) || 0;
        const next = Math.max(min, Math.min(100, cur + dir * mult));
        if (next !== cur) set(def.key, next);
      },
      activeKey: () => focusKey,
    }),
    [focusKey, sliderDefs, value],
  );

  /** 单个数值滑块（双击归零） */
  const sliderRow = (s: SliderDef) => (
    <label key={s.key} className={`lb-slider${s.accent ? ' has-track' : ''}${focusKey === s.key ? ' is-focus' : ''}`}>
      <span>{s.label}</span>
      <input
        ref={(el) => {
          sliderRefs.current[s.key] = el;
        }}
        type="range"
        min={s.min ?? -100}
        max={100}
        step={1}
        value={value[s.key]}
        disabled={disabled}
        style={s.accent ? ({ background: s.accent } as React.CSSProperties) : undefined}
        onChange={(e) => set(s.key, Number(e.target.value))}
        onFocus={() => setFocusKey(s.key)}
        onBlur={() => setFocusKey((k) => (k === s.key ? null : k))}
        onDoubleClick={() => set(s.key, 0)}
        title={i18n.t('kdb45e463')}
      />
      <b>{value[s.key]}</b>
    </label>
  );

  return (
    <div className="adjust-panel">
      {/* 全自动：按场景（逆光/舞台/高调/灰雾/人像）一次给整套参数，
          含白平衡、曝光、主曲线、影调与肤色保护，不满意再自己微调 */}
      {(onAutoTone || onUndo) && (
        <div className="auto-tone-bar">
          {onAutoTone && (
            <button
              className="btn sm primary auto-tone-btn"
              disabled={disabled}
              onClick={onAutoTone}
              title={i18n.t('k994057ac')}
            >
              <IconWand /> {i18n.t('ke2839be5')}
            </button>
          )}
          {/* 撤销/重做与 Ctrl+Z / Ctrl+Y 是同一套历史：拖坏了直接退回去 */}
          {onUndo && (
            <div className="auto-tone-history">
              <button
                className="btn sm icon"
                disabled={disabled || !canUndo}
                onClick={onUndo}
                title={i18n.t('k2273c51d')}
                aria-label={i18n.t('kbd9fcf46')}
              >
                <IconRotateCcw />
              </button>
              <button
                className="btn sm icon"
                disabled={disabled || !canRedo}
                onClick={onRedo}
                title={i18n.t('kfb9ac565')}
                aria-label={i18n.t('kc3c873d3')}
              >
                <IconRotateCw />
              </button>
            </div>
          )}
          <span className="auto-tone-hint">
            {onUndo ? i18n.t('kdefa1c2d') : i18n.t('k5bbdb2ca')}
          </span>
        </div>
      )}

      {GROUPS.map((g) => (
        <div className="adjust-group" key={g.title}>
          <div className="adjust-group-head">
            <span>{g.title}</span>
            {g.wb && (
              <div className="wb-actions">
                {onAutoWhite && (
                  <button
                    className="btn sm"
                    disabled={disabled || picking}
                    onClick={onAutoWhite}
                    title={i18n.t('kd47aae92')}
                  >
                    {i18n.t('k3aed2c11')}
                  </button>
                )}
                {onPickWhite && (
                  <button
                    className={`btn sm${picking ? ' primary' : ''}`}
                    disabled={disabled}
                    onClick={onPickWhite}
                    title={i18n.t('kf1cdf768')}
                  >
                    {picking ? i18n.t('k2d3ddc24') : i18n.t('ke705a4cd')}
                  </button>
                )}
                {/* Camera Raw 的「原照设置」：只把白平衡退回原图，曝光/色彩那些调整照样保留 */}
                <button
                  className="btn sm"
                  disabled={disabled || picking || (value.temperature === 0 && value.tint === 0)}
                  onClick={() => onChange({ ...value, temperature: 0, tint: 0 })}
                  title={i18n.t('kf8975f1b')}
                >
                  {i18n.t('k453d59a6')}
                </button>
              </div>
            )}
          </div>

          {g.wb && sample && (
            <div className="adjust-sample" title={i18n.t('k03cf1d0f')}>
              <i style={{ background: sampleHex(sample) }} />
              <span className="adjust-sample-hex">{sampleHex(sample).toUpperCase()}</span>
              <span className="adjust-sample-rgb">
                R{sample.r} G{sample.g} B{sample.b}
              </span>
              {onClearSample && (
                <button className="btn xs ghost" type="button" disabled={disabled} onClick={onClearSample}>
                  {i18n.t('k4403fca0')}
                </button>
              )}
            </div>
          )}

          {g.sliders.map(sliderRow)}
        </div>
      ))}

      {/* ---------- Camera Raw 混色器：8 色带 × 色相/饱和度/明亮度 ---------- */}
      <div className="adjust-group cm-group">
        <div className="adjust-group-head">
          <span>{i18n.t('kc6ac64d9')}</span>
          <button
            className="btn xs ghost"
            disabled={disabled || !MIX_BANDS.some(({ key }) => mixDirty(key))}
            onClick={() => onChange({ ...value, colorMixer: makeColorMixer() })}
            title={i18n.t('k1df47bd2')}
          >
            {i18n.t('kcf2baeb0')}
          </button>
        </div>

        <div className="cm-tabs">
          {MIX_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`cm-tab${mixTab === t.key ? ' on' : ''}`}
              disabled={disabled}
              onClick={() => setMixTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="cm-list">
          {MIX_BANDS.map((b) => {
            const v = cm.bands[b.key]?.[mixProp] ?? 0;
            const track =
              mixTab === 'hue'
                ? 'linear-gradient(90deg,#ff4d4d,#ffd93d,#4ade80,#38d6e0,#5b9dff,#a78bfa,#e879f9,#ff4d4d)'
                : mixTab === 'sat'
                  ? `linear-gradient(90deg,#3a3d47 0%,#8a8f9e 50%,${b.color} 100%)`
                  : `linear-gradient(90deg,#0d0e12,${b.color},#f4f6ff)`;
            return (
              <div className="cm-row" key={b.key}>
                <span className="cm-dot" style={{ background: b.color }} />
                <span className="cm-name">{b.label}</span>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={v}
                  disabled={disabled}
                  style={{ background: track }}
                  onChange={(e) => setMix(b.key, Number(e.target.value))}
                  onDoubleClick={() => setMix(b.key, 0)}
                  title={i18n.t('ke1ae7ae8', { p0: b.label })}
                />
                <b className={mixDirty(b.key) ? 'on' : ''}>{v}</b>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------- Camera Raw 颜色分级：四区色轮 + 混合/平衡 ---------- */}
      <div className="adjust-group cg-group">
        <div className="adjust-group-head">
          <span>{i18n.t('k5e41d36a')}</span>
          <button
            className="btn xs ghost"
            disabled={disabled || !GRADE_ZONES.some(({ key }) => zoneDirty(key))}
            onClick={() => onChange({ ...value, colorGrade: { ...cg, zones: makeColorGrade().zones } })}
            title={i18n.t('k0548e2b0')}
          >
            {i18n.t('kcf2baeb0')}
          </button>
        </div>

        <div className="cg-wheels">
          {GRADE_ZONES.map((z) => (
            <div className={`cg-cell${zoneKey === z.key ? ' on' : ''}`} key={z.key}>
              <ColorWheel
                hue={cg.zones[z.key]?.hue ?? 0}
                sat={cg.zones[z.key]?.sat ?? 0}
                size={54}
                disabled={disabled}
                title={i18n.t('k01a53bc9', { p0: z.label })}
                onChange={(hue, sat) => {
                  setZoneKey(z.key);
                  patchGrade({ zones: { ...cg.zones, [z.key]: { ...(cg.zones[z.key] || { hue: 0, sat: 0, lum: 0 }), hue, sat } } });
                }}
              />
              <button
                type="button"
                className={`cg-name${zoneDirty(z.key) ? ' dirty' : ''}`}
                disabled={disabled}
                onClick={() => setZoneKey(z.key)}
                style={{ color: zoneKey === z.key ? z.color : undefined }}
              >
                {z.label}
              </button>
            </div>
          ))}
        </div>

        <label className="lb-slider">
          <span>{i18n.t('k8b232299')}</span>
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={zone.hue}
            disabled={disabled}
            style={{ background: 'linear-gradient(90deg,#ff4d4d,#ffd93d,#4ade80,#38d6e0,#5b9dff,#a78bfa,#e879f9,#ff4d4d)' }}
            onChange={(e) => patchZone({ hue: Number(e.target.value) })}
            onDoubleClick={() => patchZone({ hue: 0 })}
            title={i18n.t('k04b2e348')}
          />
          <b>{Math.round(zone.hue)}°</b>
        </label>

        <label className="lb-slider">
          <span>{i18n.t('kbd05021d')}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={zone.sat}
            disabled={disabled}
            style={{ background: `linear-gradient(90deg,#2a2c33,hsl(${zone.hue},90%,55%))` }}
            onChange={(e) => patchZone({ sat: Number(e.target.value) })}
            onDoubleClick={() => patchZone({ sat: 0 })}
            title={i18n.t('k04b2e348')}
          />
          <b>{zone.sat}</b>
        </label>

        <label className="lb-slider">
          <span>{i18n.t('kad2eab72')}</span>
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={zone.lum}
            disabled={disabled}
            style={{ background: `linear-gradient(90deg,#0d0e12,hsl(${zone.hue},85%,55%),#f4f6ff)` }}
            onChange={(e) => patchZone({ lum: Number(e.target.value) })}
            onDoubleClick={() => patchZone({ lum: 0 })}
            title={i18n.t('k04b2e348')}
          />
          <b>{zone.lum}</b>
        </label>

        <label className="lb-slider">
          <span>{i18n.t('k41ce131a')}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={cg.blending}
            disabled={disabled}
            onChange={(e) => patchGrade({ blending: Number(e.target.value) })}
            onDoubleClick={() => patchGrade({ blending: COLOR_GRADE_DEFAULTS.blending })}
            title={i18n.t('ke2234058')}
          />
          <b>{cg.blending}</b>
        </label>

        <label className="lb-slider">
          <span>{i18n.t('k2028f7a5')}</span>
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={cg.balance}
            disabled={disabled}
            onChange={(e) => patchGrade({ balance: Number(e.target.value) })}
            onDoubleClick={() => patchGrade({ balance: 0 })}
            title={i18n.t('k5a546d5e')}
          />
          <b>{cg.balance}</b>
        </label>
      </div>

      <div className="adjust-group">
        <div className="adjust-group-head">
          <span>{i18n.t('k74718689')}</span>
        </div>
        {DETAIL_SLIDERS.map(sliderRow)}
      </div>

      <div className="adjust-group hs-group">
        <div className="adjust-group-head">
          <span>{i18n.t('k0a2ef31f')}</span>
          <button className="btn xs ghost" disabled={disabled} onClick={resetChannel} title={i18n.t('ka4dbfaab')}>
            {i18n.t('kcf2baeb0')}
          </button>
        </div>

        <div className="hs-chips">
          {HUE_BANDS.map((b) => (
            <button
              key={b.key}
              type="button"
              className={`hs-chip${!colorize && channel === b.key ? ' on' : ''}${dirty(b.key) ? ' dirty' : ''}`}
              style={{ '--dot': b.color } as React.CSSProperties}
              disabled={disabled || (colorize && b.key !== 'master')}
              onClick={() => {
                setChannel(b.key);
                if (colorize && b.key === 'master') return;
                if (b.key !== 'master') patchHs({ colorize: false });
              }}
              title={i18n.t('k26098cca', { p0: b.label })}
            >
              {b.label}
            </button>
          ))}
        </div>

        <label className="lb-slider">
          <span>{i18n.t('k8b232299')}</span>
          <input
            type="range"
            min={colorize ? 0 : -180}
            max={colorize ? 360 : 180}
            step={1}
            value={hueValue}
            disabled={disabled}
            /* 每个色相通道显示自己色相范围内的渐变：PS/LR 风格 */
            style={{ background: hueTrackGradient(channel, colorize) }}
            onChange={(e) => setHue(Number(e.target.value))}
            onDoubleClick={() => setHue(colorize ? 210 : 0)}
            title={i18n.t('k04b2e348')}
          />
          <b>{colorize ? `${Math.round(hs.colorizeHue)}°` : band.h}</b>
        </label>

        <label className="lb-slider">
          <span>{i18n.t('kbd05021d')}</span>
          <input
            type="range"
            min={colorize ? 0 : -100}
            max={100}
            step={1}
            value={satValue}
            disabled={disabled}
            onChange={(e) => setSat(Number(e.target.value))}
            onDoubleClick={() => setSat(colorize ? 25 : 0)}
            title={i18n.t('k04b2e348')}
          />
          <b>{satValue}</b>
        </label>

        <label className="lb-slider">
          <span>{i18n.t('kad2eab72')}</span>
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={lightValue}
            disabled={disabled}
            onChange={(e) => setLight(Number(e.target.value))}
            onDoubleClick={() => setLight(0)}
            title={i18n.t('k04b2e348')}
          />
          <b>{lightValue}</b>
        </label>

        <label className="hs-colorize" title={i18n.t('k30c98b5a')}>
          <input
            type="checkbox"
            checked={colorize}
            disabled={disabled}
            onChange={(e) => {
              patchHs({ colorize: e.target.checked });
              if (e.target.checked) setChannel('master');
            }}
          />
          <span>{i18n.t('kbbed11a8')}</span>
        </label>
      </div>

      <div className="adjust-group">
        <div className="adjust-group-head">
          <span>{i18n.t('k586dc275')}</span>
          <button className="btn sm ghost" disabled={disabled} onClick={() => onChange({ ...value, curves: { ...CURVES_DEFAULTS } })}>
            {i18n.t('k07db6e06')}
          </button>
        </div>
        <CurveEditor value={value.curves} onChange={(curves) => onChange({ ...value, curves })} disabled={disabled} />
      </div>
    </div>
  );
}

export default forwardRef(AdjustPanelInner);
