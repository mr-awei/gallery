import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconClose, IconWand } from './Icons';
import i18n from '../i18n';

/**
 * 教程：分步高亮导览。
 *
 * 设计取舍：
 * - 目标元素用 `data-tour` 标记而不是 CSS 类名，样式重构不会把教程弄坏；
 * - 找不到目标（还没导入图片 / 窗口太窄）就退化成居中卡片，教程不中断；
 * - 遮罩只挡不点：教程是「读」的，不需要用户在被高亮的元素上操作，
 *   否则每一步都要处理暂停/恢复，出错时很难说清是哪一步没完成。
 */

interface Step {
  key: string;
  title: string;
  body: string;
  /** 补充提示，做成浅色小字块 */
  tip?: string;
  /** 对应元素的 data-tour 值 */
  target?: string;
  placement?: 'right' | 'bottom' | 'left' | 'top';
}

const STEPS: Step[] = [
  {
    key: 'welcome',
    title: i18n.t('kb25985ac'),
    body: i18n.t('kea82c8ce'),
    tip: i18n.t('ke920773a'),
  },
  {
    key: 'sidebar',
    title: i18n.t('k628a1a07'),
    body: i18n.t('k73f8d14f'),
    tip: i18n.t('k5c463dc0'),
    target: 'sidebar',
    placement: 'right',
  },
  {
    key: 'topbar',
    title: i18n.t('kcfeccff5'),
    body: i18n.t('k91e85ddc'),
    target: 'topbar-actions',
    placement: 'bottom',
  },
  {
    key: 'filterbar',
    title: i18n.t('kba3cc0b1'),
    body: i18n.t('k0306e145'),
    target: 'filterbar',
    placement: 'bottom',
  },
  {
    key: 'grid',
    title: i18n.t('kef19ab3c'),
    body: i18n.t('k944d1b2d'),
    tip: i18n.t('k15338ba0'),
    target: 'gallery-grid',
    placement: 'top',
  },
  {
    key: 'lightbox',
    title: i18n.t('kc9041d00'),
    body: i18n.t('k36c40512'),
    tip: i18n.t('kb3af5dff'),
  },
  {
    key: 'settings',
    title: i18n.t('k96834f68'),
    body: i18n.t('k94a70376'),
    tip: i18n.t('ke7b7783f'),
    target: 'settings-btn',
    placement: 'bottom',
  },
];

const CARD_W = 344;
const GAP = 14;
const EDGE = 12;

