import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AdjustParams, EditSaveOptions, ImageItem } from '../types';
import { ADJUST_DEFAULTS, isAdjustDefault } from '../types';
import { api, BASE, copyImageToClipboard, isDesktop, pickFolder, BUCKET_LABELS, SOURCE_LABELS, formatDate, formatSize, quiet, revealFile } from '../api';
import { buildASE, buildPngSheet, downloadBlob } from '../lib/palette';
import ExportDialog from './ExportDialog';
import WallpaperPreview from './WallpaperPreview';
import ImageToolkit, { type ToolkitTab } from './ImageToolkit';
import CompareView from './CompareView';

/** 取文件路径所在目录（用于「另存副本」默认落到原图目录） */
const dirOfPath = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || p;
import CropOverlay, { initialRect, type CropRect } from './CropOverlay';
import CropSettings, {
  cropFocusRatio,
  cropOutputSize,
  cropRatioStr,
  defaultCropControls,
  type CropControlState,
} from './CropSettings';
import SaveModeBlock, { type SaveModeState } from './SaveModeBlock';
import ColorRoom from './ColorRoom';
import MediaViewer from './MediaViewer';
import AnnotationLayer from './AnnotationLayer';
import CommentsPanel from './CommentsPanel';
import WatermarkStudio from './WatermarkStudio';
import ToolbarCustomizer from './ToolbarCustomizer';
import Select from './Select';
import { usePinnedActions } from '../lib/pinned';

/** 顶栏默认放的「更多」项：标注、OCR、下载最常用，其余留在菜单里 */
const LB_PINNED_DEFAULT = ['anno', 'ocr', 'download'];
import InfoPanel from './lightbox/InfoPanel';
import { confirmDialog } from './Dialogs';
import type { WbSample } from './AdjustPanel';
import {
  IconClose,
  IconCopy,
  IconDownload,
  IconExpand,
  IconFolder,
  IconHeart,
  IconRotateCcw,
  IconRotateCw,
  IconSun,
  IconTrash,
  IconWallpaper,
  IconWand,
} from './Icons';


