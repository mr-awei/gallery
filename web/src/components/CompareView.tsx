import React, { useEffect, useRef, useState } from 'react';
import { formatSize } from '../api';
import type { ImageItem } from '../types';

interface Props {
  items: ImageItem[];
  leftId: number;
  rightId: number;
  /** 点「保留这张」：确认后保留该图、其余移入回收站（由父级执行，成功后关闭对比）；不传则只做查看 */
  onKeep?: (id: number) => void | Promise<void>;
  onClose: () => void;
  /** 只允许查看时隐藏「保留」按钮（例如从图库任意两张进来对比） */
  readOnly?: boolean;
}

interface View {
  s: number;
  x: number;
  y: number;
}

type Mode = 'side' | 'split' | 'overlay';

const MIN_S = 1;
const MAX_S = 12;
const RESET: View = { s: 1, x: 0, y: 0 };

/**
 * 图片对比三种方式：
 * - 并排（side）：左右各一份，缩放/平移完全同步；
 * - 分割（split）：叠在一起，用一条可拖动的分界线切开；
 * - 重叠（overlay）：叠在一起，用不透明度滑杆淡入淡出。
 * 三种模式共用同一份缩放/位移，切模式不会丢视角。
 */
export default function CompareView({ items, leftId, rightId, onKeep, onClose, readOnly }: Props) {
  const [left, setLeft] = useState(items.find((i) => i.id === leftId) || items[0]);
  const [right, setRight] = useState(items.find((i) => i.id === rightId) || items[items.length - 1]);
  const [keeping, setKeeping] = useState(false);
  // 当前「活动」半区：点缩略图替换到这一侧
  const [active, setActive] = useState<'left' | 'right'>('left');
  const [view, setView] = useState<View>(RESET);
  const [mode, setMode] = useState<Mode>('side');
  const [pos, setPos] = useState(50); // 分割线位置 / 重叠不透明度，百分比
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const splitRef = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '0') setView(RESET);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const assign = (it: ImageItem) => {
    if (active === 'left') {
      if (it.id === right.id) setRight(left); // 互换
      setLeft(it);
    } else {
      if (it.id === left.id) setLeft(right);
      setRight(it);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      const s = Math.min(MAX_S, Math.max(MIN_S, v.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      if (s === v.s) return v;
      const k = s / v.s;
      return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (splitRef.current) return; // 正在拖分割线，别顺手平移画面
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
    setActive(e.currentTarget.dataset.side === 'right' ? 'right' : 'left');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  /* 分界线的拖动：按舞台宽度换算成 0–100 */
  const onSplitDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    splitRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onSplitMove = (e: React.PointerEvent) => {
    if (!splitRef.current || !stageRef.current) return;
    e.stopPropagation();
    const r = stageRef.current.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
  };
  const onSplitUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    splitRef.current = false;
  };

  // 跨页选择时可能只取到一张：宁可什么都不画，也别拿 undefined 去渲染
  if (!left || !right || left.id === right.id) return null;

  const transform = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` };

  const pane = (side: 'left' | 'right', it: ImageItem) => (
    <div className="cmp-side" data-side={side} onPointerDown={() => setActive(side)}>
      <div
        className={`cmp-pane${active === side ? ' active' : ''}`}
        data-side={side}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="cmp-inner" style={transform}>
          <img src={it.url} alt={it.title} draggable={false} />
        </div>
        {view.s > 1 && <span className="cmp-zoom">{view.s.toFixed(1)}×</span>}
      </div>
      <Meta item={it} onKeep={readOnly ? undefined : onKeep} keeping={keeping} setKeeping={setKeeping} />
    </div>
  );

  return (
    <div className="cmp-overlay">
      <div className="cmp-head">
        <b>图片对比</b>
        <div className="cmp-modes">
          <button className={`btn sm${mode === 'side' ? ' primary' : ''}`} onClick={() => setMode('side')}>
            并排
          </button>
          <button className={`btn sm${mode === 'split' ? ' primary' : ''}`} onClick={() => setMode('split')}>
            分割
          </button>
          <button className={`btn sm${mode === 'overlay' ? ' primary' : ''}`} onClick={() => setMode('overlay')}>
            重叠
          </button>
        </div>
        <div className="cmp-thumbs">
          {items.map((it) => (
            <button
              key={it.id}
              className={`cmp-thumb${it.id === left.id || it.id === right.id ? ' used' : ''}`}
              title={`替换到${active === 'left' ? '左' : '右'}侧`}
              onClick={() => assign(it)}
            >
              <img src={it.thumbUrl} alt="" draggable={false} />
            </button>
          ))}
        </div>
        <span className="cmp-hint">
          {mode === 'side'
            ? '滚轮缩放 / 按住拖动两侧同步 · 点缩略图换到活动半区（点画面选择活动侧）'
            : mode === 'split'
              ? '拖动中间的分界线，左边是前者、右边是后者 · 滚轮缩放 / 拖动平移'
              : '拖动滑杆调整不透明度，叠着看差异 · 滚轮缩放 / 拖动平移'}
        </span>
        <div className="cmp-actions">
          {mode === 'overlay' && (
            <input
              className="cmp-range"
              type="range"
              min={0}
              max={100}
              value={pos}
              onChange={(e) => setPos(Number(e.target.value))}
              title="后一张的不透明度"
            />
          )}
          <button className="btn sm" onClick={() => setView(RESET)} title="恢复 1:1（快捷键 0）">
            重置视图
          </button>
          <button className="btn sm danger" onClick={onClose} title="退出对比（快捷键 Esc）">
            ✕ 退出对比 (Esc)
          </button>
        </div>
      </div>

      {mode === 'side' ? (
        <div className="cmp-body">
          {pane('left', left)}
          {pane('right', right)}
        </div>
      ) : (
        <>
          <div
            className="cmp-stage"
            ref={stageRef}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div className="cmp-inner" style={transform}>
              <img src={left.url} alt={left.title} draggable={false} className="cmp-base" />
              <img
                src={right.url}
                alt={right.title}
                draggable={false}
                className="cmp-over"
                style={
                  mode === 'split'
                    ? { clipPath: `inset(0 0 0 ${pos}%)` }
                    : { opacity: Math.min(1, Math.max(0, pos / 100)) }
                }
              />
              {mode === 'split' && (
                <div
                  className="cmp-divider"
                  style={{ left: `${pos}%` }}
                  onPointerDown={onSplitDown}
                  onPointerMove={onSplitMove}
                  onPointerUp={onSplitUp}
                  title="拖动分界线"
                >
                  <span />
                </div>
              )}
            </div>
            <span className="cmp-tag left">{left.title}</span>
            <span className="cmp-tag right">{right.title}</span>
            {view.s > 1 && <span className="cmp-zoom">{view.s.toFixed(1)}×</span>}
          </div>
          <div className="cmp-foot">
            <Meta item={left} onKeep={readOnly ? undefined : onKeep} keeping={keeping} setKeeping={setKeeping} />
            <Meta item={right} onKeep={readOnly ? undefined : onKeep} keeping={keeping} setKeeping={setKeeping} />
          </div>
        </>
      )}
    </div>
  );
}

function Meta({
  item,
  onKeep,
  keeping,
  setKeeping,
}: {
  item: ImageItem;
  onKeep?: (id: number) => void | Promise<void>;
  keeping: boolean;
  setKeeping: (v: boolean) => void;
}) {
  return (
    <div className="cmp-meta">
      <div className="cmp-info">
        <b title={item.title}>{item.title}</b>
        <span>
          {item.width}×{item.height} · {formatSize(item.sizeBytes)} · {item.source}
          {item.rating > 0 ? ` · ${'★'.repeat(item.rating)}` : ''}
        </span>
      </div>
      {onKeep && (
        <button
          className="btn sm primary"
          disabled={keeping}
          onClick={() => {
            setKeeping(true);
            Promise.resolve(onKeep(item.id)).finally(() => setKeeping(false));
          }}
        >
          保留这张
        </button>
      )}
    </div>
  );
}
