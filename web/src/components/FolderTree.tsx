import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconImages,
  IconLock,
  IconPalette,
  IconPencil,
  IconPlus,
  IconUnlock,
} from './Icons';
import { FOLDER_MIME, IMAGE_MIME } from '../lib/dnd';
import type { FolderNode } from '../types';
import i18n from '../i18n';

const COLLAPSE_KEY = 'tuku:folder-tree:collapsed';
/** 根节点折叠用哨兵 id（真实文件夹 id 都是正数） */
const ROOT_KEY = -1;

/** 用户手动折过的夹记下来，下次打开还是原样；null = 从没动过，用默认折叠策略 */
function readCollapsed(): number[] | null {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return null;
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((n): n is number => typeof n === 'number') : null;
  } catch {
    /* 记录损坏就按默认折叠重新计算，不影响文件夹树 */
    return null;
  }
}

/**
 * 侧栏文件夹树：后端返回扁平节点（parent_id），这里组装成树并按名称排序。
 * - 顶部固定「根素材文件夹」节点（当前库的素材根目录），点它回全库视图；
 *   其下按磁盘真实目录层级展示子孙文件夹，一眼可见图片归属（Eagle 式）
 * - 支持折叠子夹；点击文件夹进入对应视图（含后代聚合）
 * - 数字为含后代聚合数（total），即该夹下全部图片量
 * - 支持虚拟文件夹管理：根级新建、子夹新建、重命名、删除（hover 显示操作）
 * - 支持把素材卡拖到文件夹上直接归类（拖选中卡片时整批一起进）
 */
interface Props {
  folders: FolderNode[];
  activeId: number | null;
  rootName: string;
  rootPath: string;
  rootActive: boolean;
  onOpenRoot: () => void;
  onOpen: (id: number) => void;
  onCreate: (parentId: number | null) => void;
  onRename: (id: number) => void;
  onDelete: (id: number) => void;
  /** 打开「选封面」面板（手动指定夹内一张图；也可恢复自动） */
  onSetCover?: (id: number) => void;
  /** 拖拽入库：把 ids 加入 folderId 对应的文件夹 */
  onDropImages?: (folderId: number, ids: number[]) => void;
  /** 编辑文件夹标签（夹上打了标签，夹内素材自动带上，用于搜索） */
  onEditTags?: (id: number) => void;
  /** 隐私空间：加锁 / 解锁 / 重新上锁 / 移除密码（一个入口按当前状态分流） */
  onToggleLock?: (id: number) => void;
  /** 图标 / emoji + 主题色 */
  onEditAppearance?: (id: number) => void;
  /** 批量创建子文件夹 */
  onBatchCreate?: (parentId: number | null) => void;
  /** 同父级内拖动排序：把 dragId 放到 targetId 之前/之后 */
  onReorder?: (dragId: number, targetId: number, position: 'before' | 'after') => void;
}



