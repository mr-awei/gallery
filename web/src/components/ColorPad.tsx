import React, { useEffect, useRef, useState } from 'react';
import { buildASE, buildPngSheet, downloadBlob } from '../lib/palette';

/* ---------------------------- HSV <-> HEX 工具 ---------------------------- */

interface Hsv {
  h: number; // 0-360
  s: number; // 0-1
  v: number; // 0-1
}

function hexToHsv(hex: string): Hsv {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/* 调色板导出（ASE / PNG 色卡）复用 lib/palette，图片真实主色导出也走同一套编码 */

/* 快捷色块：第一行黑白灰，第二行常用彩色（对标 Eagle 调色板） */
const NEUTRALS = ['#000000', '#4d4d4d', '#808080', '#b3b3b3', '#e6e6e6', '#ffffff'];
const COLORS = [
  '#e60000', '#ff8c00', '#ffd600', '#7cb342',
  '#00b8d4', '#2962ff', '#9c27b0', '#ff4081',
];
/** 可导出的完整调色板（黑白灰 + 常用彩） */
const PALETTE = [...NEUTRALS, ...COLORS];

interface Props {
  /** 当前颜色 #rrggbb */
  value: string;
  /** 颜色变化回调（拖动中会高频触发，由父级做停下即搜） */
  onChange: (hex: string) => void;
  /** 外部真实色板（图片主色）；不传则导出内置的通用色板 */
  palette?: string[];
  /** 导出文件名前缀，便于区分是哪张图的色板 */
  title?: string;
}

/**
 * Eagle 式取色盘：SV 渐变方盘 + 色相条 + 快捷色块。
 * 无确定键——拖动过程实时回调 onChange，父组件在鼠标停下后再触发搜索。
 */
export default function ColorPad({ value, onChange, palette, title }: Props) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [drag, setDrag] = useState<null | 'sv' | 'hue'>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const emittedRef = useRef(value);
  /* 有真实图片主色就导出真实色板，否则退回内置通用色板 */
  const swatches = palette && palette.length ? palette : PALETTE;
  const slug = (title || 'tuku-palette')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .slice(0, 60);

  // 外部 value 变化（非自己发出的）时同步内部 HSV
  useEffect(() => {
    if (value.toLowerCase() !== emittedRef.current.toLowerCase()) {
      const next = hexToHsv(value);
      hsvRef.current = next;
      setHsv(next);
      emittedRef.current = value;
    }
  }, [value]);

  const apply = (mode: 'sv' | 'hue', clientX: number, clientY: number) => {
    const el = mode === 'sv' ? svRef.current : hueRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clamp01((clientX - rect.left) / rect.width);
    const y = clamp01((clientY - rect.top) / rect.height);
    const prev = hsvRef.current;
    // 拖色相条时保留原饱和度/明度；但若当前接近灰阶（饱和度极低），
    // 拖色相不会改变颜色 → 给一个可见饱和度，避免“色相条拖了没反应”的错觉。
    const s = prev.s < 0.08 ? 0.65 : prev.s;
    const v = prev.s < 0.08 ? 1 : prev.v;
    const next: Hsv =
      mode === 'hue' ? { h: y * 360, s, v } : { h: prev.h, s: x, v: 1 - y };
    hsvRef.current = next;
    setHsv(next);
    const hex = hsvToHex(next.h, next.s, next.v);
    emittedRef.current = hex;
    onChange(hex);
  };

  const start = (mode: 'sv' | 'hue') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 非真实指针（测试合成事件）忽略 */ }
    setDrag(mode);
    apply(mode, e.clientX, e.clientY);
  };

  const move = (mode: 'sv' | 'hue') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag !== mode) return;
    apply(mode, e.clientX, e.clientY);
  };

  const end = () => setDrag(null);

  const pick = (hex: string) => {
    const next = hexToHsv(hex);
    hsvRef.current = next;
    setHsv(next);
    emittedRef.current = hex;
    onChange(hex);
  };

  return (
    <div className="cpad">
      <div className="cpad-row">
        <div
          ref={svRef}
          className="cpad-sv"
          style={{ background: `hsl(${hsv.h}, 100%, 50%)` }}
          onPointerDown={start('sv')}
          onPointerMove={move('sv')}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <div className="cpad-sv-white" />
          <div className="cpad-sv-black" />
          <span
            className="cpad-cursor"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }}
          />
        </div>
        <div
          ref={hueRef}
          className="cpad-hue"
          onPointerDown={start('hue')}
          onPointerMove={move('hue')}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <span
            className="cpad-hue-cursor"
            style={{ top: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h}, 100%, 50%)` }}
          />
        </div>
      </div>
      <div className="cpad-swatches">
        {NEUTRALS.map((c) => (
          <button
            key={c}
            type="button"
            className={`cpad-sw${value.toLowerCase() === c ? ' on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => pick(c)}
          />
        ))}
      </div>
      <div className="cpad-swatches">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`cpad-sw${value.toLowerCase() === c ? ' on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => pick(c)}
          />
        ))}
      </div>
      {/* 导出：ASE 给设计软件，PNG 色卡给文档/沟通 */}
      <div className="cpad-export">
        <button
          type="button"
          className="btn sm"
          title="导出 Adobe 色板（.ase），Photoshop / Illustrator / Affinity 可直接导入"
          onClick={() => downloadBlob(buildASE(swatches, title || '图库'), `${slug}.ase`)}
        >
          导出 ASE
        </button>
        <button
          type="button"
          className="btn sm"
          title="导出色块 + 色值的长图 PNG"
          onClick={async () => {
            try {
              downloadBlob(await buildPngSheet(swatches), `${slug}.png`);
            } catch {
              /* 画布不可用时静默 */
            }
          }}
        >
          导出 PNG 色卡
        </button>
        <span className="hint">{swatches.length} 色</span>
      </div>
    </div>
  );
}
