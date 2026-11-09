/**
 * 侧栏：资源库切换 / 内容导航 / 待整理 / 标签树 / 文件夹树 / 宽度拖拽。
 *
 * 从 App.tsx 拆出（原来 90 多行 JSX 挤在 1600 行的主组件里）。
 * 这里保持纯展示：所有状态与副作用都还由 App 持有，避免拆分时改变行为。
 */
import type { CSSProperties, PointerEvent } from 'react';
import type { Filters, FolderNode, Library, SavedFilter, Stats, TagNode, View } from '../types';
import FolderTree from '../components/FolderTree';
import LibrarySwitcher from '../components/LibrarySwitcher';
import SavedFilterList from '../components/SavedFilterList';
import TagPanel from '../components/TagPanel';
import { MORE_NAV, PENDING_ITEMS, PRIMARY_NAV } from './nav';
import { SideSection, useSideSections } from './SideSection';

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

  /** 保存的筛选器（筛选现场，一键恢复） */
  savedFilters: SavedFilter[];
  activeSavedId: number | null;
  onOpenSavedFilter: (f: SavedFilter) => void;
  onSaveCurrentFilter: () => void;
  onEditSavedFilter: (f: SavedFilter) => void;
  onOverwriteSavedFilter: (f: SavedFilter) => void;
  onDeleteSavedFilter: (f: SavedFilter) => void;

  tags: TagNode[];
  tagGroups: [string, TagNode[]][];
  childrenOf: Map<string, TagNode[]>;
  onOpenTag: (tag: string) => void;
  onEditTag: (t: TagNode) => void;
  onTagsChanged: (r: { tags: TagNode[]; groups: string[] }) => void;
  /** 远端标签总数比已加载的多多少个（分页）：>0 时 TagPanel 显示「加载更多」 */
  remaining?: number;
  /** 点击「加载更多」加载下一页标签 */
  onLoadMore?: () => void;

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
  /** 文件夹图标 / emoji + 主题色 */
  onEditFolderAppearance?: (id: number) => void;
  /** 批量新建文件夹（null = 根级） */
  onBatchCreateFolder?: (parentId: number | null) => void;
  /** 同父级内拖动排序 */
  onReorderFolders?: (dragId: number, targetId: number, position: 'before' | 'after') => void;
  /** 批量新建标签 */
  onBatchCreateTag?: () => void;

  width: number;
  onResizeDown: (e: PointerEvent<HTMLDivElement>) => void;
  onResizeMove: (e: PointerEvent<HTMLDivElement>) => void;
  onResizeUp: (e: PointerEvent<HTMLDivElement>) => void;
  onResetWidth: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
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
  savedFilters,
  activeSavedId,
  onOpenSavedFilter,
  onSaveCurrentFilter,
  onEditSavedFilter,
  onOverwriteSavedFilter,
  onDeleteSavedFilter,
  tags,
  tagGroups,
  childrenOf,
  onOpenTag,
  onEditTag,
  onTagsChanged,
  remaining,
  onLoadMore,
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
  onEditFolderAppearance,
  onBatchCreateFolder,
  onReorderFolders,
  onBatchCreateTag,
  width,
  onResizeDown,
  onResizeMove,
  onResizeUp,
  onResetWidth,
  onToast,
}: Props) {
  const { open: sections, toggle: toggleSection, setAll: setAllSections, allOpen } = useSideSections();
  const pendingTotal = pendingCounts ? PENDING_ITEMS.filter((p) => pendingCounts[p.key] > 0).length : 0;

  return (
    <aside className="sidebar" data-tour="sidebar" style={{ '--sidebar-w': `${width}px` } as CSSProperties}>
      <div className="side-head">
        <span className="side-head-title">资源库</span>
        <button
          type="button"
          className="side-head-all"
          onClick={() => setAllSections(!allOpen)}
          title={allOpen ? '收起全部侧栏分区' : '展开全部侧栏分区'}
        >
          {allOpen ? '收起全部' : '展开全部'}
        </button>
      </div>

      <LibrarySwitcher
        libraries={libraries}
        activeLibId={activeLibId}
        onSwitch={onSwitchLibrary}
        onDelete={onDeleteLibrary}
        onCreate={onCreateLibrary}
        onOpenInExplorer={onOpenLibraryInExplorer}
      />

      {/* 仪表盘 / 图库是天天要点的常用功能，常驻顶部，不参与任何折叠收纳 */}
      <div className="side-primary-nav">
        {PRIMARY_NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item${view === n.key ? ' active' : ''}`}
            onClick={() => onNav(n.key)}
            title={n.label}
            data-tour={`nav:${n.key}`}
          >
            {n.icon}
            <span>{n.label}</span>
            {n.key === 'gallery' && stats?.total ? <span className="badge">{stats.total}</span> : null}
          </button>
        ))}
      </div>

      {/* 四个低频入口常驻：图标 + 文字都要，默认就能看见，也不会被「收起全部」藏起来 */}
      <div className="nav-grid side-more-nav" aria-label="更多导航">
        {MORE_NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item${view === n.key ? ' active' : ''}`}
            onClick={() => onNav(n.key)}
            title={n.label}
            data-tour={`nav:${n.key}`}
          >
            {n.icon}
            <span>{n.label}</span>
            {n.key === 'favorites' && stats?.favorite ? <span className="badge">{stats.favorite}</span> : null}
          </button>
        ))}
      </div>

      <SideSection
        title="待整理"
        open={sections.pending}
        onToggle={() => toggleSection('pending')}
        summary={pendingTotal ? `${pendingTotal} 项待处理` : '未分类 / 无标签 / 未评分'}
      >
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
      </SideSection>

      <SideSection
        title="保存的筛选"
        open={sections.saved}
        onToggle={() => toggleSection('saved')}
        summary={`${savedFilters.length} 条`}
        actions={
          <button className="folder-add-btn" title="把当前筛选条件保存下来" onClick={onSaveCurrentFilter}>
            ＋
          </button>
        }
      >
        <SavedFilterList
          filters={savedFilters}
          activeId={activeSavedId}
          onOpen={onOpenSavedFilter}
          onSaveCurrent={onSaveCurrentFilter}
          onEdit={onEditSavedFilter}
          onOverwrite={onOverwriteSavedFilter}
          onDelete={onDeleteSavedFilter}
          hideHeader
        />
      </SideSection>

      <SideSection
        title="标签"
        open={sections.tags}
        onToggle={() => toggleSection('tags')}
        summary={tags.length ? `${tags.length} 个` : '按标签筛选'}
        actions={
          onBatchCreateTag && (
            <button className="folder-add-btn" title="批量新建标签" onClick={onBatchCreateTag}>
              ＋
            </button>
          )
        }
      >
        <TagPanel
          tags={tags}
          groups={tagGroups}
          childrenOf={childrenOf}
          activeTag={filters.tag || ''}
          onOpenTag={onOpenTag}
          onEditTag={onEditTag}
          onChanged={onTagsChanged}
          onToast={onToast}
          remaining={remaining}
          onLoadMore={onLoadMore}
        />
      </SideSection>

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
          onEditAppearance={onEditFolderAppearance}
          onBatchCreate={onBatchCreateFolder}
          onReorder={onReorderFolders}
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
