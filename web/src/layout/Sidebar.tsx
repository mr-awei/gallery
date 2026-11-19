/**
 * 侧栏：资源库切换 / 内容导航 / 待整理 / 标签树 / 文件夹树 / 宽度拖拽。
 *
 * 从 App.tsx 拆出（原来 90 多行 JSX 挤在 1600 行的主组件里）。
 * 这里保持纯展示：所有状态与副作用都还由 App 持有，避免拆分时改变行为。
 */
import type { CSSProperties, PointerEvent } from 'react';
import type { Filters, FolderNode, Library, SavedFilter, Stats, SwitchLibraryResult, TagNode, View } from '../types';
import FolderTree from '../components/FolderTree';
import LibrarySwitcher from '../components/LibrarySwitcher';
import SavedFilterList from '../components/SavedFilterList';
import TagPanel from '../components/TagPanel';
import { MORE_NAV, PENDING_ITEMS, PRIMARY_NAV, navLabel } from './nav';
import { SideSection, useSideSections } from './SideSection';
import i18n from '../i18n';

interface Props {
  libraries: Library[];
  activeLibId: number | null;
  activeLibName: string;
  activeLibRoot: string;
  /** 切库；加密库把密码一起带上。失败返回结果对象（缺密码时由切换器弹框） */
  onSwitchLibrary: (id: number, password?: string) => Promise<SwitchLibraryResult>;
  /** 库的密码状态变了，刷新列表 */
  onReloadLibraries: () => void;
  onDeleteLibrary: (lib: Library) => void;
  onCreateLibrary: () => void;
  onOpenLibraryInExplorer: (lib: Library) => void;

  view: View;
  onNav: (v: View) => void;
  stats: Stats | null;
  filters: Filters;
  onOpenPending: (key: 'inbox' | 'noFolder' | 'noTags' | 'noRating') => void;
  pendingCounts: { total: number; inbox: number; noFolder: number; noTags: number; noRating: number } | null;

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
  onReloadLibraries,
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
        <span className="side-head-title">{i18n.t('kc99f5cf1')}</span>
        <button
          type="button"
          className="side-head-all"
          onClick={() => setAllSections(!allOpen)}
          title={allOpen ? i18n.t('k45d77597') : i18n.t('k36c263ed')}
          aria-expanded={allOpen}
        >
          {allOpen ? i18n.t('k715dea3c') : i18n.t('ka47b2cb1')}
        </button>
      </div>

      <LibrarySwitcher
        libraries={libraries}
        activeLibId={activeLibId}
        onSwitch={onSwitchLibrary}
        onReload={onReloadLibraries}
        onDelete={onDeleteLibrary}
        onCreate={onCreateLibrary}
        onOpenInExplorer={onOpenLibraryInExplorer}
      />

      {/* 仪表盘 / 图库是天天要点的常用功能，常驻顶部，不参与任何折叠收纳 */}
      <nav className="side-primary-nav" aria-label={i18n.t('ka5fc35f0')}>
        {PRIMARY_NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item${view === n.key ? ' active' : ''}`}
            onClick={() => onNav(n.key)}
            title={navLabel(n)}
            aria-current={view === n.key ? 'page' : undefined}
            data-tour={`nav:${n.key}`}
          >
            {n.icon}
            <span>{navLabel(n)}</span>
            {n.key === 'gallery' && stats?.total ? <span className="badge">{stats.total}</span> : null}
          </button>
        ))}
      </nav>

      {/* 四个低频入口常驻：图标 + 文字都要，默认就能看见，也不会被「收起全部」藏起来 */}
      <nav className="nav-grid side-more-nav" aria-label={i18n.t('k156f092f')}>
        {MORE_NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item${view === n.key ? ' active' : ''}`}
            onClick={() => onNav(n.key)}
            title={navLabel(n)}
            aria-current={view === n.key ? 'page' : undefined}
            data-tour={`nav:${n.key}`}
          >
            {n.icon}
            <span>{navLabel(n)}</span>
            {n.key === 'favorites' && stats?.favorite ? <span className="badge">{stats.favorite}</span> : null}
          </button>
        ))}
      </nav>

      <SideSection
        title={i18n.t('ke723910f')}
        open={sections.pending}
        onToggle={() => toggleSection('pending')}
        summary={pendingTotal ? i18n.t('k9706ceac', { p0: pendingTotal }) : i18n.t('kf16d3dec')}
      >
        {PENDING_ITEMS.map((p) => (
          <button
            key={p.key}
            className={`nav-item pending${filters.pending === p.key && view === 'gallery' ? ' active' : ''}`}
            onClick={() => onOpenPending(p.key)}
            title={navLabel(p)}
          >
            <span className="pending-dot" />
            <span>{navLabel(p)}</span>
            {pendingCounts && pendingCounts[p.key] > 0 && <span className="badge">{pendingCounts[p.key]}</span>}
          </button>
        ))}
      </SideSection>

      <SideSection
        title={i18n.t('k7cdd7d9a')}
        open={sections.saved}
        onToggle={() => toggleSection('saved')}
        summary={i18n.t('kc2234681', { p0: savedFilters.length })}
        actions={
          <button className="folder-add-btn" title={i18n.t('kf251081d')} onClick={onSaveCurrentFilter}>
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
        title={i18n.t('k14d34236')}
        open={sections.tags}
        onToggle={() => toggleSection('tags')}
        summary={tags.length ? i18n.t('k9808ed1e', { p0: tags.length }) : i18n.t('k6d0ce360')}
        actions={
          onBatchCreateTag && (
            <button className="folder-add-btn" title={i18n.t('k5a911120')} onClick={onBatchCreateTag}>
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
        title={i18n.t('k6d3e1b64')}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onDoubleClick={onResetWidth}
      />
    </aside>
  );
}
