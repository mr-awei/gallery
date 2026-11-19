import { Suspense, lazy } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { LightboxState } from '../hooks/useLightbox';
import type { PendingCounts } from '../hooks/useStatsAndTags';
import type { Filters, FolderNode, ImageItem, Stats, TagNode, View, ViewMode } from '../types';
import ErrorBoundary from '../components/ErrorBoundary';
import GalleryPage from '../pages/Gallery';
import type { ImportProgress } from './useImportWatch';
import type { Toast } from './types';
import i18n from '../i18n';

const Crawl = lazy(() => import('../pages/Crawl'));
const TimelinePage = lazy(() => import('../pages/Timeline').then((m) => ({ default: m.Timeline })));
// 低频且体积大的页面按需加载：设置页（含各分区面板）与教程（150 条文案）
// 不该拖进首包。只有图库保持静态导入——它是启动后的第一个视图，懒加载会闪骨架；
// 仪表盘虽也是「首屏级」页面，但启动默认落在图库，切过去时再取即可。
const Dashboard = lazy(() => import('../pages/Dashboard'));
const SettingsPage = lazy(() => import('../pages/Settings'));
const Knowledge = lazy(() => import('../pages/Knowledge'));
const Playlists = lazy(() => import('../pages/Playlists'));
const Tidy = lazy(() => import('../pages/Tidy'));
const EnhancePage = lazy(() => import('../pages/Enhance'));
const Search = lazy(() => import('../pages/Search'));
const Smart = lazy(() => import('../pages/Smart'));
const Bookmarks = lazy(() => import('../pages/Bookmarks'));
const People = lazy(() => import('../pages/People'));
// 地点视图带一张世界地图 + 聚合数据，首屏用不到，按需加载
const Places = lazy(() => import('../pages/Places'));
const Tutorial = lazy(() => import('../pages/Tutorial'));
// 无限画布：DOM + transform 实现，进页面才加载
const CanvasBoard = lazy(() => import('../pages/CanvasBoard'));

type Props = {
  view: View;
  viewMode: ViewMode;
  loadError: string;
  stats: Stats | null;
  filters: Filters;
  effectiveFilters: Filters;
  folderId: number | null;
  folders: FolderNode[];
  items: ImageItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  selected: Set<number>;
  annotationCounts: Record<string, number>;
  dupeCounts: Record<string, number>;
  tags: TagNode[];
  pendingCounts: PendingCounts | null;
  importProgress: ImportProgress;
  missingCount: number;
  refreshSeq: number;
  refreshing: boolean;
  importing: boolean;
  colWidth: number;
  hoverIdRef: MutableRefObject<number | null>;
  activeFolder: FolderNode | null;
  activeLibName: string;
  peopleFocus: { id: number; n: number } | null;
  tourDone: boolean;
  showToast: Toast;
  setView: Dispatch<SetStateAction<View>>;
  setLb: Dispatch<SetStateAction<LightboxState>>;
  setStackViewId: Dispatch<SetStateAction<number | null>>;
  setQuickClassifyIds: Dispatch<SetStateAction<number[] | null>>;
  reloadTags: () => void;
  openItem: (item: ImageItem, pool?: ImageItem[], full?: boolean) => void;
  onFiltersChange: (patch: Partial<Filters>) => void;
  loadMore: () => void;
  toggleSelect: (id: number) => void;
  clearSelection: () => void;
  selectAll: () => void;
  bulk: (action: string, tag?: string) => Promise<void>;
  openFromGrid: (item: ImageItem) => void;
  toggleFavorite: (item: ImageItem) => Promise<void>;
  download: (item: ImageItem) => void;
  patchItem: (updated: ImageItem) => void;
  deleteFromGrid: (item: ImageItem) => void;
  changeViewMode: (m: ViewMode) => void;
  changeColWidth: (w: number) => void;
  startCrawl: () => void;
  refreshGallery: () => Promise<void>;
  undoFromGrid: () => void;
  relocateMissing: () => Promise<void>;
  purgeMissing: () => Promise<void>;
  addToPlaylist: (playlistId: number | string) => Promise<void>;
  addToFolder: (folderId: number | string) => Promise<void>;
  reorderInFolder: (dragIds: number[], targetId: number) => Promise<void>;
  markAllSeen: () => Promise<void>;
  dropTagOnImage: (item: ImageItem, tag: string) => Promise<void>;
  ungroupStackAt: (stackId: number) => Promise<void>;
  stackSelection: () => Promise<void>;
  stackDropOnImage: (dragIds: number[], target: ImageItem) => Promise<void>;
  enterFolder: (id: number) => void;
  dropImagesOnFolderAt: (folderId: number, ids: number[]) => Promise<void>;
  openRoot: () => void;
  openFromFolderGroup: (item: ImageItem, pool: ImageItem[]) => void;
  showUnfiled: () => void;
  openPlace: (bbox: string, label: string) => void;
  startTour: () => void;
  onSetWallpaper: (item: ImageItem, style?: string) => Promise<void>;
  /** 库内写操作后统一对账（列表 + 统计 + 跟着后台扫描） */
  onLibraryChanged: () => void;
  /** 书签保存后只要列表与统计（不跟扫描） */
  onLibraryChangedOnly: () => void;
};

