import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadFile, isDesktop, openFolder, quiet } from './api';
import { subscribeEvents } from './events';
import type { Filters, ImageItem, Stats, Library, FolderNode } from './types';
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
import DeleteReasonDialog, { reasonLabel } from './components/DeleteReasonDialog';
import DialogHost, { confirmDialog, promptDialog } from './components/Dialogs';
import Onboarding from './components/Onboarding';
import FolderTree from './components/FolderTree';
import LibrarySwitcher from './components/LibrarySwitcher';
import CreateLibraryDialog from './components/CreateLibraryDialog';
import {
  IconDashboard,
  IconFolder,
  IconGear,
  IconHeart,
  IconImages,
  IconBrain,
  IconMoon,
  IconSpider,
  IconSun,
  IconLayers,
  IconWand,
  IconSearch,
  IconGrid,
} from './components/Icons';
import { applyTheme, getStoredTheme, type Theme } from './theme';

type View =
  | 'dashboard'
  | 'gallery'
  | 'favorites'
  | 'tidy'
  | 'playlists'
  | 'crawl'
  | 'knowledge'
  | 'search'
  | 'smart'
  | 'enhance'
  | 'settings';

const PAGE_SIZE = 48;

const defaultFilters: Filters = {
  q: '',
  source: [],
  favorite: 'all',
  orientation: 'all',
  bucket: [],
  tag: '',
  sort: 'newest',
  seen: 'all',
  minRating: 0,
  hue: '',
  colorHex: '',
  colorTol: 48,
};

/** 侧栏内容导航（Eagle 式：只放高频浏览入口，文件夹树跟随其后） */
const NAV: { key: View; label: string; icon: React.ReactNode }[] = [
  { key: 'gallery', label: '图库', icon: <IconImages /> },
  { key: 'favorites', label: '收藏', icon: <IconHeart /> },
  { key: 'playlists', label: '清单', icon: <IconFolder /> },
  { key: 'crawl', label: '采集', icon: <IconSpider /> },
];

