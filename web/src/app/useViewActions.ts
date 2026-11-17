import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api } from '../api';
import { confirmDialog } from '../components/Dialogs';
import type { LightboxState } from '../hooks/useLightbox';
import { clampThumbWidth } from '../lib/thumb-size';
import type { Filters, FolderNode, ImageItem, SavedFilter, View, ViewMode } from '../types';
import type { LoadGallery, Toast } from './types';
import i18n from '../i18n';

type Options = {
  setView: Dispatch<SetStateAction<View>>;
  setFolderId: Dispatch<SetStateAction<number | null>>;
  setFilters: Dispatch<SetStateAction<Filters>>;
  setViewMode: Dispatch<SetStateAction<ViewMode>>;
  setColWidth: Dispatch<SetStateAction<number>>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  setFolders: Dispatch<SetStateAction<FolderNode[]>>;
  setActiveSavedId: Dispatch<SetStateAction<number | null>>;
  setLb: Dispatch<SetStateAction<LightboxState>>;
  items: ImageItem[];
  selected: Set<number>;
  effectiveFilters: Filters;
  missingCount: number;
  defaultFilters: Filters;
  pageRef: MutableRefObject<number>;
  load: LoadGallery;
  openItem: (item: ImageItem, pool?: ImageItem[], full?: boolean) => void;
  refreshGallery: () => Promise<void>;
  undoEdit: () => Promise<void>;
  showToast: Toast;
};

/**
 * 导航 / 筛选 / 批量这几类「纯回调」动作，没有 effect。
 *
 * showUnfiled 依赖 changeViewMode，所以两者放在同一个 hook 里，避免把
 * localStorage 的写入分散到两处。
 */
