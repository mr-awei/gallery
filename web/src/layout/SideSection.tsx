/**
 * 侧栏可折叠分区（Eagle 式 disclosure）。
 *
 * 侧栏从上到下原本是十几个平铺区块，文件夹树被挤到屏幕底部。这里把次要分区做成
 * 可折叠标题，默认收起，让文件夹树一进应用就能看到；折叠状态写 localStorage，
 * 用户调过一次之后就保持自己的习惯。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

export type SideSectionKey = 'pending' | 'saved' | 'tags';

const STORAGE_KEY = 'tuku:sidebar:sections';

/** 默认：待整理展开、保存的筛选与标签收起，文件夹树占主要空间。
 *  仪表盘 / 图库与四个小图标入口是常驻区，不在这里折叠；旧存档里的 nav 键会被忽略。 */
export const DEFAULT_SIDE_SECTIONS: Record<SideSectionKey, boolean> = {
  pending: true,
  saved: false,
  tags: false,
};

const KEYS: SideSectionKey[] = ['pending', 'saved', 'tags'];

function readSections(): Record<SideSectionKey, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SIDE_SECTIONS };
    const saved = JSON.parse(raw) as Partial<Record<SideSectionKey, unknown>>;
    const next = { ...DEFAULT_SIDE_SECTIONS };
    for (const k of KEYS) if (typeof saved[k] === 'boolean') next[k] = saved[k] as boolean;
    return next;
  } catch {
    /* localStorage 被禁用 / 内容损坏：退回默认折叠状态，不影响侧栏使用 */
    return { ...DEFAULT_SIDE_SECTIONS };
  }
}

/** 所有分区的展开状态 + 单区切换 / 一键全开全收 */
export function useSideSections() {
  const [open, setOpen] = useState<Record<SideSectionKey, boolean>>(readSections);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(open));
    } catch {
      /* 隐私模式写不进去就只在本次会话生效 */
    }
  }, [open]);

  const toggle = useCallback((key: SideSectionKey) => {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const allOpen = KEYS.every((k) => open[k]);
  const setAll = useCallback((next: boolean) => {
    setOpen({ pending: next, saved: next, tags: next });
  }, []);

  return { open, toggle, setAll, allOpen };
}

interface Props {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** 折叠时标题右侧的一句话摘要（如当前库名 / 条目数），不占额外行 */
  summary?: ReactNode;
  /** 标题右侧常驻小按钮（新建 / 保存），折叠时也能点 */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SideSection({ title, open, onToggle, summary, actions, children, className = '' }: Props) {
  return (
    <section className={`side-section${open ? ' open' : ''} ${className}`.trim()}>
      <div className="side-section-head">
        <button
          type="button"
          className="side-section-toggle"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? `收起${title}` : `展开${title}`}
        >
          <span className="side-section-chevron">{open ? '▾' : '▸'}</span>
          <span className="side-section-label">{title}</span>
          {!open && summary && <span className="side-section-summary">{summary}</span>}
        </button>
        {actions && <div className="side-section-actions">{actions}</div>}
      </div>
      {open && <div className="side-section-body">{children}</div>}
    </section>
  );
}
