import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconClose, IconWand } from './Icons';

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
    title: '欢迎：这是你自己家的图库',
    body: '图库把硬盘上的图片文件夹变成一个可搜索、可整理的素材库：文件还在原来的地方，索引、标签、评分都存在本地，不上传任何地方。',
    tip: '整套导览共 7 步，大约 2 分钟。任何时候都能点「跳过教程」，之后在 设置 → 教程 里重新看。',
  },
  {
    key: 'sidebar',
    title: '左边是全部内容入口',
    body: '仪表盘看规模与增长；图库 / 收藏 / 清单放素材；采集和书签负责把网上的图收进来；「待整理」会列出还没有文件夹、标签或评分的图。',
    tip: '侧栏顶部的「资源库」可以切换或新建多个库，每个库有独立的索引与设置。',
    target: 'sidebar',
    placement: 'right',
  },
  {
    key: 'topbar',
    title: '工具箱：分析、检索与增强',
    body: '工具箱里是更进阶的入口：裁切拼接、智能检索、画质增强、知识库、AI 打标等。右侧一排是保存网页、导出 HTML 画廊、设置和明暗切换。',
    target: 'topbar-actions',
    placement: 'bottom',
  },
  {
    key: 'filterbar',
    title: '用筛选找图，而不是往下翻',
    body: '搜索框同时匹配文件名、标签和关键词；后面可以叠加来源、评分、颜色、画幅、格式和文件夹。合适的组合能存成智能文件夹，下次一键回到同一批图。',
    target: 'filterbar',
    placement: 'bottom',
  },
  {
    key: 'grid',
    title: '悬停看操作，勾选做批量',
    body: '单击卡片进大图；鼠标悬停能直接收藏、下载、删除。勾选多张后底部会浮出批量条，可以批量裁切、调色、加水印相框、移动文件夹或删除。',
    tip: 'Ctrl / ⌘ + A 全选当前筛选下的所有图，不只是屏幕上这几张。',
    target: 'gallery-grid',
    placement: 'top',
  },
  {
    key: 'lightbox',
    title: '大图里做真正的工作',
    body: '双击或按 Enter 打开大图：← → 翻页，1~5 打星，顶栏「更多」里有裁切、旋转、Camera Raw 调色、水印 / 相框和图上标注。',
    tip: '每次写回都会自动存一份版本：Ctrl / ⌘ + Z 或版本历史随时能回滚。按 ? 可以看到全部快捷键。',
  },
  {
    key: 'settings',
    title: '个性化、备份与教程都在设置里',
    body: '设置里能改存储位置、导入与采集参数、AI 接入、删除策略、外观与缩放，也能导出数据、检查重复。这个教程以后就在这里重新播放。',
    tip: '现在就可以去 设置 → 教程 试一次，或直接开始用。',
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
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="教程">
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
          <button className="tour-x" onClick={close} title="跳过教程（Esc）">
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
                title={`第 ${k + 1} 步：${s.title}`}
              />
            ))}
          </div>
          {index > 0 && (
            <button className="btn ghost sm" onClick={() => setIndex((v) => v - 1)}>
              上一步
            </button>
          )}
          {!last && (
            <button className="btn ghost sm tour-skip" onClick={close}>
              跳过
            </button>
          )}
          <button className="btn primary sm" onClick={next}>
            {last ? '开始使用' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}
