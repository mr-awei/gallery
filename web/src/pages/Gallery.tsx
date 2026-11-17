import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, downloadFile, exportZipUrl, formatSize, openFolder, quiet } from '../api';
import type { Filters, ImageItem, FolderNode, Playlist, ViewMode } from '../types';
import FilterBar from '../components/FilterBar';
import ImageCard from '../components/ImageCard';
import { promptDialog } from '../components/Dialogs';
import type { CropItem } from '../components/BatchCropStudio';
import MasonryGrid from '../components/MasonryGrid';
import ActionsPanel from '../components/ActionsPanel';
import { IconDownload, IconFolder, IconHeart, IconTrash } from '../components/Icons';
import { IconWarning, IconImages, IconGear, IconRotateCcw, IconGlobe, IconFolderOpen, IconClose, IconPencil, IconCheck, IconStar, IconRefresh } from '../components/Icons';
import Select from '../components/Select';
import ToolbarCustomizer from '../components/ToolbarCustomizer';
import { usePinnedActions } from '../lib/pinned';
import { IMAGE_MIME, TAG_MIME } from '../lib/dnd';
import i18n from '../i18n';

/**
 * 低频重浮层全部按需加载：它们只在用户点了「批量裁切 / 调色 / 水印 / 拼图 / 对比 / 导出」
 * 之后才出现，没必要压在首屏包里。装到裸静态 import 时，这 8 个组件
 * （画布、模板渲染、表格、对比台）合计把首包撑大两三百 KB，而首屏根本用不到。
 */
const BatchCropStudio = React.lazy(() => import('../components/BatchCropStudio'));
const BulkEditDialog = React.lazy(() => import('../components/BulkEditDialog'));
const ExportDialog = React.lazy(() => import('../components/ExportDialog'));
const RenameBatchDialog = React.lazy(() => import('../components/RenameBatchDialog'));
const BulkMetadataDialog = React.lazy(() => import('../components/BulkMetadataDialog'));
const StitchDialog = React.lazy(() => import('../components/StitchDialog'));
const CompareView = React.lazy(() => import('../components/CompareView'));
const WatermarkStudio = React.lazy(() => import('../components/WatermarkStudio'));
// 「按文件夹收纳」是另一种视图，只在切过去时才有用；文件夹预览与拖放逻辑不压首屏
const FolderGroupView = React.lazy(() => import('../components/FolderGroupView'));

interface Props {
  title: string;
  subtitle: string;
  filters: Filters;
  onFiltersChange: (patch: Partial<Filters>) => void;
  items: ImageItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  selected: Set<number>;
  onToggleSelect: (id: number) => void;
  onClearSelection: () => void;
  /** 全选「当前筛选下的全部图片」（不止已加载的一页） */
  onSelectAll?: () => void;
  onBulk: (action: string, tag?: string) => void;
  onOpen: (item: ImageItem) => void;
  onToggleFavorite: (item: ImageItem) => void;
  onDownload: (item: ImageItem) => void;
  /** 右键菜单：旋转 / 编辑标签后更新该卡片数据 */
  onUpdateItem?: (item: ImageItem) => void;
  /** 右键菜单：移入回收站后从列表移除 */
  onDeleteItem?: (item: ImageItem) => void;
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  /** 缩略图尺寸滑块（列宽 px） */
  colWidth?: number;
  onColWidth?: (w: number) => void;
  /** 各图片的标注数量（Eagle 式角标） */
  annotationCounts?: Record<string, number>;
  /** 完全重复（MD5）分组张数：imageId → 同组总数 */
  dupeCounts?: Record<string, number>;
  tags: { tag: string; count: number }[];
  hideFavorite?: boolean;
  onStartCrawl: () => void;
  onRefresh: () => void;
  /** 撤销最近一次覆盖写回（裁切/旋转/调色/增强） */
  onUndo?: () => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
  importing?: boolean;
  /** 导入进度：progress 0-100，saved 为已入库张数，message 为服务端任务名（边导边显示时用） */
  importProgress?: {
    progress: number;
    saved: number;
    total?: number;
    unchanged?: number;
    message?: string;
    /** 入库速度（张/秒）与预计剩余秒数：首次导入要跑几分钟，用户需要知道「还要等多久」 */
    speed?: number;
    etaSec?: number | null;
  } | null;
  missingCount?: number;
  /** 手动刷新序号：变化时清除图片卡片加载失败的残留状态（不再重挂载整页卡片） */
  refreshSeq?: number;
  /** 刷新进行中：按钮转圈并禁用 */
  refreshing?: boolean;
  onRelocateMissing?: () => void;
  onPurgeMissing?: () => void;
  onAddToPlaylist?: (playlistId: number | string) => void;
  onAddToFolder?: (folderId: number | string) => void;
  /** 当前所在文件夹（非空时多选工具栏提供「移出文件夹」） */
  folderId?: number | null;
  /** 把当前筛选结果整体标记为已看 */
  onMarkAllSeen?: () => void;
  /** 手动排序模式：拖到某张卡片上 = 插到它后面（仅文件夹视图 + sort=manual） */
  manualSort?: boolean;
  onReorder?: (dragIds: number[], targetId: number) => void;
  /** 侧栏标签拖到卡片上 = 给这张素材追加标签 */
  onDropTag?: (item: ImageItem, tag: string) => void;
  /** 打开堆叠查看器（参数是组主 id） */
  onOpenStack?: (stackId: number) => void;
  /** 解散某个堆叠 */
  onUngroupStack?: (stackId: number) => void;
  /** 批量条「堆叠」：把选中的素材合成一摞 */
  onStackSelected?: () => void;
  /** 批量条「快速分类」/ F 键：放进文件夹 + 追加标签 */
  onQuickClassify?: () => void;
  /** 把拖来的图叠到某张上（目标是组主则并入该组，否则两张成组） */
  onStackDrop?: (dragIds: number[], target: ImageItem) => void;
  /** 文件夹收纳视图需要的当前层级文件夹树 */
  folders?: FolderNode[];
  onOpenFolder?: (id: number) => void;
  onDropImagesOnFolder?: (folderId: number, ids: number[]) => void;
  /** 文件夹收纳视图：回到全库 / 当前库名 / 灯箱池 / 未归档 */
  onOpenRoot?: () => void;
  rootName?: string;
  onOpenImageFromFolder?: (item: ImageItem, pool: ImageItem[]) => void;
  unfiledCount?: number;
  onShowUnfiled?: () => void;
}

