import { IconClose, IconStar } from './Icons';
import React, { useEffect, useRef, useState } from 'react';
import { formatSize } from '../api';
import type { ImageItem, SimilarGroup } from '../types';
import i18n from '../i18n';

interface Props {
  group: SimilarGroup;
  /** 淘汰一张（loser 移入回收站）：父级负责调 API；返回是否成功 */
  onEliminate: (keepId: number, loseId: number) => Promise<boolean>;
  /** 全部对比完（只剩一张） */
  onFinished: () => void;
  onClose: () => void;
}

interface View {
  s: number;
  x: number;
  y: number;
}

const MIN_S = 1;
const MAX_S = 12;
const RESET: View = { s: 1, x: 0, y: 0 };

/**
 * 两两对决：胜者留在场上，败者立即移入回收站，队列中的下一张自动补位，
 * 直到只剩一张。每轮只做「这两个里留哪个」的判断，符合直觉且不误删。
 */
export default function DuelView({ group, onEliminate, onFinished, onClose }: Props) {
  const initial = group.items.find((i) => i.id === group.recommendId) || group.items[0];
  const [kept, setKept] = useState(initial);
  const [queue, setQueue] = useState(group.items.filter((i) => i.id !== initial.id));
  const [eliminated, setEliminated] = useState<ImageItem[]>([]);
  const [eliminating, setEliminating] = useState(false);
  // 父级既可能「返回 false」也可能「抛异常」：抛的时候以前界面完全没反馈
  const [error, setError] = useState('');
  const [view, setView] = useState<View>(RESET);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const challenger = queue[0];
  const totalRounds = group.items.length - 1;
  const round = totalRounds - queue.length + 1;

  const pick = async (winner: 'kept' | 'challenger') => {
    if (eliminating || !challenger) return;
    const keepItem = winner === 'kept' ? kept : challenger;
    const loseItem = winner === 'kept' ? challenger : kept;
    setEliminating(true);
    setError('');
    try {
      const ok = await onEliminate(keepItem.id, loseItem.id);
      if (!ok) {
        // 删除失败：停在当前轮，让用户重试或退出
        setError(i18n.t('k022898c9'));
        return;
      }
      setEliminated((prev) => [...prev, loseItem]);
      if (winner === 'challenger') setKept(challenger);
      setQueue((prev) => prev.slice(1));
      setView(RESET);
      if (queue.length <= 1) onFinished(); // 这是最后一轮
    } catch (err) {
      setError(i18n.t('kb5b5436a', { p0: (err as Error)?.message || i18n.t('k974e7484') }));
    } finally {
      setEliminating(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (eliminating || !challenger) return;
      if (e.key === 'ArrowLeft') pick('kept');
      if (e.key === 'ArrowRight') pick('challenger');
      if (e.key === '0') setView(RESET);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, eliminating, challenger, kept, queue]);

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
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const pane = (side: 'left' | 'right', it: ImageItem, role: 'kept' | 'challenger') => (
    <div className="cmp-side">
      <div
        className={`cmp-pane${role === 'kept' ? ' active' : ''}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="cmp-inner" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          <img src={it.url} alt={it.title} draggable={false} />
        </div>
        {view.s > 1 && <span className="cmp-zoom">{view.s.toFixed(1)}×</span>}
        <span className="cmp-role">{role === 'kept' ? i18n.t('kb116774f') : i18n.t('k6ff36a7b')}</span>
      </div>
      <div className="cmp-meta">
        <div className="cmp-info">
          <b title={it.title}>{it.title}</b>
          <span>
            {it.width}×{it.height} · {formatSize(it.sizeBytes)} · {it.source}
            {typeof it.quality === 'number' ? i18n.t('k81a4ba91', { p0: it.quality }) : ''}
          </span>
        </div>
        <button
          className={`btn sm primary${role === 'kept' ? '' : ''}`}
          disabled={eliminating}
          onClick={() => pick(role)}
          title={role === 'kept' ? i18n.t('k7aff8bd9') : i18n.t('k05ada364')}
        >
          {role === 'kept' ? i18n.t('kb51e88d1') : i18n.t('k6a1abed1')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="cmp-overlay">
      <div className="cmp-head">
        <b>{i18n.t('k5f96bd1f')}</b>
        <span className="cmp-hint">
          第 {Math.min(round, totalRounds)} / {totalRounds} 轮 · 败者立即移入回收站（可恢复） · ←/→ 键快速选择
        </span>
        <div className="cmp-actions">
          <button className="btn sm" onClick={() => setView(RESET)} title={i18n.t('kfb6bd756')}>
            {i18n.t('ke1dfa659')}
          </button>
          <button className="btn sm danger" onClick={onClose} title={i18n.t('kb80d6d18')}>
            <IconClose size={13} /> {i18n.t('k4b8eb1e8')}
          </button>
        </div>
      </div>
      <div className="cmp-body">
        {challenger ? (
          <>
            {pane('left', kept, 'kept')}
            {pane('right', challenger, 'challenger')}
          </>
        ) : (
          <div className="cmp-side" style={{ justifyContent: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 40 }}><IconStar size={40} /></div>
              <b>整组处理完成：保留 {kept.title}</b>
            </div>
          </div>
        )}
      </div>
      {!!error && (
        <div
          role="alert"
          style={{
            padding: '8px 12px',
            fontSize: 12.5,
            color: '#f87171',
            borderTop: '1px solid var(--border)',
          }}
        >
          {error}
        </div>
      )}
      {(eliminated.length > 0 || queue.length > 0) && (
        <div className="cmp-head" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="cmp-thumbs">
            {eliminated.map((it) => (
              <span key={it.id} className="cmp-thumb used" style={{ opacity: 0.35 }} title={i18n.t('kada92132', { p0: it.title })}>
                <img src={it.thumbUrl} alt="" draggable={false} />
              </span>
            ))}
            {challenger && (
              <span className="cmp-thumb used" title={i18n.t('k171519af')}>
                <img src={challenger.thumbUrl} alt="" draggable={false} />
              </span>
            )}
            {queue.slice(1).map((it) => (
              <span key={it.id} className="cmp-thumb" title={i18n.t('kdbdcaf54', { p0: it.title })}>
                <img src={it.thumbUrl} alt="" draggable={false} />
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
