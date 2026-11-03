import { useMemo, useState, type DragEvent } from 'react';
import type { FolderNode } from '../types';

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
}

/** 卡片拖拽约定的自定义 MIME（与 ImageCard 一致） */
const IMAGE_MIME = 'application/x-gem-image-id';

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
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  // 拖拽悬停的文件夹 id（高亮提示「松手就归到这里」）
  const [dropId, setDropId] = useState<number | null>(null);

  const dropHandlers = (folderId: number) => {
    if (!onDropImages) return {};
    return {
      onDragOver: (e: DragEvent) => {
        if (!onDropImages || !e.dataTransfer.types.includes(IMAGE_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if (dropId !== folderId) setDropId(folderId);
      },
      onDragLeave: () => setDropId((cur) => (cur === folderId ? null : cur)),
      onDrop: (e: DragEvent) => {
        const raw = e.dataTransfer.getData(IMAGE_MIME);
        setDropId(null);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        const ids = raw
          .split(',')
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0);
        if (ids.length) onDropImages(folderId, ids);
      },
    };
  };
  // 根素材文件夹节点也支持折叠（用 -1 作哨兵 id，与真实文件夹 id 不冲突）
  const ROOT_KEY = -1;

  const tree = useMemo(() => {
    const byParent = new Map<number | null, FolderNode[]>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      const arr = byParent.get(key) || [];
      arr.push(f);
      byParent.set(key, arr);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
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
            className={`folder-row${dropId === f.id ? ' drop-target' : ''}`}
            style={{ paddingLeft: depth * 14 }}
            {...dropHandlers(f.id)}
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
                  {isCollapsed ? '▸' : '▾'}
                </span>
              ) : (
                <span className="folder-chevron placeholder" />
              )}
              {f.cover?.thumbUrl && (
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
              )}
              <span className="folder-name">{f.name}</span>
              {f.tags && (
                <span className="folder-tags" title={`文件夹标签（夹内素材自动继承）：${f.tags}`}>
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
                <span className="folder-lock" title={f.unlocked ? '已解锁（本次会话可见）' : '隐私空间：已加锁'}>
                  {f.unlocked ? '🔓' : '🔒'}
                </span>
              )}
              {f.total > 0 && !f.locked && <span className="folder-count">{f.total}</span>}
            </button>
            <span className="folder-actions">
              <button title="新建子文件夹" onClick={() => onCreate(f.id)}>＋</button>
              {onToggleLock && (
                <button
                  title={f.locked ? (f.unlocked ? '重新上锁 / 改密码' : '解锁') : '加密码锁（隐私空间）'}
                  onClick={() => onToggleLock(f.id)}
                >
                  {f.locked ? '🔓' : '🔒'}
                </button>
              )}
              {onEditTags && (
                <button title="文件夹标签（夹内素材自动继承）" onClick={() => onEditTags(f.id)}>#</button>
              )}
              {onSetCover && (
                <button title="设置文件夹封面" onClick={() => onSetCover(f.id)}>▣</button>
              )}
              <button title="重命名" onClick={() => onRename(f.id)}>✎</button>
              <button title="删除文件夹（不删图片）" onClick={() => onDelete(f.id)}>✕</button>
            </span>
          </div>
          {!isCollapsed && renderLevel(f.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="folder-tree">
      <div className="folder-tree-head">
        <span>文件夹</span>
        <button className="folder-add-btn" title="新建文件夹" onClick={() => onCreate(null)}>
          ＋
        </button>
      </div>
      {/* 根素材文件夹：当前库挂载的磁盘根目录，点它回全库视图；点箭头折叠整棵树 */}
      <div className="folder-row folder-root-row" style={{ paddingLeft: 0 }}>
        <button
          type="button"
          className={`folder-item folder-root${rootActive ? ' active' : ''}`}
          onClick={onOpenRoot}
          title={rootPath ? `素材根目录：${rootPath}` : '素材根目录（未在设置页指定）'}
        >
          {tree.get(null)?.length ? (
            <span
              className="folder-chevron"
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(ROOT_KEY);
              }}
            >
              {collapsed.has(ROOT_KEY) ? '▸' : '▾'}
            </span>
          ) : (
            <span className="folder-chevron placeholder" />
          )}
          <span className="folder-name">{rootName}</span>
        </button>
      </div>
      {!collapsed.has(ROOT_KEY) && renderLevel(null, 1)}
    </div>
  );
}