/**
 * 主内容区的视图路由：一个 view 一个分支，只做 props 透传。
 * 外层 ErrorBoundary + Suspense 一并搬过来，保证单个页面渲染崩了只影响内容区。
 */
export default function AppPages(props: Props) {
  const {
    view, viewMode, loadError, stats, filters, effectiveFilters, folderId, folders, items, total,
    hasMore, loading, selected, annotationCounts, dupeCounts, tags, pendingCounts, importProgress,
    missingCount, refreshSeq, refreshing, importing, colWidth, hoverIdRef, activeFolder, activeLibName,
    peopleFocus, tourDone, showToast, setView, setLb, setStackViewId, setQuickClassifyIds, reloadTags,
    openItem, onFiltersChange, loadMore, toggleSelect, clearSelection, selectAll, bulk, openFromGrid,
    toggleFavorite, download, patchItem, deleteFromGrid, changeViewMode, changeColWidth, startCrawl,
    refreshGallery, undoFromGrid, relocateMissing, purgeMissing, addToPlaylist, addToFolder,
    reorderInFolder, markAllSeen, dropTagOnImage, ungroupStackAt, stackSelection, stackDropOnImage,
    enterFolder, dropImagesOnFolderAt, openRoot, openFromFolderGroup, showUnfiled, openPlace,
    startTour, onSetWallpaper, onLibraryChanged, onLibraryChangedOnly,
  } = props;

  return (
    // 页面级错误边界：单个页面渲染崩了只影响内容区，不会整窗白屏
    <ErrorBoundary resetKey={view}>
      <Suspense fallback={<div style={{ padding: 40, color: 'var(--muted)' }}>{i18n.t('k37dc7bfc')}</div>}>
        {view === 'dashboard' && (
          <Dashboard
            stats={stats}
            error={loadError}
            onOpen={(item, pool) => openItem(item, pool)}
            onNavigate={(v) => setView(v as View)}
          />
        )}

        {view === 'timeline' && (
          <TimelinePage onToast={showToast} onOpen={(item, pool) => openItem(item, pool)} />
        )}

        {view === 'canvas' && (
          <CanvasBoard onToast={showToast} onOpen={(item, pool) => openItem(item, pool)} />
        )}

        {(view === 'gallery' || view === 'favorites') && (
          <GalleryPage
            title={view === 'favorites' ? i18n.t('k53d02627') : activeFolder ? activeFolder.name : i18n.t('k6084bc4b')}
            subtitle={
              view === 'favorites'
                ? i18n.t('k3736761a')
                : activeFolder
                  ? i18n.t('k4e77dbcf')
                  : viewMode === 'folder'
                    ? i18n.t('k3e466133')
                    : viewMode === 'grid'
                      ? i18n.t('k54c65e84')
                      : i18n.t('kf0b813c6')
            }
            filters={effectiveFilters}
            onFiltersChange={onFiltersChange}
            items={items}
            total={total}
            hasMore={hasMore}
            loading={loading}
            onLoadMore={loadMore}
            selected={selected}
            onToggleSelect={toggleSelect}
            onClearSelection={clearSelection}
            onSelectAll={selectAll}
            onBulk={bulk}
            onOpen={openFromGrid}
            onToggleFavorite={toggleFavorite}
            onDownload={download}
            onUpdateItem={patchItem}
            onDeleteItem={deleteFromGrid}
            viewMode={viewMode}
            onViewMode={changeViewMode}
            colWidth={colWidth}
            onColWidth={changeColWidth}
            annotationCounts={annotationCounts}
            dupeCounts={dupeCounts}
            tags={tags}
            hideFavorite={view === 'favorites'}
            onStartCrawl={startCrawl}
            onRefresh={refreshGallery}
            onUndo={undoFromGrid}
            importing={importing}
            importProgress={importProgress}
            missingCount={missingCount}
            refreshSeq={refreshSeq}
            refreshing={refreshing}
            onRelocateMissing={relocateMissing}
            onPurgeMissing={purgeMissing}
            onAddToPlaylist={addToPlaylist}
            onAddToFolder={addToFolder}
            folderId={folderId}
            manualSort={filters.sort === 'manual' && !!folderId}
            onReorder={reorderInFolder}
            onMarkAllSeen={markAllSeen}
            onDropTag={dropTagOnImage}
            onOpenStack={setStackViewId}
            onUngroupStack={ungroupStackAt}
            onStackSelected={stackSelection}
            onStackDrop={stackDropOnImage}
            folders={folders}
            onOpenFolder={enterFolder}
            onDropImagesOnFolder={dropImagesOnFolderAt}
            onOpenRoot={openRoot}
            rootName={activeLibName}
            onOpenImageFromFolder={openFromFolderGroup}
            unfiledCount={pendingCounts?.noFolder ?? 0}
            onShowUnfiled={showUnfiled}
            onQuickClassify={() => {
              const ids = selected.size
                ? [...selected]
                : [hoverIdRef.current || items[0]?.id].filter((n): n is number => Number.isFinite(n as number));
              if (!ids.length) return showToast(i18n.t('k968951a3'));
              setQuickClassifyIds(ids);
            }}
          />
        )}

        {view === 'people' && (
          <People
            onToast={showToast}
            onOpen={openItem}
            focusPersonId={peopleFocus?.id ?? null}
            focusNonce={peopleFocus?.n ?? 0}
          />
        )}

        {view === 'places' && <Places onToast={showToast} onOpenPlace={openPlace} />}

        {view === 'tidy' && (
          <Tidy
            onToast={showToast}
            filters={filters}
            folderId={folderId}
            selectedIds={[...selected]}
            onLibraryChanged={onLibraryChanged}
          />
        )}

        {view === 'crawl' && <Crawl onToast={showToast} />}

        {view === 'playlists' && (
          <Playlists onToast={showToast} onOpen={openItem} onSetWallpaper={onSetWallpaper} />
        )}

        {view === 'knowledge' && <Knowledge onToast={showToast} onLibraryChanged={onLibraryChanged} />}

        {view === 'search' && (
          <Search onToast={showToast} onOpenItem={(item, pool) => openItem(item, pool, true)} />
        )}

        {view === 'smart' && <Smart onToast={showToast} onOpenItem={openItem} onTagsChanged={reloadTags} />}

        {view === 'enhance' && <EnhancePage onToast={showToast} onLibraryChanged={onLibraryChanged} />}

        {view === 'bookmarks' && (
          <Bookmarks
            onToast={showToast}
            onLibraryChanged={onLibraryChangedOnly}
            onOpen={(item, list) =>
              setLb({ items: list, index: Math.max(0, list.findIndex((x) => x.id === item.id)) })
            }
          />
        )}

        {view === 'tutorial' && (
          <Suspense fallback={<div style={{ padding: 40, color: 'var(--muted)' }}>{i18n.t('k3bbda7b4')}</div>}>
            <Tutorial />
          </Suspense>
        )}

        {view === 'settings' && (
          <Suspense fallback={<div style={{ padding: 40, color: 'var(--muted)' }}>{i18n.t('k110c1929')}</div>}>
            <SettingsPage
              onToast={showToast}
              tourDone={tourDone}
              onStartTour={startTour}
              onOpenTutorial={() => setView('tutorial')}
              onLibraryChanged={onLibraryChanged}
            />
          </Suspense>
        )}
      </Suspense>
    </ErrorBoundary>
  );
}
