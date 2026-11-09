import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, desktop, downloadFile, isDesktop, onApiError, openFolder, openFolderById, quiet } from './api';
import { subscribeEvents } from './events';
import type { Filters, ImageItem, Library, SavedFilter, TagNode, View, ViewMode } from './types';
import Dashboard from './pages/Dashboard';
import GalleryPage from './pages/Gallery';
const Crawl = lazy(() => import('./pages/Crawl'));
// 低频且体积大的页面按需加载：设置页（含各分区面板）与教程（150 条文案）
// 不该拖进首包。仪表盘与图库保持静态导入，避免首屏闪骨架。
const SettingsPage = lazy(() => import('./pages/Settings'));
const Knowledge = lazy(() => import('./pages/Knowledge'));
const Playlists = lazy(() => import('./pages/Playlists'));
const Tidy = lazy(() => import('./pages/Tidy'));
const EnhancePage = lazy(() => import('./pages/Enhance'));
const Search = lazy(() => import('./pages/Search'));
const Smart = lazy(() => import('./pages/Smart'));
import Lightbox from './components/Lightbox';
import GlobalImport from './components/GlobalImport';
import ScreenshotOverlay from './components/ScreenshotOverlay';
import DeleteReasonDialog, { reasonLabel } from './components/DeleteReasonDialog';
import DialogHost, { confirmDialog } from './components/Dialogs';
import HotkeyHelp from './components/HotkeyHelp';
import FolderLockDialog from './components/FolderLockDialog';
import BookmarkDialog from './components/BookmarkDialog';
import ExportGalleryDialog from './components/ExportGalleryDialog';
import ShareLinkDialog from './components/ShareLinkDialog';
import ErrorBoundary from './components/ErrorBoundary';
import FolderCoverDialog from './components/FolderCoverDialog';
import FolderAppearanceDialog from './components/FolderAppearanceDialog';
import BatchCreateDialog from './components/BatchCreateDialog';
import QuickClassifyDialog from './components/QuickClassifyDialog';
import StackViewer from './components/StackViewer';
import CreateLibraryDialog from './components/CreateLibraryDialog';
import OnboardingTour from './components/OnboardingTour';
import TagMetaDialog from './components/TagMetaDialog';
import { applyTheme, getStoredTheme, type Theme } from './theme';
const Bookmarks = lazy(() => import('./pages/Bookmarks'));
const People = lazy(() => import('./pages/People'));
const Tutorial = lazy(() => import('./pages/Tutorial'));
import CommandPalette, { type PaletteCommand } from './components/CommandPalette';
import { buildRoute, parseRoute, sameRoute, type RouteState } from './lib/route';
import { THUMB_DEFAULT, clampThumbWidth } from './lib/thumb-size';
import TopBar from './layout/TopBar';
import Sidebar from './layout/Sidebar';
import StatusBar from './layout/StatusBar';
import ForcedUpdateOverlay from './components/ForcedUpdateOverlay';
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

/** 首屏状态来自 URL：分享出去的链接 / 刷新后都能还原到同一个筛选视图 */
const initialRoute: RouteState = parseRoute(window.location.search);
const defaultFilters: Filters = initialRoute.filters;

