import React, { useRef } from 'react';

interface Props {
  /** 色相 0..360（0 = 正上方，顺时针） */
  hue: number;
  /** 饱和度 0..100（距圆心的距离） */
  sat: number;
  size?: number;
  disabled?: boolean;
  onChange: (hue: number, sat: number) => void;
  title?: string;
}

/**
 * Camera Raw 颜色分级的色轮：外圈是高饱和色相环，圆心为无饱和。
 * 点击/拖动直接改该区域的色相与饱和度；双击把饱和度归零（等于取消这个区域的染色）。
 */
export default function ColorWheel({ hue, sat, size = 62, disabled, onChange, title }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const pick = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    // 正上方为 0°，顺时针递增（与 CSS conic-gradient 的角度方向一致）
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (deg < 0) deg += 360;
    if (deg >= 360) deg -= 360;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const radius = r.width / 2;
    const s = Math.max(0, Math.min(100, (dist / radius) * 100));
    onChange(Math.round(deg), Math.round(s));
  };

  // 拖出圆外也继续跟手，所以按下时抓住指针
  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pick(e.clientX, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current || disabled) return;
    e.stopPropagation();
    pick(e.clientX, e.clientY);
  };

  const end = () => {
    dragging.current = false;
  };

  const rad = ((hue - 90) * Math.PI) / 180;
  const rr = (size / 2 - 5) * (Math.min(100, Math.max(0, sat)) / 100);

  return (
    <div
      ref={ref}
      className={`grading-wheel${disabled ? ' is-disabled' : ''}`}
      style={{ width: size, height: size }}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(hue, 0);
      }}
    >
      <span
        className="gw-dot"
        style={{ left: `calc(50% + ${Math.cos(rad) * rr}px)`, top: `calc(50% + ${Math.sin(rad) * rr}px)` }}
      />
    </div>
  );
}