/** 页头右侧的展示方式徽标，切换视图时一眼知道自己在哪种模式 */
const VIEW_LABELS: Record<ViewMode, string> = {
  masonry: i18n.t('k708adf1f'),
  grid: i18n.t('k49fdd7f5'),
  list: i18n.t('k06431707'),
  folder: i18n.t('k2378404c'),
};

/** 「重置筛选」的完整目标态：新增筛选字段必须同步，否则重置后条件仍残留 */
const RESET_FILTERS: Partial<Filters> = {
  favorite: 'all',
  q: '',
  source: [],
  bucket: [],
  tag: '',
  seen: 'all',
  orientation: 'all',
  minRating: 0,
  hue: '',
  colorHex: '',
  colorTol: 48,
  kind: 'all',
  pending: '',
};

/** 批量条默认露出的动作（其余收在「更多」里，用户可在面板里自由调整） */
const BULK_PINNED_DEFAULT = ['download', 'export', 'stitch', 'favorite', 'delete'];

/** 批量条上的一个可选动作；pinned 里命中 key 的露在条上，其余进「更多」菜单 */
type BulkAct = {
  key: string;
  label: string;
  /** 悬停提示 */
  title: string;
  /** 「更多」菜单里的小字说明 */
  hint?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  /** 只在特定选择状态下可用（如「对比」要求正好 2 张） */
  show?: boolean;
  run: () => void;
};

/* 列表视图的固定行高（与 grid.css 的 .list-row / .list-head 保持一致） */
const LIST_ROW_H = 58;
const LIST_HEAD_H = 36;
const LIST_OVERSCAN = 10;

/* 入库扩展名 / 上传逻辑统一放在 lib/importer，图库与全局入口共用一份 */

function fmtBytes(n: number) {
  if (!n) return '—';
  return formatSize(n);
}

/**
 * 剩余时间文案。首次导入动辄几分钟，只看到一个百分比用户没法判断还要不要等；
 * 这里刻意按「秒 / 分 / 小时」粗粒度输出 —— 导入速度本来就是估的，给到秒反而假精确。
 */
function fmtEta(sec: number) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return i18n.t('k3b7d403f', { p0: s });
  const m = Math.round(s / 60);
  if (m < 60) return i18n.t('k32307592', { p0: m });
  return i18n.t('k31bfb30b', { p0: Math.floor(m / 60), p1: m % 60 });
}

/** 导入横幅的摘要括号：只列有值的项，避免 0 张时出现空括号 */
function importSummary(p: {
  saved?: number;
  speed?: number;
  etaSec?: number | null;
  total?: number;
  unchanged?: number;
} | null | undefined) {
  if (!p) return '';
  const bits: string[] = [];
  if (p.saved) bits.push(i18n.t('ked42985b', { p0: p.saved }));
  if (p.speed) bits.push(i18n.t('k5d29efef', { p0: p.speed }));
  if (p.etaSec != null && p.etaSec > 0) bits.push(fmtEta(p.etaSec));
  if (p.total) bits.push(i18n.t('k725e1cf3', { p0: p.total }));
  if (p.unchanged) bits.push(i18n.t('k535c35b2', { p0: p.unchanged }));
  return bits.length ? `（${bits.join(' · ')}）` : '';
}

const KIND_TEXT: Record<string, string> = {
  image: i18n.t('k20def794'),
  gif: 'GIF',
  video: i18n.t('k7fcf42ed'),
  audio: i18n.t('k726dd5df'),
  font: i18n.t('k8456bc40'),
  pdf: 'PDF',
  office: 'Office',
  model: '3D',
  other: i18n.t('k2a0c4740'),
};

