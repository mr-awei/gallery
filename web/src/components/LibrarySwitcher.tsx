import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Library } from '../types';
import { IconFolder } from './Icons';

/**
 * Eagle 式资源库切换器：左上角触发按钮 → 库列表面板。
 * - 点行切换库；当前库带 ✓
 * - 每行 hover 出现 …，点开上下文菜单（在文件管理器打开 / 从列表删除）
 * - 「从列表删除」可删任意库，不必先切换过去（后端对非激活库直接移除注册）
 * - 面板与菜单用 fixed 定位：侧栏 overflow-x hidden 会裁剪 absolute 弹层
 */
interface Props {
  libraries: Library[];
  activeLibId: number | null;
  onSwitch: (id: number) => void;
  onDelete: (lib: Library) => void;
  onCreate: () => void;
  onOpenInExplorer: (lib: Library) => void;
}

export default function LibrarySwitcher({ libraries, activeLibId, onSwitch, onDelete, onCreate, onOpenInExplorer }: Props) {
  const [open, setOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = libraries.find((l) => l.id === activeLibId);

  // 点外部 / Esc 关闭（面板与菜单已 portal 到 body，需一并排除）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        wrapRef.current?.contains(t) ||
        panelRef.current?.contains(t) ||
        menuRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
      setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setMenuFor(null);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const togglePanel = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPanelPos({ top: r.bottom + 6, left: r.left });
    }
    setMenuFor(null);
    setOpen(!open);
  };

  const openRowMenu = (e: React.MouseEvent, lib: Library) => {
    e.stopPropagation();
    if (menuFor === lib.id) {
      setMenuFor(null);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 200) });
    setMenuFor(lib.id);
  };

  const pick = (fn: () => void) => () => {
    fn();
    setOpen(false);
    setMenuFor(null);
  };

  // 面板/菜单 portal 到 body：脱离侧栏的层叠上下文，避免 fixed 弹层被主内容盖住
  return (
    <div className="lib-switcher-wrap" ref={wrapRef}>
      <button ref={triggerRef} type="button" className="lib-trigger" onClick={togglePanel} title="切换资源库">
        <IconFolder />
        <span className="lib-trigger-name">{active?.name ?? '选择资源库'}</span>
        <span className="lib-trigger-caret">▾</span>
      </button>

      {open &&
        createPortal(
          <div className="lib-panel" ref={panelRef} style={{ top: panelPos.top, left: panelPos.left }}>
            <div className="lib-panel-head">资源库</div>
            <div className="lib-panel-list">
              {libraries.map((lib) => (
                <div
                  key={lib.id}
                  className={`lib-row${lib.id === activeLibId ? ' active' : ''}`}
                  onClick={() => {
                    if (lib.id !== activeLibId) onSwitch(lib.id);
                    setOpen(false);
                    setMenuFor(null);
                  }}
                  title={lib.root_path ? `素材根目录：${lib.root_path}` : lib.path}
                >
                  <span className="lib-row-icon">
                    <IconFolder />
                  </span>
                  <span className="lib-row-name">{lib.name}</span>
                  {lib.id === activeLibId && (
                    <span className="lib-row-check" title="当前资源库">
                      ✓
                    </span>
                  )}
                  <button
                    type="button"
                    className="lib-row-more"
                    title="资源库操作"
                    onClick={(e) => openRowMenu(e, lib)}
                  >
                    ⋯
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="lib-panel-create" onClick={pick(onCreate)}>
              ＋ 新建资源库…
            </button>
          </div>,
          document.body
        )}

      {open &&
        menuFor != null &&
        createPortal(
          <div className="lib-menu" ref={menuRef} style={{ top: menuPos.top, left: menuPos.left }}>
            <button
              type="button"
              onClick={pick(() => {
                const lib = libraries.find((l) => l.id === menuFor);
                if (lib) onOpenInExplorer(lib);
              })}
            >
              在文件管理器打开
            </button>
            <button
              type="button"
              className="danger"
              disabled={!libraries.find((l) => l.id === menuFor)?.deletable}
              onClick={pick(() => {
                const lib = libraries.find((l) => l.id === menuFor);
                if (lib) onDelete(lib);
              })}
            >
              从列表删除
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