/** 顶栏工具菜单：低频功能收进右上角下拉，侧栏不再常驻 */
const TOOLS: { key: View; label: string; icon: React.ReactNode }[] = [
  { key: 'dashboard', label: '仪表盘', icon: <IconDashboard /> },
  { key: 'tidy', label: '整理', icon: <IconLayers /> },
  { key: 'search', label: '智能检索', icon: <IconSearch /> },
  { key: 'smart', label: '标签·智能夹', icon: <IconGrid /> },
  { key: 'enhance', label: '画质增强', icon: <IconWand /> },
  { key: 'knowledge', label: 'AI 知识库', icon: <IconBrain /> },
];

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [stats, setStats] = useState<Stats | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<'masonry' | 'grid'>('masonry');
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [lb, setLb] = useState<{ items: ImageItem[]; index: number } | null>(null);
  const [toast, setToast] = useState('');
  const [importing, setImporting] = useState(false);
  // 导入进度（图库空态/顶部提示用）：progress 0-100，saved 为已入库张数，message 为任务名
  const [importProgress, setImportProgress] = useState<{
    progress: number;
    saved: number;
    total?: number;
    unchanged?: number;
    message?: string;
  } | null>(null);
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
  // 多资源库 + 文件夹树
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [activeLibId, setActiveLibId] = useState<number | null>(null);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [folderId, setFolderId] = useState<number | null>(null);
  const folderIdRef = useRef<number | null>(null);
  const [showCreateLib, setShowCreateLib] = useState(false);
  // 顶栏「工具箱」下拉开关（点击菜单外自动收起）
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement | null>(null);
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
      })
      .catch(() => setOnboarding(true)); // 读不到就当已完成，不拦用户
    // 仅在启动时同步一次服务端设置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === 'dark' ? 'light' : 'dark';
      api.saveSettings({ theme: next }).catch(quiet);
      return next;
    });
  }, []);

  const pageRef = useRef(1);
  const reqId = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const filtersRef = useRef<Filters>(filters);

  const effectiveFilters = useMemo<Filters>(
    () => (view === 'favorites' ? { ...filters, favorite: 'yes' } : filters),
    [view, filters]
  );
  filtersRef.current = effectiveFilters;
  folderIdRef.current = folderId;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    // 较长的是可操作报错（如「文件被占用，请关闭看图软件」），给足阅读时间
    const duration = msg.length > 40 ? 9000 : 2600;
    window.setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), duration);
  }, []);

  // importing 状态同步到 ref（job 事件 / importStatus 等多处 setImporting 都会覆盖）
  useEffect(() => {
    importingRef.current = importing;
  }, [importing]);

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
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      setTotal(res.total);
      totalRef.current = res.total;
      setHasMore(res.hasMore);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // 被新请求取代，不算错误
      showToast((err as Error).message);
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
  const refreshStats = useCallback(() => {
    api.stats().then((s) => {
      setStats(s);
      const prev = libTotalRef.current;
      libTotalRef.current = s.total;
      if (prev >= 0 && s.total > prev) {
        pageRef.current = 1;
        load(1, true);
      }
      // 导入进行中：新入库图片必然出现在默认「最新采集」列表里，
      // 让筛选栏「共 X 张」随导入实时跳动，而不是等下一次 load 才更新
      if (importingRef.current) setTotal((cur) => Math.max(cur, s.total));
    }).catch(quiet);
    api.tags().then(setTags).catch(quiet);
    api.missingFiles().then((m) => setMissingCount(m.count)).catch(quiet);
  }, [load]);

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
  }, [refreshStats, load]);

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
      showToast('已创建并切换到新资源库');
    },
    [load, refreshStats, followImport, resetLibBaseline, showToast]
  );

  // 进入某个文件夹（含后代聚合视图）
  const enterFolder = useCallback((id: number) => {
    setView('gallery');
    setFolderId(id);
  }, []);

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

  // 文件夹视图切换（folderId 变化）同样要触发列表重载
  const queryKey = JSON.stringify(effectiveFilters) + `|folder:${folderId ?? ''}`;

  useEffect(() => {
    pageRef.current = 1;
    // 重置数据源（筛选 / 文件夹 / 收藏切换）时滚回顶部，避免虚拟窗口错位
    contentRef.current?.scrollTo({ top: 0 });
    load(1, true);
  }, [queryKey, load]);

  const loadMore = useCallback(() => {
    const next = pageRef.current + 1;
    pageRef.current = next;
    load(next, false);
  }, [load]);

  useEffect(() => {
    refreshStats(); // 首次调用即建立 libTotalRef 基线
    // 服务端写操作会推 library 事件；这里防抖刷新统计。
    // 60s 低频兜底覆盖推送遗漏（如多标签页）场景。
    const timer = setInterval(refreshStats, 60000);
    let pending = 0;
    const off = subscribeEvents('library', () => {
      pending++;
      window.setTimeout(() => {
        if (--pending <= 0) {
          pending = 0;
          refreshStats(); // 内含库增长对账：变大则自动重载列表
        }
      }, 400);
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [refreshStats]);

  useEffect(() => {
    // 导入状态改为订阅 job 事件（原 3s 轮询）；导入进行中顺带刷新统计
    const off = subscribeEvents('job', (d) => {
      const imp = d?.import;
      if (!imp) return;
      setImporting(!!imp.running);
      if (imp.running) {
        setImportProgress({
          progress: Number(imp.progress) || 0,
          saved: Number(imp.result?.saved) || 0,
          total: Number(imp.result?.total) || 0,
          unchanged: Number(imp.result?.unchanged) || 0,
          message: imp.message || '',
        });
        refreshStats();
      } else {
        setImportProgress(null);
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
  }, [refreshStats, followImport, showToast]);

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
      api.tags().then(setTags).catch(quiet);
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
    async (item: ImageItem) => {
      try {
        const res = await api.wallpaper(item.id);
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

  const openItem = useCallback((item: ImageItem, pool?: ImageItem[], full = false) => {
    const list = pool && pool.some((x) => x.id === item.id) ? pool : [item];
    const index = list.findIndex((x) => x.id === item.id);
    setLb({ items: list, index: Math.max(0, index) });
    // 图库打开时，后台把当前筛选的全量列表补进导航池：
    // 平时只加载第一页（48 张），大图浏览若只在这页里导航，数量和范围都会误导
    if (full && pool) {
      (async () => {
        const first = await api.images(filtersRef.current, 1, 120);
        const all = [...first.items];
        for (let p = 2; all.length < first.total && p <= Math.ceil(first.total / 120); p++) {
          const res = await api.images(filtersRef.current, p, 120);
          all.push(...res.items);
        }
        if (all.length <= list.length) return; // 本来就是全量，无需替换
        setLb((prev) => {
          if (!prev) return prev; // 用户已关闭
          const curId = prev.items[prev.index]?.id;
          const nextIndex = Math.max(0, all.findIndex((x) => x.id === curId));
          return { items: all, index: nextIndex };
        });
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
    setFilters((prev) => ({ ...prev, ...patch }));
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
        const { item: updated } = await api.enhanceImage(item.id, enhanceModel || 'sharp-standard');
        patchItem(updated);
        showToast(`已增强至 ${updated.width}×${updated.height}`);
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
      const pages = Math.floor(pos / PAGE_SIZE) + 1;
      setLoading(true);
      const req = ++reqId.current;
      try {
        const all: ImageItem[] = [];
        let lastTotal = 0;
        for (let p = 1; p <= pages; p++) {
          const res = await api.images(filtersRef.current, p, PAGE_SIZE);
          if (req !== reqId.current) return; // 期间用户触发了其他加载，放弃
          all.push(...res.items);
          lastTotal = res.total;
          if (all.length >= res.total) break;
        }
        setItems(all);
        setTotal(lastTotal);
        totalRef.current = lastTotal;
        setHasMore(all.length < lastTotal);
        pageRef.current = pages;
        setRefreshSeq((n) => n + 1);
        setScrollTargetId(id);
      } catch (err) {
        showToast((err as Error).message);
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
  const activeLibName = libraries.find((l) => l.id === activeLibId)?.name || '默认图库';
  // 当前视图若属于工具菜单项，则顶栏「工具箱」按钮保持高亮
  const toolsActive = TOOLS.some((t) => t.key === view);

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
      <header className="topbar">
        <div className="topbar-brand">
          <div className="logo-mark">图</div>
          <div className="topbar-title">
            <b>图库</b>
            <span>{activeLibName}</span>
          </div>
        </div>
        <div className="topbar-actions" ref={toolsRef}>
          <div className="tools-wrap">
            <button
              className={`btn ghost sm tools-btn${toolsActive ? ' tools-btn-active' : ''}`}
              onClick={() => setToolsOpen((o) => !o)}
              title="整理与分析工具"
            >
              <IconWand />
              <span>工具箱</span>
              <span className="tools-chev">▾</span>
            </button>
            {toolsOpen && (
              <div className="tools-menu">
                {TOOLS.map((t) => (
                  <button
                    key={t.key}
                    className={`tools-item${view === t.key ? ' active' : ''}`}
                    onClick={() => {
                      setView(t.key);
                      setToolsOpen(false);
                    }}
                  >
                    {t.icon}
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={`icon-btn${view === 'settings' ? ' icon-btn-active' : ''}`}
            onClick={() => setView('settings')}
            title="设置"
          >
            <IconGear />
          </button>
          <button
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到明亮模式' : '切换到暗色模式'}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

      <div className="app-body">
      <aside className="sidebar">
        <div className="side-section-title">资源库</div>
        <LibrarySwitcher
          libraries={libraries}
          activeLibId={activeLibId}
          onSwitch={switchLibrary}
          onDelete={deleteLibraryAt}
          onCreate={() => setShowCreateLib(true)}
          onOpenInExplorer={(lib) => openFolder(lib.path).catch(quiet)}
        />
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item${view === n.key ? ' active' : ''}`}
            onClick={() => {
              setView(n.key);
              if (n.key === 'gallery') setFolderId(null); // 点「图库」回到全库视图
            }}
          >
            {n.icon}
            <span>{n.label}</span>
            {n.key === 'gallery' && stats?.total ? <span className="badge">{stats.total}</span> : null}
            {n.key === 'favorites' && stats?.favorite ? (
              <span className="badge">{stats.favorite}</span>
            ) : null}
          </button>
        ))}
        <div className="folders-panel">
          <FolderTree
            folders={folders}
            activeId={folderId}
            rootName={libraries.find((l) => l.id === activeLibId)?.name ?? '全部'}
            rootPath={libraries.find((l) => l.id === activeLibId)?.root_path ?? ''}
            rootActive={!folderId && view === 'gallery'}
            onOpenRoot={() => {
              setFolderId(null);
              setView('gallery');
            }}
            onOpen={enterFolder}
            onCreate={createFolderAt}
            onRename={renameFolderAt}
            onDelete={deleteFolderAt}
          />
        </div>
      </aside>

      <main className="main">
        <div className="content" ref={contentRef}>
          {view === 'dashboard' && (
            <Dashboard
              stats={stats}
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
              onClearSelection={() => setSelected(new Set())}
              onBulk={bulk}
              onOpen={(item) => openItem(item, items, true)}
              onToggleFavorite={toggleFavorite}
              onDownload={download}
              viewMode={viewMode}
              onViewMode={setViewMode}
              tags={tags}
              hideFavorite={view === 'favorites'}
              onStartCrawl={() => setView('crawl')}
              onRefresh={refreshGallery}
              importing={importing}
              importProgress={importProgress}
              missingCount={missingCount}
              refreshSeq={refreshSeq}
              refreshing={refreshing}
              onRelocateMissing={relocateMissing}
              onPurgeMissing={purgeMissing}
              onAddToPlaylist={addToPlaylist}
              onAddToFolder={addToFolder}
              onMarkAllSeen={markAllSeen}
            />
          )}

          {view === 'tidy' && (
            <Tidy
              onToast={showToast}
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

          {view === 'smart' && <Smart onToast={showToast} onOpenItem={openItem} />}

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

          {view === 'settings' && (
            <SettingsPage
              onToast={showToast}
              onLibraryChanged={() => {
                pageRef.current = 1;
                load(1, true);
                refreshStats();
                followImport();
              }}
            />
          )}
        </div>

        <footer className="statusbar">
          <span>
            <i className={`dot${crawling ? ' busy' : ''}`} />
            {crawling ? '采集进行中' : '空闲'}
          </span>
          <span>总图片 {stats?.total ?? 0}</span>
          <span>收藏 {stats?.favorite ?? 0}</span>
          {importing && <span>本地素材导入中…</span>}
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => openFolder()}>
            打开保存文件夹
          </button>
          {!isDesktop && <span>网页模式 http://localhost:3001</span>}
        </footer>
      </main>
      </div>{/* /.app-body */}

      {lb && (
        <Lightbox
          items={lb.items}
          index={lb.index}
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
          onDownload={download}
          onPatch={async (target, patch) => {
            try {
              patchItem(await api.patch(target.id, patch));
            } catch (err) {
              showToast((err as Error).message);
            }
          }}
          onOpenSimilar={(pool, id) => setLb({ items: pool, index: Math.max(0, pool.findIndex((x) => x.id === id)) })}
          onChangeToast={(msg) => {
            showToast(msg);
            refreshStats();
            pageRef.current = 1;
            load(1, true);
          }}
          onFindColor={(hue) => {
            onFiltersChange({ hue: String(hue) });
            setLb(null);
            setView('gallery');
          }}
          onReplaceItem={(updated) => {
            setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
            setLb((prev) =>
              prev
                ? {
                    ...prev,
                    items: prev.items.map((it) => (it.id === updated.id ? updated : it)),
                  }
                : prev
            );
          }}
        />
      )}

      {pendingDelete && (
        <DeleteReasonDialog
          item={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          onToast={showToast}
        />
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* 应用内 prompt/confirm 对话框（替代原生弹窗，全局唯一挂载点） */}
      <DialogHost />

      {showCreateLib && (
        <CreateLibraryDialog
          onCancel={() => setShowCreateLib(false)}
          onDone={onLibraryCreated}
          onToast={showToast}
        />
      )}

      {onboarding === false && (
        <Onboarding
          onDone={() => {
            setOnboarding(true);
            setView('gallery');
            pageRef.current = 1;
            load(1, true);
            refreshStats();
            followImport();
          }}
        />
      )}
    </div>
  );
}