// React.memo：App 里的 toast / 弹窗开关 / 统计数字变化时，
// 只要传给本页的 props 不变就不该重渲染整页（勾一张图只应重渲染那张卡片）。
// 前提见 App.tsx：所有回调 props 都必须是 useCallback/useMemo 稳定引用。
function Gallery(props: Props) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  /**
   * 可见区预览预热：把屏幕上这几张的预览图挪到服务端预取队首。
   * 列表是整页顺序预取，用户滚到页尾点开时那张往往还没轮到 —— 那 1~2 秒模糊
   * 就是这么来的。滚动停顿后上报一次，看哪儿哪儿就绪。
   */
  const warmVisible = useCallback((ids: number[]) => {
    if (!ids.length) return;
    api.warmPreviews(ids).catch(quiet);
  }, []);
  const [missingDismissed, setMissingDismissed] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [showPlaylistPick, setShowPlaylistPick] = useState(false);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [showFolderPick, setShowFolderPick] = useState(false);
  const [bulkEdit, setBulkEdit] = useState<null | 'crop' | 'color'>(null);
  const [renaming, setRenaming] = useState(false);
  /* 批量元数据（评分 / 标签 / 收藏 / 备注一次改完） */
  const [metadataOpen, setMetadataOpen] = useState(false);
  /* 批量导出（Eagle 的导出面板：格式 / 质量 / 最长边，可原样打包） */
  const [exportIds, setExportIds] = useState<number[] | null>(null);
  /* 拼接 / 对比 / 动作：都只对「当前页里选中的那几张」操作 */
  const [stitchOpen, setStitchOpen] = useState(false);
  const [cmpIds, setCmpIds] = useState<[number, number] | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** 批量条的「更多」：低频批量操作收进菜单，别把 15 个按钮挤成一条 */
  const [bulkMore, setBulkMore] = useState(false);
  /* 拖拽入库统一交给 App 层的 GlobalImport（屏幕中央圆形靶盘），本页不再整页接管 */
  /** 页面级右键菜单：原顶部工具栏的撤销 / 刷新 / 清理缺失 / 去采集 / 重置筛选 */
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number } | null>(null);
  const pageMenuRef = useRef<HTMLDivElement | null>(null);

  // 页面右键菜单：点击/滚动/缩放/Esc 关闭；渲染后按实际尺寸把菜单收进视口
  useEffect(() => {
    if (!pageMenu) return;
    const close = () => setPageMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPageMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [pageMenu]);
  useLayoutEffect(() => {
    const el = pageMenuRef.current;
    if (!pageMenu || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(pageMenu.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(pageMenu.y, window.innerHeight - r.height - 4))}px`;
  }, [pageMenu]);
  const {
    items,
    hasMore,
    loading,
    onLoadMore,
    selected,
    onClearSelection,
    onBulk,
    viewMode,
    tags,
    total,
  } = props;

  // 多选操作栏出现时拉「清单 + 文件夹树」，供两个「加入…」下拉使用。
  // 以前是两个各自依赖 [selected.size] 的 effect：每勾一张打 2 个接口，
  // 连选 20 张就是 40 个请求，而且后返回的旧响应还会盖掉新状态。
  // 合成一个 effect + 300ms 去抖后，同一串勾选只发最后一轮。
  useEffect(() => {
    if (selected.size === 0) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .playlists()
        .then((list) => {
          if (alive) setPlaylists(list);
        })
        .catch(quiet);
      api
        .folders()
        .then((r) => {
          if (alive) setFolders(r.folders);
        })
        .catch(quiet);
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [selected.size]);

  // 取消全选后菜单别留着，下次多选时也不该自动弹开
  const nothingSelected = selected.size === 0;
  useEffect(() => {
    if (nothingSelected) setBulkMore(false);
  }, [nothingSelected]);

  // 文件夹树按层级排序 + 深度映射（用于「加入文件夹」下拉缩进显示）
  const { sortedFolders, folderDepth } = useMemo(() => {
    const byParent = new Map<number | null, FolderNode[]>();
    for (const f of folders) {
      const k = f.parent_id ?? null;
      const arr = byParent.get(k);
      if (arr) arr.push(f);
      else byParent.set(k, [f]);
    }
    const depth = new Map<number, number>();
    const sorted: FolderNode[] = [];
    const walk = (pid: number | null, d: number) => {
      const kids = (byParent.get(pid) || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      for (const f of kids) {
        depth.set(f.id, d);
        sorted.push(f);
        walk(f.id, d + 1);
      }
    };
    walk(null, 0);
    return { sortedFolders: sorted, folderDepth: depth };
  }, [folders]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) onLoadMore();
      },
      { rootMargin: '600px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, onLoadMore, viewMode]);

  /* 列表视图窗口化：.list-row 行高固定 58px（grid.css），可以按固定行高切片渲染，
     上万张时只建视口附近几十个 DOM 节点，而不是一次性几万个。 */
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listWin, setListWin] = useState({ start: 0, end: 60 });
  /** 侧栏标签拖到列表行上时的落点高亮（网格视图由卡片自己管） */
  const [tagOverId, setTagOverId] = useState<number | null>(null);
  /** 拖图到列表行上 = 叠成一堆的落点高亮 */
  const [stackOverId, setStackOverId] = useState<number | null>(null);

  useEffect(() => {
    if (props.viewMode !== 'list') return;
    const el = listRef.current;
    if (!el) return;
    // 滚动容器：向上找第一个可滚祖先（App 的 contentRef 区域）
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      scroller = scroller.parentElement;
    }
    let raf = 0;
    const recompute = () => {
      const rows = props.items.length;
      if (!rows) {
        setListWin({ start: 0, end: 0 });
        return;
      }
      // 纯视口坐标计算，不依赖滚动容器内部偏移，window 滚动也适用
      const listTop = el.getBoundingClientRect().top + LIST_HEAD_H;
      const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const viewH = scroller ? scroller.clientHeight : window.innerHeight;
      const passed = viewTop - listTop; // >0：列表顶部已经滚出视口
      const start = Math.max(0, Math.floor(passed / LIST_ROW_H) - LIST_OVERSCAN);
      const count = Math.ceil(viewH / LIST_ROW_H) + LIST_OVERSCAN * 2 + 2;
      setListWin({ start, end: Math.min(rows, start + count) });
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    recompute();
    // 用 document 捕获所有滚动：绑定目标不再取决于「这一刻能不能探测到滚动容器」——
    // 灯箱打开时 .content 被改成 overflow:hidden，探测会失败，绑到 window 就再也收不到
    // 列表容器的滚动事件（列表滑不动/白屏）
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [props.viewMode, props.items.length]);



  // 选中集合不变时保持同一数组引用：每次渲染新建数组会让 ImageCard 的 memo 全部失效
  const dragIds = useMemo(() => (selected.size > 1 ? Array.from(selected) : null), [selected]);
  const listStart = Math.max(0, Math.min(listWin.start, Math.max(0, items.length - 1)));
  const listSlice = items.slice(listStart, Math.max(listStart, listWin.end));

  // 列表视图同样做可见区预热：列表一屏能看 30+ 张，点开前先让这几张的预览就绪
  const listIdsSig = props.viewMode === 'list' ? listSlice.map((it) => it.id).join(',') : '';
  useEffect(() => {
    if (!listIdsSig) return;
    const ids = listIdsSig.split(',').map(Number);
    const t = window.setTimeout(() => warmVisible(ids), 700);
    return () => window.clearTimeout(t);
  }, [listIdsSig, warmVisible]);

  const downloadZip = () => {
    // 走 api 里的唯一实现：硬拼 URL 会绕过令牌与参数编码
    if (selected.size) downloadFile(exportZipUrl([...selected]));
  };

  /** 把选中的图从当前文件夹移出（只解除归类，不删文件） */
  const removeFromCurrentFolder = async () => {
    const fid = props.folderId;
    if (!fid || !selected.size || removing) return;
    setRemoving(true);
    try {
      const r = await api.removeFromFolder(fid, [...selected]);
      props.onToast?.(i18n.t('kd72101e8', { p0: r.removed }));
      onClearSelection();
      props.onRefresh();
    } catch (err) {
      props.onToast?.(i18n.t('k33d2d003', { p0: (err as Error).message }));
    } finally {
      setRemoving(false);
    }
  };

  /* Ctrl+V 与拖拽入库都交给 App 层的 GlobalImport 统一处理，本页只负责展示 */
  const [bulkPinned, setBulkPinned] = usePinnedActions('bulk', BULK_PINNED_DEFAULT);
  const [tczOpen, setTczOpen] = useState(false);
  const [watermarkIds, setWatermarkIds] = useState<number[]>([]);

  const bulkActs: BulkAct[] = [
    {
      key: 'download',
      label: i18n.t('ka2247c1d'),
      title: i18n.t('k78241579'),
      hint: i18n.t('k18612ab9'),
      icon: <IconDownload />,
      run: downloadZip,
    },
    {
      key: 'export',
      label: i18n.t('k65e7b9a1'),
      title: i18n.t('k52d69151'),
      hint: i18n.t('k07497db2'),
      run: () => setExportIds([...selected]),
    },
    {
      key: 'stitch',
      label: i18n.t('k3715e24a'),
      title: i18n.t('k609c5800'),
      hint: i18n.t('ke761fb84'),
      run: () => setStitchOpen(true),
    },
    {
      key: 'watermark',
      label: i18n.t('ka450c5a3'),
      title: i18n.t('kd42baad8'),
      hint: i18n.t('k70084bc9'),
      run: () => setWatermarkIds([...selected]),
    },
    {
      key: 'favorite',
      label: i18n.t('kae336cd0'),
      title: i18n.t('k7911dca2'),
      hint: i18n.t('k467c6da6'),
      icon: <IconHeart filled />,
      run: () => onBulk('favorite'),
    },
    {
      key: 'unfavorite',
      label: i18n.t('kf22cec28'),
      title: i18n.t('kd7526f12'),
      hint: i18n.t('k2fe06f0b'),
      run: () => onBulk('unfavorite'),
    },
    {
      key: 'compare',
      label: i18n.t('kf5deaa17'),
      title: i18n.t('k05e9c39b'),
      hint: i18n.t('k176dc9c6'),
      show: selected.size === 2,
      run: () => {
        const two = [...selected];
        setCmpIds([two[0], two[1]]);
      },
    },
    {
      key: 'classify',
      label: i18n.t('k58424ff2'),
      title: i18n.t('k396c26cf'),
      hint: i18n.t('keb9cbf23'),
      show: !!props.onQuickClassify,
      run: () => props.onQuickClassify?.(),
    },
    {
      key: 'stack',
      label: i18n.t('ka54cf19d'),
      title: i18n.t('k18d80896'),
      hint: i18n.t('k8df1fd98'),
      show: selected.size > 1 && !!props.onStackSelected,
      run: () => props.onStackSelected?.(),
    },
    {
      key: 'actions',
      label: i18n.t('k42943762'),
      title: i18n.t('k92914153'),
      hint: i18n.t('k92914153'),
      run: () => setActionsOpen(true),
    },
    {
      key: 'crop',
      label: i18n.t('kcef1e2f6'),
      title: i18n.t('ka8ed587c'),
      hint: i18n.t('ka8ed587c'),
      run: () => setBulkEdit('crop'),
    },
    {
      key: 'color',
      label: i18n.t('kf45f5296'),
      title: i18n.t('k3f9da7b6'),
      hint: i18n.t('k3f9da7b6'),
      run: () => setBulkEdit('color'),
    },
    {
      key: 'metadata',
      label: i18n.t('kacd77a4d'),
      title: i18n.t('k68eeb004'),
      hint: i18n.t('k13928012'),
      run: () => setMetadataOpen(true),
    },
    {
      key: 'rename',
      label: i18n.t('kda4ff5bf'),
      title: i18n.t('k2db0bdba'),
      hint: i18n.t('k2db0bdba'),
      run: () => setRenaming(true),
    },
    {
      key: 'ocr',
      label: i18n.t('k10efba63'),
      title: i18n.t('k8f50adf9'),
      hint: i18n.t('k4f83019d'),
      run: () => {
        const ids = [...selected];
        props.onToast?.(i18n.t('k55512949', { p0: ids.length }));
        void api
          .ocrBatch(ids)
          .then((r) => {
            props.onToast?.(i18n.t('k3efdfa1d', { p0: r.okCount, p1: r.total }));
            props.onRefresh();
          })
          .catch((err) => props.onToast?.((err as Error).message));
      },
    },
    {
      key: 'delete',
      label: i18n.t('k2f4aaddd'),
      title: i18n.t('k676b03ae'),
      hint: i18n.t('k8ad56d7e'),
      icon: <IconTrash />,
      danger: true,
      run: () => onBulk('delete'),
    },
  ];

  const bulkShown = bulkActs.filter((a) => a.show !== false);
  const bulkOnBar = bulkPinned
    .map((k) => bulkShown.find((a) => a.key === k))
    .filter((a): a is BulkAct => Boolean(a));
  const bulkInMenu = bulkShown.filter((a) => !bulkPinned.includes(a.key));

  return (
    <div
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (!(t instanceof Element)) return;
        // 输入框 / 下拉 / 已有菜单（卡片菜单、批量「更多」）里的右键交给它们自己
        if (t.closest('input,textarea,select,[contenteditable="true"],.card-ctx,.bulk-more')) return;
        // 卡片会自行 stopPropagation 打开自己的菜单（见 ImageCard），
        // 能走到这里的右键 = 页面空白/标题区：弹出页面级操作
        e.preventDefault();
        setPageMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="sticky-head">
        <div className="page-head">
        <div>
          <h1 className="page-title">{props.title}</h1>
          <div className="page-sub">{props.subtitle}</div>
        </div>
        <div className="page-head-meta">
          <span className="page-view-badge">{VIEW_LABELS[viewMode]}</span>
          <span className="page-count">共 {total.toLocaleString('zh-CN')} 张</span>
        </div>
      </div>

      {!!props.missingCount && !missingDismissed && (
        <div className="missing-banner">
          <div className="missing-banner-text">
            <b><IconWarning size={13} /> {props.missingCount} 张图片的文件在磁盘上找不到了</b>
            <p>
              如果你只是移动或更换了保存文件夹，点「尝试重新定位」可按文件名自动找回；
              确认文件已彻底删除的话，可清理这些记录，避免白白占位。
            </p>
          </div>
          <div className="missing-banner-actions">
            <button className="btn sm primary" onClick={props.onRelocateMissing}>
              {i18n.t('k0311212a')}
            </button>
            <button className="btn sm danger" onClick={props.onPurgeMissing}>
              {i18n.t('k9ff19387')}
            </button>
            <button className="btn sm ghost" onClick={() => setMissingDismissed(true)}>
              {i18n.t('kc0d5d68f')}
            </button>
          </div>
        </div>
      )}

      {props.importing && (
        <div
          className="import-banner"
          role="status"
          aria-live="polite"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            marginBottom: 12,
            borderRadius: 8,
            background: 'rgba(120, 140, 255, 0.12)',
            color: 'var(--text)',
            fontSize: 13,
          }}
        >
          <span className="spinner" />
          <span>
            {props.importProgress?.message || i18n.t('kd631e657')}
            {props.importProgress?.progress != null
              ? ` ${Math.min(99, Math.max(0, props.importProgress.progress))}%`
              : ''}
            {importSummary(props.importProgress)}
            —— 新图片会边扫描边出现
          </span>
        </div>
      )}

        <FilterBar
          filters={props.filters}
          onChange={props.onFiltersChange}
          tags={tags}
          viewMode={viewMode}
          onViewMode={props.onViewMode}
          colWidth={props.colWidth}
          onColWidth={props.onColWidth}
          hideFavorite={props.hideFavorite}
          canManualSort={!!props.folderId}
          onMarkAllSeen={props.onMarkAllSeen}
        />
      </div>

      {viewMode !== 'folder' && !items.length && !loading && (
        <div className="empty">
          <div className="big"><IconImages size={42} /></div>
          <h3>
            {props.importing
              ? i18n.t('ke02c0a10', { p0: Math.min(99, Math.max(0, props.importProgress?.progress ?? 0)), p1: importSummary(
                  props.importProgress
                ) })
              : i18n.t('kd4932f14')}
          </h3>
          {props.importing ? (
            <p>{i18n.t('ka07ddcd9')}</p>
          ) : (
            <p>
              {i18n.t('k33c03ca4')}
            </p>
          )}
          {!props.importing && (
            <button className="btn primary" onClick={props.onStartCrawl}>
              {i18n.t('kff4a3771')}
            </button>
          )}
        </div>
      )}

      {/* 图片展开视图只平铺素材本身（文件夹里的图也在内），不再插一排文件夹卡片；
          按文件夹浏览统一交给「按文件夹收纳」视图 */}
      {/* 筛选/搜索后读屏用户需要知道还剩多少张，否则只能自己数 */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {props.loading ? i18n.t('kd6fdcd52') : i18n.t('k3b745f53', { p0: total })}
      </div>

      {viewMode === 'folder' ? (
        <React.Suspense
          fallback={<div className="tiny muted" style={{ padding: '28px 4px' }}>{i18n.t('k42c15762')}</div>}
        >
          <FolderGroupView
            folders={props.folders || []}
            folderId={props.folderId ?? null}
            rootName={props.rootName || i18n.t('ke8e1189e')}
            onOpenRoot={props.onOpenRoot || (() => undefined)}
            onOpenFolder={props.onOpenFolder || (() => undefined)}
            onOpenImage={props.onOpenImageFromFolder || (() => undefined)}
            onDropImages={props.onDropImagesOnFolder}
            onShowUnfiled={props.onShowUnfiled}
            unfiledCount={props.unfiledCount}
            refreshSeq={props.refreshSeq}
            totalImages={total}
          />
        </React.Suspense>
      ) : viewMode === 'list' ? (
        /* 列表视图（Eagle List View）：一屏看更多，靠标签/日期/大小做整理 */
        <div className="list-view" ref={listRef}>
          <div className="list-head">
            <span />
            {/* 表头即排序开关：再点一次换方向，省得回到筛选栏去找 */}
            <button
              className={`list-sort${props.filters.sort === 'name' ? ' on' : ''}`}
              onClick={() => props.onFiltersChange({ sort: 'name' })}
              title={i18n.t('k9daf5e43')}
              aria-pressed={props.filters.sort === 'name'}
            >
              名称{props.filters.sort === 'name' ? ' ↑' : ''}
            </button>
            <span>{i18n.t('k226b0912')}</span>
            <span>{i18n.t('k47984602')}</span>
            <button
              className={`list-sort${props.filters.sort === 'size' ? ' on' : ''}`}
              onClick={() => props.onFiltersChange({ sort: 'size' })}
              title={i18n.t('k90baa1f5')}
              aria-pressed={props.filters.sort === 'size'}
            >
              大小{props.filters.sort === 'size' ? ' ↓' : ''}
            </button>
            <span>{i18n.t('k14d34236')}</span>
            <button
              className={`list-sort${props.filters.sort === 'new' || props.filters.sort === 'old' ? ' on' : ''}`}
              onClick={() => props.onFiltersChange({ sort: props.filters.sort === 'new' ? 'old' : 'new' })}
              title={i18n.t('ka04229a8')}
              aria-pressed={props.filters.sort === 'new' || props.filters.sort === 'old'}
            >
              采集时间{props.filters.sort === 'new' ? ' ↓' : props.filters.sort === 'old' ? ' ↑' : ''}
            </button>
          </div>
          {/* 外层撑出总高度保持滚动条长度，内层平移后只渲染切片 */}
          <div style={{ position: 'relative', height: items.length * LIST_ROW_H }}>
            <div style={{ transform: `translateY(${listStart * LIST_ROW_H}px)`, willChange: 'transform' }}>
          {listSlice.map((it) => (
            <div
              key={it.id}
              className={`list-row${selected.has(it.id) ? ' selected' : ''}${tagOverId === it.id ? ' tag-hint' : ''}${
                stackOverId === it.id ? ' stack-hint' : ''
              }`}
              data-image-id={it.id}
              onClick={() => props.onOpen(it)}
              // 列表行和网格卡片一样要能用键盘打开：Tab 到行、回车/空格进入预览
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                props.onOpen(it);
              }}
              title={it.title}
              draggable
              onDragStart={(e) => {
                const ids = selected.has(it.id) && selected.size > 1 ? Array.from(selected) : [it.id];
                e.dataTransfer.setData('application/x-tuku-image-id', ids.join(','));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onDragOver={(e) => {
                // 列表视图也要能接侧栏拖来的标签，不然「拖标签到图片」只在网格里成立
                if (props.onDropTag && e.dataTransfer.types.includes(TAG_MIME)) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'copy';
                  if (tagOverId !== it.id) setTagOverId(it.id);
                  return;
                }
                if (props.manualSort || !props.onStackDrop) return;
                if (!e.dataTransfer.types.includes(IMAGE_MIME)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                if (stackOverId !== it.id) setStackOverId(it.id);
              }}
              onDragLeave={() => {
                setTagOverId(null);
                setStackOverId(null);
              }}
              onDrop={(e) => {
                const tag = e.dataTransfer.getData(TAG_MIME);
                setTagOverId(null);
                setStackOverId(null);
                if (tag && props.onDropTag) {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onDropTag(it, tag);
                  return;
                }
                if (props.manualSort || !props.onStackDrop) return;
                const raw = e.dataTransfer.getData(IMAGE_MIME);
                if (!raw) return;
                const ids = raw
                  .split(',')
                  .map((s) => Number(s))
                  .filter((n) => Number.isFinite(n) && n > 0);
                if (!ids.length || ids.includes(it.id)) return;
                e.preventDefault();
                e.stopPropagation();
                props.onStackDrop(ids, it);
              }}
            >
              <span
                className={`list-check${selected.has(it.id) ? ' on' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onToggleSelect(it.id);
                }}
              >
                {selected.has(it.id) ? <IconCheck size={12} /> : ''}
              </span>
              <span className="list-name">
                <img src={it.thumbUrl} alt="" loading="lazy" />
                <span className="list-title">{it.title}</span>
                {it.favorite && (
                  <span className="list-star">
                    <IconStar size={12} filled />
                  </span>
                )}
                {!!props.annotationCounts?.[String(it.id)] && (
                  <span className="list-badge" title={i18n.t('kec8ad261', { p0: props.annotationCounts[String(it.id)] })}>
                    <IconPencil size={11} /> {props.annotationCounts[String(it.id)]}
                  </span>
                )}
                {!!props.dupeCounts?.[String(it.id)] && props.dupeCounts[String(it.id)] > 1 && (
                  <span className="list-badge dupe" title={i18n.t('k71646c9d', { p0: props.dupeCounts[String(it.id)] })}>
                    ×{props.dupeCounts[String(it.id)]}
                  </span>
                )}
              </span>
              <span className="list-kind">{KIND_TEXT[it.mediaKind || 'image'] || i18n.t('k2a0c4740')}</span>
              <span className="list-dim">
                {it.width > 0 && it.height > 0
                  ? `${it.width}×${it.height}`
                  : it.duration > 0
                    ? `${Math.round(it.duration)}s`
                    : '—'}
              </span>
              <span className="list-size">{fmtBytes(it.sizeBytes)}</span>
              <span className="list-tags">
                {it.tags.slice(0, 3).map((t) => (
                  <span key={t} className="tag-pill">
                    {t}
                  </span>
                ))}
                {it.tags.length > 3 && <span className="tag-pill">+{it.tags.length - 3}</span>}
              </span>
              <span className="list-date">{it.createdAt ? it.createdAt.slice(0, 10) : '—'}</span>
            </div>
          ))}
            </div>
          </div>
        </div>
      ) : (
        /* 绝对定位瀑布流 + 虚拟滚动：大图库只渲染视口附近卡片，滚动不整列重排 */
        <MasonryGrid
          items={items}
          mode={viewMode === 'grid' ? 'grid' : 'masonry'}
          colWidth={props.colWidth}
          /* 整块网格只留一个 Tab 停点，其余靠方向键走；否则几万张要按几万次 Tab */
          roving
          onVisibleIds={warmVisible}
          renderItem={(item) => (
            <ImageCard
              item={item}
              selected={selected.has(item.id)}
              onOpen={props.onOpen}
              onToggleSelect={props.onToggleSelect}
              onToggleFavorite={props.onToggleFavorite}
              onDownload={props.onDownload}
              onUpdateItem={props.onUpdateItem}
              onDeleteItem={props.onDeleteItem}
              resetKey={props.refreshSeq}
              annotationCount={props.annotationCounts?.[String(item.id)]}
              dupeCount={props.dupeCounts?.[String(item.id)]}
              dragIds={dragIds && selected.has(item.id) ? dragIds : undefined}
              manualSort={props.manualSort}
              onReorderDrop={props.onReorder}
              onDropTag={props.onDropTag}
              onOpenStack={props.onOpenStack}
              onUngroupStack={props.onUngroupStack}
              onStackDrop={props.onStackDrop}
            />
          )}
        />
      )}

      {viewMode !== 'folder' && (
        <div className="load-more" ref={sentinel}>
          {loading ? (
            <span className="spinner" />
          ) : hasMore ? (
            <button className="btn sm" onClick={onLoadMore}>
              {i18n.t('k77281549')}
            </button>
          ) : items.length ? (
            i18n.t('kcd35e6f8')
          ) : null}
        </div>
      )}

      {selected.size > 0 && (
        <div className="bulk-bar">
          <div className="bulk-info">
            <b className="bulk-count">已选中 {selected.size} 张</b>
            {total > selected.size && <span className="bulk-sub">筛选结果共 {total} 张</span>}
            {props.onSelectAll && selected.size < total && (
              <button
                className="bulk-link"
                title={i18n.t('k8fec71e2')}
                onClick={props.onSelectAll}
              >
                {i18n.t('k1b4775b0')}
              </button>
            )}
          </div>
          <div className="bulk-acts">
            {bulkOnBar.map((a) => (
              <button
                key={a.key}
                className={`btn sm${a.danger ? ' danger' : ''}`}
                title={a.title}
                onClick={a.run}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
            <div className="bulk-more-wrap">
              <button
                className={`btn sm${bulkMore ? ' on' : ''}`}
                title={i18n.t('k47ac96da')}
                onClick={() => setBulkMore((v) => !v)}
              >
                {i18n.t('k8eb63bbb')}
              </button>
              {bulkMore && (
                <>
                  <div className="bulk-more-mask" onMouseDown={() => setBulkMore(false)} />
                  <div className="bulk-more" role="menu">
                    {bulkInMenu.map((a) => (
                      <button
                        key={a.key}
                        className="bulk-more-item"
                        title={a.title}
                        onClick={() => {
                          setBulkMore(false);
                          a.run();
                        }}
                      >
                        {a.label}
                        {a.hint && <em>{a.hint}</em>}
                      </button>
                    ))}
                    {bulkInMenu.length > 0 && <div className="bulk-more-sep" />}
                    {props.onAddToPlaylist && (
                      <button
                        className="bulk-more-item"
                        onClick={() => {
                          // 展开时重新拉一次，避免多选期间新建的清单不在列表里
                          api.playlists().then(setPlaylists).catch(quiet);
                          setShowPlaylistPick((v) => !v);
                        }}
                      >
                        {i18n.t('k5f4d97a0')}<em>{i18n.t('k4621418c')}</em>
                      </button>
                    )}
                    {props.onAddToPlaylist && showPlaylistPick && (
                      <div className="bulk-more-pick">
                        <Select
                          className="bulk-more-select"
                          value=""
                          title={i18n.t('k4621418c')}
                          placeholder={i18n.t('kd8597667')}
                          onChange={(v) => {
                            if (!v) return;
                            void (async () => {
                              const name = v === '__new__' ? await promptDialog(i18n.t('k3941027d')) : '';
                              props.onAddToPlaylist!(v === '__new__' ? `__new__:${name || ''}` : Number(v));
                              setShowPlaylistPick(false);
                              setBulkMore(false);
                            })();
                          }}
                          options={[
                            { value: '', label: i18n.t('kd8597667'), disabled: true },
                            ...playlists.map((p) => ({
                              value: String(p.id),
                              label: `${p.name}（${p.count ?? 0}）`,
                            })),
                            { value: '__new__', label: i18n.t('k498e4f52') },
                          ]}
                        />
                      </div>
                    )}
                    {props.onAddToFolder && (
                      <button
                        className="bulk-more-item"
                        onClick={() => {
                          // 展开时重新拉一次：侧栏刚新建/改名的文件夹要立刻可选（原来只在选中数变化时拉，会缺项）
                          api.folders().then((r) => setFolders(r.folders)).catch(quiet);
                          setShowFolderPick((v) => !v);
                        }}
                      >
                        {i18n.t('ke9744b73')}<em>{i18n.t('k45a65e60')}</em>
                      </button>
                    )}
                    {props.onAddToFolder && showFolderPick && (
                      <div className="bulk-more-pick">
                        <Select
                          className="bulk-more-select"
                          value=""
                          title={i18n.t('k45a65e60')}
                          placeholder={i18n.t('ka0249eda')}
                          onChange={(v) => {
                            if (!v) return;
                            void (async () => {
                              const name = v === '__new__' ? await promptDialog(i18n.t('k0dc0361c')) : '';
                              props.onAddToFolder!(v === '__new__' ? `__new__:${name || ''}` : Number(v));
                              setShowFolderPick(false);
                              setBulkMore(false);
                            })();
                          }}
                          options={[
                            { value: '', label: i18n.t('ka0249eda'), disabled: true },
                            ...sortedFolders.map((f) => ({
                              value: String(f.id),
                              label: `${'　'.repeat(folderDepth.get(f.id) || 0)}${f.name}（${f.count ?? 0}）`,
                            })),
                            { value: '__new__', label: i18n.t('kd48be844') },
                          ]}
                        />
                      </div>
                    )}
                    {props.folderId != null && (
                      <button
                        className="bulk-more-item"
                        disabled={removing}
                        title={i18n.t('ke95cd4c7')}
                        onClick={() => {
                          setBulkMore(false);
                          void removeFromCurrentFolder();
                        }}
                      >
                        {removing ? i18n.t('k80cf6fc4') : i18n.t('k62c5320d')}
                      </button>
                    )}
                    <div className="bulk-more-sep" />
                    <button
                      className="bulk-more-item"
                      title={i18n.t('k934213f1')}
                      onClick={() => {
                        setBulkMore(false);
                        setTczOpen(true);
                      }}
                    >
                      <IconGear size={13} /> {i18n.t('k13f04863')}<em>{i18n.t('kc7574dee')}</em>
                    </button>
                  </div>
                </>
              )}
            </div>
            <button className="btn sm ghost bulk-clear" onClick={onClearSelection}>
              {i18n.t('k76159d0d')}
            </button>
          </div>
        </div>
      )}

      {/* 按需加载的重浮层：加载失败不该影响主格网，fallback 只留空白 */}
      <React.Suspense fallback={null}>
      {/* 批量裁切：独立的全屏裁切台（每张一个框，可选比例/横竖/尺寸/自动焦点） */}
      {bulkEdit === 'crop' && (
        <BatchCropStudio
          items={items
            .filter((x) => selected.has(x.id) && (x.mediaKind === 'image' || x.mediaKind === 'gif'))
            .map<CropItem>((x) => ({
              id: x.id,
              title: x.title,
              thumb: x.thumbUrl,
              url: x.url,
              width: x.width,
              height: x.height,
            }))}
          onClose={() => setBulkEdit(null)}
          onToast={props.onToast}
          onDone={props.onRefresh}
        />
      )}

      {bulkEdit === 'color' && (
        <BulkEditDialog
          ids={[...selected]}
          preview={(() => {
            // 取当前页里第一张选中项做预览（跨页选中时可能取不到，调色台会提示）
            const it = items.find((x) => selected.has(x.id));
            return it ? { src: it.url, title: it.title, meta: `${it.width} × ${it.height}` } : undefined;
          })()}
          films={items
            .filter((x) => selected.has(x.id))
            .slice(0, 240)
            .map((x) => ({
              id: x.id,
              src: x.url,
              thumb: x.thumbUrl,
              title: x.title,
              meta: `${x.width} × ${x.height}`,
            }))}
          onClose={() => setBulkEdit(null)}
          onToast={props.onToast}
          onDone={props.onRefresh}
        />
      )}

      {renaming && (
        <RenameBatchDialog
          ids={[...selected]}
          items={items.filter((x) => selected.has(x.id))}
          onClose={() => setRenaming(false)}
          onToast={props.onToast ?? (() => undefined)}
          onDone={props.onRefresh}
        />
      )}

      {metadataOpen && (
        <BulkMetadataDialog
          ids={[...selected]}
          onClose={() => setMetadataOpen(false)}
          onToast={props.onToast ?? (() => undefined)}
          onUpdated={() => {
            props.onClearSelection?.();
            props.onRefresh();
          }}
        />
      )}

      {exportIds && (
        <ExportDialog ids={exportIds} onClose={() => setExportIds(null)} onToast={props.onToast} />
      )}

      {stitchOpen && (
        <StitchDialog
          items={items.filter((x) => selected.has(x.id)).slice(0, 60)}
          onClose={() => setStitchOpen(false)}
          onToast={props.onToast}
        />
      )}

      {cmpIds && (
        <CompareView
          items={items.filter((x) => cmpIds.includes(x.id))}
          leftId={cmpIds[0]}
          rightId={cmpIds[1]}
          onClose={() => setCmpIds(null)}
          readOnly
        />
      )}

      <ActionsPanel
        open={actionsOpen}
        ids={[...selected]}
        onClose={() => setActionsOpen(false)}
        onToast={props.onToast}
        onRefresh={props.onRefresh}
      />

      {/* 水印 / 相框：单张与批量共用一个工作台 */}
      <WatermarkStudio
        open={watermarkIds.length > 0}
        ids={watermarkIds}
        onClose={() => setWatermarkIds([])}
        onToast={props.onToast}
        onDone={props.onRefresh}
      />

      {/* 批量条自定义：决定哪些动作直接露在条上，其余收进「更多」 */}
      <ToolbarCustomizer
        open={tczOpen}
        title={i18n.t('k0d3a5fee')}
        barName={i18n.t('kb53b83fc')}
        hint={i18n.t('kbd8e7b89')}
        all={bulkShown.map((a) => ({ key: a.key, label: a.label }))}
        pinned={bulkPinned}
        defaults={BULK_PINNED_DEFAULT}
        onChange={setBulkPinned}
        onClose={() => setTczOpen(false)}
      />
      </React.Suspense>


      {/* 拖拽入库由 App 层 GlobalImport 统一接管：屏幕中央圆形靶盘，落点不在圈内不入库 */}

      {pageMenu &&
        createPortal(
          <div
            ref={pageMenuRef}
            className="card-ctx"
            style={{ left: pageMenu.x, top: pageMenu.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              disabled={!props.onUndo}
              title={i18n.t('kaa5b26e5')}
              onClick={() => {
                setPageMenu(null);
                props.onUndo?.();
              }}
            >
              <IconRotateCcw size={13} /> {i18n.t('k2b48f892')}
            </button>
            <button
              disabled={props.refreshing}
              title={i18n.t('k39b74a74')}
              onClick={() => {
                setPageMenu(null);
                props.onRefresh();
              }}
            >
              <span className={props.refreshing ? 'spinning' : ''}>
                <IconRefresh size={14} />
              </span>{' '}
              {props.refreshing ? i18n.t('kbfb2e454') : i18n.t('k694fc5ef')}
            </button>
            <button
              disabled={!props.missingCount}
              title={i18n.t('k54593c2a')}
              onClick={() => {
                setPageMenu(null);
                props.onPurgeMissing?.();
              }}
            >
              <IconTrash size={13} /> 清理缺失{props.missingCount ? `（${props.missingCount}）` : ''}
            </button>
            <button
              onClick={() => {
                setPageMenu(null);
                props.onStartCrawl();
              }}
            >
              <IconGlobe size={13} /> {i18n.t('k7967c1f3')}
            </button>
            <div className="card-ctx-sep" />
            <button
              title={i18n.t('kd0680b7f')}
              onClick={() => {
                setPageMenu(null);
                // 文件夹视图：先按文件夹名在图片路径里定位真实目录（兼容父夹聚合视图）；
                // 定位不到就用当前第一张图所在目录。其它视图直接打开当前库素材根目录。
                let dir = '';
                if (props.folderId != null) {
                  const name = (props.title || '').toLowerCase();
                  const hit = name ? props.items.find((x) => x.path && x.path.toLowerCase().includes(`\\${name}\\`)) : undefined;
                  if (hit?.path) {
                    const idx = hit.path.toLowerCase().indexOf(`\\${name}\\`);
                    if (idx >= 0) dir = hit.path.slice(0, idx + name.length + 1);
                  }
                  if (!dir) {
                    const first = props.items.find((x) => x.path);
                    if (first?.path) dir = first.path.replace(/[\\/][^\\/]+$/, '');
                  }
                }
                void openFolder(dir || undefined).catch(quiet);
              }}
            >
              <IconFolderOpen size={13} /> {i18n.t('kb38f6423')}
            </button>
            <div className="card-ctx-sep" />
            <button
              title={i18n.t('kffef0a7a')}
              onClick={() => {
                setPageMenu(null);
                props.onFiltersChange(RESET_FILTERS);
              }}
            >
              <IconClose size={13} /> {i18n.t('k0f47025e')}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}

export default React.memo(Gallery);