export default function FolderTree({
  folders,
  activeId,
  rootName,
  rootPath,
  rootActive,
  onOpenRoot,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onSetCover,
  onDropImages,
  onEditTags,
  onToggleLock,
  onEditAppearance,
  onBatchCreate,
  onReorder,
}: Props) {
  const savedCollapse = useRef(readCollapsed() !== null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set(readCollapsed() || []));
  // 拖拽悬停的文件夹 id（高亮提示「松手就归到这里」）
  const [dropId, setDropId] = useState<number | null>(null);
  /** 正在被拖动的文件夹（拖动排序时用；只在同一父级内允许落点） */
  const [dragFolderId, setDragFolderId] = useState<number | null>(null);
  /** 拖动排序的插入位：目标夹 + 前/后 */
  const [dropPos, setDropPos] = useState<{ id: number; pos: 'before' | 'after' } | null>(null);
  /** 文件夹右键菜单：所有操作都从这里进（folder 为 null 表示根素材目录） */
  const [menu, setMenu] = useState<{ x: number; y: number; folder: FolderNode | null } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const mf = menu?.folder ?? null;

  /** 折叠状态持久化：调过一次之后，下次启动仍是用户自己的树形 */
  useEffect(() => {
    if (!savedCollapse.current) return; // 默认折叠尚未算出来之前，别把空集合写成「用户选择全展开」
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* 隐私模式写不进去就只在本次会话生效 */
    }
  }, [collapsed]);

  /** 默认只展开根级：有子夹的节点收起，当前所在文件夹的祖先链保持展开（Eagle 式） */
  useEffect(() => {
    if (savedCollapse.current || !folders.length) return;
    savedCollapse.current = true;
    const parents = new Set<number>();
    const byId = new Map(folders.map((f) => [f.id, f]));
    for (const f of folders) if (f.parent_id != null) parents.add(f.parent_id);
    const guard = new Set<number>();
    let cur = activeId != null ? byId.get(activeId) : undefined;
    while (cur?.parent_id != null && !guard.has(cur.parent_id)) {
      guard.add(cur.parent_id);
      parents.delete(cur.parent_id);
      cur = byId.get(cur.parent_id);
    }
    setCollapsed(parents);
  }, [folders, activeId]);

  /** 头部「展开 / 收起全部子文件夹」：只作用于有子夹的节点 */
  const parentIds = useMemo(() => {
    const ids = new Set<number>();
    for (const f of folders) if (f.parent_id != null) ids.add(f.parent_id);
    return [...ids];
  }, [folders]);
  const allChildrenCollapsed = parentIds.length > 0 && parentIds.every((id) => collapsed.has(id));
  const toggleAllChildren = () => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (allChildrenCollapsed) {
        parentIds.forEach((id) => next.delete(id));
        next.delete(ROOT_KEY); // 根级也一起展开
      } else {
        parentIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))}px`;
  }, [menu]);

  const openMenu = (e: ReactMouseEvent, folder: FolderNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, folder });
  };

  const dropHandlers = (folderId: number, parentId: number | null) => {
    return {
      onDragOver: (e: DragEvent) => {
        // 文件夹拖动排序：只接受同一父级内的目标（跨级拖动是「移动」不是「排序」）
        if (e.dataTransfer.types.includes(FOLDER_MIME)) {
          if (!dragFolderId || dragFolderId === folderId || !onReorder) return;
          const src = folders.find((x) => x.id === dragFolderId);
          if (!src || (src.parent_id ?? null) !== (parentId ?? null)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
          setDropPos((cur) => (cur?.id === folderId && cur.pos === pos ? cur : { id: folderId, pos }));
          return;
        }
        if (!onDropImages || !e.dataTransfer.types.includes(IMAGE_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if (dropId !== folderId) setDropId(folderId);
      },
      onDragLeave: () => {
        setDropId((cur) => (cur === folderId ? null : cur));
        setDropPos((cur) => (cur?.id === folderId ? null : cur));
      },
      onDragEnd: () => {
        setDragFolderId(null);
        setDropPos(null);
      },
      onDrop: (e: DragEvent) => {
        if (e.dataTransfer.types.includes(FOLDER_MIME)) {
          const rawFolder = e.dataTransfer.getData(FOLDER_MIME);
          const pos = dropPos?.id === folderId ? dropPos.pos : 'after';
          setDropPos(null);
          setDragFolderId(null);
          const dragId = Number(rawFolder) || dragFolderId;
          if (!dragId || dragId === folderId) return;
          e.preventDefault();
          e.stopPropagation();
          onReorder?.(dragId, folderId, pos);
          return;
        }
        const raw = e.dataTransfer.getData(IMAGE_MIME);
        setDropId(null);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        const ids = raw
          .split(',')
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0);
        if (ids.length) onDropImages?.(folderId, ids);
      },
    };
  };
  const tree = useMemo(() => {
    const byParent = new Map<number | null, FolderNode[]>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      const arr = byParent.get(key) || [];
      arr.push(f);
      byParent.set(key, arr);
    }
    for (const arr of byParent.values()) {
      // 手动排序值优先（拖动排序写入），同值再按名称 —— 没拖过的夹保持原来的字母序
      arr.sort(
        (a, b) =>
          (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN')
      );
    }
    return byParent;
  }, [folders]);

  const toggleCollapse = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderLevel = (parentId: number | null, depth: number) => {
    const children = tree.get(parentId) || [];
    return children.map((f) => {
      const kids = tree.get(f.id) || [];
      const isCollapsed = collapsed.has(f.id);
      return (
        <div key={f.id} className="folder-node">
          <div
            className={`folder-row${dropId === f.id ? ' drop-target' : ''}${
              dropPos?.id === f.id ? ` drop-${dropPos.pos}` : ''
            }${dragFolderId === f.id ? ' dragging' : ''}`}
            style={{ paddingLeft: depth * 14 }}
            {...dropHandlers(f.id, f.parent_id ?? null)}
            onContextMenu={(e) => openMenu(e, f)}
            draggable={!!onReorder}
            onDragStart={(e) => {
              if (!onReorder) return;
              // 只在文件夹行上拖才带这个 MIME；卡片拖拽带的是图片 MIME，互不干扰
              e.dataTransfer.setData(FOLDER_MIME, String(f.id));
              e.dataTransfer.effectAllowed = 'move';
              setDragFolderId(f.id);
            }}
          >
            <button
              type="button"
              className={`folder-item${f.id === activeId ? ' active' : ''}`}
              onClick={() => onOpen(f.id)}
              title={f.name}
            >
              {kids.length ? (
                <span
                  className="folder-chevron"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(f.id);
                  }}
                >
                  {isCollapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                </span>
              ) : (
                <span className="folder-chevron placeholder" />
              )}
              {f.icon ? (
                <span className="folder-icon" style={f.color ? { color: f.color } : undefined} aria-hidden>
                  {f.icon}
                </span>
              ) : (
                f.cover?.thumbUrl && (
                  <img
                    className="folder-cover"
                    src={f.cover.thumbUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )
              )}
              {f.color && <span className="folder-color-dot" style={{ background: f.color }} aria-hidden />}
              <span className="folder-name" style={f.color ? { color: f.color } : undefined}>
                {f.name}
              </span>
              {f.tags && (
                <span className="folder-tags" title={i18n.t('k1aae1c7f', { p0: f.tags })}>
                  {String(f.tags)
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((t) => `#${t}`)
                    .join(' ')}
                </span>
              )}
              {f.locked && (
                <span className="folder-lock" title={f.unlocked ? i18n.t('k65771115') : i18n.t('k25a9facd')}>
                  {f.unlocked ? <IconUnlock size={12} /> : <IconLock size={12} />}
                </span>
              )}
              {f.total > 0 && !f.locked && <span className="folder-count">{f.total}</span>}
            </button>
          </div>
          {!isCollapsed && renderLevel(f.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="folder-tree">
      <div className="folder-tree-head">
        <span>{i18n.t('k1f4c1042')}</span>
        <div className="folder-tree-head-actions">
          {parentIds.length > 0 && (
            <button
              className="folder-add-btn"
              title={allChildrenCollapsed ? i18n.t('k9e9f0fe4') : i18n.t('k2030ab5c')}
              onClick={toggleAllChildren}
            >
              {allChildrenCollapsed ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </button>
          )}
          <button className="folder-add-btn" title={i18n.t('kf3a485df')} aria-label={i18n.t('kf3a485df')} onClick={() => onCreate(null)}>
            <IconPlus size={14} />
          </button>
        </div>
      </div>
      {/* 根素材文件夹：当前库挂载的磁盘根目录，点它回全库视图；点箭头折叠整棵树 */}
      <div className="folder-row folder-root-row" style={{ paddingLeft: 0 }} onContextMenu={(e) => openMenu(e, null)}>
        <button
          type="button"
          className={`folder-item folder-root${rootActive ? ' active' : ''}`}
          onClick={onOpenRoot}
          title={rootPath ? i18n.t('k6a1172a2', { p0: rootPath }) : i18n.t('kea01ef23')}
        >
          {tree.get(null)?.length ? (
            <span
              className="folder-chevron"
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(ROOT_KEY);
              }}
            >
              {collapsed.has(ROOT_KEY) ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
            </span>
          ) : (
            <span className="folder-chevron placeholder" />
          )}
          <span className="folder-name">{rootName}</span>
        </button>
      </div>
      {!collapsed.has(ROOT_KEY) && renderLevel(null, 1)}

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="card-ctx"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {mf ? (
              <>
                <button onClick={() => { setMenu(null); onOpen(mf.id); }}>{i18n.t('kb00f8cb9')}</button>
                <div className="card-ctx-sep" />
                <button onClick={() => { setMenu(null); onCreate(mf.id); }}>
                  <IconPlus size={13} /> {i18n.t('kbefd04b3')}
                </button>
                {onBatchCreate && (
                  <button onClick={() => { setMenu(null); onBatchCreate(mf.id); }}>
                    <IconPlus size={13} /> {i18n.t('k5319a349')}
                  </button>
                )}
                {onEditAppearance && (
                  <button onClick={() => { setMenu(null); onEditAppearance(mf.id); }}>
                    <IconPalette size={13} /> {i18n.t('kba1684ef')}
                  </button>
                )}
                {onSetCover && (
                  <button onClick={() => { setMenu(null); onSetCover(mf.id); }}>
                    <IconImages size={13} /> {i18n.t('kb9bbf33f')}
                  </button>
                )}
                {onEditTags && (
                  <button onClick={() => { setMenu(null); onEditTags(mf.id); }}>{i18n.t('ke286f652')}</button>
                )}
                {onToggleLock && (
                  <button onClick={() => { setMenu(null); onToggleLock(mf.id); }}>
                    {mf.locked && mf.unlocked ? <IconUnlock size={13} /> : <IconLock size={13} />}
                    {mf.locked ? (mf.unlocked ? i18n.t('kc18de144') : i18n.t('kfa7ffa2d')) : i18n.t('k41989790')}
                  </button>
                )}
                <div className="card-ctx-sep" />
                <button onClick={() => { setMenu(null); onRename(mf.id); }}>
                  <IconPencil size={13} /> {i18n.t('kc8ce4b36')}
                </button>
                <button onClick={() => { setMenu(null); onDelete(mf.id); }}>
                  <IconClose size={13} /> {i18n.t('k42d3ae1d')}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => { setMenu(null); onOpenRoot(); }}>{i18n.t('kb3f144a3')}</button>
                <button onClick={() => { setMenu(null); onCreate(null); }}>
                  <IconPlus size={13} /> {i18n.t('kf3a485df')}
                </button>
                {onBatchCreate && (
                  <button onClick={() => { setMenu(null); onBatchCreate(null); }}>
                    <IconPlus size={13} /> {i18n.t('k267e5c9e')}
                  </button>
                )}
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