export default function OnboardingTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [hole, setHole] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const step = STEPS[Math.min(index, STEPS.length - 1)];

  const measure = useCallback(() => {
    if (!step.target) {
      setHole(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!el) {
      setHole(null);
      return;
    }
    const r = el.getBoundingClientRect();
    // 空图库的网格高度是 0，框住一条线没有意义，直接居中讲。
    // 阈值必须很小：顶栏按钮条只有 32px 高，用 40 会把它们全判成「不存在」。
    if (r.width < 16 || r.height < 16) {
      setHole(null);
      return;
    }
    // 四周留 6px 余量，被讲解的元素不至于贴着边框
    const PAD = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 只框屏幕里看得见的那部分：图片网格有几千像素高，整块「高亮」等于没有高亮；
    // 高度再压到 62% 视口以内，给说明卡片留出位置
    const x = Math.max(r.left - PAD, 0);
    const y = Math.max(r.top - PAD, 0);
    const w = Math.min(r.right + PAD, vw) - x;
    const h = Math.min(Math.min(r.bottom + PAD, vh) - y, vh * 0.62);
    if (w < 16 || h < 16) {
      setHole(null);
      return;
    }
    const next = { x, y, w, h };
    setHole((prev) =>
      prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next
    );
  }, [step.target]);

  /* 每次打开都从头讲 */
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  /* 量目标位置：切步、窗口缩放、容器内滚动都要重算 */
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onMove = () => measure();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, index, measure]);

  /* 摆浮层：先按声明的方向，放不下就翻面，都放不下就贴边居中 */
  useLayoutEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    if (!card) return;
    if (!hole) {
      setPos(null);
      return;
    }
    const cw = card.offsetWidth || CARD_W;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const placement = step.placement || 'bottom';
    const box = {
      right: { x: hole.x + hole.w + GAP, y: hole.y + hole.h / 2 - ch / 2, ok: hole.x + hole.w + GAP + cw <= vw - EDGE },
      left: { x: hole.x - cw - GAP, y: hole.y + hole.h / 2 - ch / 2, ok: hole.x - cw - GAP >= EDGE },
      bottom: { x: hole.x + hole.w / 2 - cw / 2, y: hole.y + hole.h + GAP, ok: hole.y + hole.h + GAP + ch <= vh - EDGE },
      top: { x: hole.x + hole.w / 2 - cw / 2, y: hole.y - ch - GAP, ok: hole.y - ch - GAP >= EDGE },
    } as const;
    const flip: Record<string, keyof typeof box> = { right: 'left', left: 'right', bottom: 'top', top: 'bottom' };
    const first = box[placement];
    const second = box[flip[placement]];
    const picked = first.ok ? first : second.ok ? second : first;
    setPos({
      x: Math.min(Math.max(picked.x, EDGE), Math.max(EDGE, vw - cw - EDGE)),
      y: Math.min(Math.max(picked.y, EDGE), Math.max(EDGE, vh - ch - EDGE)),
    });
  }, [open, hole, index, step.placement]);

  const close = useCallback(() => onClose(), [onClose]);
  const next = useCallback(() => {
    if (index >= STEPS.length - 1) {
      close();
      return;
    }
    setIndex((v) => v + 1);
  }, [index, close]);

  /* 键盘：→/Enter 下一步，← 上一步，Esc 跳过（与「关闭弹窗」的肌肉记忆一致） */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
        // 焦点在按钮上时交给浏览器原生的 click，避免一次回车走两步
        if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.closest('button')) return;
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((v) => Math.max(0, v - 1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close, next]);

  /* 打开/切步后把焦点放到卡片上，键盘用户不需要先 Tab 找位置 */
  useEffect(() => {
    if (open) cardRef.current?.focus();
  }, [open, index]);

  if (!open) return null;

  const last = index === STEPS.length - 1;

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label={i18n.t('kb7824d5c')}>
      {hole ? (
        <div
          className="tour-hole"
          style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
        />
      ) : (
        <div className="tour-dim" />
      )}

      <div
        ref={cardRef}
        tabIndex={-1}
        className={`tour-card${pos ? '' : ' center'}`}
        style={pos ? { left: pos.x, top: pos.y } : undefined}
      >
        <div className="tour-head">
          <span className="tour-badge">
            <IconWand />
          </span>
          <span className="tour-count">
            {index + 1} / {STEPS.length}
          </span>
          <button className="tour-x" onClick={close} title={i18n.t('kfbedd4c1')}>
            <IconClose />
          </button>
        </div>

        <div className="tour-title">{step.title}</div>
        <p className="tour-body">{step.body}</p>
        {step.tip && <div className="tour-tip">{step.tip}</div>}

        <div className="tour-foot">
          <div className="tour-dots">
            {STEPS.map((s, k) => (
              <button
                key={s.key}
                className={`tour-dot${k === index ? ' on' : ''}`}
                onClick={() => setIndex(k)}
                title={i18n.t('k893571d0', { p0: k + 1, p1: s.title })}
              />
            ))}
          </div>
          {index > 0 && (
            <button className="btn ghost sm" onClick={() => setIndex((v) => v - 1)}>
              {i18n.t('keeb69088')}
            </button>
          )}
          {!last && (
            <button className="btn ghost sm tour-skip" onClick={close}>
              {i18n.t('k92636e8c')}
            </button>
          )}
          <button className="btn primary sm" onClick={next}>
            {last ? i18n.t('k85d22db7') : i18n.t('k38ce27d8')}
          </button>
        </div>
      </div>
    </div>
  );
}
