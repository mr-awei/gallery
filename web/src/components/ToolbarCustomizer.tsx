import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 工具栏自定义面板：左边是「顶栏显示（按这个顺序）」，右边是「收在更多菜单里」。
 * 点一下就挪过去，↑↓ 调顺序 —— 比一堆复选框直观，也能表达顺序。
 */
type Props = {
  open: boolean;
  title?: string;
  hint?: string;
  /** 可选功能的全集（key + 展示名），顺序即默认顺序 */
  all: { key: string; label: string }[];
  pinned: string[];
  onChange: (keys: string[]) => void;
  onClose: () => void;
  /** 恢复默认的列表 */
  defaults: string[];
  /** 左栏标题里的位置名（大图顶栏 / 批量条），默认「顶栏」 */
  barName?: string;
};

export default function ToolbarCustomizer({
  open,
  title = '自定义工具栏',
  hint,
  all,
  pinned,
  onChange,
  onClose,
  defaults,
  barName = '顶栏',
}: Props) {
  const [draft, setDraft] = useState<string[]>(pinned);

  useEffect(() => {
    if (open) setDraft(pinned);
  }, [open, pinned]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const known = new Set(all.map((a) => a.key));
  const inBar = draft.filter((k) => known.has(k));
  const rest = all.filter((a) => !inBar.includes(a.key));
  const labelOf = (k: string) => all.find((a) => a.key === k)?.label ?? k;

  const move = (i: number, dir: -1 | 1) => {
    const next = [...inBar];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  };

  return createPortal(
    <div className="tcz-mask" onMouseDown={onClose}>
      <div className="tcz-card" onMouseDown={(e) => e.stopPropagation()}>
        <header className="tcz-head">
          <h4>{title}</h4>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="tcz-hint">
          {hint || '点条目在两栏之间移动；顶栏按左边从上到下的顺序显示，放不下时会自动收成图标。'}
        </p>
        <div className="tcz-body">
          <section className="tcz-col">
            <h5>
              {barName}显示 <em>{inBar.length}</em>
            </h5>
            <div className="tcz-list">
              {inBar.length === 0 && <div className="tcz-empty">全部收进「更多」了</div>}
              {inBar.map((k, i) => (
                <div className="tcz-row" key={k}>
                  <span className="tcz-name">{labelOf(k)}</span>
                  <span className="tcz-ops">
                    <button title="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button title="下移" disabled={i === inBar.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    <button
                      title="收进「更多」"
                      onClick={() =>
                        setDraft((cur) => {
                          const n = cur.filter((x) => x !== k);
                          return n;
                        })
                      }
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="tcz-col">
            <h5>
              收在「更多」里 <em>{rest.length}</em>
            </h5>
            <div className="tcz-list">
              {rest.length === 0 && <div className="tcz-empty">全部都在顶栏上了</div>}
              {rest.map((a) => (
                <div className="tcz-row muted" key={a.key}>
                  <span className="tcz-name">{a.label}</span>
                  <span className="tcz-ops">
                    <button title="放到顶栏" onClick={() => setDraft((cur) => [...cur.filter((x) => x !== a.key), a.key])}>
                      +
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
        <footer className="tcz-foot">
          <button className="btn ghost" onClick={() => setDraft(defaults)}>
            恢复默认
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onChange(draft);
              onClose();
            }}
          >
            保存
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
