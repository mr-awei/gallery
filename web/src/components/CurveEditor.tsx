import React, { useMemo, useRef, useState } from 'react';
import type { CurveChannel, CurvePoint, CurveSet } from '../types';
import { CURVE_CHANNELS, CURVES_DEFAULTS, isCurveIdentity } from '../types';
import { curveFn } from '../lib/tone';

const SIZE = 200;
const PAD = 8;
const SPAN = SIZE - PAD * 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 控制点 → SVG 坐标（y 轴翻转，白在上） */
function toXY(p: CurvePoint): [number, number] {
  return [PAD + (p[0] / 255) * SPAN, SIZE - PAD - (p[1] / 255) * SPAN];
}

/** 曲线采样成 path（插值算法与保存时服务端一致） */
function pathOf(points: CurvePoint[]): string {
  const f = curveFn(points);
  const seg: string[] = [];
  for (let i = 0; i <= 48; i++) {
    const x = i / 48;
    const [px, py] = toXY([x * 255, clamp(f(x), 0, 1) * 255]);
    seg.push(`${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`);
  }
  return seg.join(' ');
}

const IDENTITY: CurvePoint[] = [
  [0, 0],
  [255, 255],
];

interface Props {
  value: CurveSet;
  onChange: (curves: CurveSet) => void;
  disabled?: boolean;
}

/**
 * 四通道曲线（PS 曲线面板同构）：RGB 主通道 + 红/绿/蓝单通道。
 * 拖点调形、双击空白加点、双击点删除；未选中的通道以淡线叠加显示。
 */
export default function CurveEditor({ value, onChange, disabled }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [channel, setChannel] = useState<CurveChannel>('rgb');

  const curves = value || CURVES_DEFAULTS;

  const pts = useMemo<CurvePoint[]>(() => {
    const c = curves[channel];
    if (c && c.length >= 2) return [...c].sort((a, b) => a[0] - b[0]);
    return IDENTITY;
  }, [curves, channel]);

  const paths = useMemo(() => {
    const out: Record<CurveChannel, string> = { rgb: '', r: '', g: '', b: '' };
    for (const ch of CURVE_CHANNELS) {
      const c = curves[ch.key];
      if (c && !isCurveIdentity(c)) out[ch.key] = pathOf(c);
    }
    return out;
  }, [curves]);

  const color = CURVE_CHANNELS.find((c) => c.key === channel)?.color || '#e6e8f2';

  const localOf = (clientX: number, clientY: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { lx: 0, ly: 0 };
    return { lx: ((clientX - r.left) / r.width) * SIZE, ly: ((clientY - r.top) / r.height) * SIZE };
  };

  const toValue = (lx: number, ly: number): CurvePoint => [
    clamp(Math.round(((lx - PAD) / SPAN) * 255), 0, 255),
    clamp(Math.round(((SIZE - PAD - ly) / SPAN) * 255), 0, 255),
  ];

  const emit = (next: CurvePoint[]) => onChange({ ...curves, [channel]: next });

  const commit = (i: number, nx: number, ny: number) => {
    const next = pts.map((p) => [p[0], p[1]] as CurvePoint);
    if (i === 0) next[0] = [0, ny];
    else if (i === next.length - 1) next[i] = [255, ny];
    else next[i] = [clamp(nx, next[i - 1][0] + 1, next[i + 1][0] - 1), ny];
    emit(next);
  };

  const onPointerDownDot = (e: React.PointerEvent, i: number) => {
    if (disabled) return;
    e.stopPropagation();
    setDrag(i);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag == null || disabled) return;
    const { lx, ly } = localOf(e.clientX, e.clientY);
    const [nx, ny] = toValue(lx, ly);
    commit(drag, nx, ny);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (disabled) return;
    const { lx, ly } = localOf(e.clientX, e.clientY);
    const [nx, ny] = toValue(lx, ly);
    if (nx <= 2 || nx >= 253) return;
    if (pts.some((p) => Math.abs(p[0] - nx) < 6)) return; // 附近已有点，别叠在一起
    const added: CurvePoint = [nx, ny];
    emit([...pts, added].sort((a, b) => a[0] - b[0]));
  };

  const onDotDoubleClick = (e: React.MouseEvent, i: number) => {
    if (disabled) return;
    e.stopPropagation();
    if (i === 0 || i === pts.length - 1) return;
    emit(pts.filter((_, k) => k !== i));
  };

  const resetChannel = () => {
    if (disabled) return;
    onChange({ ...curves, [channel]: [] });
  };

  return (
    <div className={`curve-editor${disabled ? ' disabled' : ''}`}>
      <div className="curve-tabs">
        {CURVE_CHANNELS.map((ch) => (
          <button
            key={ch.key}
            type="button"
            className={`curve-tab${channel === ch.key ? ' on' : ''}${curves[ch.key] && !isCurveIdentity(curves[ch.key]) ? ' edited' : ''}`}
            style={{ '--ch': ch.color } as React.CSSProperties}
            disabled={disabled}
            onClick={() => {
              setChannel(ch.key);
              setDrag(null);
            }}
            title={`${ch.label} 通道曲线`}
          >
            {ch.label}
          </button>
        ))}
        <button type="button" className="curve-tab reset" disabled={disabled} onClick={resetChannel} title="只清空当前通道">
          清空
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="curve-canvas"
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onDoubleClick={onDoubleClick}
      >
        {[1, 2, 3].map((i) => (
          <g key={i} className="curve-grid">
            <line x1={PAD + (SPAN / 4) * i} y1={PAD} x2={PAD + (SPAN / 4) * i} y2={SIZE - PAD} />
            <line x1={PAD} y1={PAD + (SPAN / 4) * i} x2={SIZE - PAD} y2={PAD + (SPAN / 4) * i} />
          </g>
        ))}
        <line className="curve-diag" x1={PAD} y1={SIZE - PAD} x2={SIZE - PAD} y2={PAD} />

        {/* 未选中的通道：淡线叠加，方便对照三原色曲线 */}
        {CURVE_CHANNELS.filter((c) => c.key !== channel && paths[c.key]).map((c) => (
          <path key={c.key} className="curve-path ghost" d={paths[c.key]} style={{ stroke: c.color }} />
        ))}

        <path className="curve-path" d={paths[channel] || pathOf(IDENTITY)} style={{ stroke: color }} />

        {pts.map((p, i) => {
          const [x, y] = toXY(p);
          return (
            <circle
              key={`${p[0]}-${i}`}
              className={`curve-dot${drag === i ? ' on' : ''}`}
              cx={x}
              cy={y}
              r={5}
              style={{ stroke: color, fill: drag === i ? color : '#12121f' }}
              onPointerDown={(e) => onPointerDownDot(e, i)}
              onDoubleClick={(e) => onDotDoubleClick(e, i)}
            />
          );
        })}
      </svg>
      <div className="curve-tip">当前：{CURVE_CHANNELS.find((c) => c.key === channel)?.label} 通道 · 拖动调整 · 双击加点 · 双击点删除</div>
    </div>
  );
}
