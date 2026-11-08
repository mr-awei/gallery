import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, desktop, downloadFile, isDesktop, onApiError, openFolder, quiet } from './api';
import { subscribeEvents } from './events';
import type { Filters, ImageItem, Stats, Library, FolderNode, SavedFilter, TagNode, View } from './types';
import Dashboard from './pages/Dashboard';
import GalleryPage from './pages/Gallery';
import Crawl from './pages/Crawl';
import SettingsPage from './pages/Settings';
import Knowledge from './pages/Knowledge';
import Playlists from './pages/Playlists';
import Tidy from './pages/Tidy';
import EnhancePage from './pages/Enhance';
import Search from './pages/Search';
import Smart from './pages/Smart';
import Lightbox from './components/Lightbox';
import GlobalImport from './components/GlobalImport';
import ScreenshotOverlay from './components/ScreenshotOverlay';
import TagPanel from './components/TagPanel';
import DeleteReasonDialog, { reasonLabel } from './components/DeleteReasonDialog';
import DialogHost, { confirmDialog, promptDialog } from './components/Dialogs';
import HotkeyHelp from './components/HotkeyHelp';
import FolderLockDialog from './components/FolderLockDialog';
import BookmarkDialog from './components/BookmarkDialog';
import ExportGalleryDialog from './components/ExportGalleryDialog';
import ErrorBoundary from './components/ErrorBoundary';
import FolderCoverDialog from './components/FolderCoverDialog';
import FolderTree from './components/FolderTree';
import FolderAppearanceDialog from './components/FolderAppearanceDialog';
import BatchCreateDialog from './components/BatchCreateDialog';
import QuickClassifyDialog from './components/QuickClassifyDialog';
import StackViewer from './components/StackViewer';
import LibrarySwitcher from './components/LibrarySwitcher';
import CreateLibraryDialog from './components/CreateLibraryDialog';
import OnboardingTour from './components/OnboardingTour';
import TagMetaDialog from './components/TagMetaDialog';
import { applyTheme, getStoredTheme, type Theme } from './theme';
import Bookmarks from './pages/Bookmarks';
import Tutorial from './pages/Tutorial';
import CommandPalette, { type PaletteCommand } from './components/CommandPalette';
import { buildRoute, parseRoute, sameRoute, type RouteState } from './lib/route';
import { THUMB_DEFAULT, clampThumbWidth } from './lib/thumb-size';
import { matchesBinding, useKeymap } from './lib/keymap';
import TopBar from './layout/TopBar';
import Sidebar from './layout/Sidebar';
import StatusBar from './layout/StatusBar';
import ForcedUpdateOverlay from './components/ForcedUpdateOverlay';
import { TOOLS } from './layout/nav';
import { useAppUiState } from './hooks/useAppUiState';

const PAGE_SIZE = 48;

/**
 * 追加分页结果时按 id 去重。
 * offset 分页在导入期会整体后移：刚加载完第 2 页，前面又插进 30 张新图，
 * 第 3 页就会把第 2 页末尾那几张再返回一次。直接 concat 会让同一张图在网格里
 * 出现两次、React key 重复（卡片叠位、点击命中错的素材）。
 */