export function useViewActions({
  setView,
  setFolderId,
  setFilters,
  setViewMode,
  setColWidth,
  setSelected,
  setFolders,
  setActiveSavedId,
  setLb,
  items,
  selected,
  effectiveFilters,
  missingCount,
  defaultFilters,
  pageRef,
  load,
  openItem,
  refreshGallery,
  undoEdit,
  showToast,
}: Options) {
  /** 展示方式 / 缩略图尺寸：写 localStorage，下次打开保持（Eagle 也记住缩略图大小） */
  const changeViewMode = useCallback(
    (m: ViewMode) => {
      setViewMode(m);
      localStorage.setItem('tuku:view-mode', m);
    },
    [setViewMode]
  );

  const changeColWidth = useCallback(
    (w: number) => {
      const next = clampThumbWidth(w);
      setColWidth(next);
      localStorage.setItem('tuku:col-width', String(next));
    },
    [setColWidth]
  );

  const openSavedFilter = useCallback(
    (f: SavedFilter) => {
      const q = (f.query || {}) as Partial<Filters> & { folderId?: number | null };
      setFolderId(q.folderId ?? null);
      setFilters({ ...defaultFilters, ...q });
      setActiveSavedId(f.id);
      setView('gallery');
    },
    [defaultFilters, setActiveSavedId, setFilters, setFolderId, setView]
  );

  /** 回到全库（侧栏根节点与文件夹收纳视图面包屑共用） */
  const openRoot = useCallback(() => {
    setFolderId(null);
    setView('gallery');
  }, [setFolderId, setView]);

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
  }, [changeViewMode, setActiveSavedId, setFilters, setFolderId]);

  /** 「待整理」入口：进入图库并套用对应筛选 */
  const openPending = useCallback(
    (kind: 'noFolder' | 'noTags' | 'noRating') => {
      setFolderId(null);
      setFilters((prev) => ({ ...prev, pending: kind, tag: '' }));
      setView('gallery');
    },
    [setFilters, setFolderId, setView]
  );

  const openTag = useCallback(
    (tag: string) => {
      setFolderId(null);
      setFilters((prev) => ({ ...prev, tag, pending: '' }));
      setView('gallery');
    },
    [setFilters, setFolderId, setView]
  );

  /** 地点视图点了某一块：把 bbox 交给图库筛选（URL 里也带，分享出去打开就是那块地图） */
  const openPlace = useCallback(
    (bbox: string, label: string) => {
      setFolderId(null);
      setFilters((prev) => ({ ...prev, bbox, tag: '', pending: '' }));
      setView('gallery');
      showToast(i18n.t('k7f2191e7', { p0: label }));
    },
    [setFilters, setFolderId, setView, showToast]
  );

  /** 侧栏导航：点「图库」时清空文件夹筛选，回到全库视图 */
  const handleNav = useCallback(
    (v: View) => {
      setView(v);
      if (v === 'gallery') setFolderId(null);
    },
    [setFolderId, setView]
  );

  const onFiltersChange = useCallback(
    (patch: Partial<Filters>) => {
      // 手动改筛选就离开「保存的筛选」视图：否则侧栏那条还高亮着，看着像没生效
      setActiveSavedId(null);
      setFilters((prev) => ({ ...prev, ...patch }));
    },
    [setActiveSavedId, setFilters]
  );

  /* Gallery 已用 React.memo 包住：这些回调必须是稳定引用，
     否则每次 App 渲染都会生成新函数，memo 永远命中不了（勾一张图就重渲染整页）。 */
  const openFromGrid = useCallback((item: ImageItem) => openItem(item, items, true), [openItem, items]);

  const startCrawl = useCallback(() => setView('crawl'), [setView]);
  const undoFromGrid = useCallback(() => void undoEdit(), [undoEdit]);

  /** 把当前筛选结果整体标记为已看（整理「未看过」时用） */
  const markAllSeen = useCallback(async () => {
    try {
      const res = await api.markAllViewed(effectiveFilters);
      showToast(res.affected ? i18n.t('k93ea0939', { p0: res.affected }) : i18n.t('k6f54a9bd'));
      pageRef.current = 1;
      load(1, true);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [effectiveFilters, load, showToast, pageRef]);

  /** 文件丢失处理：先尝试按文件名在新路径找回，找不回可清理记录 */
  const relocateMissing = useCallback(async () => {
    try {
      const res = await api.relocateMissing();
      const unreadable = res.unreadable || 0;
      const unreadableNote = unreadable
        ? i18n.t('kb1a4bee2', { p0: unreadable })
        : '';
      showToast(
        res.relocated
          ? i18n.t('ka5b69513', { p0: res.relocated, p1: res.remaining ? i18n.t('k73acabcf', { p0: res.remaining }) : '', p2: unreadableNote })
          : i18n.t('k9e0d3a0f', { p0: res.remaining, p1: unreadableNote })
      );
    } catch (err) {
      showToast((err as Error).message);
    }
    refreshGallery();
  }, [refreshGallery, showToast]);

  const purgeMissing = useCallback(async () => {
    if (!(await confirmDialog(i18n.t('kb757ec32', { p0: missingCount })))) return;
    try {
      const res = await api.purgeMissing();
      showToast(i18n.t('kaa83c02c', { p0: res.removed }));
    } catch (err) {
      showToast((err as Error).message);
    }
    refreshGallery();
  }, [missingCount, refreshGallery, showToast]);

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
          if (!pl) throw new Error(i18n.t('kc69f1598'));
          pid = pl.id;
        }
        const res = await api.addToPlaylist(pid as number, ids);
        showToast(i18n.t('k5fcf1205', { p0: res.added }));
      } catch (err) {
        showToast((err as Error).message);
      }
      setSelected(new Set());
    },
    [selected, showToast, setSelected]
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
        showToast(i18n.t('kc37ccaa8', { p0: res.added }));
      } catch (err) {
        showToast((err as Error).message);
      }
      setSelected(new Set());
    },
    [selected, showToast, setFolders, setSelected]
  );

  return {
    changeViewMode,
    changeColWidth,
    openSavedFilter,
    openRoot,
    openFromFolderGroup,
    showUnfiled,
    openPending,
    openTag,
    openPlace,
    handleNav,
    onFiltersChange,
    openFromGrid,
    startCrawl,
    undoFromGrid,
    markAllSeen,
    relocateMissing,
    purgeMissing,
    addToPlaylist,
    addToFolder,
  };
}
