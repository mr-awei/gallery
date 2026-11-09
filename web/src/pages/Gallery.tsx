import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, downloadFile, exportZipUrl, formatSize, openFolder, quiet } from '../api';
import { UPLOAD_HINT, importFiles } from '../lib/importer';
import type { Filters, ImageItem, FolderNode, Playlist, ViewMode } from '../types';
import FilterBar from '../components/FilterBar';
import ImageCard from '../components/ImageCard';
import { promptDialog } from '../components/Dialogs';
import BulkEditDialog from '../components/BulkEditDialog';
import BatchCropStudio, { type CropItem } from '../components/BatchCropStudio';
import ExportDialog from '../components/ExportDialog';
import RenameBatchDialog from '../components/RenameBatchDialog';
import MasonryGrid from '../components/MasonryGrid';
import StitchDialog from '../components/StitchDialog';
import CompareView from '../components/CompareView';
import ActionsPanel from '../components/ActionsPanel';
import { IconDownload, IconFolder, IconHeart, IconTrash } from '../components/Icons';
import Select from '../components/Select';
import ToolbarCustomizer from '../components/ToolbarCustomizer';
import WatermarkStudio from '../components/WatermarkStudio';
import { usePinnedActions } from '../lib/pinned';
import { IMAGE_MIME, TAG_MIME } from '../lib/dnd';
import FolderGroupView from '../components/FolderGroupView';

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
  masonry: '图片展开 · 瀑布流',
  grid: '图片展开 · 网格',
  list: '图片展开 · 列表',
  folder: '按文件夹收纳',
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

