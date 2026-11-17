import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18n from './i18n';

import { isDesktop, openFolder, openFolderById, quiet } from './api';
import type { Filters, View, ViewMode } from './types';
import GlobalImport from './components/GlobalImport';
import ScreenshotOverlay from './components/ScreenshotOverlay';
import LibraryLockScreen from './components/LibraryLockScreen';
import { THUMB_DEFAULT, clampThumbWidth } from './lib/thumb-size';
import { parseRoute, type RouteState } from './lib/route';
import TopBar from './layout/TopBar';
import Sidebar from './layout/Sidebar';
import StatusBar from './layout/StatusBar';
import { TOOLS } from './layout/nav';
import { useAppUiState } from './hooks/useAppUiState';
import { useGalleryList } from './hooks/useGalleryList';
import { useStatsAndTags } from './hooks/useStatsAndTags';
import { useFolderTree } from './hooks/useFolderTree';
import { useSelection } from './hooks/useSelection';
import { useLightbox } from './hooks/useLightbox';
import { useSavedFilters } from './hooks/useSavedFilters';
import { useSidebarWidth } from './hooks/useSidebarWidth';
import { useAppKeyBindings } from './hooks/useAppKeyBindings';
import AppPages from './app/AppPages';
import LoadErrorBar from './app/LoadErrorBar';
import { useThemeAndTour } from './app/useThemeAndTour';
import { useImportWatch } from './app/useImportWatch';
import { useLibraries } from './app/useLibraries';
import { useAppServices } from './app/useAppServices';
import { useGallerySync } from './app/useGallerySync';
import { useRouteSync } from './app/useRouteSync';
import { useLiveData } from './app/useLiveData';
import { useEditHistory } from './app/useEditHistory';
import { useStacks } from './app/useStacks';
import { useItemActions } from './app/useItemActions';
import { useViewActions } from './app/useViewActions';
import { usePaletteCommands } from './app/usePaletteCommands';
import { useEnhance } from './app/useEnhance';
import { useDialogState } from './app/useDialogState';

/**
 * 27 个浮层（导出、水印、批注、人物、堆叠、命令面板…）不该压在首包里：
 * 首屏只用外壳 + 图库列表，浮层等真要打开时再取。启动后空闲时段预取，
 * 所以第一次按 Cmd+K 也不会等加载。
 */
const AppDialogs = lazy(() => import('./app/AppDialogs'));

/** 首屏状态来自 URL：分享出去的链接 / 刷新后都能还原到同一个筛选视图 */
const initialRoute: RouteState = parseRoute(window.location.search);
const defaultFilters: Filters = initialRoute.filters;

/**
 * 应用装配层。
 *
 * 拆成三部分后这里只负责「把状态接起来」：
 * - hooks/ 下是数据层（列表 / 统计 / 文件夹 / 选择 / 灯箱 / 保存的筛选）
 * - app/ 下是把原来散在本文件里的状态与 effect 按职责收拢后的 hooks 与两个渲染组件
 *   （AppPages 视图路由、AppDialogs 全部浮层）
 *
 * ⚠️ 这里所有 effect 的**注册顺序**与拆分前逐条对应（见每段上方的注释），
 * 因为它们之间有先后依赖（先拉设置再决定开不开教程、先订阅推送再对账等）。
 */