interface Props {
  items: ImageItem[];
  index: number;
  onClose: () => void;
  onIndex: (index: number) => void;
  onToggleFavorite: (item: ImageItem) => void;
  onSaveTags: (item: ImageItem, tags: string[]) => void;
  onDelete: (item: ImageItem) => void;
  /** style 省略时用设置里的默认铺底方式 */
  onSetWallpaper: (item: ImageItem, style?: string) => void;
  onReplaceItem: (item: ImageItem) => void;
  /** 标注数量变化，父级更新图库卡片的角标 */
  onAnnotCount?: (id: number, n: number) => void;
  onEnhance: (item: ImageItem) => void;
  enhancing?: boolean;
  /** 标记已看后回传，父级同步列表状态（未看过角标会消失） */
  onViewed?: (item: ImageItem) => void;
  onDownload?: (item: ImageItem) => void;
  /** 星级 / 备注等自定义字段 */
  onPatch?: (item: ImageItem, patch: Partial<Pick<ImageItem, 'rating' | 'note'>>) => void;
  /** 按主色系筛选（跳到图库并只看同色系）；'gray' 表示黑白灰 */
  onFindColor?: (hue: string) => void;
  /** 跳到某张相似图：pool 为「当前图 + 相似结果」，id 为要看的图 */
  onOpenSimilar?: (pool: ImageItem[], id: number) => void;
  /** 去背景等操作的结果提示 */
  onChangeToast?: (msg: string) => void;
  /** 当前资源库：详情面板里显示「这张图属于哪个库」 */
  library?: { id?: string; name: string; path: string } | null;
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const SLIDE_SECONDS = [3, 5, 10, 20];
/** 缩略图条只渲染当前附近的这些张，避免几百张时卡顿 */
const THUMB_WINDOW = 48;

/**
 * 轮子所在的那条链路上，有没有**还能往这个方向继续滚**的容器。
 *
 * 用途：灯箱的滚轮默认翻图，但只要指针压在一个可滚动的浮层（更多菜单、弹窗列表、
 * 信息栏）上，滚轮就应该归那个容器。判断「还能不能滚」比「是不是某个类名」更准：
 * 列表滚到底之后再滚，就该继续翻图，而不是整块死掉。
 */
function scrollsUnder(start: HTMLElement | null, deltaY: number): boolean {
  // 只看到灯箱根为止：外面的 .content 也在滚，把它算进来就再也翻不了图了
  const stop = start?.closest('.lightbox') ?? null;
  for (let el = start; el && el !== stop; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    if (el.scrollHeight - el.clientHeight < 2) continue;
    if (style.overflowY === 'hidden') continue;
    const room = deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    if (room) return true;
  }
  return false;
}

export default function Lightbox({
  items,
  index,
  onClose,
  onIndex,
  onToggleFavorite,
  onSaveTags,
  onDelete,
  onSetWallpaper,
  onReplaceItem,
  onAnnotCount,
  onEnhance,
  enhancing,
  onViewed,
  onDownload,
  onPatch,
  onFindColor,
  onOpenSimilar,
  onChangeToast,
  library,
}: Props) {
  const item = items[index];
  const [tagInput, setTagInput] = useState('');
  /* 该图归属的文件夹：补上「能加不能移」的缺口（Eagle 里详情区可直接移出） */
  const [imgFolders, setImgFolders] = useState<{ id: number; name: string; parent_id: number | null; path: string }[]>([]);
  const [rotating, setRotating] = useState<'cw' | 'ccw' | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [slideSec, setSlideSec] = useState(5);
  const [showThumbs, setShowThumbs] = useState(true);
  const [chrome, setChrome] = useState(true); // 幻灯片播放时自动隐藏界面
  const [aiDesc, setAiDesc] = useState<{ description?: string; issues?: string[]; quality?: number } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [matting, setMatting] = useState(false); // 去背景进行中
  const [imgLoaded, setImgLoaded] = useState(false); // 主图解码完成前用缩略图垫底
  const [previewFailed, setPreviewFailed] = useState(false); // 预览图不可用 → 回退原图
  /** 垫底图：优先用上一张成功加载的预览图（比 640 缩略图清楚得多），首次进来才是缩略图 */
  const [backdropSrc, setBackdropSrc] = useState(() => {
    // 初值直接给当前图的缩略图：等 useEffect 里再设会有一次空帧（白闪）
    const first = items[index];
    return first?.thumbUrl ? BASE + first.thumbUrl : '';
  });
  /** 已换成原图：放大看细节、进调色台时才需要，浏览状态下不拉 20MB 的原图 */
  const [hq, setHq] = useState(false);
  /* ---------------- 标注 / 评论（Eagle Annotations） ---------------- */
  const [annoMode, setAnnoMode] = useState(false);
  const [annoCount, setAnnoCount] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [cmtCount, setCmtCount] = useState(0);
  /* ---------------- 编辑（裁切面板 / 全屏调色台） ---------------- */
  const [editor, setEditor] = useState<null | 'crop'>(null);
  // 裁切参数与批量裁切台同一套（尺寸/比例/焦点），只是框铺在预览界面上
  const [crop, setCrop] = useState<CropControlState>(() => defaultCropControls('free'));
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, w: 1, h: 1 });
  const [cropFocusBusy, setCropFocusBusy] = useState(false);
  const [adjust, setAdjust] = useState<AdjustParams>(ADJUST_DEFAULTS);
  const [saving, setSaving] = useState(false);
  // 同步锁：saving 是 state，要等下一次渲染才生效，而确认弹窗是 await，
  // 中间这段时间连点两次「确认」会提交两次裁切（第二次裁的是已裁过的图）。
  const saveLockRef = useRef(false);
  // 调色台：独立全屏界面，图上吸管取样的读数留给面板显示
  const [colorRoom, setColorRoom] = useState(false);
  const [sample, setSample] = useState<WbSample | null>(null);
  const colorRoomRef = useRef(false);
  colorRoomRef.current = colorRoom;
  // 保存方式：默认覆盖原图；切到「另存副本」时默认落在原图所在目录
  const [moreOpen, setMoreOpen] = useState(false); // 顶部「更多」菜单
  // 哪些「更多」里的功能被用户挪到了顶栏（顺序即显示顺序）
  const [pinnedActs, setPinnedActs] = usePinnedActions('lightbox', LB_PINNED_DEFAULT);
  const [tczOpen, setTczOpen] = useState(false); // 自定义工具栏面板
  const [wmOpen, setWmOpen] = useState(false); // 水印 / 相框工作台
  const [rotOpen, setRotOpen] = useState(false); // 旋转方向菜单（左转 / 右转）
  // 底部详情：默认只留一行摘要，要看完整字段再展开；选择记在本地，下次还按上次的样子
  const [infoOpen, setInfoOpen] = useState(() => localStorage.getItem('gem:lb-info') === '1');
  // 素材工具箱（检查器 / OCR / 来源 / 版本 / 多区域裁切）；点开后只加载当前页签的数据
  const [toolkit, setToolkit] = useState<ToolkitTab | null>(null);
  // 图片对比：默认拿「当前 + 下一张」，可换两侧
  const [cmpIds, setCmpIds] = useState<{ left: number; right: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [wpPreviewOpen, setWpPreviewOpen] = useState(false); // 「导出为图片」对话框
  const [saveMode, setSaveMode] = useState<'overwrite' | 'copy'>('overwrite');
  const [targetDir, setTargetDir] = useState('');
  const [addToLibrary, setAddToLibrary] = useState(true);
  // 图片在 lightbox-body 内的实际渲染矩形（裁切选框与调色叠加层据此定位）
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const editorRef = useRef<null | 'crop' | 'color'>(null);
  editorRef.current = editor;
  const annoRef = useRef(false);
  annoRef.current = annoMode;
  // 「找相似」面板：相似度阈值可调，结果可点击跳转
  const [sim, setSim] = useState<{
    open: boolean;
    minCos: number;
    items: ImageItem[];
    loading: boolean;
    error: string;
  }>({ open: false, minCos: 0.9, items: [], loading: false, error: '' });

  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const draggedRef = useRef(false);
  const wheelAcc = useRef(0);
  const wheelLock = useRef(0);
  const hideTimer = useRef<number | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const imgRef = useRef<HTMLImageElement | null>(null);

  /* 卸载兜底：幻灯片播放中直接关闭时，隐藏界面的定时器不再逃逸 */
  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    []
  );

  const currentId = item?.id;

  /* ------- 找相似：面板打开 / 阈值变化 / 切图后自动（防抖）拉取 ------- */
  useEffect(() => {
    if (!sim.open || !currentId) return;
    const timer = window.setTimeout(() => {
      setSim((s) => ({ ...s, loading: true, error: '' }));
      api
        .similarTo(currentId, sim.minCos)
        .then((r) => setSim((s) => ({ ...s, items: r.items, loading: false })))
        .catch((err) => setSim((s) => ({ ...s, loading: false, error: (err as Error).message })));
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.open, sim.minCos, currentId]);

  /* ------- 归属文件夹：切图后按需拉取（列表接口不返回，避免每行多一次 JOIN） ------- */
  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    api
      .imageFolders(currentId)
      .then((r) => {
        if (!cancelled) setImgFolders(r.folders);
      })
      .catch(() => {
        if (!cancelled) setImgFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  /* ------------------------- 切换图片：重置视图并标记已看 ------------------------- */
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setEditor(null); // 切图时退出编辑，避免把上一张的裁切框/调色参数套到新图
    setMoreOpen(false);
    setAnnoMode(false);
    setCommentsOpen(false);
    const cur = items[indexRef.current];
    if (!cur) return;
    // 快速连按切换时，上一个图的请求可能晚于本次返回：用 cancelled 守卫
    // 丢弃过期响应，避免旧图描述/已看状态串到新图上（乱序问题）
    let cancelled = false;
    api
      .markViewed(cur.id)
      .then((r) => {
        if (!cancelled) onViewed?.(r.item);
      })
      .catch(quiet);
    // 缩略图条滚到当前项
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-thumb="${cur.id}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
    // 标注 / 评论数量：给按钮上的数字角标用（顺带预热，点开面板更快）
    api
      .annotations(cur.id)
      .then((r) => {
        if (!cancelled) setAnnoCount(r.items.length);
      })
      .catch(quiet);
    api
      .comments(cur.id)
      .then((r) => {
        if (!cancelled) setCmtCount(r.comments.length);
      })
      .catch(quiet);
    // 换图：先让缩略图垫底，等新图解码完再撤
    setImgLoaded(false);
    setPreviewFailed(false);
    setHq(false); // 新图先用 1920 的预览图，放大到 1.4 倍以上才去拉原图
    setBackdropSrc(cur.thumbUrl ? BASE + cur.thumbUrl : '');
    // 读缓存里的 AI 描述（有就显示，没有等用户点「AI 识图」）
    setAiDesc(null);
    api
      .aiDesc(cur.id)
      .then((d) => {
        if (!cancelled && d?.description) setAiDesc(d);
      })
      .catch(quiet);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  /* ------- 预加载前后各一张：切换时先有画面，清晰版随后补齐 -------
   * 只预加载图像（视频/音频的 url 丢给 Image 只会白白请求一遍 404/大文件），
   * 并且连按方向键时把上一轮的请求取消掉，不然一次翻十张会在后台压十条下载。
   * 以前预加载的是原图：连翻几张就是几个 MB 同时下载，反而把用户正看的这张挤慢了。
   * 现在缩略图 + 预览图各预一份：缩略图保证「立刻有画面」，预览图保证换过去就是清晰的。 */
  useEffect(() => {
    const preloaded: HTMLImageElement[] = [];
    for (const it of [items[index + 1], items[index - 1]]) {
      if (!it) continue;
      const kind = it.mediaKind || 'image';
      if (kind !== 'image' && kind !== 'gif') continue;
      const thumb = new Image();
      thumb.src = BASE + (it.thumbUrl || it.url);
      preloaded.push(thumb);
      const pv = new Image();
      // 必须和主图完全同一个 URL（含 ?v=），否则预加载进的是另一份缓存，点开还要再请求
      pv.src = `${BASE}${it.previewUrl || `/api/images/${it.id}/preview`}`;
      preloaded.push(pv);
    }
    return () => {
      // src='' 会中止尚未完成的请求（Chrome/Electron 有效），已缓存的不受影响
      for (const img of preloaded) img.src = '';
    };
  }, [index, items]);

  /* ------- 放大到 1.4 倍以上才去拉原图 -------
   * 1920 的预览图在 1.4 倍内还够看，再往上就明显糊；而浏览状态下把 20MB 的原图
   * 拉进来既慢又占内存。hq 一旦为 true 就不再退回（已经加载好了，没必要再来一次）。 */
  useEffect(() => {
    if (zoom > 1.4 && !hq) setHq(true);
  }, [zoom, hq]);

  /* --------------------------- 缩放（鼠标位置为锚点） --------------------------- */
  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const z = zoomRef.current;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor));
    if (Math.abs(next - z) < 0.001) return;
    const o = offsetRef.current;
    const rect = bodyRef.current?.getBoundingClientRect();
    const cx = clientX - ((rect?.left || 0) + (rect?.width || 0) / 2);
    const cy = clientY - ((rect?.top || 0) + (rect?.height || 0) / 2);
    const k = next / z;
    setZoom(next);
    setOffset(next <= 1.001 ? { x: 0, y: 0 } : { x: cx - (cx - o.x) * k, y: cy - (cy - o.y) * k });
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  /* --------------------- 滚轮：Ctrl 缩放，普通滚轮切换图片 --------------------- */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 调色台是独立界面，滚轮只归它自己（缩放预览 / 滚动面板），不能切换图片
      if (colorRoomRef.current) return;
      const t = e.target as HTMLElement | null;
      /**
       * 只有**图片舞台**上的滚轮才翻页 / 缩放。
       * 之前的写法是「排除一串类名」，底部缩略图条、信息栏、顶栏工具条一旦
       * 漏在名单外，轮子事件就从它们冒泡到 .lightbox 被当成「翻下一张」——
       * 用户滚缩略图条结果画面跳走了。这里反过来做白名单：舞台之外的滚轮一律不管，
       * 以后新加任何浮层都不会再犯这个错。
       */
      if (!t?.closest?.('.lightbox-body')) return;
      // 舞台里也有不该翻页的区域：左右箭头、缩放条、相似面板、视频/PDF 控件
      if (t.closest('.lightbox-nav, .lightbox-zoom, .lb-sim-panel, .mv-wrap, .lb-more-menu, .modal-backdrop')) return;
      // 通用兜底：轮子悬在任何**还能继续滚**的容器上时，把滚动留给它自己。
      if (scrollsUnder(t, e.deltaY)) return;
      // 编辑 / 标注期间禁止缩放：CropOverlay 与标注图层都用「测出来的显示尺寸」换算坐标，
      // 缩放后 frame 不会更新 → 看到的框和实际裁的区域、标注落点全部错位。
      if (editorRef.current || annoRef.current) {
        if (e.ctrlKey || e.metaKey) e.preventDefault(); // 也别让 Chromium 整体缩放页面
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); // 阻止浏览器整体缩放
        zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        return;
      }
      const now = Date.now();
      if (now < wheelLock.current) return;
      const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY; // 行模式归一化
      wheelAcc.current += delta;
      if (Math.abs(wheelAcc.current) < 40) return;
      const next = indexRef.current + (wheelAcc.current > 0 ? 1 : -1);
      wheelAcc.current = 0;
      if (next < 0 || next >= items.length) return;
      wheelLock.current = now + 220;
      onIndex(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [items.length, onIndex, zoomAt]);

  /* ---------------------------- 幻灯片自动播放 ---------------------------- */
  useEffect(() => {
    if (!playing || items.length < 2) return;
    const timer = window.setInterval(() => {
      const i = indexRef.current;
      onIndex(i + 1 >= items.length ? 0 : i + 1);
    }, slideSec * 1000);
    return () => window.clearInterval(timer);
  }, [playing, slideSec, items.length, onIndex]);

  /** 播放时界面自动隐藏：鼠标一动就出来 2.5 秒 */
  const pokeChrome = useCallback(() => {
    if (!playing) return;
    setChrome(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 2500);
  }, [playing]);

  useEffect(() => {
    if (!playing) {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      setChrome(true);
      return;
    }
    setChrome(false);
    pokeChrome();
  }, [playing, pokeChrome]);

  // 预览期间锁定底层页面滚动（滚轮用于切换/缩放）
  useEffect(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    const prev = content?.style.overflow || '';
    // overflow:hidden 期间浏览器可能把滚动位置夹到 0（内容高度暂时算不出来时），
    // 恢复时再写回打开前的值，否则关掉预览会莫名回到顶部/停在空白处
    const prevTop = content?.scrollTop || 0;
    if (content) content.style.overflow = 'hidden';
    return () => {
      if (!content) return;
      content.style.overflow = prev;
      if (Math.abs(content.scrollTop - prevTop) > 1) content.scrollTop = prevTop;
      // overflow 恢复不会触发 scroll/resize，MasonryGrid 缓存的可视区间不会重算，
      // 关闭预览后网格会停在打开前那一刻（表现像卡死）。手动踢一次 scroll + resize 重测。
      content.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    };
  }, []);

  /* -------------------------------- 键盘快捷键 -------------------------------- */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return; // 输入标签时不要触发快捷键
      }
      // 调色台打开时快捷键全交给它自己处理，别在背后切图/缩放
      if (colorRoomRef.current) return;
      // 工具箱 / 对比图层在最上面：Esc 与方向键属于它们，别顺手把灯箱也关了
      if (document.querySelector('.tk-backdrop, .cmp-overlay')) return;
      // 标注模式：ESC 只退出标注，不关预览、不切图
      if (annoRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setAnnoMode(false);
        }
        return;
      }
      // 编辑模式下：ESC 只退出编辑，方向键不切图（避免丢掉未保存的裁切）
      if (editorRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setEditor(null);
        }
        return;
      }
      const i = indexRef.current;
      if (e.key === 'Escape') {
        // 菜单开着时先收菜单（和系统菜单一致），再退播放，最后才关大图
        if (moreOpen || rotOpen) {
          setMoreOpen(false);
          setRotOpen(false);
        } else if (playing) setPlaying(false);
        else onClose();
      } else if (e.key === 'ArrowLeft') {
        onIndex(Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        onIndex(Math.min(items.length - 1, i + 1));
      } else if (e.key === ' ') {
        e.preventDefault();
        // 空格是「快速预览」的开关：可播放的媒体仍是播放/暂停，静态图直接退出预览
        const kind = items[i]?.mediaKind || 'image';
        if (kind === 'video' || kind === 'audio') setPlaying((p) => !p);
        else onClose();
      } else if (e.key === '+' || e.key === '=') {
        const r = bodyRef.current?.getBoundingClientRect();
        zoomAt((r?.left || 0) + (r?.width || 0) / 2, (r?.top || 0) + (r?.height || 0) / 2, 1.25);
      } else if (e.key === '-') {
        const r = bodyRef.current?.getBoundingClientRect();
        zoomAt((r?.left || 0) + (r?.width || 0) / 2, (r?.top || 0) + (r?.height || 0) / 2, 1 / 1.25);
      } else if (e.key === '0') {
        resetZoom();
      } else if (/^[1-5]$/.test(e.key)) {
        // 1~5 直接打星，再按同一颗清除（Eagle 的手感）
        const cur = items[indexRef.current];
        if (cur) onPatch?.(cur, { rating: cur.rating === Number(e.key) ? 0 : Number(e.key) });
      } else if (e.key === 'i' || e.key === 'I') {
        // 详情抽屉开关（和顶栏「信息」按钮同一个状态）
        setInfoOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [items.length, playing, moreOpen, rotOpen, onClose, onIndex, resetZoom, zoomAt, onPatch]);

  /* --------------- 编辑：图片渲染矩形测量与调色预览（hooks 需在早退之前） --------------- */
  const measureFrame = useCallback(() => {
    const img = imgRef.current;
    const body = bodyRef.current;
    if (!img || !body) return;
    const ir = img.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    setFrame({ left: ir.left - br.left, top: ir.top - br.top, width: ir.width, height: ir.height });
  }, []);

  // 打开编辑器 / 进入标注 / 窗口尺寸变化 → 重测（图片加载完成也在 onLoad 里补一次）
  // 只在 editor 时测是不够的：标注模式用的是同一个 frame，从来没人给它测量过，
  // 于是标注坐标基于 0×0（或上一次裁切的旧值）换算，落点整体偏移。
  useEffect(() => {
    if (!editor && !annoMode) return;
    const raf = requestAnimationFrame(measureFrame);
    // 进入编辑会把 zoom 复位到 1，而 transform 带过渡动画：rAF 那一帧量到的是过渡中间值，
    // 过渡结束后（>200ms）必须补测一次，否则一开始就是错的基准框。
    const settle = window.setTimeout(measureFrame, 240);
    const onResize = () => measureFrame();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      window.removeEventListener('resize', onResize);
    };
  }, [editor, annoMode, measureFrame]);

  // 「更多」菜单：点页面任意处关闭（菜单内部阻止冒泡，避免点菜单项时先被关掉）
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [moreOpen]);

  // 旋转方向菜单同理
  useEffect(() => {
    if (!rotOpen) return;
    const close = () => setRotOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [rotOpen]);

  // 详情折叠状态持久化
  useEffect(() => {
    localStorage.setItem('gem:lb-info', infoOpen ? '1' : '0');
  }, [infoOpen]);


  if (!item) return null;

  /** 图片走原有的缩放/裁切/调色管线；GIF 及其它媒体交给 MediaViewer 播放 */
  const isImage = (item.mediaKind || 'image') === 'image';
  const isAnnotatable = isImage;

  /* 主图地址：默认走 1920 的预览图（300~550KB，磁盘命中时 3ms 就能开始解码），
   * 只有「调色台要读原始像素」「放大看细节」「预览图缺失」这三种情况才加载原图。
   * 以前一律加载原图，6000×4000 的 20MB JPG 光解码就要一两秒，这就是模糊的来源。 */
  // 带文件版本号（DTO 里给的）：同一张图重复打开直接命中浏览器缓存，不走条件请求
  const previewUrl = `${BASE}${item.previewUrl || `/api/images/${item.id}/preview`}`;
  const mainSrc = colorRoom || previewFailed || hq ? item.url : previewUrl;

  /* 这张图的主色板：优先用导入时 MMCQ 提取的 palette，缺失时退回单一主色 */
  const paletteColors = (() => {
    const list = (item.palette || []).map((c) => c.h).filter((h) => /^#[0-9a-f]{6}$/i.test(h));
    if (list.length) return list.slice(0, 12);
    return item.dominant && /^#[0-9a-f]{6}$/i.test(item.dominant) ? [item.dominant] : [];
  })();
  const safeName = (t: string) =>
    t.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'palette';

  /* ---------------------- 编辑：打开 / 关闭 / 保存 ---------------------- */
  /**
   * 抠图：mode='ai' 走 U-2-Net 人像分割（要模型），mode='flat' 走纯底图抠图（零模型）。
   * AI 模型没装时后端回 409，这里顺手把下载挂上，免得用户还要自己去设置页找。
   */
  const runCut = async (mode: 'ai' | 'flat') => {
    setMatting(true);
    try {
      // 先问一句模型在不在：没下载就直接开始下载并引导，不做一次注定失败的请求
      if (mode === 'ai') {
        const st = await api.mattingStatus();
        if (!st.downloaded) {
          if (!st.downloading) void api.mattingInstall().catch(() => undefined);
          onChangeToast?.(
            st.downloading
              ? 'AI 抠图模型正在下载（约 4.5MB），下完再点一次；白底/灰底图现在就能用「纯底图抠图」'
              : 'AI 抠图模型还没下载，已在后台开始下载（约 4.5MB）；白底/灰底图现在就能用「纯底图抠图」'
          );
          return;
        }
      }
      const r = await api.removeBackground(item.id, mode);
      if (!r.ok) {
        onChangeToast?.(`抠图失败：${r.reason || '未知原因'}`);
        return;
      }
      // 后端发现前景占比异常时会给 warning：别把废图说成「成功」
      if (r.warning) onChangeToast?.(`已生成，但${r.warning}`);
      else if (mode === 'flat') onChangeToast?.(`已生成透明底版本（纯底图抠图，前景 ${Math.round((r.coverage || 0) * 100)}%）`);
      else onChangeToast?.('已生成去背景版本，已存入图库');
    } catch (err) {
      const msg = (err as Error).message || '';
      if (mode === 'ai' && /模型|下载/.test(msg)) {
        // 缺模型：顺手开始后台下载，并告诉用户下完再来
        void api.mattingInstall().catch(() => undefined);
        onChangeToast?.('AI 抠图模型还没下载，已在后台开始下载（约 4.5MB）；白底/灰底图现在就能用「纯底图抠图」');
      } else {
        onChangeToast?.(`抠图失败：${msg}`);
      }
    } finally {
      setMatting(false);
    }
  };

  const openEditor = (mode: 'crop' | 'color') => {
    setCrop(defaultCropControls('free'));
    setCropRect({ x: 0, y: 0, w: 1, h: 1 });
    setAdjust(ADJUST_DEFAULTS);
    setSample(null);
    // 另存副本默认落在原图所在目录，省一次选择
    setTargetDir((d) => d || dirOfPath(item.path || ''));
    // 调色走独立的全屏调色台，不再在预览界面上就地展开
    if (mode === 'color') {
      setColorRoom(true);
      return;
    }
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setEditor('crop');
  };

  const saveOpts: EditSaveOptions =
    saveMode === 'copy' ? { saveMode: 'copy', targetDir: targetDir.trim(), addToLibrary } : { saveMode: 'overwrite' };

  const closeEditor = () => {
    setEditor(null);
    setSaving(false);
  };

  const imageAspect = item.width && item.height ? item.width / item.height : 1;
  const cropRatio = cropRatioStr(crop);
  const patchCrop = (p: Partial<CropControlState>) => setCrop((s) => ({ ...s, ...p }));
  const cropOut = cropOutputSize(crop);
  // 选框在原图像素上的实际尺寸（「不进行调整」时这就是输出尺寸）
  const cropPixels = {
    w: Math.round(cropRect.w * (item.width || 0)),
    h: Math.round(cropRect.h * (item.height || 0)),
  };

  /* 焦点检测：与批量裁切台同一个接口。序号令牌保证连点/切图时旧结果不会回填 */
  const focusSeq = useRef(0);
  const runCropFocus = async () => {
    const my = ++focusSeq.current;
    setCropFocusBusy(true);
    try {
      const r = await api.imageFocus(item.id, cropFocusRatio(crop, imageAspect));
      if (my === focusSeq.current && r?.rect) setCropRect(r.rect);
    } catch {
      /* 检测失败就保持居中，不打断用户 */
    } finally {
      if (my === focusSeq.current) setCropFocusBusy(false);
    }
  };

  // 换比例 / 换图 / 打开面板：选框回到居中最大；勾了自动焦点就再找一次主体
  useEffect(() => {
    if (editor !== 'crop') return;
    setCropRect(initialRect(cropRatio, imageAspect));
    if (crop.autoFocus) void runCropFocus();
    // 只在比例变化时重置：拖选框不该被拉回
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropRatio, item.id, editor]);

  /** 覆盖原图是不可逆写回：值得一次确认（副本模式不用问） */
  const confirmOverwrite = async (what: string) => {
    if (saveMode === 'copy') return true;
    return confirmDialog(`${what}将直接覆盖原文件（可用 Ctrl+Z 撤销最近一次）。继续？`);
  };

  const saveCrop = async () => {
    if (saveLockRef.current || saving) return;
    if (saveMode === 'copy' && !targetDir.trim()) {
      onChangeToast?.('请先选择副本保存位置');
      return;
    }
    // 先同步上锁再等确认：确认框还开着时第二次点击必须被挡掉
    saveLockRef.current = true;
    setSaving(true);
    try {
      if (!(await confirmOverwrite('裁切'))) return;
      const r = await api.cropImage(item.id, {
        ratio: cropRatio,
        rect: cropRect,
        outWidth: cropOut?.w,
        outHeight: cropOut?.h,
        ...saveOpts,
      });
      if (r.item) onReplaceItem(r.item); // 另存且未入库时 item 为 null，原图没变不用刷新
      // 按比例裁切会先找主体；没找到主体就走了居中，得告诉用户为什么裁在这里
      const focusNote = r.focus === 'center' ? '（未检测到明显主体，已居中裁切）' : '';
      onChangeToast?.(
        r.copied ? `裁切副本已保存：${r.savedPath}${r.note || ''}${focusNote}` : `裁切已保存到原文件${focusNote}`
      );
      closeEditor();
    } catch (err) {
      onChangeToast?.(`裁切失败：${(err as Error).message || '未知错误'}`);
    } finally {
      saveLockRef.current = false;
      setSaving(false);
    }
  };

  const saveAdjust = async () => {
    if (saveLockRef.current || saving) return;
    if (saveMode === 'copy' && !targetDir.trim()) {
      onChangeToast?.('请先选择副本保存位置');
      return;
    }
    // 与裁切同一把锁：调色写回原图同样是不可逆操作
    saveLockRef.current = true;
    setSaving(true);
    try {
      if (!(await confirmOverwrite('调色'))) return;
      const r = await api.adjustImage(item.id, { ...adjust, ...saveOpts });
      if (r.item) onReplaceItem(r.item);
      onChangeToast?.(
        r.copied ? `调色副本已保存：${r.savedPath}${r.note || ''}` : '调色已保存到原文件'
      );
      setColorRoom(false);
    } catch (err) {
      onChangeToast?.(`调色失败：${(err as Error).message || '未知错误'}`);
    } finally {
      saveLockRef.current = false;
      setSaving(false);
    }
  };

  const addTag = () => {
    const value = tagInput.trim();
    if (!value) return;
    if (!item.tags.includes(value)) onSaveTags(item, [...item.tags, value]);
    setTagInput('');
  };

  /** 物理旋转 90° 并保存到原文件 */
  const rotate = async (dir: 'cw' | 'ccw') => {
    if (rotating) return;
    setRotating(dir);
    try {
      const { item: updated } = await api.rotateImage(item.id, dir);
      onReplaceItem(updated);
    } catch (err) {
      onChangeToast?.(`旋转失败：${(err as Error).message || '未知错误'}`);
    } finally {
      setRotating(null);
    }
  };

  /* ------------------------------ 拖拽平移（放大后） ------------------------------ */
  // 拖拽期间每帧 mousemove 都 setState 会让整个 Lightbox（顶栏/缩略图条/侧栏）跟着重渲。
  // 改为：拖拽中只更新 offsetRef 并直写 img 的 transform（跳过 React），松手时一次性同步 state。
  const applyTransform = () => {
    const el = imgRef.current;
    if (!el) return;
    const o = offsetRef.current;
    el.style.transform = `translate(${o.x}px, ${o.y}px) scale(${zoomRef.current})`;
  };
  const onMouseDown = (e: React.MouseEvent) => {
    if (editorRef.current) return; // 编辑中拖拽用于调框，不触发缩放平移
    if (annoMode) return; // 标注时拖拽是画框，不移动图片
    if (zoomRef.current <= 1.001) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y };
    draggedRef.current = false;
    setDragging(true);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    pokeChrome();
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) draggedRef.current = true;
    offsetRef.current = { x: d.ox + dx, y: d.oy + dy };
    if (imgRef.current) imgRef.current.style.transition = 'none';
    applyTransform();
  };
  const endDrag = () => {
    const wasDragging = !!dragRef.current;
    dragRef.current = null;
    if (wasDragging) {
      setOffset({ ...offsetRef.current }); // 一次重渲把最终位置同步进 state
      if (imgRef.current) imgRef.current.style.transition = '';
    }
    setDragging(false);
  };
  const onBodyClick = () => {
    // 拖拽平移结束时不要误关
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    if (editorRef.current || annoMode) return; // 编辑/标注中点击画面不关闭查看器
    if (playing) return; // 播放中点击不关闭
    onClose();
  };
  const toggleZoom = (e: React.MouseEvent) => {
    if (editorRef.current || annoMode) return;
    if (zoomRef.current > 1.001) resetZoom();
    else zoomAt(e.clientX, e.clientY, 2.5);
  };

  // 缩略图条：只渲染当前附近的一段
  const from = Math.max(0, Math.min(index - THUMB_WINDOW / 2, items.length - THUMB_WINDOW));
  const to = Math.min(items.length, from + THUMB_WINDOW);
  const strip = items.slice(from, to);

  /**
   * 「更多」菜单的条目清单。
   * 之前这些按钮是硬编码在 JSX 里的，用户想把常用的挪到顶栏只能提需求；
   * 现在改成数据表 + 自定义面板（ToolbarCustomizer），谁常用谁自己挪。
   */
  const acts: {
    key: string;
    label: string;
    short?: string;
    icon: React.ReactNode;
    title: string;
    run: () => void;
    disabled?: boolean;
    group: 'edit' | 'wall' | 'tool' | 'io' | 'view';
    show?: boolean;
  }[] = [
    {
      key: 'enhance',
      label: enhancing ? '增强中…' : '画质增强',
      icon: <IconWand />,
      title: '按「设置 → 画质增强」里的目标标准与模型放大（AI 模型需先下载运行库），结果覆盖原文件',
      disabled: !isImage || !!rotating || !!enhancing,
      group: 'edit',
      run: () => onEnhance(item),
    },
    {
      key: 'watermark',
      label: '水印 / 相框…',
      icon: '🖋',
      title: '读取拍摄信息（品牌型号 / 光圈 / 快门 / ISO / 时间 / 地点）加水印，或加白框黑框等相框',
      disabled: !isImage,
      group: 'edit',
      run: () => setWmOpen(true),
    },
    {
      key: 'anno',
      label: `图上标注${annoCount > 0 ? `（${annoCount}）` : ''}`,
      icon: '✏',
      title: '图上标注：矩形 / 箭头 / 文字 / 马赛克 / 画笔，自动保存',
      group: 'edit',
      show: isAnnotatable,
      run: () => {
        setAnnoMode((v) => !v);
        resetZoom();
      },
    },
    {
      key: 'matte-ai',
      label: matting ? '抠图中…' : 'AI 抠图（人像 / 宠物）',
      icon: '✂',
      title: 'AI 抠图（U-2-Net 人像分割）：适合人物/宠物，风景与物体效果差；模型约 4.5MB，没下载会自动开始下载',
      disabled: !isImage || matting,
      group: 'edit',
      run: () => void runCut('ai'),
    },
    {
      key: 'matte-flat',
      label: '纯底图抠图（白底 / 灰底）',
      icon: '✂',
      title: '纯底图抠图：白底、灰底、蓝底、绿幕等单一颜色背景，纯像素处理、不用模型、秒出',
      disabled: !isImage || matting,
      group: 'edit',
      run: () => void runCut('flat'),
    },
    {
      key: 'wallpaper',
      label: '设为桌面壁纸',
      icon: <IconWallpaper />,
      title: '设为桌面壁纸（竖版图会合成为「完整竖图居中 + 模糊同图铺底」，不裁切）',
      group: 'wall',
      run: () => onSetWallpaper(item),
    },
    {
      key: 'wallpaper-preview',
      label: '壁纸效果预览…',
      icon: '🖥',
      title: '先看看这张图在实际屏幕上合成后的样子（不裁切、不拉伸），再决定是否设置',
      group: 'wall',
      run: () => setWpPreviewOpen(true),
    },
    {
      key: 'toolbox',
      label: '素材工具箱…',
      icon: '🧰',
      title: '看尺寸 / 格式 / EXIF，或识别图里的文字、查来源、恢复旧版本',
      group: 'tool',
      run: () => setToolkit('info'),
    },
    {
      key: 'ocr',
      label: '图内文字（OCR）…',
      short: 'OCR',
      icon: '🔤',
      title: '复制图里的文字（识别后也能用关键词搜到）',
      group: 'tool',
      run: () => setToolkit('ocr'),
    },
    {
      key: 'source',
      label: '来源 / 换大图…',
      short: '换大图',
      icon: '🌐',
      title: '以图搜图找原出处，或检测并替换成更大的版本',
      group: 'tool',
      show: isImage,
      run: () => setToolkit('source'),
    },
    {
      key: 'versions',
      label: '版本历史…',
      short: '版本',
      icon: '🕘',
      title: '每次裁切 / 调色 / 换大图前的原图都留着，可随时换回',
      group: 'tool',
      run: () => setToolkit('versions'),
    },
    {
      key: 'compare',
      label: '图片对比…',
      short: '对比',
      icon: '↔',
      title: '并排 / 分割 / 重叠三种方式与另一张对比',
      group: 'tool',
      show: isImage && items.length > 1,
      run: () => setCmpIds({ left: item.id, right: items[(index + 1) % items.length].id }),
    },
    {
      key: 'download',
      label: '下载',
      icon: <IconDownload />,
      title: '另存为',
      group: 'io',
      show: !!onDownload,
      run: () => onDownload?.(item),
    },
    {
      key: 'copy',
      label: '复制图片',
      short: '复制',
      icon: <IconCopy />,
      title: '复制到系统剪贴板，可直接粘到微信 / PPT / 文档里',
      group: 'io',
      run: () => {
        void copyImageToClipboard(item.url).then(
          () => onChangeToast?.('已复制到剪贴板'),
          (err: Error) => onChangeToast?.(`复制失败：${err.message}`)
        );
      },
    },
    {
      key: 'export',
      label: '导出为图片…',
      short: '导出',
      icon: <IconDownload />,
      title: '转成 JPEG / PNG / WebP / AVIF 另存，可改质量和尺寸',
      group: 'io',
      show: isImage,
      run: () => setExportOpen(true),
    },
    {
      key: 'reveal',
      label: '在文件夹中显示',
      icon: <IconFolder />,
      title: '在文件夹中显示',
      group: 'io',
      run: () => revealFile(item.path),
    },
    {
      key: 'slideshow',
      label: playing ? '暂停幻灯片' : '幻灯片播放',
      icon: playing ? '⏸' : '▶',
      title: '幻灯片自动播放（空格切换）',
      group: 'view',
      run: () => setPlaying((p) => !p),
    },
    {
      key: 'thumbs',
      label: showThumbs ? '隐藏底部缩略图' : '显示底部缩略图',
      short: '缩略图',
      icon: '▤',
      title: '显示/隐藏底部缩略图条',
      group: 'view',
      run: () => setShowThumbs((v) => !v),
    },
  ];
  const visible = acts.filter((a) => a.show !== false);
  const pinned = visible.filter((a) => pinnedActs.includes(a.key));
  const groupOrder: { key: 'edit' | 'wall' | 'tool' | 'io' | 'view'; name: string }[] = [
    { key: 'edit', name: '编辑' },
    { key: 'wall', name: '壁纸' },
    { key: 'tool', name: '工具' },
    { key: 'io', name: '导出与文件' },
    { key: 'view', name: '浏览' },
  ];
  // 菜单里剩下的（没被挪到顶栏的），空分组不渲染也不留分隔线
  const menuGroups = groupOrder
    .map((g) => ({ ...g, list: visible.filter((a) => a.group === g.key && !pinnedActs.includes(a.key)) }))
    .filter((g) => g.list.length > 0);

  return (
    <div
      ref={rootRef}
      className={`lightbox${playing ? ' playing' : ''}${chrome ? '' : ' hide-chrome'}`}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <div className="lightbox-top" onClick={(e) => e.stopPropagation()}>
        <div className="lb-top-left">
          <button className="btn ghost sm" onClick={onClose} title="关闭（ESC）">
            <IconClose />
            <span className="lb-txt">关闭</span>
            <span className="lb-txt-short">关闭</span>
          </button>
          <span className="lb-counter">
            {index + 1} / {items.length}
          </span>
          {/* 文件名：之前只有序号，连自己在看哪张都不知道（Eagle / 系统看图都放标题） */}
          <span className="lb-title" title={item.title}>
            {item.title}
          </span>
        </div>

        <div className="lb-top-actions">
          <button
            className={`btn sm${item.favorite ? ' primary' : ''}`}
            onClick={() => onToggleFavorite(item)}
            title={item.favorite ? '取消收藏' : '加入收藏'}
          >
            <IconHeart filled={item.favorite} />
            <span className="lb-txt">{item.favorite ? '已收藏' : '收藏'}</span>
            <span className="lb-txt-short">{item.favorite ? '已收藏' : '收藏'}</span>
          </button>
          <span className="lb-divider" />
          {/* 高频编辑只留三个：裁切 / 调色 / 旋转（左转右转合成一个下拉） */}
          <button
            className={`btn sm${editor === 'crop' ? ' primary' : ''}`}
            title="裁切：预设比例或自由框选，可覆盖原图或另存副本"
            disabled={!isImage || !!rotating || !!enhancing}
            onClick={() => (editor === 'crop' ? closeEditor() : openEditor('crop'))}
          >
            <IconExpand />
            <span className="lb-txt">裁切</span>
            <span className="lb-txt-short">裁切</span>
          </button>
          <button
            className={`btn sm${colorRoom ? ' primary' : ''}`}
            title="打开独立调色台：白平衡吸管 + 直方图 + 影调/色彩/细节 + RGB 曲线，可覆盖原图或另存副本"
            disabled={!isImage || !!rotating || !!enhancing}
            onClick={() => (colorRoom ? setColorRoom(false) : openEditor('color'))}
          >
            <IconSun />
            <span className="lb-txt">调色</span>
            <span className="lb-txt-short">调色</span>
          </button>
          <div className="lb-more-wrap">
            <button
              className={`btn sm${rotOpen ? ' primary' : ''}`}
              title="旋转 90° 并保存（左转 / 右转）"
              disabled={!isImage || !!rotating}
              onClick={() => setRotOpen((v) => !v)}
            >
              <IconRotateCw />
              <span className="lb-txt">{rotating ? '保存中…' : '旋转'}</span>
              <span className="lb-txt-short">{rotating ? '保存中…' : '旋转'}</span>
              <span className="lb-icon-only">↻</span>
            </button>
            {rotOpen && (
              <div className="lb-more-menu" onMouseDown={(e) => e.stopPropagation()}>
                <button
                  className="btn sm ghost"
                  title="逆时针旋转 90° 并保存"
                  onClick={() => {
                    setRotOpen(false);
                    rotate('ccw');
                  }}
                >
                  <IconRotateCcw /> 向左转 90°
                </button>
                <button
                  className="btn sm ghost"
                  title="顺时针旋转 90° 并保存"
                  onClick={() => {
                    setRotOpen(false);
                    rotate('cw');
                  }}
                >
                  <IconRotateCw /> 向右转 90°
                </button>
              </div>
            )}
          </div>
          <button
            className={`btn sm${commentsOpen ? ' primary' : ''}`}
            title="评论：记录用途、修改意见（Ctrl+Enter 发送）"
            onClick={() => setCommentsOpen((v) => !v)}
          >
            <span className="lb-icon-only">💬</span>
            <span className="lb-txt">评论{cmtCount > 0 ? ` ${cmtCount}` : ''}</span>
            <span className="lb-txt-short">评论{cmtCount > 0 ? ` ${cmtCount}` : ''}</span>
          </button>
          <button
            className={`btn sm${infoOpen ? ' lb-on' : ''}`}
            title="显示 / 隐藏详情信息（I）"
            onClick={() => setInfoOpen((v) => !v)}
          >
            <span className="lb-icon-only">ⓘ</span>
            <span className="lb-txt">信息</span>
            <span className="lb-txt-short">信息</span>
          </button>
          <span className="lb-divider" />
          {/* 用户自己挪到顶栏的常用项：由「更多 → 自定义工具栏」控制 */}
          {pinned.map((a) => (
            <button key={a.key} className="btn sm" title={a.title} disabled={a.disabled} onClick={a.run}>
              {a.icon}
              <span className="lb-txt">{a.short ?? a.label}</span>
              <span className="lb-txt-short">{a.short ?? a.label}</span>
            </button>
          ))}
          {/* 其余低频操作留在「更多」，菜单内容同样由上面那张数据表生成 */}
          <div className="lb-more-wrap">
            <button
              className={`btn sm${moreOpen ? ' primary' : ''}`}
              onClick={() => setMoreOpen((v) => !v)}
              title="更多操作（可在菜单底部自定义顶栏显示哪些）"
            >
              <span className="lb-icon-only">⋯</span>
              <span className="lb-txt">更多</span>
              <span className="lb-txt-short">更多</span>
            </button>
            {moreOpen && (
              <div className="lb-more-menu" onMouseDown={(e) => e.stopPropagation()}>
                {menuGroups.map((g, gi) => (
                  <React.Fragment key={g.key}>
                    {gi > 0 && <div className="lb-more-sep" />}
                    {g.list.map((a) => (
                      <button
                        key={a.key}
                        className="btn sm ghost"
                        title={a.title}
                        disabled={a.disabled}
                        onClick={() => {
                          setMoreOpen(false);
                          a.run();
                        }}
                      >
                        {a.icon} {a.label}
                      </button>
                    ))}
                  </React.Fragment>
                ))}
                <div className="lb-more-sep" />
                <div className="lb-more-row">
                  <span className="lb-more-label">幻灯片间隔</span>
                  <Select
                    className="select-sm"
                    value={slideSec}
                    onChange={(v) => setSlideSec(Number(v))}
                    title="幻灯片间隔"
                  >
                    {SLIDE_SECONDS.map((s) => (
                      <option key={s} value={s}>
                        {s} 秒
                      </option>
                    ))}
                  </Select>
                </div>
                <button
                  className="btn sm ghost"
                  title="选择哪些常用功能放到顶栏、按什么顺序排"
                  onClick={() => {
                    setMoreOpen(false);
                    setTczOpen(true);
                  }}
                >
                  ⚙ 自定义工具栏…
                </button>
              </div>
            )}
          </div>
          <button className="btn sm danger" onClick={() => onDelete(item)} title="删除（可撤销）">
            <IconTrash />
            <span className="lb-txt">删除</span>
            <span className="lb-txt-short">删除</span>
          </button>
        </div>
      </div>

      <div
        className="lightbox-body"
        ref={bodyRef}
        onClick={onBodyClick}
        onMouseDown={onMouseDown}
      >
        {index > 0 && (
          <button
            className="lightbox-nav prev"
            onClick={(e) => {
              e.stopPropagation();
              onIndex(index - 1);
            }}
          >
            ‹
          </button>
        )}
        {isImage ? (
        <>
          {/* 垫底图：网格里已经请求过的缩略图 / 上一张的预览图，浏览器缓存命中，
              几乎瞬间就有画面，清晰版解码完再盖上来。 */}
          {!imgLoaded && backdropSrc && (
            <img
              // 垫底的是 640 缩略图要多糊（遮住像素块），是 1920 预览图就少糊一点
              className={`lightbox-blur${backdropSrc.includes('-pv.') ? ' is-hd' : ''}`}
              src={backdropSrc}
              alt=""
              aria-hidden
              draggable={false}
            />
          )}
          <img
            key={item.id}
            ref={imgRef}
            src={mainSrc}
            alt={item.title}
            decoding="async"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={toggleZoom}
            onError={() => {
              // 预览图生成失败 / 文件损坏：退回原图，别让灯箱空着
              if (!previewFailed && !hq) setPreviewFailed(true);
            }}
            onLoad={(e) => {
              setImgLoaded(true);
              // 记住「已经显示出来的这张」，放大换原图时拿它垫底，不会闪白
              setBackdropSrc(e.currentTarget.currentSrc || mainSrc);
              measureFrame();
            }}
            draggable={false}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              transition: dragging ? 'none' : 'transform 0.16s ease-out',
              cursor: editor
                ? 'default'
                : zoom > 1.001
                  ? dragging
                    ? 'grabbing'
                    : 'grab'
                  : 'zoom-in',
            }}
          />
        </>
        ) : (
          /* 视频 / 音频 / 字体 / PDF / Office / 3D 等交给 MediaViewer 播放或预览 */
          <MediaViewer item={item} onReplaceItem={onReplaceItem} onToast={onChangeToast} />
        )}
        {/* 裁切选框：铺在图片实际渲染区域上 */}
        {editor === 'crop' && frame.width > 0 && (
          <CropOverlay
            frame={frame}
            imageAspect={imageAspect}
            ratio={cropRatio}
            value={cropRect}
            onChange={setCropRect}
          />
        )}
        {/* 标注图层：跟随图片实际渲染矩形，坐标存相对原图比例 */}
        {annoMode && isAnnotatable && (
          <AnnotationLayer
            imageId={item.id}
            imageUrl={item.url}
            frame={frame}
            onCount={(n) => {
              setAnnoCount(n);
              onAnnotCount?.(item.id, n);
            }}
            onToast={onChangeToast}
          />
        )}
        {index < items.length - 1 && (
          <button
            className="lightbox-nav next"
            onClick={(e) => {
              e.stopPropagation();
              onIndex(index + 1);
            }}
          >
            ›
          </button>
        )}
        {zoom > 1.001 && (
          <div className="lightbox-zoom" onClick={(e) => e.stopPropagation()}>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={resetZoom}>重置</button>
          </div>
        )}
      </div>

      {/* 找相似悬浮面板：覆盖在图片区右侧，不挤占信息栏 */}
      {sim.open && (
        <div className="lb-sim-panel" onClick={(e) => e.stopPropagation()}>
          <div className="lb-sim-head">
            <b>找相似</b>
            <input
              type="range"
              min={0.8}
              max={0.98}
              step={0.01}
              value={sim.minCos}
              style={{ flex: 1 }}
              onChange={(e) => setSim((s) => ({ ...s, minCos: Number(e.target.value) }))}
            />
            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
              ≥ {(sim.minCos * 100).toFixed(0)}%
            </span>
            <button className="btn sm ghost" onClick={() => setSim((s) => ({ ...s, open: false }))}>
              ✕
            </button>
          </div>
          <div className="lb-sim-grid">
            {sim.loading && <span className="lb-sim-empty">搜索中…</span>}
            {!sim.loading && sim.error && <span className="lb-sim-empty" style={{ color: 'var(--err, #e5484d)' }}>{sim.error}</span>}
            {!sim.loading && !sim.error && !sim.items.length && (
              <span className="lb-sim-empty">该阈值下没有相似图片，把滑杆往左调低试试</span>
            )}
            {!sim.loading &&
              sim.items.map((it) => (
                <button
                  key={it.id}
                  className="lb-sim-item"
                  title={`${it.title} · ${it.width}×${it.height}`}
                  onClick={() => onOpenSimilar?.([item, ...sim.items], it.id)}
                >
                  <img src={it.thumbUrl} alt={it.title} loading="lazy" />
                  <span className="lb-sim-cos">{(it.cos! * 100).toFixed(1)}%</span>
                </button>
              ))}
          </div>
        </div>
      )}

      {/* 裁切面板：调色已改到独立的全屏调色台 */}
      {editor === 'crop' && (
        <div className="lb-edit-panel" onClick={(e) => e.stopPropagation()}>
          <div className="lb-edit-head">
            <b>裁切</b>
            <button className="btn sm ghost" onClick={closeEditor} title="放弃本次编辑">
              ✕
            </button>
          </div>

          <CropSettings
            value={crop}
            allowFree
            onChange={(p) => {
              patchCrop(p);
              if (p.autoFocus) void runCropFocus();
            }}
            busy={cropFocusBusy}
            outputHint={
              cropOut ? `输出 ${cropOut.w} × ${cropOut.h} px` : `裁切后 ${cropPixels.w} × ${cropPixels.h} px`
            }
            onCenter={() => setCropRect(initialRect(cropRatio, imageAspect))}
            onFocus={() => void runCropFocus()}
            centerLabel="重置居中"
            focusLabel="按焦点重新取景"
          />
          <div className="lb-edit-hint">拖动选框内部平移，拖四边/四角调整大小</div>

          {/* 保存方式：与批量裁切台同一个组件（覆盖原图 / 另存副本到自定目录） */}
          <SaveModeBlock
            value={{ saveMode, targetDir, addToLibrary }}
            count={1}
            overwriteHint="裁切会直接写回原文件（可用 Ctrl+Z 撤销最近一次）。"
            onChange={(p: Partial<SaveModeState>) => {
              if (p.saveMode !== undefined) setSaveMode(p.saveMode);
              if (p.targetDir !== undefined) setTargetDir(p.targetDir);
              if (p.addToLibrary !== undefined) setAddToLibrary(p.addToLibrary);
            }}
          />

          <div className="lb-edit-actions">
            <button
              className="btn sm ghost"
              onClick={() => {
                setCrop(defaultCropControls('free'));
                setCropRect(initialRect('free', imageAspect));
              }}
            >
              重置
            </button>
            <button className="btn sm primary" disabled={saving} onClick={saveCrop}>
              {saving ? '保存中…' : saveMode === 'copy' ? '另存裁切' : '保存裁切'}
            </button>
          </div>
        </div>
      )}

      {/* 标注时把缩略图条收起：画布能高出一截，底部工具条也不会压住图片 */}
      {showThumbs && !annoMode && items.length > 1 && (
        <div
          className="lightbox-thumbs"
          ref={stripRef}
          onClick={(e) => e.stopPropagation()}
          // 条子是横向滚动的：竖向滚轮顺手翻成横向（触控板横向滑动则原样跟随）。
          // 这里不翻页，翻页只发生在图片舞台上（见 wheel 处理器）
          onWheel={(e) => {
            const el = e.currentTarget;
            if (el.scrollWidth <= el.clientWidth) return;
            const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            el.scrollLeft += e.deltaMode === 1 ? raw * 40 : raw;
          }}
        >
          {strip.map((it, i) => (
            <button
              key={it.id}
              data-thumb={it.id}
              className={`lb-thumb${from + i === index ? ' on' : ''}`}
              title={it.title}
              onClick={() => onIndex(from + i)}
            >
              {it.mediaKind && it.mediaKind !== 'image' && it.mediaKind !== 'gif' && !(it.coverTs > 0) ? (
                <span className="lb-thumb-glyph">
                  {it.mediaKind === 'video' ? '🎬' : it.mediaKind === 'audio' ? '🎵' : it.mediaKind === 'font' ? 'Aa' : '📄'}
                </span>
              ) : (
                <img src={it.thumbUrl} alt="" loading="lazy" draggable={false} />
              )}
            </button>
          ))}
          {to - from < items.length && (
            <span className="lb-thumb-more" title={`共 ${items.length} 张，左右滚动切换到的缩略图会随之更新`}>
              共 {items.length} 张
            </span>
          )}
        </div>
      )}

      {/* 全屏调色台：单张调色独立成界面，保存方式与按钮仍走 Lightbox 的逻辑 */}
      {colorRoom && (
        <ColorRoom
          src={item.url}
          title={item.title}
          meta={`${item.width} × ${item.height}`}
          value={adjust}
          onChange={setAdjust}
          sample={sample}
          onSampleChange={setSample}
          busy={saving}
          onClose={() => setColorRoom(false)}
          saveBar={
            <>
              <div className="cr-save-mode">
                <label className="lb-radio">
                  <input
                    type="radio"
                    name="cr-save-mode"
                    checked={saveMode === 'overwrite'}
                    onChange={() => setSaveMode('overwrite')}
                  />
                  <span>覆盖原图</span>
                </label>
                <label className="lb-radio">
                  <input
                    type="radio"
                    name="cr-save-mode"
                    checked={saveMode === 'copy'}
                    onChange={() => setSaveMode('copy')}
                  />
                  <span>另存为副本</span>
                </label>
              </div>
              {saveMode === 'copy' && (
                <div className="lb-save-dir">
                  <div className="lb-dir-row">
                    <input
                      className="input"
                      value={targetDir}
                      placeholder="选择保存位置…"
                      readOnly={isDesktop}
                      onChange={(e) => setTargetDir(e.target.value)}
                    />
                    {isDesktop && (
                      <button
                        className="btn sm"
                        onClick={async () => {
                          const d = await pickFolder();
                          if (d) setTargetDir(d);
                        }}
                      >
                        选择…
                      </button>
                    )}
                  </div>
                  <label className="lb-radio">
                    <input type="checkbox" checked={addToLibrary} onChange={(e) => setAddToLibrary(e.target.checked)} />
                    <span>保存后加入图库</span>
                  </label>
                </div>
              )}
              <div className="lb-edit-actions">
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    setAdjust(ADJUST_DEFAULTS);
                    setSample(null);
                  }}
                >
                  重置
                </button>
                <button
                  className="btn sm primary"
                  disabled={saving || (saveMode === 'overwrite' && isAdjustDefault(adjust))}
                  onClick={saveAdjust}
                >
                  {saving ? '保存中…' : saveMode === 'copy' ? '另存调色' : '保存调色'}
                </button>
              </div>
            </>
          }
        />
      )}

      {commentsOpen && (
        <CommentsPanel
          imageId={item.id}
          onCount={setCmtCount}
          onClose={() => setCommentsOpen(false)}
          onToast={onChangeToast}
        />
      )}

      <InfoPanel
        item={item}
        library={library}
        // 标注模式下强制收成一行摘要：面板占的高度直接变成画布高度，退出标注后恢复原样
        open={infoOpen && !annoMode}
        onToggle={() => setInfoOpen((v) => !v)}
        isImage={isImage}
        imgFolders={imgFolders}
        setImgFolders={setImgFolders}
        onPatch={onPatch}
        onChangeToast={onChangeToast}
        onFindColor={onFindColor}
        onSaveTags={onSaveTags}
        tagInput={tagInput}
        setTagInput={setTagInput}
        addTag={addTag}
        paletteColors={paletteColors}
        simOpen={sim.open}
        onToggleSim={() => setSim((s) => ({ ...s, open: !s.open }))}
        aiDesc={aiDesc}
        setAiDesc={setAiDesc}
        aiBusy={aiBusy}
        setAiBusy={setAiBusy}
      />

      {exportOpen && <ExportDialog item={item} onClose={() => setExportOpen(false)} onToast={(m) => onChangeToast?.(m)} />}

      {toolkit && (
        <ImageToolkit
          item={item}
          tab={toolkit}
          onClose={() => setToolkit(null)}
          onToast={(m) => onChangeToast?.(m)}
          onReplaced={(next) => {
            onReplaceItem?.(next);
            onChangeToast?.('原图已更新，缩略图与指纹已重建');
          }}
        />
      )}

      {cmpIds && items.length > 1 && (
        <CompareView
          items={items}
          leftId={cmpIds.left}
          rightId={cmpIds.right}
          readOnly
          onClose={() => setCmpIds(null)}
        />
      )}

      {wpPreviewOpen && (
        <WallpaperPreview
          itemId={item.id}
          title={item.title}
          onClose={() => setWpPreviewOpen(false)}
          onApply={(style) => {
            setWpPreviewOpen(false);
            onSetWallpaper(item, style);
          }}
        />
      )}

      <WatermarkStudio
        open={wmOpen}
        ids={[item.id]}
        onClose={() => setWmOpen(false)}
        onToast={onChangeToast}
        onDone={(next) => next && onReplaceItem(next)}
      />

      <ToolbarCustomizer
        open={tczOpen}
        title="自定义大图顶栏"
        hint="左边是顶栏按钮（按从上到下的顺序显示），右边收在「更多」菜单里。点条目即可在两栏之间移动。"
        all={visible.map((a) => ({ key: a.key, label: a.label }))}
        pinned={pinnedActs}
        defaults={LB_PINNED_DEFAULT}
        onChange={setPinnedActs}
        onClose={() => setTczOpen(false)}
      />
    </div>
  );
}