function mergeItems(prev: ImageItem[], next: ImageItem[]): ImageItem[] {
  const seen = new Set(prev.map((x) => x.id));
  const out = prev.slice();
  for (const it of next) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

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
  const [stats, setStats] = useState<Stats | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<'masonry' | 'grid' | 'list'>(() => {
    const v = localStorage.getItem('tuku:view-mode');
    return v === 'grid' || v === 'list' ? v : 'masonry';
  });
  /** 缩略图尺寸（列宽 px，Eagle 的缩略图滑块），持久化在本地；默认「中小」= 250 */
  const [colWidth, setColWidth] = useState(() => {
    const v = Number(localStorage.getItem('tuku:col-width'));
    return Number.isFinite(v) && v > 0 ? clampThumbWidth(v) : THUMB_DEFAULT;
  });
  const [tags, setTags] = useState<TagNode[]>([]);
  const [tagGroups, setTagGroups] = useState<string[]>([]);
  /** 标签总数（分页）：远端实际标签数可能大于本地已加载的 tags */
  const [tagTotal, setTagTotal] = useState(0);
  /** 「待整理」三个入口的数量（Eagle 侧栏数字） */
  const [pendingCounts, setPendingCounts] = useState<{ total: number; noFolder: number; noTags: number; noRating: number } | null>(
    null
  );
  /** 卡片角标：标注数量 / 完全重复同组张数 */
  const [annotationCounts, setAnnotationCounts] = useState<Record<string, number>>({});
  const [dupeCounts, setDupeCounts] = useState<Record<string, number>>({});
  /** 正在编辑元数据的标签（右键侧栏标签） */
  const [tagEdit, setTagEdit] = useState<TagNode | null>(null);
  const [lb, setLb] = useState<{ items: ImageItem[]; index: number } | null>(null);
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
  const [missingCount, setMissingCount] = useState(0);
  // 手动刷新序号：每次刷新自增，作为图片卡片的 key 之一，强制重挂载以清除
  // 「缩略图加载失败」的残留状态（否则卡片复用实例，刷新也无法恢复显示）
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const totalRef = useRef(0);
  // 上一次统计到的全库张数：library 推送后若库变大（导入/采集），自动重载列表
  const libTotalRef = useRef(-1);
// 导入进行中标记（ref 供 refreshStats 读取，避免回调依赖频繁变化）
const importingRef = useRef(false);
  // 退出大图后要滚动定位到的图片 id（图库页补载页面后滚动过去）
  const [scrollTargetId, setScrollTargetId] = useState<number | null>(null);
  const [enhanceModel, setEnhanceModel] = useState('');
  const [enhancingId, setEnhancingId] = useState<number | null>(null);
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  // 首次引导：null=加载中 / false=需引导 / true=已完成
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  // 新手教程（分步导览）：tourOpen 控制显示；tourDone 落设置（跨资源库共享）
  const [tourOpen, setTourOpen] = useState(false);
  const [tourDone, setTourDone] = useState<boolean | null>(null);
  const tourStartedRef = useRef(false);
  // 多资源库 + 文件夹树
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [activeLibId, setActiveLibId] = useState<number | null>(null);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [folderId, setFolderId] = useState<number | null>(initialRoute.folderId);
  const folderIdRef = useRef<number | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);

  /* 集合类能力：保存筛选器 / 文件夹外观 / 批量创建 / 快速分类 / 堆叠 */
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [activeSavedId, setActiveSavedId] = useState<number | null>(null);
  const [appearanceFolderId, setAppearanceFolderId] = useState<number | null>(null);
  const [batchCreate, setBatchCreate] = useState<{ mode: 'folder' | 'tag'; parentId: number | null } | null>(null);
  const [quickClassifyIds, setQuickClassifyIds] = useState<number[] | null>(null);
  const [stackViewId, setStackViewId] = useState<number | null>(null);

  // 侧栏宽度：右缘把手拖拽调整并持久化，双击恢复默认。
  // 宽度写入 --sidebar-w 变量（.sidebar 的 width/flex-basis 都引用它），
  // 窄屏媒体查询直接覆盖 width，不受内联变量影响
  const DEFAULT_SIDEBAR_W = 232;
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 440;
  const [sidebarW, setSidebarW] = useState(() => {
    const v = Number(localStorage.getItem('tuku:sidebar-w'));
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : DEFAULT_SIDEBAR_W;
  });
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  // 由位移直接算当前宽度——不依赖 state/ref 的异步更新时序，up 时也能取到准确终值
  const widthAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = resizeRef.current;
    if (!st) return sidebarW;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, st.startW + e.clientX - st.startX));
  };
  const onResizerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startW: sidebarW };
    e.currentTarget.setPointerCapture(e.pointerId); // 后续 move/up 都派发给把手，滑出也不丢
    document.body.classList.add('sidebar-resizing');
  };
  const onResizerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    setSidebarW(widthAt(e));
  };
  const onResizerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    const finalW = widthAt(e); // 先取值再清状态
    resizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove('sidebar-resizing');
    setSidebarW(finalW);
    localStorage.setItem('tuku:sidebar-w', String(finalW));
  };
  // 主内容滚动容器：切筛选/文件夹重载列表时必须滚回顶部，
  // 否则残留的 scrollTop 会让 MasonryGrid 虚拟窗口落在新内容之外（卡片裁剪/空白/提前到底）
  const contentRef = useRef<HTMLDivElement | null>(null);

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
    api.folders().then((r) => setFolders(r.folders)).catch(quiet);
    api.savedFilters().then((r) => setSavedFilters(r.filters)).catch(quiet);
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

  const pageRef = useRef(1);
  // 用户在深处浏览时来了新图：只提示一次，别反复把列表打回第 1 页
  const newAtTopRef = useRef(false);
  const reqId = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const filtersRef = useRef<Filters>(filters);

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

  const load = useCallback(async (page: number, reset: boolean) => {
    const id = ++reqId.current;
    // 切筛选 / 翻页时取消上一个还在路上的列表请求，避免旧结果占用连接与状态
    loadAbort.current?.abort();
    loadAbort.current = new AbortController();
    const signal = loadAbort.current.signal;
    setLoading(true);
    try {
      const res = folderIdRef.current
        ? await api.folderImages(folderIdRef.current, page, PAGE_SIZE, { signal })
        : await api.images(filtersRef.current, page, PAGE_SIZE, { signal });
      if (id !== reqId.current) return;
      setItems((prev) => (reset ? res.items : mergeItems(prev, res.items)));
      setTotal(res.total);
      totalRef.current = res.total;
      setHasMore(res.hasMore);
      // 页码只在成功后推进（由 loadMore 触发），失败不能把这一页永久跳过
      if (!reset) pageRef.current = page;
      else newAtTopRef.current = false;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // 被新请求取代，不算错误
      const msg = (err as Error).message;
      // 首屏请求失败必须清掉旧数据：否则切到「打不开的文件夹/筛选」后，
      // 界面仍显示上一个视图的图，用户对着错的内容继续批量操作
      if (id === reqId.current && reset) {
        setItems([]);
        setTotal(0);
        totalRef.current = 0;
        setHasMore(false);
      }
      showToast(msg);
    } finally {
      // 收起加载态要判代：旧请求被新请求 abort 后，它的 finally 仍会执行，
      // 若无条件 setLoading(false)，无限滚动的 IO 守卫会误判「空闲」而立刻追加
      // 下一页 —— 这个请求又把当前请求 abort 掉，其结果因代数过期被丢弃，
      // 就会丢一页数据。永久转圈不会发生：reqId.current 永远指向最新请求，
      // 它自己 settle 时一定会收尾。
      if (id === reqId.current) setLoading(false);
    }
  }, [showToast]);

  /**
   * 统计刷新 + 库增长对账。
   * 之前列表增量加载只挂在 library 事件上 —— 导入的 CPU 密集段（sharp 解码 / pHash）
   * 会阻塞 SSE 心跳，EventSource 断连重连期间 library 事件全部丢失，列表就停在
   * 断连前的张数不再前进（P0：导入 642 张前端只跟到 10 张）。
   * 现在对账收进这里：library 事件、job 快照（1.5s 必到）、60s 兜底定时器都会调用，
   * 任何一路活着列表就能跟上导入进度。
   */
  // 标签是全量扫 images.tags 算出来的，比 stats 贵得多；而导入进度推送期间
  // 标签集合不会变（入库不带标签）。2s 内重复拉只是白扫一遍全表。
  const tagsFetchedAtRef = useRef(0);

  const refreshStats = useCallback(() => {
    api.stats().then((s) => {
      setStats(s);
      const prev = libTotalRef.current;
      libTotalRef.current = s.total;
      if (prev >= 0 && s.total > prev) {
        // 用户已经翻到第 2 页以后就别再打回第 1 页：那会 abort 在途分页、列表跳回顶部，
        // 正在看的内容被抽走（导入期 1.2s 一次，根本没法翻）。新图在回到首屏时自然出现。
        if (pageRef.current <= 1) {
          pageRef.current = 1;
          load(1, true);
        } else if (!newAtTopRef.current) {
          newAtTopRef.current = true;
          showToast('有新图片入库，回到顶部即可看到');
        }
      }
      // 导入进行中：新入库图片必然出现在默认「最新采集」列表里，
      // 让筛选栏「共 X 张」随导入实时跳动，而不是等下一次 load 才更新
      if (importingRef.current) setTotal((cur) => Math.max(cur, s.total));
    }).catch(quiet);
    const now = Date.now();
    if (now - tagsFetchedAtRef.current >= 2000) {
      tagsFetchedAtRef.current = now;
      api
        .tags({ limit: 500 })
        .then((r) => {
          setTags(r.tags);
          setTagGroups(r.groups);
          setTagTotal(r.total ?? r.tags.length);
        })
        .catch(quiet);
    }
    api.pending().then(setPendingCounts).catch(quiet);
    api.missingFiles().then((m) => setMissingCount(m.count)).catch(quiet);
  }, [load, showToast]);

  /**
   * 统计刷新节流（800ms）。
   * library 与 job 两条推送都走这里：导入期任务快照每秒好几条，以前每条都打
   * stats/tags/pending/missingFiles 四个接口，叠加 1.2s 轮询直接变成请求风暴。
   * 用「定时器在就不重置」的节流而不是尾随去抖：持续导入时也保持稳定刷新节奏，
   * 不会因为事件不断而永远刷不到。
   */
  const statsThrottleRef = useRef(0);
  const scheduleStatsRefresh = useCallback(() => {
    if (statsThrottleRef.current) return;
    statsThrottleRef.current = window.setTimeout(() => {
      statsThrottleRef.current = 0;
      refreshStats();
    }, 800);
  }, [refreshStats]);

  /** 只重取标签/分组：智能文件夹页改名、合并、删除后要让侧栏同步，不必重拉统计 */
  const reloadTags = useCallback(() => {
    api
      .tags({ limit: 500 })
      .then((r) => {
        setTags(r.tags);
        setTagGroups(r.groups);
        setTagTotal(r.total ?? r.tags.length);
      })
      .catch(quiet);
  }, []);

  /** 侧栏标签按需加载更多页（标签很多时初始只拉前 500，避免一次拉完） */
  const loadMoreTags = useCallback(() => {
    api
      .tags({ limit: 500, offset: tags.length })
      .then((r) => {
        setTags((prev) => [...prev, ...r.tags]);
        setTagTotal((prevTotal) => r.total ?? prevTotal + r.tags.length);
      })
      .catch(quiet);
  }, [tags.length]);

  /** 错误条上的「重试」：把统计、标签、列表这几条主链路重跑一遍 */
  const retryFailedLoad = useCallback(() => {
    setLoadError('');
    setRefreshSeq((n) => n + 1);
    refreshStats();
    void load(1, true);
  }, [load, refreshStats]);

  /* 卡片角标与「待整理」数字：换库 / 手动刷新时重取（标注 & MD5 重复都是低频变更） */
  useEffect(() => {
    api.annotationCounts().then((r) => setAnnotationCounts(r.counts || {})).catch(quiet);
  }, [refreshSeq, activeLibId]);

  useEffect(() => {
    api
      .md5Dupes()
      .then((r) => {
        const map: Record<string, number> = {};
        for (const g of r.groups) for (const it of g.items) map[String(it.id)] = g.items.length;
        setDupeCounts(map);
      })
      .catch(quiet);
  }, [refreshSeq, activeLibId]);

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
        api.folders().then((r) => setFolders(r.folders)).catch(quiet);
        // 保存的筛选器存在各库自己的 gallery.db：不重载就会继续显示上一个库的条目
        setActiveSavedId(null);
        api.savedFilters().then((r) => setSavedFilters(r.filters)).catch(quiet);
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
          api.folders().then((x) => setFolders(x.folders)).catch(quiet);
          setActiveSavedId(null);
          api.savedFilters().then((x) => setSavedFilters(x.filters)).catch(quiet);
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
      api.folders().then((r) => setFolders(r.folders)).catch(quiet);
      setActiveSavedId(null);
      api.savedFilters().then((r) => setSavedFilters(r.filters)).catch(quiet);
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

  // 隐私空间的密码弹窗目标（null = 关闭）
  const [lockFolderId, setLockFolderId] = useState<number | null>(null);

  // 进入某个文件夹（含后代聚合视图）
  const enterFolder = useCallback(
    (id: number) => {
      const f = folders.find((x) => x.id === id);
      // 已加锁且本次会话没解锁：先要密码，别让用户白等一次 403
      if (f?.locked && !f.unlocked) {
        setLockFolderId(id);
        return;
      }
      setView('gallery');
      setFolderId(id);
    },
    [folders]
  );

  const lockFolder = lockFolderId != null ? folders.find((f) => f.id === lockFolderId) || null : null;

  // 新建虚拟文件夹（根级 parentId=null 或某夹下）
  const createFolderAt = useCallback(
    async (parentId: number | null) => {
      const name = await promptDialog(parentId == null ? '新建文件夹' : '新建子文件夹', '', '文件夹名称');
      if (name === null) return;
      if (!name.trim()) return showToast('文件夹名称不能为空');
      try {
        const r = await api.createFolder(name.trim(), parentId);
        setFolders(r.folders);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  // 重命名文件夹
  const renameFolderAt = useCallback(
    async (id: number) => {
      const folder = folders.find((f) => f.id === id);
      const name = await promptDialog('重命名文件夹', folder?.name || '', '新名称');
      if (name === null || !name.trim()) return;
      try {
        const r = await api.renameFolder(id, name.trim());
        setFolders(r.folders);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folders, showToast]
  );

  /**
   * 文件夹标签：夹上打标签，夹内素材在搜索/筛选时自动继承（Eagle 的老习惯）。
   * 只写 folders.tags，图片记录不动 —— 撤销只要把标签清掉，不用逐张回滚。
   */
  const editFolderTags = useCallback(
    async (id: number) => {
      const folder = folders.find((f) => f.id === id);
      const cur = String(folder?.tags || '');
      const next = await promptDialog('文件夹标签', cur, '多个用逗号分隔，夹内素材自动继承');
      if (next === null) return;
      const tags = next
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        const r = await api.setFolderTags(id, tags);
        setFolders(r.folders);
        showToast(tags.length ? `已给「${folder?.name || '文件夹'}」打上 ${tags.length} 个标签` : '已清空文件夹标签');
        refreshStats();
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folders, showToast, refreshStats]
  );

  /**
   * 手动排序：把拖动的几张插到目标卡片后面，把整份新顺序发给后端。
   * 只在文件夹视图里有意义（同一张图在不同夹可以有不同的位置）。
   */
  const reorderInFolder = useCallback(
    async (dragIds: number[], targetId: number) => {
      if (!folderId) {
        showToast('手动排序只在文件夹里生效：先打开一个文件夹');
        return;
      }
      const ids = items.map((i) => i.id);
      const moving = ids.filter((id) => dragIds.includes(id));
      if (!moving.length) return;
      const rest = ids.filter((id) => !dragIds.includes(id));
      const at = rest.indexOf(targetId);
      if (at < 0) return;
      const next = [...rest.slice(0, at + 1), ...moving, ...rest.slice(at + 1)];
      try {
        await api.reorderFolder(folderId, next);
        // 拖放只在 sort=manual 且已打开文件夹时才启用，这里不必再改筛选，按当前排序重取即可
        load(1, true);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folderId, items, load, showToast]
  );

  // 删除文件夹（仅解除关联，不删图片）
  const deleteFolderAt = useCallback(
    async (id: number) => {
      const folder = folders.find((f) => f.id === id);
      const ok = await confirmDialog(`删除文件夹「${folder?.name || ''}」？只会解除归类，不会删除任何图片。`);
      if (!ok) return;
      try {
        const r = await api.deleteFolder(id);
        setFolders(r.folders);
        if (folderId === id) setFolderId(null); // 删的是当前视图，退回全库
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folders, folderId, showToast]
  );

  /** 文件夹同父级拖动排序：把 dragId 插到 targetId 前/后，整份新顺序发给后端 */
  const reorderFoldersAt = useCallback(
    async (dragId: number, targetId: number, position: 'before' | 'after') => {
      const target = folders.find((f) => f.id === targetId);
      if (!target) return;
      const parent = target.parent_id ?? null;
      const siblings = folders
        .filter((f) => (f.parent_id ?? null) === parent)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
      const dragged = siblings.find((f) => f.id === dragId);
      if (!dragged) return;
      const without = siblings.filter((f) => f.id !== dragId);
      const at = without.findIndex((f) => f.id === targetId);
      if (at < 0) return;
      const next = [...without];
      next.splice(position === 'before' ? at : at + 1, 0, dragged);
      try {
        const r = await api.reorderFolders(parent, next.map((f) => f.id));
        setFolders(r.folders);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [folders, showToast]
  );

  /* ------------------------- 保存的筛选器：存 / 用 / 改 / 删 ------------------------- */

  const openSavedFilter = useCallback((f: SavedFilter) => {
    const q = (f.query || {}) as Partial<Filters> & { folderId?: number | null };
    setFolderId(q.folderId ?? null);
    setFilters({ ...defaultFilters, ...q });
    setActiveSavedId(f.id);
    setView('gallery');
  }, []);

  const saveCurrentFilter = useCallback(async () => {
    const name = await promptDialog('保存当前筛选', '', '给这组筛选起个名字（例：4K 风景待修）');
    if (name === null) return;
    if (!name.trim()) return showToast('名称不能为空');
    try {
      const r = await api.createSavedFilter(name.trim(), { ...filters, folderId });
      setSavedFilters(r.filters);
      setActiveSavedId(r.id);
      showToast(`已保存筛选「${name.trim()}」`);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [filters, folderId, showToast]);

  const editSavedFilter = useCallback(
    async (f: SavedFilter) => {
      const name = await promptDialog('重命名筛选器', f.name, '新名称');
      if (name === null || !name.trim()) return;
      try {
        const r = await api.updateSavedFilter(f.id, { name: name.trim() });
        setSavedFilters(r.filters);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  /** 用当前筛选覆盖已保存的那一条：Eagle 里改完条件顺手存回去，不必删了重存 */
  const overwriteSavedFilter = useCallback(
    async (f: SavedFilter) => {
      if (!(await confirmDialog(`用当前筛选条件覆盖「${f.name}」？原来的条件会被替换。`))) return;
      try {
        const r = await api.updateSavedFilter(f.id, { query: { ...filters, folderId } });
        setSavedFilters(r.filters);
        setActiveSavedId(f.id);
        showToast(`已用当前筛选更新「${f.name}」`);
      } catch (err) {
        showToast((err as Error).message, 'error');
      }
    },
    [filters, folderId, showToast]
  );

  const deleteSavedFilter = useCallback(
    async (f: SavedFilter) => {
      if (!(await confirmDialog(`删除筛选器「${f.name}」？只删这条筛选记录，不会动任何素材。`))) return;
      try {
        const r = await api.deleteSavedFilter(f.id);
        setSavedFilters(r.filters);
        if (activeSavedId === f.id) setActiveSavedId(null);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [activeSavedId, showToast]
  );

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

  /** 拖图到文件夹卡片上：归档并刷新夹上的数量/封面 */
  const dropImagesOnFolderAt = useCallback(
    async (targetFolderId: number, ids: number[]) => {
      try {
        const r = await api.addToFolder(targetFolderId, ids);
        showToast(`已把 ${ids.length} 张放进文件夹（新增 ${r.added} 条归属）`);
        api.folders().then((x) => setFolders(x.folders)).catch(quiet);
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
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

  const loadMore = useCallback(() => {
    // 页码由 load() 在成功后提交：提前 +1 再请求，一旦失败这一页就被永久跳过，
    // 用户往下滚永远少一屏，且没有任何提示
    load(pageRef.current + 1, false);
  }, [load]);

  /**
   * 全选 = 选中「当前筛选条件下的全部图片」，不只是已经加载的那一页。
   * 原来 Ctrl+A 只 setSelected(items)，用户以为选全了，批量删/移动其实只处理一页。
   */
  const selectAllMatching = useCallback(async () => {
    if (selectingAllRef.current) return;
    selectingAllRef.current = true;
    try {
      // 文件夹视图必须把 folderId 一起带上：只传 filters 会选中全库匹配项，
      // 用户以为只选了当前文件夹，批量删除却波及范围外的图
      const r = await api.imageIds(filtersRef.current, { folderId: folderIdRef.current });
      setSelected(new Set(r.ids));
      const scope = folderIdRef.current ? '当前文件夹（含子文件夹）' : '当前筛选';
      showToast(
        r.truncated
          ? `范围共 ${r.total} 张，已选中前 ${r.ids.length} 张（超出上限，请先缩小筛选）`
          : r.total > items.length
            ? `已选中${scope}全部 ${r.total} 张（当前只显示 ${items.length} 张）`
            : `已选中${scope} ${r.total} 张`
      );
    } catch (err) {
      showToast(`全选失败：${(err as Error).message}`);
    } finally {
      selectingAllRef.current = false;
    }
  }, [items.length, showToast]);

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

  // 大图导航池补全代数：期间用户再次打开大图 / 关闭后，旧补全回调不得覆盖新池
  const lbFillSeq = useRef(0);
  // 补全请求的取消句柄：关闭大图 / 重开必须 abort，否则关掉后几百个请求还在继续跑
  const lbFillAbort = useRef<AbortController | null>(null);
  // 「从大图定位回网格」的请求句柄：连续定位时取消上一次
  const revealAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (lb) return;
    lbFillAbort.current?.abort();
    lbFillAbort.current = null;
  }, [lb]);

  const openItem = useCallback((item: ImageItem, pool?: ImageItem[], full = false) => {
    // 重开大图：上一轮补全与「定位回网格」立刻作废，别让旧请求稍后改写列表
    lbFillAbort.current?.abort();
    lbFillAbort.current = null;
    revealAbort.current?.abort();
    revealAbort.current = null;
    const list = pool && pool.some((x) => x.id === item.id) ? pool : [item];
    const index = list.findIndex((x) => x.id === item.id);
    setLb({ items: list, index: Math.max(0, index) });
    // 图库打开时，后台把当前筛选的全量列表补进导航池：
    // 平时只加载第一页（48 张），大图浏览若只在这页里导航，数量和范围都会误导。
    // 万级库 ≈ 数百页：旧实现串行逐页拉会打出 70+ 连发请求；现在延迟 1.5s
    // （让大图和缩略图先加载）+ 并发 5 路分块拉取，每页到齐即合并，失败页直接放弃补全。
    if (full && pool) {
      const seq = ++lbFillSeq.current;
      const ac = new AbortController();
      lbFillAbort.current = ac;
      const { signal } = ac;
      const filters = filtersRef.current; // 快照：补全期间用户切筛选时保持页间一致
      const replacePool = (all: ImageItem[]) => {
        setLb((prev) => {
          if (!prev || seq !== lbFillSeq.current) return prev; // 已关闭 / 已重开大图
          const curId = prev.items[prev.index]?.id;
          const nextIndex = Math.max(0, all.findIndex((x) => x.id === curId));
          return { items: all, index: nextIndex };
        });
      };
      (async () => {
        await new Promise((r) => setTimeout(r, 1500));
        if (signal.aborted || seq !== lbFillSeq.current) return;
        const first = await api.images(filters, 1, 120, { signal });
        if (signal.aborted || seq !== lbFillSeq.current) return;
        if (first.total <= list.length) return; // 本来就是全量，无需替换
        // 上限 200 页（24000 张）：更大的库也只补一段连续前缀，
        // 不能因为「打开了张图」就打出上千个请求
        const pages = Math.min(Math.ceil(first.total / 120), 200);
        const results: (ImageItem[] | null)[] = new Array(pages).fill(null);
        results[0] = first.items;
        if (pages === 1) return replacePool(first.items);
        let next = 2;
        const worker = async () => {
          while (next <= pages) {
            // 循环体内也要检查：只在最后检查的话，关闭大图后已排队的页仍会全部打出去
            if (signal.aborted || seq !== lbFillSeq.current) return;
            const p = next++;
            try {
              results[p - 1] = (await api.images(filters, p, 120, { signal })).items;
            } catch {
              return; // 一页失败（含被 abort）就放弃补全，保留已有池
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(5, pages - 1) }, worker));
        if (signal.aborted || seq !== lbFillSeq.current || results.some((r) => !r)) return;
        replacePool(results.flat() as ImageItem[]);
      })().catch(quiet);
    }
  }, []);

  const download = useCallback((item: ImageItem) => {
    downloadFile(item.downloadUrl);
  }, []);

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectingAllRef = useRef(false);
  const bulkBusyRef = useRef(false);
  const bulk = useCallback(
    async (action: string, tag?: string) => {
      if (bulkBusyRef.current) return; // 批量任务进行中忽略重复触发（双击 / 回车重放）
      const ids = [...selected];
      if (!ids.length) return;
      if (action === 'delete' && !(await confirmDialog(`确定删除选中的 ${ids.length} 张图片？`))) return;
      bulkBusyRef.current = true;
      try {
        await api.batch(ids, action, tag);
        showToast(action === 'delete' ? `已删除 ${ids.length} 张` : `已更新 ${ids.length} 张`);
        setSelected(new Set());
        pageRef.current = 1;
        load(1, true);
        refreshStats();
      } catch (err) {
        // 之前失败是静默的：用户以为删了/收藏了，实际什么都没发生
        showToast(`批量操作失败：${(err as Error).message}`);
      } finally {
        bulkBusyRef.current = false;
      }
    },
    [selected, load, refreshStats, showToast]
  );

  const onFiltersChange = useCallback((patch: Partial<Filters>) => {
    // 手动改筛选就离开「保存的筛选」视图：否则侧栏那条还高亮着，看着像没生效
    setActiveSavedId(null);
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  /* Gallery 已用 React.memo 包住：这些回调必须是稳定引用，
     否则每次 App 渲染都会生成新函数，memo 永远命中不了（勾一张图就重渲染整页）。 */
  const clearSelection = useCallback(() => setSelected(new Set<number>()), []);
  const selectAll = useCallback(() => void selectAllMatching(), [selectAllMatching]);
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

  /* 全局快捷键：搜索聚焦、全选、删除、Esc、? 帮助；输入框内一律不拦（避免抢字） */
  const [helpOpen, setHelpOpen] = useState(false);

  /* 卡片右键「搜索命令…」：菜单在卡片里，命令表在 App 里，用事件把两处接起来 */
  useEffect(() => {
    const onAsk = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: 'command' | 'filter' }>).detail?.mode;
      setPalette(mode === 'filter' ? 'filter' : 'command');
    };
    window.addEventListener('tuku:palette', onAsk);
    return () => window.removeEventListener('tuku:palette', onAsk);
  }, []);

  /* 全局快捷键表：默认值 + 用户在设置里改过的键位（改完立即生效，无需重启） */
  const { keymap } = useKeymap();

  /* 空格快速预览：记住光标底下的卡片（不改动每张卡的监听，鼠标划过即记录） */
  const hoverIdRef = useRef<number | null>(null);
  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-image-id]') as HTMLElement | null;
      hoverIdRef.current = el ? Number(el.dataset.imageId) || null : null;
    };
    document.addEventListener('mouseover', onOver, { passive: true });
    return () => document.removeEventListener('mouseover', onOver);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      // 命令面板：即使在输入框里也要能开（Eagle 的同类入口也是全局的）
      if (matchesBinding(e, keymap.palette)) {
        e.preventDefault();
        setPalette((v) => (v === 'command' ? null : 'command'));
        return;
      }
      // 筛选器搜索：不用翻侧栏，直接搜「类型 / 星级 / 色系 / 文件夹」
      if (matchesBinding(e, keymap.filter)) {
        e.preventDefault();
        setPalette((v) => (v === 'filter' ? null : 'filter'));
        return;
      }
      // 新建窗口：同一图库多开（桌面端才有）
      if (matchesBinding(e, keymap.newWindow)) {
        e.preventDefault();
        if (desktop?.openNewWindow) {
          void desktop.openNewWindow().then((r) => {
            if (!r?.ok) showToast(r?.error || '打开新窗口失败');
          });
        } else {
          showToast('多窗口仅在桌面端可用');
        }
        return;
      }
      if (palette) return; // 面板自己处理 Esc / 方向键 / Enter
      // F1：教程随叫随到，输入框里也照样能开（F1 不会当文字输入）
      if (e.key === 'F1') {
        e.preventDefault();
        setLb(null);
        setView('tutorial');
        return;
      }
      if (!typing && matchesBinding(e, keymap.help)) {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (helpOpen && e.key === 'Escape') {
        e.preventDefault();
        setHelpOpen(false);
        return;
      }
      // 搜索框：Ctrl+F（可自定义），另外保留「/」这个手顺的备用入口
      if (matchesBinding(e, keymap.search) || (e.key === '/' && !mod)) {
        const el = document.querySelector<HTMLInputElement>('input[placeholder*="搜索"]');
        if (el) {
          e.preventDefault();
          el.focus();
          if (matchesBinding(e, keymap.search)) el.select();
        }
        return;
      }
      if (typing) return;
      if (lb) return; // 大图内自己的快捷键优先，别在这里抢
      // 全屏工作台（批量裁切 / 调色台）里按键归它自己：否则 Delete 会把背后的选中项删掉
      if (document.querySelector('.crop-studio, .cr-room')) return;
      // 空格快速预览（Eagle 的手感）：鼠标停在谁身上就预览谁；没悬停时用选中项 / 第一张。
      // 卡片自身聚焦时空格是「勾选」，让位给它，避免一次按键干两件事。
      if (matchesBinding(e, keymap.quickPreview)) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest?.('[data-image-id]')) return;
        const id = hoverIdRef.current;
        const target =
          (id != null ? items.find((it) => it.id === id) : undefined) ||
          (selected.size ? items.find((it) => selected.has(it.id)) : undefined) ||
          items[0];
        if (target) {
          e.preventDefault();
          openItem(target, items, true);
          return;
        }
      }
      // F 快速分类：选中一批素材 → 「放进文件夹 + 追加标签」一步到位。
      // 卡片自身聚焦时让位（卡片里的 F 是收藏），避免一次按键干两件事。
      if ((e.key === 'f' || e.key === 'F') && !mod && !e.altKey && !e.shiftKey) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest?.('[data-image-id]')) return;
        const fallback = hoverIdRef.current ?? items[0]?.id;
        const ids = selected.size
          ? [...selected]
          : fallback
            ? [fallback]
            : [];
        if (!ids.length) return;
        e.preventDefault();
        setQuickClassifyIds(ids);
        return;
      }
      if (e.key === 'Escape') {
        if (selected.size) setSelected(new Set());
        return;
      }
      if ((matchesBinding(e, keymap.delete) || e.key === 'Backspace') && selected.size) {
        e.preventDefault();
        void bulk('delete');
        return;
      }
      if (matchesBinding(e, keymap.selectAll) && (items.length || total)) {
        e.preventDefault();
        void selectAllMatching();
        return;
      }
      // 撤销最近一次覆盖写回的编辑（调色台 / 裁切台内部另有自己的撤销）
      if (matchesBinding(e, keymap.undo)) {
        e.preventDefault();
        void undoEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bulk, helpOpen, items, keymap, lb, openItem, palette, selectAllMatching, selected, showToast, total, undoEdit]);

  /** 视图模式 / 缩略图尺寸：写 localStorage，下次打开保持（Eagle 也记住缩略图大小） */
  const changeViewMode = useCallback((m: 'masonry' | 'grid' | 'list') => {
    setViewMode(m);
    localStorage.setItem('tuku:view-mode', m);
  }, []);
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

  /**
   * 标签面板（Eagle 式）：按 group 分组、parent 做父子层级。
   * 标签本体仍是逗号串，这里只负责展示与筛选，不额外维护倒排。
   */
  const tagTree = useMemo(() => {
    const names = new Set(tags.map((t) => t.tag));
    const childrenOf = new Map<string, TagNode[]>();
    const cmp = (a: TagNode, b: TagNode) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN');
    for (const t of tags) {
      const p = t.parent && names.has(t.parent) ? t.parent : '';
      if (!p) continue;
      const arr = childrenOf.get(p);
      if (arr) arr.push(t);
      else childrenOf.set(p, [t]);
    }
    for (const arr of childrenOf.values()) arr.sort(cmp);
    const groups = new Map<string, TagNode[]>();
    for (const t of tags) {
      // 子标签不单列，跟父标签一起出现
      if (t.parent && names.has(t.parent)) continue;
      const g = t.group || '未分组';
      const arr = groups.get(g);
      if (arr) arr.push(t);
      else groups.set(g, [t]);
    }
    return {
      groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN')),
      childrenOf,
    };
  }, [tags]);

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

  /** 侧栏文件夹树接收拖入的素材（拖拽归类，Eagle 式交互） */
  const dropImagesIntoFolder = useCallback(
    async (targetId: number, ids: number[]) => {
      if (!ids.length) return;
      try {
        const res = await api.addToFolder(targetId, ids);
        setFolders(res.folders);
        showToast(res.added ? `已归入文件夹（新增 ${res.added} 张）` : '这些素材已在该文件夹里');
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  /**
   * 手动刷新：先把素材文件夹里尚未登记的图片补登记，再按当前筛选重拉第 1 页。
   * 只重读列表的话，用户往目录里放的新图永远进不了图库（曾被当成 P0）。
   */
  const refreshGallery = useCallback(async () => {
    pageRef.current = 1;
    setRefreshSeq((n) => n + 1);
    setRefreshing(true);
    try {
      const scan = await api.scanFolder().catch(() => null);
      await load(1, true);
      refreshStats();
      const saved = Number(scan?.saved) || 0;
      const dropped = Number(scan?.dropped) || 0;
      showToast(
        saved
          ? `已导入 ${saved} 张新图片${dropped ? `（${dropped} 张未通过尺寸/体积筛选）` : ''}`
          : `已刷新（当前筛选 ${totalRef.current} 张）`
      );
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [load, refreshStats, showToast]);

  /* 截图入库统一走 ScreenshotOverlay（框选后由它上传并刷新），这里不再监听主进程直传事件 */

  /** 退出大图时：把图库列表补载到最后浏览的那张所在位置，并滚动过去 */
  const revealGalleryItem = useCallback(
    async (id: number, pool: ImageItem[]) => {
      const pos = pool.findIndex((x) => x.id === id);
      if (pos < 0) return;
      // 该图已在已加载列表里（浏览范围没超出第一屏加载量）→ 直接滚动
      if (document.querySelector(`[data-image-id="${id}"]`)) {
        setScrollTargetId(id);
        return;
      }
      // 只请求目标页（必要时再加相邻一页），不再从第 1 页串行拉到底：
      // 在第 400 页的图上点「在网格中显示」以前要发 400 个请求，界面全程无反馈。
      const page = Math.max(1, Math.floor(pos / PAGE_SIZE) + 1);
      setLoading(true);
      const req = ++reqId.current;
      revealAbort.current?.abort();
      const ac = new AbortController();
      revealAbort.current = ac;
      try {
        const filters = filtersRef.current;
        let landed = page;
        let res = await api.images(filters, landed, PAGE_SIZE, { signal: ac.signal });
        if (req !== reqId.current) return;
        // 期间有新增导致列表整体后移：目标可能落到下一页，补查一次
        if (!res.items.some((x) => x.id === id) && landed * PAGE_SIZE < res.total) {
          landed += 1;
          res = await api.images(filters, landed, PAGE_SIZE, { signal: ac.signal });
          if (req !== reqId.current) return;
        }
        setItems(res.items);
        setTotal(res.total);
        totalRef.current = res.total;
        setHasMore((landed - 1) * PAGE_SIZE + res.items.length < res.total);
        pageRef.current = landed;
        setRefreshSeq((n) => n + 1);
        setScrollTargetId(id);
      } catch (err) {
        // 主动 abort 不算错误，别弹「网络请求失败」吓用户
        if ((err as Error)?.name !== 'AbortError') showToast((err as Error).message);
      } finally {
        if (req === reqId.current) setLoading(false);
      }
    },
    [showToast]
  );

  // 补载完成后等卡片渲染出来，再滚动居中（节点尚未渲染时重试几帧）
  useEffect(() => {
    if (!scrollTargetId) return;
    let tries = 0;
    const tick = () => {
      const el = document.querySelector(`[data-image-id="${scrollTargetId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        setScrollTargetId(null);
        return;
      }
      if (++tries < 30) requestAnimationFrame(tick);
      else setScrollTargetId(null);
    };
    requestAnimationFrame(tick);
  }, [scrollTargetId]);

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
      showToast(
        res.relocated
          ? `已找回 ${res.relocated} 张图片的路径${res.remaining ? `，仍有 ${res.remaining} 张未找到` : ''}`
          : `没有找回任何图片（${res.remaining} 张仍未找到，可能已被删除）`
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
        onOpenRoot={() => {
          setFolderId(null);
          setView('gallery');
        }}
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
        onResetWidth={() => {
          setSidebarW(DEFAULT_SIDEBAR_W);
          localStorage.setItem('tuku:sidebar-w', String(DEFAULT_SIDEBAR_W));
        }}
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
                    : viewMode === 'list'
                      ? '列表浏览 · 按名称/类型/大小/时间快速整理'
                      : viewMode === 'grid'
                        ? '网格浏览 · 缩略图大小可拖动调整'
                        : '瀑布流浏览 · 悬停操作 · 点击进入大图预览'
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
              showFolderCards={view === 'gallery'}
              folders={folders}
              onOpenFolder={enterFolder}
              onDropImagesOnFolder={dropImagesOnFolderAt}
              onQuickClassify={() => {
                const ids = selected.size
                  ? [...selected]
                  : [hoverIdRef.current || items[0]?.id].filter((n): n is number => Number.isFinite(n as number));
                if (!ids.length) return showToast('先在网格里选中素材，或把鼠标停在某张卡片上');
                setQuickClassifyIds(ids);
              }}
            />
          )}

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

          {view === 'tutorial' && <Tutorial />}

          {view === 'settings' && (
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
          )}
          </ErrorBoundary>
        </div>

        <StatusBar
          crawling={crawling}
          stats={stats}
          importing={importing}
          isDesktop={isDesktop}
          onOpenFolder={() => openFolder()}
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

      {/* 新手教程：建库引导优先，教程等它关掉后再自动弹 */}
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