export default function App() {
  /* 空闲时把浮层 chunk 备好：首屏不等它，但用户真按 Cmd+K 时它已经在内存里 */
  useEffect(() => {
    const load = () => void import('./app/AppDialogs');
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(load, { timeout: 2500 });
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = setTimeout(load, 1200);
    return () => clearTimeout(timer);
  }, []);

  // 提示条 / 错误条 / 弹窗开关下沉到 hook：App 主体只管图库数据与筛选
  const ui = useAppUiState();
  const {
    showToast, loadError, setLoadError,
    setShowCreateLib, setBookmarkOpen, setExportOpen, setCoverFolderId,
    toolsOpen, setToolsOpen, setPalette,
  } = ui;
  // 各类集合弹窗的开关（纯 useState，无 effect）：先声明，命令面板与快捷键都要用
  const dialogs = useDialogState();
  // 当前资源库 id：统计 hook 要用它，而库会话 hook 在 effect 顺序上必须排在后面，
  // 所以这份 state 仍由 App 持有（与拆分前一致），库会话 hook 拿到的是同一份 state
  const [activeLibId, setActiveLibId] = useState<number | null>(null);

  const [view, setView] = useState<View>(initialRoute.view);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = localStorage.getItem('tuku:view-mode');
    // 旧版存过 'list'：列表视图已从切换组去掉，老用户重开时回落到瀑布流
    return v === 'grid' || v === 'folder' ? v : 'masonry';
  });
  /** 缩略图尺寸（列宽 px，Eagle 的缩略图滑块），持久化在本地；默认「中小」= 250 */
  const [colWidth, setColWidth] = useState(() => {
    const v = Number(localStorage.getItem('tuku:col-width'));
    return Number.isFinite(v) && v > 0 ? clampThumbWidth(v) : THUMB_DEFAULT;
  });
  const toolsRef = useRef<HTMLDivElement | null>(null);

  // 主内容滚动容器：切筛选/文件夹重载列表时必须滚回顶部，
  // 否则残留的 scrollTop 会让 MasonryGrid 虚拟窗口落在新内容之外（卡片裁剪/空白/提前到底）
  const contentRef = useRef<HTMLDivElement | null>(null);

  /* --------------------- 数据层：全部下沉到 hook，App 只做编排 --------------------- */
  const filtersRef = useRef<Filters>(filters);
  const folderIdRef = useRef<number | null>(initialRoute.folderId);
  // 导入进行中标记（ref 供 refreshStats 读取，避免回调依赖频繁变化）
  const importingRef = useRef(false);
  // 列表的「手动刷新」要用统计刷新，而统计 hook 又要用列表的 load —— 这层先后依赖用 ref 打通。
  // 两个取值器都必须 useCallback 稳定引用：它们进的是 hook 内回调的依赖数组，
  // 每次渲染换新函数会让 load/refreshStats 跟着换身份，memo 与定时器效应全部失效。
  const refreshStatsRef = useRef<() => void>(() => {});
  const requestStatsRefresh = useCallback(() => refreshStatsRef.current(), []);
  const isImportingNow = useCallback(() => importingRef.current, []);
  const showGallery = useCallback(() => setView('gallery'), []);

  const {
    items, setItems, total, setTotal, hasMore, loading, pageRef, newAtTopRef, refreshSeq, setRefreshSeq,
    refreshing, load, loadMore, refreshGallery, reveal: revealGalleryItem,
  } = useGalleryList({ showToast, filtersRef, folderIdRef, refreshStats: requestStatsRefresh });

  const {
    stats, setStats, tags, setTags, setTagGroups, tagTotal, pendingCounts, annotationCounts,
    setAnnotationCounts, dupeCounts, missingCount, libTotalRef, refreshStats, scheduleStatsRefresh,
    reloadOnIngest, statsThrottleRef, reloadTags, loadMoreTags, tagTree,
  } = useStatsAndTags({
    showToast, load, pageRef, newAtTopRef, setTotal, refreshSeq, activeLibId, isImporting: isImportingNow,
  });
  refreshStatsRef.current = refreshStats;

  const {
    folders, setFolders, reload: reloadFolders, folderId, setFolderId, enterFolder, lockFolderId,
    setLockFolderId, lockFolder, createFolderAt, renameFolderAt, editFolderTags, reorderInFolder,
    deleteFolderAt, reorderFoldersAt, dropImagesOnFolderAt, dropImagesIntoFolder,
  } = useFolderTree({
    showToast, items, load, refreshStats, initialFolderId: initialRoute.folderId, showGallery,
  });

  const { selected, setSelected, toggleSelect, clearSelection, selectAll, selectAllMatching, bulk } = useSelection({
    showToast, items, filtersRef, folderIdRef, pageRef, load, refreshStats,
  });

  const { lb, setLb, openItem } = useLightbox({ filtersRef });

  const {
    savedFilters, activeSavedId, setActiveSavedId, reload: reloadSavedFilters, saveCurrentFilter,
    editSavedFilter, overwriteSavedFilter, deleteSavedFilter,
  } = useSavedFilters({ filters, folderId, showToast });

  const { sidebarW, onResizerDown, onResizerMove, onResizerUp, resetWidth } = useSidebarWidth();

  // 导入进度 + 跟随轮询（无 effect，importingRef 的同步 effect 仍在下面原位置）
  const {
    importing, setImporting, importProgress, setImportProgress, wasImportingRef, followImport,
  } = useImportWatch({ showToast, refreshStats, load, pageRef, importingRef });

  // effect 1-3：主题立即生效 → 拉一次服务端设置 → 决定要不要自动开教程
  const {
    theme, setTheme, toggleTheme, onboarding, tourOpen, tourDone, finishOnboarding, finishTour, startTour,
  } = useThemeAndTour({ setView });

  // effect 4-7：库列表 + 文件夹树 → 由库状态推导解锁屏 → 订阅 423 → 校验 URL 里的 folderId
  const {
    libraries, lockInfo, reloadLibraries, switchLibrary, deleteLibraryAt, onLibraryCreated,
  } = useLibraries({
    showToast, setView, setFolderId, setFolders, setShowCreateLib, setActiveSavedId, pageRef, load,
    refreshStats, followImport, reloadFolders, reloadSavedFilters, libTotalRef, folders, folderId,
    activeLibId, setActiveLibId,
  });

  // effect 8：importing 状态同步到 ref（job 事件 / importStatus 等多处 setImporting 都会覆盖）
  useEffect(() => {
    importingRef.current = importing;
  }, [importing]);

  // effect 9-13：后台错误收口 / 本地服务状态 / 事件异常 toast / 全网搜图 / 在图库中定位
  const { rsTarget, setRsTarget, peopleFocus, setPeopleFocus } = useAppServices({
    setLoadError, showToast, setView, setFolderId, openItem,
    setServiceRestarting: ui.setServiceRestarting,
    setServiceOffline: ui.setServiceOffline,
    setServiceError: ui.setServiceError,
  });

  const effectiveFilters = useMemo<Filters>(
    () => (view === 'favorites' ? { ...filters, favorite: 'yes' } : filters),
    [view, filters]
  );
  filtersRef.current = effectiveFilters;
  folderIdRef.current = folderId;

  // 文件夹视图切换（folderId 变化）同样要触发列表重载
  const queryKey = JSON.stringify(effectiveFilters) + `|folder:${folderId ?? ''}`;

  // effect 14-18：换数据源回顶重载清选择 → 量页头高度 → 换库清选择 → 回图库对账 → 焦点补刷
  useGallerySync({ queryKey, load, refreshStats, pageRef, contentRef, setSelected, view, activeLibId });

  // effect 19-20：URL ←→ 状态（push/replace）+ 浏览器后退前进
  useRouteSync({ initialRoute, view, filters, folderId, setView, setFilters, setFolderId, setSelected });

  // effect 21-22：弹窗无障碍 / 统计定时兜底 / library 事件 + job 事件里的导入进度
  useLiveData({
    refreshStats, scheduleStatsRefresh, reloadOnIngest, statsThrottleRef, setImporting, setImportProgress,
    wasImportingRef, followImport, showToast, load, pageRef,
  });

  // effect 23：单张替换 + 编辑撤销/重做（含 Ctrl+Z / Ctrl+Shift+Z 监听）
  const { patchItem, dropTagOnImage, undoEdit } = useEditHistory({
    setItems, setLb, load, refreshStats, reloadTags, showToast,
  });

  const { stackSelection, stackDropOnImage, ungroupStackAt } = useStacks({
    selected, setSelected, pageRef, load, showToast,
  });

  const {
    pendingDelete, setPendingDelete, requestDelete, confirmDelete,
    toggleFavorite, saveTags, deleteFromGrid, setWallpaper, download,
  } = useItemActions({
    patchItem, setStats, setItems, setLb, setTags, setTagGroups, refreshStats, showToast,
  });

  const {
    changeViewMode, changeColWidth, openSavedFilter, openRoot, openFromFolderGroup, showUnfiled,
    openPending, openTag, openPlace, handleNav, onFiltersChange, openFromGrid, startCrawl, undoFromGrid,
    markAllSeen, relocateMissing, purgeMissing, addToPlaylist, addToFolder,
  } = useViewActions({
    setView, setFolderId, setFilters, setViewMode, setColWidth, setSelected, setFolders, setActiveSavedId,
    setLb, items, selected, effectiveFilters, missingCount, defaultFilters, pageRef, load, openItem,
    refreshGallery, undoEdit, showToast,
  });

  // effect 24：命令面板命令表 + 「卡片右键搜命令」事件桥
  const { paletteCommands } = usePaletteCommands({
    theme, setTheme, setView, setFolderId, setFilters, setBookmarkOpen, setExportOpen, setPalette, setLb,
    setHelpOpen: dialogs.setHelpOpen, selectAllMatching, load, refreshStats, defaultFilters,
  });

  /* 全局快捷键（空格快速预览 / F 快速分类 / 全选 / 删除 / 撤销）全部在 hook 里 */
  const { hoverIdRef } = useAppKeyBindings({
    showToast, palette: ui.palette, setPalette, lb, setLb, setView, items, total, selected, setSelected,
    helpOpen: dialogs.helpOpen, setHelpOpen: dialogs.setHelpOpen,
    setQuickClassifyIds: dialogs.setQuickClassifyIds, bulk, openItem, selectAllMatching, undoEdit,
  });

  // effect 25：读取默认增强模型（大图预览里的「画质增强」用它）
  const { enhancingId, enhanceOne } = useEnhance({ patchItem, refreshStats, showToast });

  // 点击菜单外部收起工具下拉
  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!toolsRef.current?.contains(e.target as Node)) setToolsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [toolsOpen, setToolsOpen]);

  /** 错误条上的「重试」：把统计、标签、列表这几条主链路重跑一遍 */
  const retryFailedLoad = useCallback(() => {
    setLoadError('');
    setRefreshSeq((n) => n + 1);
    refreshStats();
    void load(1, true);
  }, [load, refreshStats, setLoadError, setRefreshSeq]);

  /** 库内写操作后统一对账：列表 + 统计 + 跟着后台扫描（原来四处各写一份内联箭头）。
   *  刻意**不用 useCallback**：拆分前它就是每次渲染新建的函数，而 Enhance 页的 job 订阅
   *  把它放进了依赖数组 —— 换成稳定引用会改变那条订阅的重订阅节奏，属于行为变化。 */
  const onLibraryChanged = () => {
    pageRef.current = 1;
    load(1, true);
    refreshStats();
    followImport();
  };

  /** 书签保存后只要列表与统计，不跟扫描 */
  const onLibraryChangedOnly = () => {
    pageRef.current = 1;
    load(1, true);
    refreshStats();
  };

  const crawling = !!stats?.crawling || importing;
  const activeFolder = folders.find((f) => f.id === folderId) || null;
  const activeLib = libraries.find((l) => l.id === activeLibId) || null;
  const activeLibName = activeLib?.name || i18n.t('k5435325b');
  // 当前视图若属于工具菜单项，则顶栏「工具箱」按钮保持高亮
  const toolsActive = TOOLS.some((t) => t.key === view);

  // 当前库锁着：整页只留解锁屏。必须在所有 hook 之后，且不能把下面的页面渲染出来
  // ——锁定时服务端对业务接口一律 423，渲染出来也只是一堆空状态
  if (lockInfo) {
    return <LibraryLockScreen library={lockInfo} onUnlocked={() => window.location.reload()} />;
  }

  return (
    <div className="app">
      {/* 键盘用户不必逐个 Tab 过侧栏 40 多个入口：Tab 第一下就能跳到主内容 */}
      <a className="skip-link" href="#main">
        {i18n.t('kcbe32105')}
      </a>
      {/* 任意页面都能拖入 / 粘贴入库（Eagle 三件套）；图库页接管时这里自动让位 */}
      <GlobalImport
        onImported={(n) => {
          showToast(i18n.t('k092eb236', { p0: n }));
          void refreshGallery();
        }}
        onToast={showToast}
      />
      {/* 截图框选（快捷键 / 托盘 / 📷 按钮触发） */}
      <ScreenshotOverlay
        onImported={() => {
          void refreshGallery();
        }}
        onToast={showToast}
      />
      <TopBar
        activeLibName={activeLibName}
        view={view}
        onView={setView}
        toolsOpen={toolsOpen}
        onToolsOpen={setToolsOpen}
        toolsRef={toolsRef}
        toolsActive={toolsActive}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBookmark={() => setBookmarkOpen(true)}
        onExportGallery={() => setExportOpen(true)}
        onShareLink={() => dialogs.setShareOpen(true)}
      />

      <div className="app-body">
        <Sidebar
          libraries={libraries}
          activeLibId={activeLibId}
          activeLibName={activeLib?.name ?? i18n.t('ka8b0c204')}
          activeLibRoot={activeLib?.root_path ?? ''}
          onSwitchLibrary={switchLibrary}
          onReloadLibraries={reloadLibraries}
          onDeleteLibrary={deleteLibraryAt}
          onCreateLibrary={() => setShowCreateLib(true)}
          onOpenLibraryInExplorer={(lib) => openFolder(lib.path).catch(quiet)}
          view={view}
          onNav={handleNav}
          stats={stats}
          filters={filters}
          onOpenPending={openPending}
          pendingCounts={pendingCounts}
          savedFilters={savedFilters}
          activeSavedId={activeSavedId}
          onOpenSavedFilter={openSavedFilter}
          onSaveCurrentFilter={saveCurrentFilter}
          onEditSavedFilter={editSavedFilter}
          onOverwriteSavedFilter={overwriteSavedFilter}
          onDeleteSavedFilter={deleteSavedFilter}
          tags={tags}
          tagGroups={tagTree.groups}
          childrenOf={tagTree.childrenOf}
          remaining={Math.max(0, tagTotal - tags.length)}
          onLoadMore={loadMoreTags}
          onOpenTag={openTag}
          onEditTag={dialogs.setTagEdit}
          onTagsChanged={(r) => {
            setTags(r.tags);
            setTagGroups(r.groups);
          }}
          folders={folders}
          folderId={folderId}
          onOpenRoot={openRoot}
          onOpenFolder={enterFolder}
          onCreateFolder={createFolderAt}
          onRenameFolder={renameFolderAt}
          onDeleteFolder={deleteFolderAt}
          onSetFolderCover={setCoverFolderId}
          onEditFolderTags={editFolderTags}
          onToggleFolderLock={setLockFolderId}
          onDropImages={dropImagesIntoFolder}
          onEditFolderAppearance={dialogs.setAppearanceFolderId}
          onBatchCreateFolder={(parentId) => dialogs.setBatchCreate({ mode: 'folder', parentId })}
          onReorderFolders={reorderFoldersAt}
          onBatchCreateTag={() => dialogs.setBatchCreate({ mode: 'tag', parentId: null })}
          width={sidebarW}
          onResizeDown={onResizerDown}
          onResizeMove={onResizerMove}
          onResizeUp={onResizerUp}
          onResetWidth={resetWidth}
          onToast={showToast}
        />

        <main className="main" id="main" tabIndex={-1}>
          {/* 后台请求失败：明确说「没加载出来」而不是让界面装作「没有数据」 */}
          {loadError && (
            <LoadErrorBar error={loadError} onRetry={retryFailedLoad} onClose={() => setLoadError('')} />
          )}
          <div className="content" ref={contentRef}>
            <AppPages
              view={view}
              viewMode={viewMode}
              loadError={loadError}
              stats={stats}
              filters={filters}
              effectiveFilters={effectiveFilters}
              folderId={folderId}
              folders={folders}
              items={items}
              total={total}
              hasMore={hasMore}
              loading={loading}
              selected={selected}
              annotationCounts={annotationCounts}
              dupeCounts={dupeCounts}
              tags={tags}
              pendingCounts={pendingCounts}
              importProgress={importProgress}
              missingCount={missingCount}
              refreshSeq={refreshSeq}
              refreshing={refreshing}
              importing={importing}
              colWidth={colWidth}
              hoverIdRef={hoverIdRef}
              activeFolder={activeFolder}
              activeLibName={activeLibName}
              peopleFocus={peopleFocus}
              tourDone={tourDone === true}
              showToast={showToast}
              setView={setView}
              setLb={setLb}
              setStackViewId={dialogs.setStackViewId}
              setQuickClassifyIds={dialogs.setQuickClassifyIds}
              reloadTags={reloadTags}
              openItem={openItem}
              onFiltersChange={onFiltersChange}
              loadMore={loadMore}
              toggleSelect={toggleSelect}
              clearSelection={clearSelection}
              selectAll={selectAll}
              bulk={bulk}
              openFromGrid={openFromGrid}
              toggleFavorite={toggleFavorite}
              download={download}
              patchItem={patchItem}
              deleteFromGrid={deleteFromGrid}
              changeViewMode={changeViewMode}
              changeColWidth={changeColWidth}
              startCrawl={startCrawl}
              refreshGallery={refreshGallery}
              undoFromGrid={undoFromGrid}
              relocateMissing={relocateMissing}
              purgeMissing={purgeMissing}
              addToPlaylist={addToPlaylist}
              addToFolder={addToFolder}
              reorderInFolder={reorderInFolder}
              markAllSeen={markAllSeen}
              dropTagOnImage={dropTagOnImage}
              ungroupStackAt={ungroupStackAt}
              stackSelection={stackSelection}
              stackDropOnImage={stackDropOnImage}
              enterFolder={enterFolder}
              dropImagesOnFolderAt={dropImagesOnFolderAt}
              openRoot={openRoot}
              openFromFolderGroup={openFromFolderGroup}
              showUnfiled={showUnfiled}
              openPlace={openPlace}
              startTour={startTour}
              onSetWallpaper={setWallpaper}
              onLibraryChanged={onLibraryChanged}
              onLibraryChangedOnly={onLibraryChangedOnly}
            />
          </div>

          <StatusBar
            crawling={crawling}
            stats={stats}
            importing={importing}
            isDesktop={isDesktop}
            folderName={activeFolder?.name || null}
            onOpenFolder={() => {
              // 在某个文件夹里就打开它自己那一层，而不是永远弹库根（用户得再手动往下找）
              if (folderId == null || !activeFolder) {
                openFolder().catch(quiet);
                return;
              }
              openFolderById(folderId).catch((err) => {
                const msg = (err as Error).message || i18n.t('k7d17ec8b');
                if (activeFolder.anchor_path) showToast(i18n.t('k8230b634', { p0: msg }), 'error');
                // 虚拟文件夹本来就没有磁盘目录，退回打开库根并说清楚原因
                else showToast(i18n.t('kdb9ccd24'));
                openFolder().catch(quiet);
              });
            }}
          />
        </main>
      </div>
      {/* /.app-body */}

      <Suspense fallback={null}>
      <AppDialogs
        ui={ui}
        dialogs={dialogs}
        view={view}
        filters={filters}
        folders={folders}
        folderId={folderId}
        selected={selected}
        stats={stats}
        tags={tags}
        lb={lb}
        activeLib={activeLib}
        activeLibName={activeLibName}
        activeFolder={activeFolder}
        onboarding={onboarding}
        tourOpen={tourOpen}
        pendingDelete={pendingDelete}
        confirmDelete={confirmDelete}
        rsTarget={rsTarget}
        setRsTarget={setRsTarget}
        paletteCommands={paletteCommands}
        lockFolderId={lockFolderId}
        lockFolder={lockFolder}
        enhancingId={enhancingId}
        pageRef={pageRef}
        load={load}
        refreshStats={refreshStats}
        openItem={openItem}
        revealGalleryItem={revealGalleryItem}
        toggleFavorite={toggleFavorite}
        saveTags={saveTags}
        requestDelete={requestDelete}
        setWallpaper={setWallpaper}
        enhanceOne={enhanceOne}
        patchItem={patchItem}
        download={download}
        setAnnotationCounts={setAnnotationCounts}
        setFolders={setFolders}
        setTags={setTags}
        setTagGroups={setTagGroups}
        setSelected={setSelected}
        setView={setView}
        setFolderId={setFolderId}
        setLb={setLb}
        setPeopleFocus={setPeopleFocus}
        setPendingDelete={setPendingDelete}
        setLockFolderId={setLockFolderId}
        onFiltersChange={onFiltersChange}
        finishTour={finishTour}
        finishOnboarding={finishOnboarding}
        onLibraryCreated={onLibraryCreated}
        showToast={showToast}
      />
      </Suspense>
    </div>
  );
}