const KIND_TEXT: Record<string, string> = {
  image: '图片',
  gif: 'GIF',
  video: '视频',
  audio: '音频',
  font: '字体',
  pdf: 'PDF',
  office: 'Office',
  model: '3D',
  other: '文件',
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
  /* 批量导出（Eagle 的导出面板：格式 / 质量 / 最长边，可原样打包） */
  const [exportIds, setExportIds] = useState<number[] | null>(null);
  /* 拼接 / 对比 / 动作：都只对「当前页里选中的那几张」操作 */
  const [stitchOpen, setStitchOpen] = useState(false);
  const [cmpIds, setCmpIds] = useState<[number, number] | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** 批量条的「更多」：低频批量操作收进菜单，别把 15 个按钮挤成一条 */
  const [bulkMore, setBulkMore] = useState(false);
  /* 拖拽 / 粘贴入库（Eagle 三件套） */
  const [dragDepth, setDragDepth] = useState(0);
  const [uploading, setUploading] = useState<{ done: number; total: number; saved: number; failed: number } | null>(
    null
  );
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
      props.onToast?.(`已从当前文件夹移出 ${r.removed} 张`);
      onClearSelection();
      props.onRefresh();
    } catch (err) {
      props.onToast?.(`移出失败：${(err as Error).message}`);
    } finally {
      setRemoving(false);
    }
  };

  /** 拖拽入库：和全局粘贴共用 lib/importer，这里额外显示逐张进度 */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      setUploading({ done: 0, total: files.length, saved: 0, failed: 0 });
      const r = await importFiles(files, setUploading);
      setUploading(null);
      if (!r.saved) {
        props.onToast?.(
          r.skipped
            ? `没有可入库的文件（${UPLOAD_HINT}）`
            : `入库失败：${r.failed} 个文件未通过${r.firstError ? `（${r.firstError}）` : ''}`
        );
        return;
      }
      props.onToast?.(
        r.failed
          ? `入库完成：${r.saved} 个成功，${r.failed} 个失败${r.firstError ? `（${r.firstError}）` : ''}`
          : `已入库 ${r.saved} 个文件`
      );
      props.onRefresh();
    },
    [props.onToast, props.onRefresh]
  );

  /* Ctrl+V 交给 App 层的 GlobalImport 统一处理（图库页卸载后也能粘），这里只保留拖拽进度条 */

  /* 批量条自定义：acts 是全集，pinned 决定哪些直接露在条上，其余收进「更多」 */
  const [bulkPinned, setBulkPinned] = usePinnedActions('bulk', BULK_PINNED_DEFAULT);
  const [tczOpen, setTczOpen] = useState(false);
  const [watermarkIds, setWatermarkIds] = useState<number[]>([]);

  const bulkActs: BulkAct[] = [
    {
      key: 'download',
      label: '打包下载',
      title: '原样打包下载（不改格式，最快）',
      hint: '原样打包，最快',
      icon: <IconDownload />,
      run: downloadZip,
    },
    {
      key: 'export',
      label: '导出…',
      title: '批量导出：转成 JPEG / PNG / WebP / AVIF，可改质量与最长边，打包成 zip',
      hint: '转格式 / 质量 / 最长边',
      run: () => setExportIds([...selected]),
    },
    {
      key: 'stitch',
      label: '拼接…',
      title: '把选中的图按网格拼成一张联系表（可调列数 / 间距 / 底色 / 格式）',
      hint: '多张拼成一张联系表',
      run: () => setStitchOpen(true),
    },
    {
      key: 'watermark',
      label: '水印 / 相框…',
      title: '读取 EXIF 加相机信息水印或加相框，可批量套用同一套参数',
      hint: '23 款水印 · 20 款相框',
      run: () => setWatermarkIds([...selected]),
    },
    {
      key: 'favorite',
      label: '收藏',
      title: '给选中的图全部打上收藏',
      hint: '全部打上收藏',
      icon: <IconHeart filled />,
      run: () => onBulk('favorite'),
    },
    {
      key: 'unfavorite',
      label: '取消收藏',
      title: '把选中的图全部取消收藏',
      hint: '全部取消收藏',
      run: () => onBulk('unfavorite'),
    },
    {
      key: 'compare',
      label: '对比',
      title: '并排 / 分割 / 重叠三种方式对比选中的两张',
      hint: '并排 / 分割 / 重叠',
      show: selected.size === 2,
      run: () => {
        const two = [...selected];
        setCmpIds([two[0], two[1]]);
      },
    },
    {
      key: 'classify',
      label: '快速分类…',
      title: '把选中的素材放进文件夹并追加标签（快捷键 F）',
      hint: '文件夹 + 标签，一步归类',
      show: !!props.onQuickClassify,
      run: () => props.onQuickClassify?.(),
    },
    {
      key: 'stack',
      label: '堆叠',
      title: '把同素材的多个版本合成一摞（只显示封面，角标可展开）',
      hint: '多版本合成一摞',
      show: selected.size > 1 && !!props.onStackSelected,
      run: () => props.onStackSelected?.(),
    },
    {
      key: 'actions',
      label: '动作…',
      title: '批量打标签 / 评分 / 备注',
      hint: '批量打标签 / 评分 / 备注',
      run: () => setActionsOpen(true),
    },
    {
      key: 'crop',
      label: '批量裁切…',
      title: '统一比例 / 横竖 / 自动对焦',
      hint: '统一比例 / 横竖 / 自动对焦',
      run: () => setBulkEdit('crop'),
    },
    {
      key: 'color',
      label: '批量调色…',
      title: '白平衡 / 影调 / 曲线',
      hint: '白平衡 / 影调 / 曲线',
      run: () => setBulkEdit('color'),
    },
    {
      key: 'rename',
      label: '批量重命名…',
      title: '按模板改名',
      hint: '按模板改名',
      run: () => setRenaming(true),
    },
    {
      key: 'ocr',
      label: 'OCR 识别文字',
      title: '识别选中图里的文字，识别完可按内容搜索',
      hint: '识别完可按内容搜索',
      run: () => {
        const ids = [...selected];
        props.onToast?.(`正在识别 ${ids.length} 张图里的文字…`);
        void api
          .ocrBatch(ids)
          .then((r) => {
            props.onToast?.(`识别完成：${r.okCount} / ${r.total} 张有结果`);
            props.onRefresh();
          })
          .catch((err) => props.onToast?.((err as Error).message));
      },
    },
    {
      key: 'delete',
      label: '删除',
      title: '移入回收站（可恢复）',
      hint: '移入回收站，可恢复',
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
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setDragDepth(0);
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) void uploadFiles(files);
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
            <b>⚠ {props.missingCount} 张图片的文件在磁盘上找不到了</b>
            <p>
              如果你只是移动或更换了保存文件夹，点「尝试重新定位」可按文件名自动找回；
              确认文件已彻底删除的话，可清理这些记录，避免白白占位。
            </p>
          </div>
          <div className="missing-banner-actions">
            <button className="btn sm primary" onClick={props.onRelocateMissing}>
              尝试重新定位
            </button>
            <button className="btn sm danger" onClick={props.onPurgeMissing}>
              清理这些记录
            </button>
            <button className="btn sm ghost" onClick={() => setMissingDismissed(true)}>
              忽略
            </button>
          </div>
        </div>
      )}

      {props.importing && (
        <div
          className="import-banner"
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
            {props.importProgress?.message || '正在扫描素材文件夹'}
            {props.importProgress?.progress != null
              ? ` ${Math.min(99, Math.max(0, props.importProgress.progress))}%`
              : ''}
            {props.importProgress?.saved ? `（已入库 ${props.importProgress.saved} 张）` : ''}
            {props.importProgress?.total ? `／共 ${props.importProgress.total} 张` : ''}
            {props.importProgress?.unchanged ? `，跳过 ${props.importProgress.unchanged} 张未变化` : ''}
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
          <div className="big">🖼️</div>
          <h3>
            {props.importing
              ? `正在扫描素材文件夹… ${Math.min(99, Math.max(0, props.importProgress?.progress ?? 0))}${
                  props.importProgress?.saved ? `（已入库 ${props.importProgress.saved} 张）` : ''
                }`
              : '还没有符合条件的图片'}
          </h3>
          {props.importing ? (
            <p>图片会边扫描边显示，无需等待全部完成。</p>
          ) : (
            <p>
              前往「采集」页面，选择关键词与来源开始自动采集全网高清图，
              <br />
              采集结果会自动去重并按分辨率筛选后进入图库。
            </p>
          )}
          {!props.importing && (
            <button className="btn primary" onClick={props.onStartCrawl}>
              立即开始采集
            </button>
          )}
        </div>
      )}

      {/* 图片展开视图只平铺素材本身（文件夹里的图也在内），不再插一排文件夹卡片；
          按文件夹浏览统一交给「按文件夹收纳」视图 */}
      {viewMode === 'folder' ? (
        <FolderGroupView
          folders={props.folders || []}
          folderId={props.folderId ?? null}
          rootName={props.rootName || '当前资源库'}
          onOpenRoot={props.onOpenRoot || (() => undefined)}
          onOpenFolder={props.onOpenFolder || (() => undefined)}
          onOpenImage={props.onOpenImageFromFolder || (() => undefined)}
          onDropImages={props.onDropImagesOnFolder}
          onShowUnfiled={props.onShowUnfiled}
          unfiledCount={props.unfiledCount}
          refreshSeq={props.refreshSeq}
          totalImages={total}
        />
      ) : viewMode === 'list' ? (
        /* 列表视图（Eagle List View）：一屏看更多，靠标签/日期/大小做整理 */
        <div className="list-view" ref={listRef}>
          <div className="list-head">
            <span />
            {/* 表头即排序开关：再点一次换方向，省得回到筛选栏去找 */}
            <button
              className={`list-sort${props.filters.sort === 'name' ? ' on' : ''}`}
              onClick={() => props.onFiltersChange({ sort: 'name' })}
              title="按文件名排序"
            >
              名称{props.filters.sort === 'name' ? ' ↑' : ''}
            </button>
            <span>类型</span>
            <span>尺寸 / 时长</span>
            <button
              className={`list-sort${props.filters.sort === 'size' ? ' on' : ''}`}
              onClick={() => props.onFiltersChange({ sort: 'size' })}
              title="按文件大小排序（大的在前）"
            >
              大小{props.filters.sort === 'size' ? ' ↓' : ''}
            </button>
            <span>标签</span>
            <button
              className={`list-sort${props.filters.sort === 'new' || props.filters.sort === 'old' ? ' on' : ''}`}
              onClick={() => props.onFiltersChange({ sort: props.filters.sort === 'new' ? 'old' : 'new' })}
              title="按入库时间排序，点击切换新旧"
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
                {selected.has(it.id) ? '✓' : ''}
              </span>
              <span className="list-name">
                <img src={it.thumbUrl} alt="" loading="lazy" />
                <span className="list-title">{it.title}</span>
                {it.favorite && <span className="list-star">★</span>}
                {!!props.annotationCounts?.[String(it.id)] && (
                  <span className="list-badge" title={`${props.annotationCounts[String(it.id)]} 处标注`}>
                    ✏ {props.annotationCounts[String(it.id)]}
                  </span>
                )}
                {!!props.dupeCounts?.[String(it.id)] && props.dupeCounts[String(it.id)] > 1 && (
                  <span className="list-badge dupe" title={`${props.dupeCounts[String(it.id)]} 个完全相同的文件`}>
                    ×{props.dupeCounts[String(it.id)]}
                  </span>
                )}
              </span>
              <span className="list-kind">{KIND_TEXT[it.mediaKind || 'image'] || '文件'}</span>
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
              加载更多
            </button>
          ) : items.length ? (
            '已经到底啦'
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
                title="选中当前筛选条件下的全部图片（不只是已加载的这几屏）"
                onClick={props.onSelectAll}
              >
                全选全部
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
                title="低频批量处理与归类；可在菜单底部自定义条上显示哪些动作"
                onClick={() => setBulkMore((v) => !v)}
              >
                更多 ▾
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
                        加入清单…<em>选一个清单，或直接新建</em>
                      </button>
                    )}
                    {props.onAddToPlaylist && showPlaylistPick && (
                      <div className="bulk-more-pick">
                        <Select
                          className="bulk-more-select"
                          value=""
                          title="选一个清单，或直接新建"
                          placeholder="选择清单…"
                          onChange={(v) => {
                            if (!v) return;
                            void (async () => {
                              const name = v === '__new__' ? await promptDialog('新清单名称') : '';
                              props.onAddToPlaylist!(v === '__new__' ? `__new__:${name || ''}` : Number(v));
                              setShowPlaylistPick(false);
                              setBulkMore(false);
                            })();
                          }}
                          options={[
                            { value: '', label: '选择清单…', disabled: true },
                            ...playlists.map((p) => ({
                              value: String(p.id),
                              label: `${p.name}（${p.count ?? 0}）`,
                            })),
                            { value: '__new__', label: '＋ 新建清单…' },
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
                        加入文件夹…<em>归到某个文件夹下</em>
                      </button>
                    )}
                    {props.onAddToFolder && showFolderPick && (
                      <div className="bulk-more-pick">
                        <Select
                          className="bulk-more-select"
                          value=""
                          title="归到某个文件夹下"
                          placeholder="选择文件夹…"
                          onChange={(v) => {
                            if (!v) return;
                            void (async () => {
                              const name = v === '__new__' ? await promptDialog('新文件夹名称') : '';
                              props.onAddToFolder!(v === '__new__' ? `__new__:${name || ''}` : Number(v));
                              setShowFolderPick(false);
                              setBulkMore(false);
                            })();
                          }}
                          options={[
                            { value: '', label: '选择文件夹…', disabled: true },
                            ...sortedFolders.map((f) => ({
                              value: String(f.id),
                              label: `${'　'.repeat(folderDepth.get(f.id) || 0)}${f.name}（${f.count ?? 0}）`,
                            })),
                            { value: '__new__', label: '＋ 新建文件夹…' },
                          ]}
                        />
                      </div>
                    )}
                    {props.folderId != null && (
                      <button
                        className="bulk-more-item"
                        disabled={removing}
                        title="把选中的图从当前文件夹移出（只解除归类，不删除文件）"
                        onClick={() => {
                          setBulkMore(false);
                          void removeFromCurrentFolder();
                        }}
                      >
                        {removing ? '移出中…' : '从当前文件夹移出'}
                      </button>
                    )}
                    <div className="bulk-more-sep" />
                    <button
                      className="bulk-more-item"
                      title="选择哪些动作直接显示在批量条上"
                      onClick={() => {
                        setBulkMore(false);
                        setTczOpen(true);
                      }}
                    >
                      ⚙ 自定义工具栏…<em>把常用动作挪到条上</em>
                    </button>
                  </div>
                </>
              )}
            </div>
            <button className="btn sm ghost bulk-clear" onClick={onClearSelection}>
              取消选择
            </button>
          </div>
        </div>
      )}

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
        title="自定义批量操作条"
        barName="操作条"
        hint="左边是直接显示在批量条上的动作（按顺序排列），右边收在「更多 ▾」里。加入清单 / 加入文件夹等归类动作固定在「更多」中。"
        all={bulkShown.map((a) => ({ key: a.key, label: a.label }))}
        pinned={bulkPinned}
        defaults={BULK_PINNED_DEFAULT}
        onChange={setBulkPinned}
        onClose={() => setTczOpen(false)}
      />


      {/* 拖拽入库：整页接收文件，松手即入库（Eagle 同款体验） */}
      {dragDepth > 0 && (
        <div className="drop-zone">
          <div className="drop-zone-inner">
            <div className="big">⬇</div>
            <b>松开鼠标即可入库</b>
            <p>支持图片 / 视频 / GIF / 音频 / 字体 / PDF / Office / 3D 模型</p>
          </div>
        </div>
      )}
      {uploading && (
        <div className="upload-toast">
          <span className="spinner" /> 正在入库 {uploading.done}/{uploading.total}
          {uploading.saved ? ` · 成功 ${uploading.saved}` : ''}
          {uploading.failed ? ` · 失败 ${uploading.failed}` : ''}
        </div>
      )}

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
              title="撤销最近一次编辑（覆盖写回可用它还原，Ctrl+Z）"
              onClick={() => {
                setPageMenu(null);
                props.onUndo?.();
              }}
            >
              ↩ 撤销编辑
            </button>
            <button
              disabled={props.refreshing}
              title="重新加载当前筛选下的图片"
              onClick={() => {
                setPageMenu(null);
                props.onRefresh();
              }}
            >
              <span className={props.refreshing ? 'spinning' : ''}>⟳</span> {props.refreshing ? '刷新中…' : '刷新'}
            </button>
            <button
              disabled={!props.missingCount}
              title="把文件已丢失的图片记录从数据库中移除"
              onClick={() => {
                setPageMenu(null);
                props.onPurgeMissing?.();
              }}
            >
              🗑 清理缺失{props.missingCount ? `（${props.missingCount}）` : ''}
            </button>
            <button
              onClick={() => {
                setPageMenu(null);
                props.onStartCrawl();
              }}
            >
              🌐 去采集
            </button>
            <div className="card-ctx-sep" />
            <button
              title="在资源管理器中打开当前文件夹（全库视图打开素材根目录）"
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
              📂 打开所在位置
            </button>
            <div className="card-ctx-sep" />
            <button
              title="清空全部筛选条件，回到完整图库"
              onClick={() => {
                setPageMenu(null);
                props.onFiltersChange(RESET_FILTERS);
              }}
            >
              ✕ 重置筛选
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}

export default React.memo(Gallery);
