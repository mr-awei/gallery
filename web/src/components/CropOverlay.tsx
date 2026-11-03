import React, { useCallback, useMemo, useRef } from 'react';

/** 归一化裁切框（0..1，相对原图宽高） */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_RECT: CropRect = { x: 0, y: 0, w: 1, h: 1 };

const MIN_SIZE = 0.03;

/** 比例 → 归一化空间比例（归一化 x/y 单位不同，需按原图宽高比换算） */
export function ratioNormOf(ratio: string, imageAspect: number): number | null {
  if (ratio === 'free') return null;
  if (ratio === 'orig') return 1;
  const m = String(ratio).match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return Number(m[1]) / Number(m[2]) / (imageAspect || 1);
}

/** 按比例生成居中最大初始框 */
export function initialRect(ratio: string, imageAspect: number): CropRect {
  const rn = ratioNormOf(ratio, imageAspect);
  if (rn === null) return { ...FULL_RECT };
  let w = 1;
  let h = 1;
  if (rn >= 1) h = 1 / rn;
  else w = rn;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 保持比例缩回 [0,1] 内 */
function fitRect(r: CropRect): CropRect {
  let { x, y, w, h } = r;
  if (w > 1) {
    const k = 1 / w;
    w = 1;
    h *= k;
  }
  if (h > 1) {
    const k = 1 / h;
    h = 1;
    w *= k;
  }
  w = Math.max(MIN_SIZE, w);
  h = Math.max(MIN_SIZE, h);
  x = clamp(x, 0, 1 - w);
  y = clamp(y, 0, 1 - h);
  return { x, y, w, h };
}

/** 锁定比例：mode 是被拖动的句柄（n/s/e/w 可组合），start 是拖动起始框 */
function lockAspect(r: CropRect, start: CropRect, rn: number, mode: string): CropRect {
  let { x, y, w, h } = r;
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  if (mode === 'e' || mode === 'w') {
    // 水平边：宽度主导，垂直居中
    if (w / rn > 1) w = rn;
    h = w / rn;
    y = cy - h / 2;
    if (mode === 'w') x = start.x + start.w - w;
  } else if (mode === 'n' || mode === 's') {
    // 垂直边：高度主导，水平居中
    if (h * rn > 1) h = 1 / rn;
    w = h * rn;
    x = cx - w / 2;
    if (mode === 'n') y = start.y + start.h - h;
  } else {
    // 角：按变化更大的轴主导，固定对角
    const dw = Math.abs(w - start.w);
    const dh = Math.abs(h - start.h) * rn;
    if (dw >= dh) h = w / rn;
    else w = h * rn;
    if (mode.includes('w')) x = start.x + start.w - w;
    if (mode.includes('n')) y = start.y + start.h - h;
  }
  return fitRect({ x, y, w, h });
}

interface Props {
  /** 图片在父容器内的实际渲染矩形（像素）。组件据此铺满图片区域 */
  frame: { left: number; top: number; width: number; height: number };
  /** 原图宽高比 W/H */
  imageAspect: number;
  /** 'free' | 'orig' | '1:1' | '4:3' ... */
  ratio: string;
  value: CropRect;
  onChange: (v: CropRect) => void;
}

/**
 * 裁切选框：拖边框/拖动内部即可调整区域，锁比例时自动约束。
 * 事件全部走 pointer events（鼠标与触屏统一）。
 */
export default function CropOverlay({ frame, imageAspect, ratio, value, onChange }: Props) {
  const dragRef = useRef<{ mode: string; sx: number; sy: number; start: CropRect } | null>(null);
  const rn = useMemo(() => ratioNormOf(ratio, imageAspect), [ratio, imageAspect]);

  const onDown = useCallback(
    (e: React.PointerEvent, mode: string) => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { mode, sx: e.clientX, sy: e.clientY, start: value };
    },
    [value]
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.sx) / Math.max(1, frame.width);
      const dy = (e.clientY - d.sy) / Math.max(1, frame.height);
      const s = d.start;
      if (d.mode === 'move') {
        onChange({ x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h), w: s.w, h: s.h });
        return;
      }
      const r: CropRect = { x: s.x, y: s.y, w: s.w, h: s.h };
      if (d.mode.includes('w')) {
        const nx = clamp(s.x + dx, 0, s.x + s.w - MIN_SIZE);
        r.x = nx;
        r.w = s.x + s.w - nx;
      }
      if (d.mode.includes('e')) r.w = clamp(s.w + dx, MIN_SIZE, 1 - s.x);
      if (d.mode.includes('n')) {
        const ny = clamp(s.y + dy, 0, s.y + s.h - MIN_SIZE);
        r.y = ny;
        r.h = s.y + s.h - ny;
      }
      if (d.mode.includes('s')) r.h = clamp(s.h + dy, MIN_SIZE, 1 - s.y);
      onChange(rn === null ? fitRect(r) : lockAspect(r, s, rn, d.mode));
    },
    [frame.width, frame.height, onChange, rn]
  );

  const onUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // 像素坐标（相对 frame）
  const px = {
    left: value.x * frame.width,
    top: value.y * frame.height,
    width: Math.max(1, value.w * frame.width),
    height: Math.max(1, value.h * frame.height),
  };

  const handleStyle: React.CSSProperties = {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 3,
    background: '#fff',
    boxShadow: '0 0 0 1px rgba(0,0,0,.45)',
    touchAction: 'none',
  };
  const edgeStyle: React.CSSProperties = { position: 'absolute', touchAction: 'none' };

  return (
    <div
      style={{
        position: 'absolute',
        left: frame.left,
        top: frame.top,
        width: frame.width,
        height: frame.height,
        zIndex: 30,
        touchAction: 'none',
      }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* 选框：外阴影压暗四周，边框示意裁切区域 */}
      <div
        onPointerDown={(e) => onDown(e, 'move')}
        style={{
          position: 'absolute',
          left: px.left,
          top: px.top,
          width: px.width,
          height: px.height,
          boxShadow: '0 0 0 9999px rgba(0,0,0,.55)',
          border: '1px solid rgba(255,255,255,.9)',
          cursor: 'move',
          touchAction: 'none',
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,.25) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.25) 1px, transparent 1px)',
          backgroundSize: `${px.width / 3}px ${px.height / 3}px`,
          backgroundPosition: '-1px -1px',
        }}
      >
        {/* 四边 */}
        <div
          style={{ ...edgeStyle, left: -6, top: '30%', width: 12, height: '40%', cursor: 'ew-resize' }}
          onPointerDown={(e) => onDown(e, 'w')}
        />
        <div
          style={{ ...edgeStyle, right: -6, top: '30%', width: 12, height: '40%', cursor: 'ew-resize' }}
          onPointerDown={(e) => onDown(e, 'e')}
        />
        <div
          style={{ ...edgeStyle, top: -6, left: '30%', height: 12, width: '40%', cursor: 'ns-resize' }}
          onPointerDown={(e) => onDown(e, 'n')}
        />
        <div
          style={{ ...edgeStyle, bottom: -6, left: '30%', height: 12, width: '40%', cursor: 'ns-resize' }}
          onPointerDown={(e) => onDown(e, 's')}
        />
        {/* 四角 */}
        <div style={{ ...handleStyle, left: -7, top: -7, cursor: 'nwse-resize' }} onPointerDown={(e) => onDown(e, 'nw')} />
        <div style={{ ...handleStyle, right: -7, top: -7, cursor: 'nesw-resize' }} onPointerDown={(e) => onDown(e, 'ne')} />
        <div style={{ ...handleStyle, left: -7, bottom: -7, cursor: 'nesw-resize' }} onPointerDown={(e) => onDown(e, 'sw')} />
        <div style={{ ...handleStyle, right: -7, bottom: -7, cursor: 'nwse-resize' }} onPointerDown={(e) => onDown(e, 'se')} />
        {/* 尺寸角标 */}
        <span
          style={{
            position: 'absolute',
            left: 0,
            bottom: -24,
            fontSize: 11,
            color: '#fff',
            background: 'rgba(0,0,0,.6)',
            padding: '1px 6px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {Math.round(value.w * 100)}% × {Math.round(value.h * 100)}%
        </span>
      </div>
    </div>
  );
}
