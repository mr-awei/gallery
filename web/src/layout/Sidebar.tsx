/**
 * 侧栏：资源库切换 / 内容导航 / 待整理 / 标签树 / 文件夹树 / 宽度拖拽。
 *
 * 从 App.tsx 拆出（原来 90 多行 JSX 挤在 1600 行的主组件里）。
 * 这里保持纯展示：所有状态与副作用都还由 App 持有，避免拆分时改变行为。
 */
import type { CSSProperties, PointerEvent } from 'react';
import type { Filters, FolderNode, Library, Stats, TagNode, View } from '../types';
import FolderTree from '../components/FolderTree';
import LibrarySwitcher from '../components/LibrarySwitcher';
import TagPanel from '../components/TagPanel';
import { NAV, PENDING_ITEMS } from './nav';

interface Props {
  libraries: Library[];
  activeLibId: number | null;
  activeLibName: string;
  activeLibRoot: string;
  onSwitchLibrary: (id: number) => void;
  onDeleteLibrary: (lib: Library) => void;
  onCreateLibrary: () => void;
  onOpenLibraryInExplorer: (lib: Library) => void;

  view: View;
  onNav: (v: View) => void;
  stats: Stats | null;
  filters: Filters;
  onOpenPending: (key: 'noFolder' | 'noTags' | 'noRating') => void;
  pendingCounts: { total: number; noFolder: number; noTags: number; noRating: number } | null;

  tags: TagNode[];
  tagGroups: [string, TagNode[]][];
  childrenOf: Map<string, TagNode[]>;
  onOpenTag: (tag: string) => void;
  onEditTag: (t: TagNode) => void;
  onTagsChanged: (r: { tags: TagNode[]; groups: string[] }) => void;

  folders: FolderNode[];
  folderId: number | null;
  onOpenRoot: () => void;
  onOpenFolder: (id: number) => void;
  onCreateFolder: (parentId: number | null) => void;
  onRenameFolder: (id: number) => void;
  onDeleteFolder: (id: number) => void;
  /** 设置文件夹封面（弹夹内素材选择面板） */
  onSetFolderCover?: (id: number) => void;
  /** 编辑文件夹标签（夹内素材搜索时自动继承） */
  onEditFolderTags?: (id: number) => void;
  /** 隐私空间：加锁 / 解锁 / 移除密码 */
  onToggleFolderLock?: (id: number) => void;
  onDropImages: (folderId: number, ids: number[]) => void;

  width: number;
  onResizeDown: (e: PointerEvent<HTMLDivElement>) => void;
  onResizeMove: (e: PointerEvent<HTMLDivElement>) => void;
  onResizeUp: (e: PointerEvent<HTMLDivElement>) => void;
  onResetWidth: () => void;
  onToast: (msg: string) => void;
}

export default function Sidebar({
  libraries,
  activeLibId,
  activeLibName,
  activeLibRoot,
  onSwitchLibrary,
  onDeleteLibrary,
  onCreateLibrary,
  onOpenLibraryInExplorer,
  view,
  onNav,
  stats,
  filters,
  onOpenPending,
  pendingCounts,
  tags,
  tagGroups,
  childrenOf,
  onOpenTag,
  onEditTag,
  onTagsChanged,
  folders,
  folderId,
  onOpenRoot,
  onOpenFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onSetFolderCover,
  onEditFolderTags,
  onToggleFolderLock,
  onDropImages,
  width,
  onResizeDown,
  onResizeMove,
  onResizeUp,
  onResetWidth,
  onToast,
}: Props) {
  return (
    <aside className="sidebar" data-tour="sidebar" style={{ '--sidebar-w': `${width}px` } as CSSProperties}>
      <div className="side-section-title">资源库</div>
      <LibrarySwitcher
        libraries={libraries}
        activeLibId={activeLibId}
        onSwitch={onSwitchLibrary}
        onDelete={onDeleteLibrary}
        onCreate={onCreateLibrary}
        onOpenInExplorer={onOpenLibraryInExplorer}
      />
      {NAV.map((n) => (
        <button
          key={n.key}
          className={`nav-item${view === n.key ? ' active' : ''}`}
          onClick={() => onNav(n.key)}
        >
          {n.icon}
          <span>{n.label}</span>
          {n.key === 'gallery' && stats?.total ? <span className="badge">{stats.total}</span> : null}
          {n.key === 'favorites' && stats?.favorite ? <span className="badge">{stats.favorite}</span> : null}
        </button>
      ))}

      <div className="side-section-title">待整理</div>
      {PENDING_ITEMS.map((p) => (
        <button
          key={p.key}
          className={`nav-item pending${filters.pending === p.key && view === 'gallery' ? ' active' : ''}`}
          onClick={() => onOpenPending(p.key)}
          title={p.hint}
        >
          <span className="pending-dot" />
          <span>{p.label}</span>
          {pendingCounts && pendingCounts[p.key] > 0 && <span className="badge">{pendingCounts[p.key]}</span>}
        </button>
      ))}

      <div className="side-section-title">标签</div>
      <TagPanel
        tags={tags}
        groups={tagGroups}
        childrenOf={childrenOf}
        activeTag={filters.tag || ''}
        onOpenTag={onOpenTag}
        onEditTag={onEditTag}
        onChanged={onTagsChanged}
        onToast={onToast}
      />

      <div className="folders-panel">
        <FolderTree
          folders={folders}
          activeId={folderId}
          rootName={activeLibName}
          rootPath={activeLibRoot}
          rootActive={!folderId && view === 'gallery'}
          onOpenRoot={onOpenRoot}
          onOpen={onOpenFolder}
          onCreate={onCreateFolder}
          onRename={onRenameFolder}
          onDelete={onDeleteFolder}
          onSetCover={onSetFolderCover}
          onEditTags={onEditFolderTags}
          onToggleLock={onToggleFolderLock}
          onDropImages={onDropImages}
        />
      </div>
      <div
        className="sidebar-resizer"
        title="拖动调整侧栏宽度 · 双击恢复默认"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onDoubleClick={onResetWidth}
      />
    </aside>
  );
}
