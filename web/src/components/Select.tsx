import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * 自绘下拉框。
 *
 * 为什么不用原生 <select>：Windows 上 Chromium 的原生弹出层由系统菜单渲染，
 * 在 Electron 窗口里经常点了没反应（用户报的「设置里所有下拉框都打不开」），
 * 而且 option 的暗色样式在 Windows 上根本不生效（白底黑字糊在深色界面上）。
 * 这里改成纯 DOM 弹层，点哪开哪，配色也能完全跟着主题走。
 *
 * 支持两种写法：
 *   <Select value={v} onChange={setV}><option value="a">A</option></Select>
 *   <Select value={v} onChange={setV} options={[{ value: 'a', label: 'A' }]} />
 */
type Item = { value: string; label: string; group?: string; disabled?: boolean };

export type SelectOption = { value: string; label: string; group?: string; disabled?: boolean };

type Props = {
  value: string | number;
  onChange: (value: string) => void;
  children?: ReactNode;
  options?: SelectOption[];
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  /** 值匹配不到任何选项时显示的文案 */
  placeholder?: string;
  title?: string;
  /** 列表里超过这个数量就带搜索框 */
  searchThreshold?: number;
};

/** <option>ABCD</option> 的文本就是显示文案（React 会把它放进 props.children） */
function optionLabel(children: ReactNode): string {
  if (children == null || children === false || children === true) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(optionLabel).join('');
  if (isValidElement(children)) {
    const el = children as ReactElement<{ children?: ReactNode }>;
    return optionLabel(el.props.children);
  }
  return '';
}

function collect(children: ReactNode, group: string | undefined, out: Item[]): Item[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ children?: ReactNode; value?: string; label?: string; disabled?: boolean }>;
    if (el.type === 'optgroup') {
      collect(el.props.children, String(el.props.label ?? ''), out);
      return;
    }
    if (el.type === 'option') {
      out.push({
        value: String(el.props.value ?? ''),
        label: optionLabel(el.props.children) || String(el.props.value ?? ''),
        group,
        disabled: el.props.disabled,
      });
      return;
    }
    if (el.props?.children) collect(el.props.children, group, out);
  });
  return out;
}

export default function Select({
  value,
  onChange,
  children,
  options,
  className,
  style,
  disabled,
  placeholder = '请选择',
  title,
  searchThreshold = 12,
}: Props) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, up: false, maxH: 320 });
  const [active, setActive] = useState(-1);
  const [q, setQ] = useState('');

  const items = useMemo<Item[]>(() => {
    if (options) return options.map((o) => ({ ...o }));
    const out: Item[] = [];
    collect(children, undefined, out);
    return out;
  }, [children, options]);

  const cur = value == null ? '' : String(value);
  const current = items.find((i) => i.value === cur);
  const showSearch = items.length > searchThreshold;
  const filtered = useMemo(() => {
    if (!q.trim()) return items;
    const k = q.trim().toLowerCase();
    return items.filter((i) => i.label.toLowerCase().includes(k) || i.value.toLowerCase().includes(k));
  }, [items, q]);

  /** 弹层位置：优先贴在触发按钮下方，下方放不下就翻到上面 */
  const measure = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const gap = 6;
    const below = window.innerHeight - r.bottom - gap - 12;
    const above = r.top - gap - 12;
    const want = Math.min(360, Math.max(160, items.length * 34 + (showSearch ? 44 : 0) + 10));
    const up = below < Math.min(want, 200) && above > below;
    const maxH = Math.max(140, Math.min(want, up ? above : below));
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(200, r.width) - 8)),
      top: up ? r.top - gap : r.bottom + gap,
      width: Math.max(200, r.width),
      up,
      maxH,
    });
  }, [items.length, showSearch]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // 捕获阶段监听所有滚动容器（弹层是 fixed，父容器滚动后位置就对不上了），
    // 但弹层自己列表的滚动必须放过：否则一滚就关，下面的选项永远选不到
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const commit = useCallback(
    (v: string) => {
      setOpen(false);
      setQ('');
      if (v !== cur) onChange(v);
      btnRef.current?.focus();
    },
    [onChange, cur]
  );

  const move = (dir: 1 | -1) => {
    if (!filtered.length) return;
    const i = filtered.findIndex((x, idx) => idx === active);
    let next = i + dir;
    if (i < 0) next = dir > 0 ? 0 : filtered.length - 1;
    if (next < 0) next = filtered.length - 1;
    if (next >= filtered.length) next = 0;
    // 跳过 disabled
    let guard = 0;
    while (filtered[next]?.disabled && guard < filtered.length) {
      next = (next + dir + filtered.length) % filtered.length;
      guard += 1;
    }
    setActive(next);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
      setActive(items.findIndex((i) => i.value === cur));
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[active];
      if (it && !it.disabled) commit(it.value);
    }
  };

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sel-btn${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        style={style}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (disabled) return;
          setQ('');
          setActive(items.findIndex((i) => i.value === cur));
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKey}
      >
        <span className="sel-label">{current?.label ?? placeholder}</span>
        <svg className="sel-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden>
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`sel-pop${pos.up ? ' up' : ''}`}
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxH }}
            role="listbox"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {showSearch && (
              <div className="sel-search">
                <input
                  autoFocus
                  value={q}
                  placeholder="搜索…"
                  onChange={(e) => {
                    setQ(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onTriggerKey}
                />
              </div>
            )}
            <div className="sel-list">
              {filtered.length === 0 && <div className="sel-empty">没有匹配项</div>}
              {filtered.map((it, idx) => {
                const head = it.group && it.group !== lastGroup ? it.group : null;
                lastGroup = it.group;
                return (
                  <div key={`${it.group ?? ''}-${it.value}-${idx}`}>
                    {head && <div className="sel-group">{head}</div>}
                    <div
                      role="option"
                      aria-selected={it.value === cur}
                      className={`sel-item${it.value === cur ? ' on' : ''}${idx === active ? ' hover' : ''}${
                        it.disabled ? ' dis' : ''
                      }`}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => !it.disabled && commit(it.value)}
                    >
                      <span className="sel-item-label">{it.label}</span>
                      {it.value === cur && (
                        <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden>
                          <path
                            d="M1 5.2l3.2 3.2L11 1.6"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