export default function App() {
  // 提示条 / 错误条 / 弹窗开关下沉到 hook：App 主体只管图库数据与筛选
  const {
    toast, showToast, loadError, setLoadError,
    serviceRestarting, setServiceRestarting, serviceOffline, setServiceOffline, serviceError, setServiceError,
    showCreateLib, setShowCreateLib, bookmarkOpen, setBookmarkOpen,
    exportOpen, setExportOpen, coverFolderId, setCoverFolderId,
    toolsOpen, setToolsOpen, palette, setPalette,
  } = useAppUiState();
  const [view, setView] = useState<View>(initialRoute.view);
  const [shareOpen, setShareOpen] = useState(false);
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
  /** 正在编辑元数据的标签（右键侧栏标签） */
  const [tagEdit, setTagEdit] = useState<TagNode | null>(null);
  const [importing, setImporting] = useState(false);
  // 导入进度（图库空态/顶部提示用）：progress 0-100，saved 为已入库张数，message 为任务名
  const [importProgress, setImportProgress] = useState<{
    progress: number;
    saved: number;
    total?: number;
    unchanged?: number;
    message?: string;
  } | null>(null);
  /** 导入是否正处于「进行中」（用于在结束那一刻只提示一次深度截断） */
  const wasImportingRef = useRef(false);
  /** 采集是否正在跑（记录上一次快照，用于在「刚结束」那一刻刷一次列表） */
  const crawlRunningRef = useRef(false);
  const [pendingDelete, setPendingDelete] = useState<ImageItem | null>(null);
  const [enhanceModel, setEnhanceModel] = useState('');
  const [enhancingId, setEnhancingId] = useState<number | null>(null);
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  // 首次引导：null=加载中 / false=需引导 / true=已完成
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  // 教程（分步导览）：tourOpen 控制显示；tourDone 落设置（跨资源库共享）
  const [tourOpen, setTourOpen] = useState(false);
  const [tourDone, setTourDone] = useState<boolean | null>(null);
  const tourStartedRef = useRef(false);
  // 多资源库（文件夹树在 useFolderTree 里）
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [activeLibId, setActiveLibId] = useState<number | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);

  /* 集合类能力：文件夹外观 / 批量创建 / 快速分类 / 堆叠查看器 / 快捷键帮助 */
  const [appearanceFolderId, setAppearanceFolderId] = useState<number | null>(null);
  const [batchCreate, setBatchCreate] = useState<{ mode: 'folder' | 'tag'; parentId: number | null } | null>(null);
  const [quickClassifyIds, setQuickClassifyIds] = useState<number[] | null>(null);
  const [stackViewId, setStackViewId] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

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
    items, setItems, total, setTotal, hasMore, loading,
    pageRef, newAtTopRef, refreshSeq, setRefreshSeq, refreshing,
    load, loadMore, refreshGallery, reveal: revealGalleryItem,
  } = useGalleryList({
    showToast,
    filtersRef,
    folderIdRef,
    refreshStats: requestStatsRefresh,
  });

  const {
    stats, setStats, tags, setTags, setTagGroups, tagTotal,
    pendingCounts, annotationCounts, setAnnotationCounts, dupeCounts,
    missingCount,
    libTotalRef,
    refreshStats, scheduleStatsRefresh, statsThrottleRef,
    reloadTags, loadMoreTags, tagTree,
  } = useStatsAndTags({
    showToast,
    load,
    pageRef,
    newAtTopRef,
    setTotal,
    refreshSeq,
    activeLibId,
    isImporting: isImportingNow,
  });
  refreshStatsRef.current = refreshStats;

  const {
    folders, setFolders, reload: reloadFolders, folderId, setFolderId,
    enterFolder, lockFolderId, setLockFolderId, lockFolder,
    createFolderAt, renameFolderAt, editFolderTags, reorderInFolder,
    deleteFolderAt, reorderFoldersAt, dropImagesOnFolderAt, dropImagesIntoFolder,
  } = useFolderTree({
    showToast,
    items,
    load,
    refreshStats,
    initialFolderId: initialRoute.folderId,
    showGallery,
  });

  const { selected, setSelected, toggleSelect, clearSelection, selectAll, selectAllMatching, bulk } = useSelection({
    showToast,
    items,
    filtersRef,
    folderIdRef,
    pageRef,
    load,
    refreshStats,
  });

  const { lb, setLb, openItem } = useLightbox({ filtersRef });

  const {
    savedFilters, activeSavedId, setActiveSavedId,
    reload: reloadSavedFilters,
    saveCurrentFilter, editSavedFilter, overwriteSavedFilter, deleteSavedFilter,
  } = useSavedFilters({ filters, folderId, showToast });

  const { sidebarW, onResizerDown, onResizerMove, onResizerUp, resetWidth } = useSidebarWidth();

  // 主题：立即生效 + 持久化到设置（换机器/清缓存后仍保留）
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        if (s.theme === 'light' || s.theme === 'dark') setTheme((cur) => (cur === s.theme ? cur : s.theme));
        setOnboarding(s.onboarded === true);
        setTourDone(s.tourDone === true);
      })
      .catch(() => {
        // 读不到设置就别拦用户：首次建库与教程都当作「已完成」，避免卡在引导里出不去
        setOnboarding(true);
        setTourDone(true);
      });
    // 仅在启动时同步一次服务端设置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 教程自动触发：建库引导做完、且明确没看过（tourDone === false）时自动开一次。
     用 ref 记住「本次会话已尝试过」，避免用户在设置里重置后立刻又被弹一遍。 */
  useEffect(() => {
    if (onboarding !== true || tourDone !== false || tourStartedRef.current) return;
    tourStartedRef.current = true;
    // 后 4 步讲的是筛选栏和网格：停在仪表盘上会「指不到东西」，先回图库
    setView('gallery');
    setTourOpen(true);
  }, [onboarding, tourDone]);

  // 加载资源库列表与当前库的文件夹树
  useEffect(() => {
    api
      .libraries()
      .then((r) => {
        setLibraries(r.libraries);
        setActiveLibId(r.activeId);
      })
      .catch(quiet);
    reloadFolders();
    reloadSavedFilters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 分享链接里的 folder 可能属于别的库、或已被删除：树一到就校验，失配退回全库 */
  useEffect(() => {
    if (!folderId || !folders.length) return;
    if (!folders.some((f) => f.id === folderId)) setFolderId(null);
  }, [folders, folderId]);

  const toggleTheme = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === 'dark' ? 'light' : 'dark';
      api.saveSettings({ theme: next }).catch(quiet);
      return next;
    });
  }, []);

  const effectiveFilters = useMemo<Filters>(
    () => (view === 'favorites' ? { ...filters, favorite: 'yes' } : filters),
    [view, filters]
  );
  filtersRef.current = effectiveFilters;
  folderIdRef.current = folderId;

  // importing 状态同步到 ref（job 事件 / importStatus 等多处 setImporting 都会覆盖）
  useEffect(() => {
    importingRef.current = importing;
  }, [importing]);

  // 后台请求失败统一收口：同一条错误只显示一次，用户关掉后不再反复弹
  useEffect(() => onApiError((err) => setLoadError((prev) => prev || err.message)), []);

  // 本地服务重启：先遮住，恢复后主进程会重载页面，遮罩自然消失
  useEffect(() => {
    if (!desktop?.onServiceState) return;
    return desktop.onServiceState((s) => {
      setServiceRestarting(!!s.restarting);
      // dead 态不遮罩锁死，但要常驻一条离线横幅，别让用户对着「点不动」猜原因
      setServiceOffline(!!s.dead);
      setServiceError(String(s.error || ''));
      if (s.error) setLoadError(`本地服务重启失败：${s.error}`);
    });
  }, []);

  /** 错误条上的「重试」：把统计、标签、列表这几条主链路重跑一遍 */
  const retryFailedLoad = useCallback(() => {
    setLoadError('');
    setRefreshSeq((n) => n + 1);
    refreshStats();
    void load(1, true);
  }, [load, refreshStats]);

  /**
   * 选文件夹后的「导入跟随」：主动轮询导入状态直到结束，期间每 1.2s 刷新一次列表。
   * 作为 SSE 事件的可靠兜底 —— 真实运行环境（尤其 Electron）在导入的 CPU 密集期，
   * SSE 心跳可能超时断连、丢失中间 library 事件，前端停在断连前的张数不再前进。
   * 轮询直接查 importStatus + stats，不依赖任何推送，确保图库持续自动展示。
   */
  const followRunningRef = useRef(false);
  const followImport = useCallback(async () => {
    // 单实例：库事件 / 建库 / 切库可能连着触发多次 followImport，并发多路
    // 轮询只会放大请求量（每路约 2.5 req/s），后到的直接让路 —— 在跑的这路
    // 每轮都会拉最新的 importStatus，自然覆盖新触发的场景
    if (followRunningRef.current) return;
    followRunningRef.current = true;
    try {
      // 首次观察到「未在运行」时不急着收尾：切库时旧库的扫描被叫停后，
      // 新库的扫描是排队补跑的，可能晚几百毫秒才置 running，需要再确认一次
      let confirmed = false;
      for (let i = 0; i < 240; i++) {
        let status;
        try {
          status = await api.importStatus();
        } catch {
          return;
        }
        if (status.running) {
          confirmed = true;
          setImporting(true);
          setImportProgress({
            progress: Number(status.progress) || 0,
            saved: Number(status.result?.saved) || 0,
            total: Number(status.result?.total) || 0,
            unchanged: Number(status.result?.unchanged) || 0,
            message: status.message || '',
          });
          refreshStats(); // 内含库增长对账：stats.total 变大则 load(1, true)
        } else if (!confirmed) {
          confirmed = true;
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        } else {
          setImporting(false);
          setImportProgress(null);
          refreshStats();
          // 扫描崩溃不能静默收尾：以前只在 importState 里留一句话，界面上就是
          // 「库是空的、也没有任何提示」，用户只能以为图丢了。
          if (status.error) {
            showToast(`扫描失败：${status.error}（可到 设置 → 数据维护 重新扫描）`, 'error');
          }
          // 收尾强制重载一次：若导入在最后一次对账后才落库，列表会停在旧张数
          pageRef.current = 1;
          load(1, true);
          return;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      refreshStats();
    } finally {
      followRunningRef.current = false;
    }
  }, [refreshStats, load, showToast]);

  /** 切库 / 建库 / 删库后重置「库张数」基线。
   *  refreshStats 靠 total 变大判断要不要重载列表；换库后新旧库张数没有可比性
   *  （旧库 5008 → 新库 0），不重置的话新库导入期间永远判定为「没增长」，
   *  列表就停在切库那一刻的张数不再刷新。 */
  const resetLibBaseline = useCallback(() => {
    libTotalRef.current = -1;
  }, []);

  // 切换到另一个资源库：重载列表、统计、文件夹树
  const switchLibrary = useCallback(
    async (id: number) => {
      if (id === activeLibId) return;
      try {
        await api.activateLibrary(id);
        setActiveLibId(id);
        setFolderId(null);
        setFolders([]);
        setView('gallery');
        pageRef.current = 1;
        resetLibBaseline();
        load(1, true);
        refreshStats();
        // 切库会触发后台扫描（activate 路由 startLocalImport），
        // SSE 在导入 CPU 密集期会丢事件，必须开轮询兜底
        followImport();
        reloadFolders();
        // 保存的筛选器存在各库自己的 gallery.db：不重载就会继续显示上一个库的条目
        setActiveSavedId(null);
        reloadSavedFilters();
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [activeLibId, load, refreshStats, followImport, resetLibBaseline, showToast]
  );

  // 删除资源库（Eagle 式「从列表删除」：可删任意库，不必先切换过去。
  // 只删库自建产物，素材图片保留；默认库不可删。删当前库则切回剩余库并重载）
  const deleteLibraryAt = useCallback(
    async (lib: Library) => {
      if (!lib.deletable) return showToast('默认资源库不可删除');
      const isCurrent = lib.id === activeLibId;
      const ok = await confirmDialog(
        `从列表删除资源库「${lib.name}」？将移除注册并删除库目录（gallery.db + 缩略图），素材图片会保留。` +
          (isCurrent ? '\n\n这是当前打开的资源库，删除后会切换到其他库。' : '')
      );
      if (!ok) return;
      try {
        const r = await api.deleteLibrary(lib.id);
        setLibraries(r.libraries);
        if (isCurrent) {
          setActiveLibId(r.activeId);
          setFolderId(null);
          setFolders([]);
          setView('gallery');
          pageRef.current = 1;
          resetLibBaseline();
          load(1, true);
          refreshStats();
          reloadFolders();
          setActiveSavedId(null);
          reloadSavedFilters();
        }
        showToast(`已删除资源库「${lib.name}」`);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [activeLibId, load, refreshStats, resetLibBaseline, showToast]
  );

  // 新建资源库后：刷新库列表、切到新库并扫描
  const onLibraryCreated = useCallback(
    (library: Library) => {
      setShowCreateLib(false);
      setActiveLibId(library.id);
      setFolderId(null);
      setFolders([]);
      setView('gallery');
      pageRef.current = 1;
      resetLibBaseline();
      load(1, true);
      refreshStats();
      // 新建库后服务端会后台扫描素材目录（activate 路由 startLocalImport）。
      // 导入的 CPU 密集段 SSE 心跳会断、library 事件全丢，前端会停在「导入完成
      // 但列表/统计不更新」的中间状态，必须开轮询兜底。
      followImport();
      api.libraries().then((r) => {
        setLibraries(r.libraries);
        setActiveLibId(r.activeId);
      }).catch(quiet);
      reloadFolders();
      setActiveSavedId(null);
      reloadSavedFilters();
      showToast('已创建并切换到新资源库');
    },
    [load, refreshStats, followImport, resetLibBaseline, showToast]
  );

  // 结束首次引导：跳过和建库成功都走这里。之前引导页自己存 storageDir、
  // 不建库，和「新建资源库」是两套问法（一个只问文件夹、一个问三个输入框），
  // 现在统一到 CreateLibraryDialog —— 引导结束只负责落 onboarded 标记
  const finishOnboarding = useCallback(() => {
    setOnboarding(true);
    api.saveSettings({ onboarded: true }).catch(quiet);
  }, []);

  /** 教程结束（看完或跳过都算）：只在设置里记一笔，下次启动不再自动弹 */
  const finishTour = useCallback(() => {
    setTourOpen(false);
    setTourDone(true);
    tourStartedRef.current = true;
    api.saveSettings({ tourDone: true }).catch(quiet);
  }, []);

  /** 设置页「重新看一遍」：先回图库，导览才有侧栏/筛选/网格可指 */
  const startTour = useCallback(() => {
    tourStartedRef.current = true;
    setView('gallery');
    setTourOpen(true);
  }, []);

  /* 事件回调里抛的错（定时器、onClick 里的 await）到不了 React 错误边界，
     由 main.tsx 统一转成 tuku:error，这里用 toast 让用户至少知道「刚才那下失败了」 */
  useEffect(() => {
    const onErr = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (typeof msg === 'string' && msg) showToast(`出现异常：${msg}`, 'error');
    };
    window.addEventListener('tuku:error', onErr);
    return () => window.removeEventListener('tuku:error', onErr);
  }, [showToast]);

  /* ------------------------- 保存的筛选器：存 / 用 / 改 / 删 ------------------------- */

  const openSavedFilter = useCallback((f: SavedFilter) => {
    const q = (f.query || {}) as Partial<Filters> & { folderId?: number | null };
    setFolderId(q.folderId ?? null);
    setFilters({ ...defaultFilters, ...q });
    setActiveSavedId(f.id);
    setView('gallery');
  }, []);

  /* ---------------------------------- 图片堆叠 ---------------------------------- */

  const stackSelection = useCallback(async () => {
    const ids = [...selected];
    if (ids.length < 2) return showToast('至少选两张素材才能堆叠');
    try {
      await api.createStack(ids);
      showToast(`已把 ${ids.length} 张合成一个堆叠`);
      setSelected(new Set());
      pageRef.current = 1;
      load(1, true);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [load, selected, showToast]);

  /**
   * 拖图到某张卡上：目标是组主就并入那一堆，否则两张（多张）现场成组。
   * 桌面端系统级拖出会抢走 HTML5 拖放，所以卡片上按住 Alt 拖才走这条路径（见 ImageCard）。
   */
  const stackDropOnImage = useCallback(
    async (dragIds: number[], target: ImageItem) => {
      const ids = dragIds.filter((id) => id !== target.id);
      if (!ids.length) return;
      try {
        if ((target.stackCount || 0) > 1 && target.stackId) {
          const r = await api.addToStack(target.stackId, ids);
          showToast(`已把 ${ids.length} 张并入这一堆（共 ${r.stacks.length} 张）`);
        } else {
          await api.createStack([target.id, ...ids]);
          showToast(`已把 ${ids.length + 1} 张叠成一堆`);
        }
        setSelected(new Set());
        pageRef.current = 1;
        load(1, true);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [load, showToast]
  );

  const ungroupStackAt = useCallback(
    async (stackId: number) => {
      try {
        const r = await api.ungroupStack(stackId);
        showToast(`已解散堆叠（${r.removed} 张恢复为独立素材）`);
        pageRef.current = 1;
        load(1, true);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [load, showToast]
  );

  // 文件夹视图切换（folderId 变化）同样要触发列表重载
  const queryKey = JSON.stringify(effectiveFilters) + `|folder:${folderId ?? ''}`;

  useEffect(() => {
    pageRef.current = 1;
    // 重置数据源（筛选 / 文件夹 / 收藏切换）时滚回顶部，避免虚拟窗口错位
    contentRef.current?.scrollTo({ top: 0 });
    // 选中集合必须跟着数据源一起清空：批量删除直接取 [...selected]，
    // 不清空的话「选中 30 张 → 切到另一个文件夹 → 点删除」会删掉用户看不见的另一批图
    setSelected(new Set());
    load(1, true);
  }, [queryKey, load]);

  // 换库同理：旧库的 id 在新库里指向别的图
  useEffect(() => {
    setSelected(new Set());
  }, [activeLibId]);

  /**
   * 从别的视图（采集 / 任务中心 / 设置）回到列表时对账一次。
   * queryKey 没变，上面那个效应不会重跑 —— 采集刚入库的图就永远不出现，
   * 用户只能手动点刷新（这正是「列表不自动刷新」的根因之一）。
   */
  const prevViewRef = useRef(view);
  useEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = view;
    if (view !== 'gallery' || prev === 'gallery') return;
    pageRef.current = 1;
    load(1, true);
    refreshStats();
  }, [view, load, refreshStats]);

  // 窗口重新获得焦点（托盘恢复 / 多窗口来回切）时补一次刷新，防止错过推送
  useEffect(() => {
    const onWake = () => refreshStats();
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [refreshStats]);

  /**
   * URL ←→ 状态同步。
   * 切视图（侧栏点导航）推一条历史，可以后退回来；改筛选只 replace 当前条，
   * 否则每敲一个字都会塞一条历史，后退键要按几十次才回得去。
   */
  const lastRouteRef = useRef<RouteState>(initialRoute);
  useEffect(() => {
    const next: RouteState = { view, filters, folderId };
    if (sameRoute(lastRouteRef.current, next)) return;
    const qs = buildRoute(view, filters, folderId);
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    try {
      if (lastRouteRef.current.view !== view) {
        window.history.pushState({ tukuRoute: true }, '', url);
      } else {
        window.history.replaceState({ tukuRoute: true }, '', url);
      }
    } catch {
      /* file:// 或受限环境下改不了地址栏，界面照常工作 */
    }
    lastRouteRef.current = next;
  }, [view, filters, folderId]);

  /* 浏览器后退 / 前进：把地址栏里的状态搬回界面（列表由 queryKey 效应自动重载） */
  useEffect(() => {
    const onPop = () => {
      const r = parseRoute(window.location.search);
      lastRouteRef.current = r;
      setFolderId(r.folderId);
      setFilters(r.filters);
      setView(r.view);
      setSelected(new Set());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    refreshStats(); // 首次调用即建立 libTotalRef 基线
    // 服务端写操作会推 library 事件；与 job 推送共用 800ms 节流。
    // 60s 低频兜底覆盖推送遗漏（如多标签页）场景；页面隐藏时不发请求
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshStats();
    }, 60000);
    const off = subscribeEvents('library', scheduleStatsRefresh);
    return () => {
      clearInterval(timer);
      off();
      // 卸载 / 重订阅后，在途的节流回调不能再 setState、也不能再打接口
      if (statsThrottleRef.current) {
        window.clearTimeout(statsThrottleRef.current);
        statsThrottleRef.current = 0;
      }
    };
  }, [refreshStats, scheduleStatsRefresh]);

  useEffect(() => {
    // 导入状态改为订阅 job 事件（原 3s 轮询）；导入进行中顺带刷新统计
    const off = subscribeEvents('job', (d) => {
      // 采集的下载与入库全在后台协程里，前端只在「跑完」这一刻对账一次：
      // 否则用户盯着采集页看进度，切回列表还以为一张新图都没进
      const crawl = d?.crawl;
      if (crawl) {
        if (crawl.running) crawlRunningRef.current = true;
        else if (crawlRunningRef.current) {
          crawlRunningRef.current = false;
          refreshStats();
          if (pageRef.current <= 1) load(1, true);
        }
      }
      const imp = d?.import;
      if (!imp) return;
      setImporting(!!imp.running);
      if (imp.running) {
        wasImportingRef.current = true;
        setImportProgress({
          progress: Number(imp.progress) || 0,
          saved: Number(imp.result?.saved) || 0,
          total: Number(imp.result?.total) || 0,
          unchanged: Number(imp.result?.unchanged) || 0,
          message: imp.message || '',
        });
        // 进度快照每秒好几条：走节流，别每条都打一遍 stats/tags/pending/missing
        scheduleStatsRefresh();
      } else {
        setImportProgress(null);
        // 结束时一次性提示：有目录因超过深度上限没被扫到（以前完全静默，用户只看到"少了一半图"）
        if (wasImportingRef.current) {
          wasImportingRef.current = false;
          const skipped = imp.result?.depthSkippedDirs;
          if (Array.isArray(skipped) && skipped.length) {
            showToast(
              `有 ${skipped.length} 个目录超过导入深度上限未扫描，可在设置里调大「导入深度」`
            );
          }
        }
      }
    });
    // 页面打开时可能正赶上一次导入（含「上次导入未完成，重启后自动继续」）。
    // 只置 importing 不跟进度的话，横幅会永久停在 0% 且不会在结束时消失（P1），
    // 所以这里必须同时补上进度并开启轮询跟随。
    api
      .importStatus()
      .then((s) => {
        setImporting(s.running);
        if (!s.running) {
          setImportProgress(null);
          // 打开页面时上一次扫描已经失败了：也得说一声
          if (s.error) showToast(`上次扫描失败：${s.error}（可到 设置 → 数据维护 重新扫描）`, 'error');
          return;
        }
        setImportProgress({
          progress: Number(s.progress) || 0,
          saved: Number(s.result?.saved) || 0,
          total: Number(s.result?.total) || 0,
          unchanged: Number(s.result?.unchanged) || 0,
          message: s.message || '',
        });
        if (s.message) showToast(s.message);
        followImport();
      })
      .catch(quiet);
    return () => {
      off();
    };
  }, [refreshStats, scheduleStatsRefresh, followImport, showToast, load]);

  const patchItem = useCallback((updated: ImageItem) => {
    setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
    setLb((prev) =>
      prev
        ? {
            items: prev.items.map((it) => (it.id === updated.id ? updated : it)),
            index: prev.index,
          }
        : prev
    );
  }, []);

  /** 侧栏标签拖到卡片上：追加这个标签（不清空原有标签） */
  const dropTagOnImage = useCallback(
    async (item: ImageItem, tag: string) => {
      const t = String(tag || '').trim();
      if (!t) return;
      if ((item.tags || []).includes(t)) return showToast(`「${t}」已经在这张图的标签里了`);
      try {
        const updated = await api.patch(item.id, { tags: [...(item.tags || []), t] });
        patchItem(updated);
        showToast(`已给「${item.title}」打上 #${t}`);
        reloadTags();
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [patchItem, reloadTags, showToast]
  );

  /**
   * 撤销最近一次「覆盖写回」编辑。
   * 裁切/旋转/调色/增强都是原地覆盖，以前误操作只能去 Eagle 备份里捞文件；
   * 现在服务端每次写回前都会留一份备份（edit_history），这里一键还原。
   */
  const undoEdit = useCallback(async () => {
    try {
      const last = await api.lastUndo();
      if (!last.last) {
        showToast('没有可撤销的编辑');
        return;
      }
      const res = await api.undo(last.last.imageId);
      if (res.item) patchItem(res.item);
      else load(1, true);
      const label =
        { rotate: '旋转', crop: '裁切', color: '调色', enhance: '增强', edit: '编辑' }[last.last.kind] || '编辑';
      showToast(`已撤销${label}`);
      refreshStats();
    } catch (err) {
      showToast(`撤销失败：${(err as Error).message}`);
    }
  }, [load, patchItem, refreshStats, showToast]);

  const toggleFavorite = useCallback(
    async (item: ImageItem) => {
      const updated = await api.patch(item.id, { favorite: !item.favorite });
      patchItem(updated);
      setStats((prev) =>
        prev ? { ...prev, favorite: prev.favorite + (updated.favorite ? 1 : -1) } : prev
      );
    },
    [patchItem]
  );

  const saveTags = useCallback(
    async (item: ImageItem, tagList: string[]) => {
      const updated = await api.patch(item.id, { tags: tagList });
      patchItem(updated);
      api
        .tags()
        .then((r) => {
          setTags(r.tags);
          setTagGroups(r.groups);
        })
        .catch(quiet);
    },
    [patchItem]
  );

  /** 请求删除：弹出「为什么不满意」对话框，让 AI 学习 */
  const requestDelete = useCallback((item: ImageItem) => {
    setPendingDelete(item);
  }, []);

  const confirmDelete = useCallback(
    async (payload: { reasons: string[]; note: string; aiAnalysis: string; learn: boolean }) => {
      const item = pendingDelete;
      if (!item) return;
      setPendingDelete(null);
      try {
        if (!payload.learn) {
          await api.remove(item.id);
          showToast('已删除（未记录反馈）');
        } else {
          await api.deleteWithReason(item.id, payload);
          showToast(
            payload.reasons.length
              ? `已删除并记录：${payload.reasons.map(reasonLabel).join('、')}（可在 AI 知识库一键归纳）`
              : '已删除'
          );
        }
      } catch (err) {
        showToast((err as Error).message);
      }
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      setLb((prev) => {
        if (!prev) return prev;
        const rest = prev.items.filter((it) => it.id !== item.id);
        if (!rest.length) return null;
        return { items: rest, index: Math.min(prev.index, rest.length - 1) };
      });
      refreshStats();
    },
    [pendingDelete, refreshStats, showToast]
  );

  const setWallpaper = useCallback(
    async (item: ImageItem, style?: string) => {
      try {
        const res = await api.wallpaper(item.id, style);
        showToast(
          res.generated
            ? `已设为壁纸：按屏幕 ${res.screen.width}×${res.screen.height} 合成，竖版完整居中不裁切`
            : '已设为桌面壁纸（原图铺满）'
        );
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  const download = useCallback((item: ImageItem) => {
    downloadFile(item.downloadUrl);
  }, []);

  const onFiltersChange = useCallback((patch: Partial<Filters>) => {
    // 手动改筛选就离开「保存的筛选」视图：否则侧栏那条还高亮着，看着像没生效
    setActiveSavedId(null);
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  /* Gallery 已用 React.memo 包住：这些回调必须是稳定引用，
     否则每次 App 渲染都会生成新函数，memo 永远命中不了（勾一张图就重渲染整页）。 */
  const openFromGrid = useCallback((item: ImageItem) => openItem(item, items, true), [openItem, items]);
  const deleteFromGrid = useCallback(
    (item: ImageItem) => {
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      setLb((prev) => {
        if (!prev) return prev;
        const rest = prev.items.filter((it) => it.id !== item.id);
        if (!rest.length) return null;
        return { items: rest, index: Math.min(prev.index, rest.length - 1) };
      });
      refreshStats();
    },
    [refreshStats]
  );
  const startCrawl = useCallback(() => setView('crawl'), []);
  const undoFromGrid = useCallback(() => void undoEdit(), [undoEdit]);

  /* 命令面板里的命令：只列真正能跑通的入口，不做「点了没反应」的假菜单 */
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const go = (v: View, label: string, hint?: string): PaletteCommand => ({
      id: `nav:${v}`,
      label,
      group: '前往',
      hint,
      run: () => {
        setView(v);
        setFolderId(null);
      },
    });
    return [
      go('gallery', '图库'),
      go('dashboard', '仪表盘'),
      go('people', '人物（人脸分组）'),
      go('search', '语义搜索'),
      go('tidy', '整理（重复 / 相似）'),
      go('smart', '智能文件夹'),
      go('enhance', '画质增强'),
      go('crawl', '采集'),
      go('bookmarks', '书签'),
      go('playlists', '播放列表'),
      go('knowledge', '知识库'),
      go('settings', '设置'),
      {
        id: 'act:bookmark',
        label: '新建书签…',
        group: '操作',
        run: () => setBookmarkOpen(true),
      },
      ...(desktop?.openNewWindow
        ? [
            {
              id: 'act:new-window',
              label: '新建窗口',
              group: '窗口',
              hint: '同一图库开第二个窗口，可一边挑选一边整理',
              run: () => void desktop?.openNewWindow?.(),
            } satisfies PaletteCommand,
          ]
        : []),
      {
        id: 'act:export-gallery',
        label: '导出画廊 HTML…',
        group: '操作',
        run: () => setExportOpen(true),
      },
      {
        id: 'act:select-all',
        label: '全选当前筛选结果',
        group: '操作',
        hint: 'Ctrl+A',
        run: () => void selectAllMatching(),
      },
      {
        id: 'act:clear-filters',
        label: '清空全部筛选条件',
        group: '操作',
        run: () => {
          setFilters(defaultFilters);
          setFolderId(null);
        },
      },
      {
        id: 'act:refresh',
        label: '刷新列表与统计',
        group: '操作',
        run: () => {
          void load(1, true);
          void refreshStats();
        },
      },
      {
        id: 'ui:theme',
        label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        group: '界面',
        run: () => {
          const next: Theme = theme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          applyTheme(next);
        },
      },
      {
        id: 'ui:tutorial',
        label: '使用教程（按功能查找）',
        group: '帮助',
        hint: 'F1',
        run: () => {
          setLb(null);
          setView('tutorial');
        },
      },
      {
        id: 'ui:help',
        label: '快捷键速查',
        group: '帮助',
        hint: '?',
        run: () => setHelpOpen(true),
      },
    ];
  }, [load, refreshStats, selectAllMatching, theme]);

  /* 卡片右键「搜索命令…」：菜单在卡片里，命令表在 App 里，用事件把两处接起来 */
  useEffect(() => {
    const onAsk = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: 'command' | 'filter' }>).detail?.mode;
      setPalette(mode === 'filter' ? 'filter' : 'command');
    };
    window.addEventListener('tuku:palette', onAsk);
    return () => window.removeEventListener('tuku:palette', onAsk);
  }, []);

  /* 全局快捷键（空格快速预览 / F 快速分类 / 全选 / 删除 / 撤销）全部在 hook 里 */
  const { hoverIdRef } = useAppKeyBindings({
    showToast,
    palette,
    setPalette,
    helpOpen,
    setHelpOpen,
    lb,
    setLb,
    setView,
    items,
    total,
    selected,
    setSelected,
    setQuickClassifyIds,
    bulk,
    openItem,
    selectAllMatching,
    undoEdit,
  });

  /** 展示方式 / 缩略图尺寸：写 localStorage，下次打开保持（Eagle 也记住缩略图大小） */
  const changeViewMode = useCallback((m: ViewMode) => {
    setViewMode(m);
    localStorage.setItem('tuku:view-mode', m);
  }, []);
  /** 回到全库（侧栏根节点与文件夹收纳视图面包屑共用） */
  const openRoot = useCallback(() => {
    setFolderId(null);
    setView('gallery');
  }, []);
  /** 文件夹收纳视图里的缩略图：灯箱导航池用该组已加载的图片，避免串到全库列表 */
  const openFromFolderGroup = useCallback(
    (item: ImageItem, pool: ImageItem[]) => openItem(item, pool),
    [openItem]
  );
  /** 「未归档」卡片：切回图片展开并套用未分类筛选 */
  const showUnfiled = useCallback(() => {
    setActiveSavedId(null);
    setFolderId(null);
    setFilters((prev) => ({ ...prev, pending: 'noFolder', q: '', tag: '' }));
    changeViewMode('masonry');
  }, [changeViewMode]);
  const changeColWidth = useCallback((w: number) => {
    const next = clampThumbWidth(w);
    setColWidth(next);
    localStorage.setItem('tuku:col-width', String(next));
  }, []);

  /** 「待整理」入口：进入图库并套用对应筛选 */
  const openPending = useCallback((kind: 'noFolder' | 'noTags' | 'noRating') => {
    setFolderId(null);
    setFilters((prev) => ({ ...prev, pending: kind, tag: '' }));
    setView('gallery');
  }, []);


  const openTag = useCallback((tag: string) => {
    setFolderId(null);
    setFilters((prev) => ({ ...prev, tag, pending: '' }));
    setView('gallery');
  }, []);

  // 读取默认增强模型（大图预览里的「画质增强」用它，与设置里保持一致）
  useEffect(() => {
    api
      .enhanceStandards()
      .then((s) => setEnhanceModel(s.config?.model || 'sharp-standard'))
      .catch(quiet);
  }, []);

  /** 大图预览中直接增强：按默认模型放大到标准以上并覆盖原文件 */
  const enhanceOne = useCallback(
    async (item: ImageItem) => {
      setEnhancingId(item.id);
      try {
        const { item: updated, noop } = await api.enhanceImage(item.id, enhanceModel || 'sharp-standard');
        patchItem(updated);
        // 已达标时服务端不会改动文件（noop），不能谎报「已增强至 W×H」
        showToast(
          noop ? `该图已是 ${updated.width}×${updated.height}，无需增强` : `已增强至 ${updated.width}×${updated.height}`
        );
        refreshStats();
      } catch (err) {
        showToast(`增强失败：${(err as Error).message}`);
      } finally {
        setEnhancingId(null);
      }
    },
    [enhanceModel, patchItem, refreshStats, showToast]
  );

  /** 把选中的图片加入清单（传入 '__new__:名称' 时先建清单） */
  const addToPlaylist = useCallback(
    async (playlistId: number | string) => {
      const ids = [...selected];
      if (!ids.length) return;
      try {
        let pid = playlistId;
        if (typeof pid === 'string' && pid.startsWith('__new__:')) {
          const name = pid.slice(8).trim();
          if (!name) return;
          const created = await api.createPlaylist(name);
          const pl = created.playlists.find((p) => p.name === name);
          if (!pl) throw new Error('创建清单失败');
          pid = pl.id;
        }
        const res = await api.addToPlaylist(pid as number, ids);
        showToast(`已加入清单（新增 ${res.added} 张）`);
      } catch (err) {
        showToast((err as Error).message);
      }
      setSelected(new Set());
    },
    [selected, showToast]
  );

  /** 把选中的图片加入文件夹（传入 '__new__:名称' 时先建虚拟夹） */
  const addToFolder = useCallback(
    async (folderId: number | string) => {
      const ids = [...selected];
      if (!ids.length) return;
      try {
        let fid = folderId;
        if (typeof fid === 'string' && fid.startsWith('__new__:')) {
          const name = fid.slice(8).trim();
          if (!name) return;
          const created = await api.createFolder(name, null);
          fid = created.id;
        }
        const res = await api.addToFolder(fid as number, ids);
        setFolders(res.folders);
        showToast(`已加入文件夹（新增 ${res.added} 张）`);
      } catch (err) {
        showToast((err as Error).message);
      }
      setSelected(new Set());
    },
    [selected, showToast]
  );


  /* 截图入库统一走 ScreenshotOverlay（框选后由它上传并刷新），这里不再监听主进程直传事件 */


  /** 把当前筛选结果整体标记为已看（整理「未看过」时用） */
  const markAllSeen = useCallback(async () => {
    try {
      const res = await api.markAllViewed(effectiveFilters);
      showToast(res.affected ? `已标记 ${res.affected} 张为已看` : '当前筛选下没有图片');
      pageRef.current = 1;
      load(1, true);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [effectiveFilters, load, showToast]);

  /** 文件丢失处理：先尝试按文件名在新路径找回，找不回可清理记录 */
  const relocateMissing = useCallback(async () => {
    try {
      const res = await api.relocateMissing();
      const unreadable = res.unreadable || 0;
      const unreadableNote = unreadable ? `；另有 ${unreadable} 个文件读不到大小，未参与重关联` : '';
      showToast(
        res.relocated
          ? `已找回 ${res.relocated} 张图片的路径${res.remaining ? `，仍有 ${res.remaining} 张未找到` : ''}${unreadableNote}`
          : `没有找回任何图片（${res.remaining} 张仍未找到，可能已被删除）${unreadableNote}`
      );
    } catch (err) {
      showToast((err as Error).message);
    }
    refreshGallery();
  }, [refreshGallery, showToast]);

  const purgeMissing = useCallback(async () => {
    if (!(await confirmDialog(`确定清理这 ${missingCount} 条文件缺失的记录吗？图片记录将被移除。`))) return;
    try {
      const res = await api.purgeMissing();
      showToast(`已清理 ${res.removed} 条缺失记录`);
    } catch (err) {
      showToast((err as Error).message);
    }
    refreshGallery();
  }, [missingCount, refreshGallery, showToast]);

  const crawling = !!stats?.crawling || importing;
  const activeFolder = folders.find((f) => f.id === folderId) || null;
  const activeLib = libraries.find((l) => l.id === activeLibId) || null;
  const activeLibName = activeLib?.name || '默认图库';
  // 当前视图若属于工具菜单项，则顶栏「工具箱」按钮保持高亮
  const toolsActive = TOOLS.some((t) => t.key === view);

  /** 侧栏导航：点「图库」时清空文件夹筛选，回到全库视图 */
  const handleNav = useCallback((v: View) => {
    setView(v);
    if (v === 'gallery') setFolderId(null);
  }, []);

  // 点击菜单外部收起工具下拉
  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!toolsRef.current?.contains(e.target as Node)) setToolsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [toolsOpen]);

  return (
    <div className="app">
      {/* 任意页面都能拖入 / 粘贴入库（Eagle 三件套）；图库页接管时这里自动让位 */}
      <GlobalImport
        onImported={(n) => {
          showToast(`已入库 ${n} 个文件`);
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
        onShareLink={() => setShareOpen(true)}
      />

      <div className="app-body">
      <Sidebar
        libraries={libraries}
        activeLibId={activeLibId}
        activeLibName={activeLib?.name ?? '全部'}
        activeLibRoot={activeLib?.root_path ?? ''}
        onSwitchLibrary={switchLibrary}
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
        onEditTag={setTagEdit}
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
        onEditFolderAppearance={setAppearanceFolderId}
        onBatchCreateFolder={(parentId) => setBatchCreate({ mode: 'folder', parentId })}
        onReorderFolders={reorderFoldersAt}
        onBatchCreateTag={() => setBatchCreate({ mode: 'tag', parentId: null })}
        width={sidebarW}
        onResizeDown={onResizerDown}
        onResizeMove={onResizerMove}
        onResizeUp={onResizerUp}
        onResetWidth={resetWidth}
        onToast={showToast}
      />

      <main className="main">
        {/* 后台请求失败：明确说「没加载出来」而不是让界面装作「没有数据」 */}
        {loadError && (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              margin: '10px 16px 0',
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(255, 107, 107, 0.12)',
              border: '1px solid rgba(255, 107, 107, 0.35)',
              color: '#ffb4b4',
              fontSize: 12.5,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
              有数据没能加载出来：{loadError}
            </span>
            <button className="btn sm" onClick={retryFailedLoad}>
              重试
            </button>
            <button className="icon-btn" title="关闭" onClick={() => setLoadError('')}>
              ×
            </button>
          </div>
        )}
        <div className="content" ref={contentRef}>
          {/* 页面级错误边界：单个页面渲染崩了只影响内容区，不会整窗白屏 */}
          <ErrorBoundary resetKey={view}>
          <Suspense fallback={<div style={{ padding: 40, color: 'var(--muted)' }}>正在加载…</div>}>
          {view === 'dashboard' && (
            <Dashboard
              stats={stats}
              error={loadError}
              onOpen={(item, pool) => openItem(item, pool)}
              onNavigate={(v) => setView(v as View)}
            />
          )}

          {(view === 'gallery' || view === 'favorites') && (
            <GalleryPage
              title={view === 'favorites' ? '收藏夹' : activeFolder ? activeFolder.name : '图库'}
              subtitle={
                view === 'favorites'
                  ? '所有已收藏的照片'
                  : activeFolder
                    ? '文件夹 · 含全部子文件夹'
                    : viewMode === 'folder'
                      ? '按文件夹收纳 · 点文件夹进入，点箭头就地展开组内图片'
                      : viewMode === 'grid'
                        ? '图片展开 · 网格浏览，缩略图大小可拖动调整'
                        : '图片展开 · 瀑布流浏览，悬停操作 · 点击进入大图预览'
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
                if (!ids.length) return showToast('先在网格里选中素材，或把鼠标停在某张卡片上');
                setQuickClassifyIds(ids);
              }}
            />
          )}

          {view === 'people' && <People onToast={showToast} onOpen={openItem} />}

          {view === 'tidy' && (
            <Tidy
              onToast={showToast}
              filters={filters}
              folderId={folderId}
              selectedIds={[...selected]}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
                followImport();
              }}
            />
          )}

          {view === 'crawl' && <Crawl onToast={showToast} />}

          {view === 'playlists' && (
            <Playlists onToast={showToast} onOpen={openItem} onSetWallpaper={setWallpaper} />
          )}

          {view === 'knowledge' && (
            <Knowledge
              onToast={showToast}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
                followImport();
              }}
            />
          )}

          {view === 'search' && <Search onToast={showToast} onOpenItem={(item, pool) => openItem(item, pool, true)} />}

          {view === 'smart' && (
            <Smart onToast={showToast} onOpenItem={openItem} onTagsChanged={reloadTags} />
          )}

          {view === 'enhance' && (
            <EnhancePage
              onToast={showToast}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
                followImport();
              }}
            />
          )}

          {view === 'bookmarks' && (
            <Bookmarks
              onToast={showToast}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
              }}
              onOpen={(item, list) =>
                setLb({ items: list, index: Math.max(0, list.findIndex((x) => x.id === item.id)) })
              }
            />
          )}

          {view === 'tutorial' && (
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--muted)' }}>正在加载教程…</div>}>
              <Tutorial />
            </Suspense>
          )}

          {view === 'settings' && (
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--muted)' }}>正在加载设置…</div>}>
              <SettingsPage
                onToast={showToast}
                tourDone={tourDone === true}
                onStartTour={startTour}
                onOpenTutorial={() => setView('tutorial')}
                onLibraryChanged={() => {
                  pageRef.current = 1;
                  load(1, true);
                  refreshStats();
                  followImport();
                }}
              />
            </Suspense>
          )}
          </Suspense>
          </ErrorBoundary>
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
              const msg = (err as Error).message || '打开文件夹失败';
              if (activeFolder.anchor_path) showToast(`打开失败：${msg}`, 'error');
              // 虚拟文件夹本来就没有磁盘目录，退回打开库根并说清楚原因
              else showToast('这个文件夹只是虚拟分类，没有对应的磁盘目录，已打开素材库根目录');
              openFolder().catch(quiet);
            });
          }}
        />
      </main>
      </div>{/* /.app-body */}

      {helpOpen && <HotkeyHelp onClose={() => setHelpOpen(false)} />}

      <CommandPalette
        open={palette !== null}
        mode={palette || 'command'}
        onClose={() => setPalette(null)}
        commands={paletteCommands}
        filters={filters}
        onFilter={onFiltersChange}
        folders={folders}
        onOpenFolder={(id) => {
          setView('gallery');
          setFolderId(id);
        }}
      />

      {lockFolderId != null && lockFolder && (
        <FolderLockDialog
          folder={lockFolder}
          onClose={() => setLockFolderId(null)}
          onFolders={(fs) => {
            setFolders(fs);
            // 加锁 / 解锁会改变可见集：当前正停留在这个夹里且它被重新锁上，就退回全库
            const cur = fs.find((f) => f.id === lockFolderId);
            if (folderId === lockFolderId && cur && !cur.unlocked) setFolderId(null);
            load(1, true);
            refreshStats();
          }}
          onToast={showToast}
        />
      )}

      {lb && (
        // 大图/水印面板在内容区那个 ErrorBoundary 之外（它是全屏浮层），
        // 一旦渲染期抛错整棵树会被卸载 —— 用户看到的是一片白，连侧栏都没了。
        // 这里单独兜一层：崩了就显示错误卡片，换张图自动重置。
        <ErrorBoundary resetKey={`lb:${lb.items[lb.index]?.id ?? ''}`}>
        <Lightbox
          items={lb.items}
          index={lb.index}
          // 服务端一定会给 library；这里再拿库列表兜一层，任何情况下都不显示空
          // （旧版服务/竞态时 stats.library 可能缺失，用户就分不清图在哪个库了）
          library={
            stats?.library ||
            (activeLib
              ? { id: String(activeLib.id), name: activeLib.name, path: activeLib.root_path || '' }
              : null)
          }
          onClose={() => {
            const last = lb.items[lb.index];
            setLb(null);
            // 图库/收藏页打开的大图：退出后把列表定位到最后浏览的那张
            if (last && (view === 'gallery' || view === 'favorites')) revealGalleryItem(last.id, lb.items);
          }}
          onIndex={(index) => setLb((prev) => (prev ? { ...prev, index } : prev))}
          onToggleFavorite={toggleFavorite}
          onSaveTags={saveTags}
          onDelete={requestDelete}
          onSetWallpaper={setWallpaper}
          onEnhance={enhanceOne}
          enhancing={enhancingId === lb.items[lb.index]?.id}
          onViewed={patchItem}
          onAnnotCount={(id, n) => setAnnotationCounts((prev) => ({ ...prev, [String(id)]: n }))}
          onDownload={download}
          onPatch={async (target, patch) => {
            try {
              patchItem(await api.patch(target.id, patch));
            } catch (err) {
              showToast((err as Error).message);
            }
          }}
          onOpenSimilar={(pool, id) => setLb({ items: pool, index: Math.max(0, pool.findIndex((x) => x.id === id)) })}
          onOpenStack={(sid) => setStackViewId(sid)}
          onChangeToast={(msg) => {
            showToast(msg);
            refreshStats();
            pageRef.current = 1;
            load(1, true);
          }}
          onFindColor={(hue) => {
            onFiltersChange({ hue });
            setLb(null);
            setView('gallery');
          }}
          onReplaceItem={patchItem}
        />
        </ErrorBoundary>
      )}

      {pendingDelete && (
        <DeleteReasonDialog
          item={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          onToast={showToast}
        />
      )}

      {toast && <div className={`toast${toast.kind === 'error' ? ' toast-error' : ''}`}>{toast.text}</div>}

      {/* 应用内 prompt/confirm 对话框（替代原生弹窗，全局唯一挂载点） */}
      <DialogHost />

      {/* 本地服务重启中：端口可能变，界面此刻的请求都会失败，先遮住再重载 */}
      {serviceRestarting && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            background: 'rgba(10, 12, 18, 0.72)',
            backdropFilter: 'blur(3px)',
            color: '#e8ecf5',
            fontSize: 13.5,
          }}
          role="alertdialog"
          aria-label="本地服务正在重启"
        >
          <span className="spinner" />
          <div>本地服务正在重启，请稍候…</div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>正在进行的上传/导入会被中断，完成后自动恢复。</div>
        </div>
      )}

      {/* 服务彻底起不来：常驻离线横幅（不遮罩），用户仍可浏览界面 */}
      {serviceOffline && !serviceRestarting && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9997,
            padding: '9px 18px',
            background: 'rgba(120, 34, 46, 0.94)',
            color: '#fff',
            fontSize: 12.5,
            textAlign: 'center',
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
          role="alert"
        >
          <span>
            本地服务不可用：换壁纸、收藏、导入等接口暂时失效。
            {serviceError && <span style={{ opacity: 0.85 }}> 原因：{serviceError}</span>}
          </span>
          <button
            className="btn sm"
            onClick={() => {
              if (!desktop?.restartService) {
                showToast('当前是开发模式，请重启 npm run dev', 'error');
                return;
              }
              void desktop
                .restartService()
                .then((r) => {
                  if (!r?.ok) showToast('重启未成功，可在托盘右键选「重启本地服务」再试一次', 'error');
                })
                .catch((err) => showToast(`重启失败：${(err as Error)?.message || err}`, 'error'));
            }}
          >
            立即重启服务
          </button>
        </div>
      )}

      {/* 强制更新：确认有新版本后全屏接管，装完才允许继续用 */}
      <ForcedUpdateOverlay />

      {tagEdit && (
        <TagMetaDialog
          tag={tagEdit}
          tags={tags}
          onClose={() => setTagEdit(null)}
          onSaved={(r) => {
            setTags(r.tags);
            setTagGroups(r.groups);
            setTagEdit(null);
          }}
          onToast={showToast}
        />
      )}

      {showCreateLib && (
        <CreateLibraryDialog
          onCancel={() => setShowCreateLib(false)}
          onDone={onLibraryCreated}
          onToast={showToast}
        />
      )}

      {bookmarkOpen && (
        <BookmarkDialog
          onClose={() => setBookmarkOpen(false)}
          onToast={showToast}
          onSaved={() => {
            setBookmarkOpen(false);
            // 书签是按当前库入库的：留在原视图刷新首屏即可看到
            setView('gallery');
            pageRef.current = 1;
            load(1, true);
            refreshStats();
          }}
        />
      )}

      {exportOpen && (
        <ExportGalleryDialog
          defaultTitle={activeFolder ? activeFolder.name : activeLibName}
          folderId={folderId}
          folderName={activeFolder?.name}
          selectedIds={selected.size ? [...selected] : undefined}
          onClose={() => setExportOpen(false)}
          onToast={showToast}
        />
      )}

      {shareOpen && (
        <ShareLinkDialog
          defaultTitle={activeFolder ? activeFolder.name : activeLibName}
          folderId={folderId}
          folderName={activeFolder?.name}
          selectedIds={selected.size ? [...selected] : undefined}
          onClose={() => setShareOpen(false)}
          onToast={showToast}
        />
      )}

      {coverFolderId != null && (() => {
        const target = folders.find((f) => f.id === coverFolderId);
        if (!target) return null;
        return (
          <FolderCoverDialog
            folder={target}
            onClose={() => setCoverFolderId(null)}
            onSaved={(next, msg) => {
              setFolders(next);
              showToast(msg);
            }}
            onToast={showToast}
          />
        );
      })()}

      {appearanceFolderId != null && (() => {
        const target = folders.find((f) => f.id === appearanceFolderId);
        if (!target) return null;
        return (
          <FolderAppearanceDialog
            folder={target}
            onClose={() => setAppearanceFolderId(null)}
            onSaved={setFolders}
            onToast={showToast}
          />
        );
      })()}

      {batchCreate && (
        <BatchCreateDialog
          mode={batchCreate.mode}
          parentId={batchCreate.parentId}
          parentName={
            batchCreate.parentId != null ? folders.find((f) => f.id === batchCreate.parentId)?.name || '' : ''
          }
          onClose={() => setBatchCreate(null)}
          onFolders={setFolders}
          onTags={(r) => {
            setTags(r.tags);
            setTagGroups(r.groups);
          }}
          onToast={showToast}
        />
      )}

      {quickClassifyIds && quickClassifyIds.length > 0 && (
        <QuickClassifyDialog
          ids={quickClassifyIds}
          folders={folders}
          currentFolderId={folderId}
          onClose={() => setQuickClassifyIds(null)}
          onDone={() => {
            setSelected(new Set());
            pageRef.current = 1;
            load(1, true);
            refreshStats();
          }}
          onToast={showToast}
        />
      )}

      {stackViewId != null && (
        <StackViewer
          stackId={stackViewId}
          onClose={() => setStackViewId(null)}
          onChanged={() => {
            pageRef.current = 1;
            load(1, true);
          }}
          onToast={showToast}
          onOpenItem={(it) => openItem(it, [it])}
        />
      )}

      {/* 教程：建库引导优先，教程等它关掉后再自动弹 */}
      <OnboardingTour open={tourOpen && onboarding === true} onClose={finishTour} />

      {onboarding === false && (
        <CreateLibraryDialog
          welcome
          onCancel={finishOnboarding}
          onDone={(library) => {
            onLibraryCreated(library);
            finishOnboarding();
          }}
          onToast={showToast}
        />
      )}
    </div>
  );
}
