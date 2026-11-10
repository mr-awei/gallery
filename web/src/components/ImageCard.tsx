import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ImageItem } from '../types';
import { BASE, SOURCE_LABELS, api, copyText, desktop, formatSize as fmtSize, revealFile } from '../api';
import { confirmDialog, promptDialog } from './Dialogs';
import { fontFrameDataUrl, imageFrameDataUrl, videoElementDataUrl, videoFrameDataUrl } from '../lib/coverFrame';
import { captureVideoSprite, frameIndexAt, type SpriteResult } from '../lib/video-frames';
import { IMAGE_MIME, TAG_MIME } from '../lib/dnd';
import { IconDownload, IconExpand, IconHeart } from './Icons';

interface Props {
  item: ImageItem;
  selected: boolean;
  /** 可选的附加标注（如以图搜图的「几乎相同 / 高度相似」） */
  note?: string;
  onOpen: (item: ImageItem) => void;
  onToggleSelect: (id: number) => void;
  onToggleFavorite: (item: ImageItem) => void;
  onDownload: (item: ImageItem) => void;
  /** 右键菜单 / 拖拽等操作的提示（可选；未传则静默） */
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
  /** 旋转 / 编辑标签后父组件用新数据替换（未传时操作后不更新列表，仅提示） */
  onUpdateItem?: (item: ImageItem) => void;
  /** 移入回收站后父组件从列表移除（未传则不显示删除菜单项） */
  onDeleteItem?: (item: ImageItem) => void;
  /** 手动刷新序号：变化时只对「失败过」的卡片清态重试（URL 加参数绕过缓存），
   * 正常卡片不受影响——取代旧的「整网格重挂载」方案，刷新不再闪屏 */
  resetKey?: number;
  /** 该卡片上的标注数量（Eagle 式角标；0/未传不显示） */
  annotationCount?: number;
  /** 完全重复（MD5）同组张数，含自己；≤1 时不显示 */
  dupeCount?: number;
  /** 拖拽时携带的 id 列表：拖选中卡片时把整批一起带走（不传则只拖自己） */
  dragIds?: number[];
  /** 手动排序模式（文件夹视图 + sort=manual）：拖到另一张卡片上表示「插到它后面」 */
  manualSort?: boolean;
  onReorderDrop?: (dragIds: number[], targetId: number) => void;
  /** 侧栏标签拖到这张卡上：给这张素材追加这个标签 */
  onDropTag?: (item: ImageItem, tag: string) => void;
  /** 点堆叠角标：打开堆叠查看器（组主 id） */
  onOpenStack?: (stackId: number) => void;
  /** 解散这张图所在的堆叠 */
  onUngroupStack?: (stackId: number) => void;
  /** 把拖过来的图叠到这张上（目标是组主则并入该组，否则两张成组） */
  onStackDrop?: (dragIds: number[], target: ImageItem) => void;
}

/* 全局同时只保留一个卡片右键菜单：在另一张卡上右键时先收起上一张的（菜单状态在各卡实例内，需跨实例互斥） */
let closeOpenCardMenu: (() => void) | null = null;

/* ------------------------- 多格式素材卡（视频/音频/字体…） ------------------------- */

const KIND_LABEL: Record<string, string> = {
  video: '视频',
  audio: '音频',
  font: '字体',
  pdf: 'PDF',
  office: 'Office',
  model: '3D 模型',
  design: '设计稿',
  raw: 'RAW',
  bookmark: '网页',
  other: '文件',
};

const KIND_GLYPH: Record<string, string> = {
  video: '🎬',
  audio: '🎵',
  font: 'Aa',
  pdf: '📕',
  office: '📊',
  model: '🧊',
  design: '🎨',
  raw: '📷',
  bookmark: '🔗',
  other: '📦',
};

/** 秒 → 0:00 / 0:00:00 */
function fmtDuration(sec: number) {
  if (!sec || !Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

function extOfPath(p: string) {
  const m = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(p || '');
  return m ? m[1].toUpperCase() : '';
}

/** 视频卡：有自定义封面就贴封面，否则用 <video> 定格首帧（不依赖 ffmpeg） */
function VideoThumb({
  src,
  poster,
  onFrame,
}: {
  src: string;
  poster?: string;
  /** 首次定格成功时回调一帧，供卡片自动落成服务端封面（此后不必再解码视频） */
  onFrame?: (v: HTMLVideoElement) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [sprite, setSprite] = useState<SpriteResult | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  if (failed) return <MediaGlyph kind="video" size={0} title="" label="" />;
  return (
    <div
      className="media-video"
      onMouseEnter={() => {
        // 悬停才解码：一张卡不 hover 就完全不抽帧
        if (sprite) return;
        void captureVideoSprite(src, 6).then(setSprite);
      }}
      onMouseMove={(e) => {
        if (!sprite) return;
        const box = e.currentTarget.getBoundingClientRect();
        setScrub(frameIndexAt((e.clientX - box.left) / (box.width || 1), sprite.frames));
      }}
      onMouseLeave={() => setScrub(null)}
    >
      {sprite && scrub !== null && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url(${sprite.url})`,
            backgroundSize: `${sprite.frames * 100}% 100%`,
            backgroundPosition: `${(scrub / Math.max(1, sprite.frames - 1)) * 100}% 0`,
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      <video
        src={src}
        poster={poster}
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={(e) => {
          if (poster) return;
          const v = e.currentTarget;
          // 跳到一点点，避免纯黑开场帧（没有封面时才需要）
          try {
            v.currentTime = Math.min(0.2, (v.duration || 1) * 0.02);
          } catch {
            /* 某些容器不支持 seek，忽略即可 */
          }
        }}
        onSeeked={(e) => {
          if (poster) return;
          onFrame?.(e.currentTarget);
        }}
        onError={() => setFailed(true)}
      />
      <span className="media-play" aria-hidden>
        ▶
      </span>
    </div>
  );
}

/**
 * 自动封面去重：同一张素材在一次会话里只尝试一次。
 * 失败（编码不支持、跨域污染画布）不重试，避免网格里反复解码视频。
 */
const autoCoverTried = new Set<number>();

/** 字体卡：运行时把字体文件挂进 document.fonts，用自己的字形预览 */
function FontThumb({ url, title }: { url: string; title: string }) {
  const [family, setFamily] = useState('');
  useEffect(() => {
    let cancelled = false;
    const fam = `tukufont-${Math.random().toString(36).slice(2, 9)}`;
    let face: FontFace | null = null;
    try {
      face = new FontFace(fam, `url("${url}")`);
      face
        .load()
        .then((loaded) => {
          if (cancelled) return;
          document.fonts.add(loaded);
          setFamily(fam);
        })
        .catch(() => {
          /* 解析失败就用兜底字形，不打扰用户 */
        });
    } catch {
      /* 老浏览器没有 FontFace */
    }
    return () => {
      cancelled = true;
      if (face) {
        try {
          document.fonts.delete(face);
        } catch {
          /* noop */
        }
      }
    };
  }, [url]);
  return (
    <div className="media-glyph font">
      <div className="media-font-sample" style={family ? { fontFamily: `"${family}", sans-serif` } : undefined}>
        Aa 字体预览
      </div>
      <div className="media-font-name">{title}</div>
    </div>
  );
}

/**
 * 无缩略图的素材统一用图标卡（音频/字体/PDF/Office/3D/其他）。
 * 音频卡以前画的是「按 id 随机生成的假波形」，看着像声波其实与音频无关；
 * 卡片上不放假的图，真要波形要点开预览（那边是解码出来的真波形）。
 */
function MediaGlyph({
  kind,
  size,
  title,
  label,
  duration = 0,
}: {
  kind: string;
  size: number;
  title: string;
  label: string;
  duration?: number;
}) {
  return (
    <div className={`media-glyph ${kind}`}>
      <div className="media-glyph-icon">{KIND_GLYPH[kind] || KIND_GLYPH.other}</div>
      <div className="media-glyph-kind">{label || KIND_LABEL[kind] || '文件'}</div>
      {title && <div className="media-glyph-title">{title}</div>}
      <div className="media-glyph-meta">
        {duration > 0 && <span>{fmtDuration(duration)}</span>}
        {size > 0 && <span>{fmtSize(size)}</span>}
      </div>
    </div>
  );
}

const ImageCard = React.memo(function ImageCard({
  item,
  selected,
  note,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  onDownload,
  onToast,
  onUpdateItem,
  onDeleteItem,
  resetKey,
  annotationCount,
  dupeCount,
  dragIds,
  manualSort,
  onReorderDrop,
  onDropTag,
  onOpenStack,
  onUngroupStack,
  onStackDrop,
}: Props) {
  // 手动排序时被拖到本卡上方高亮：告诉用户「松手就插到这张后面」
  const [dropHint, setDropHint] = useState(false);
  /** 侧栏标签拖到这张卡上时的落点高亮 */
  const [tagHint, setTagHint] = useState(false);
  /** 拖图到这张卡上 = 叠成一堆的落点高亮 */
  const [stackHint, setStackHint] = useState(false);
  const [broken, setBroken] = useState(false);
  /**
   * 缩略图待生成：后端没有现成的缩略图时会立刻 404 并在后台补，
   * 这不是「文件缺失」，所以单独一个状态 —— 显示占位、几秒后自动重试。
   */
  const [thumbPending, setThumbPending] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // 是否失败过 + 重载令牌：手动刷新时据此重试，正常卡片 URL 保持不变（不触发重新请求）
  const failedEverRef = useRef(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(
    () => () => {
      if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (resetKey == null || !failedEverRef.current) return;
    failedEverRef.current = false;
    setBroken(false);
    setThumbPending(false);
    retryCountRef.current = 0;
    setReloadToken(resetKey);
  }, [resetKey]);

  const fullUrl = BASE + (item.downloadUrl || item.url);

  const params: string[] = [];
  if (reloadToken) params.push(`tukur=${reloadToken}`);
  // retry=1 让后端给这张图一次插队生成的机会；带 tick 保证 URL 每次都变（不被缓存挡住）
  if (retryTick) params.push('retry=1', `grt=${retryTick}`);
  const thumbSrc = params.length
    ? `${item.thumbUrl}${item.thumbUrl.includes('?') ? '&' : '?'}${params.join('&')}`
    : item.thumbUrl;

  /* 音频时长懒探测：卡片只需读一次元数据，回写库后下次直接显示，不用逐张打开预览 */
  useEffect(() => {
    if ((item.mediaKind || '') !== 'audio' || item.duration > 0) return;
    const el = new Audio();
    el.preload = 'metadata';
    el.src = fullUrl;
    let dead = false;
    const onMeta = () => {
      if (dead) return;
      const d = Math.round(el.duration || 0);
      if (!d) return;
      api
        .patchMedia(item.id, { duration: d })
        .then((r) => r.image && onUpdateItem?.(r.image))
        .catch(() => undefined);
    };
    el.addEventListener('loadedmetadata', onMeta);
    return () => {
      dead = true;
      el.removeEventListener('loadedmetadata', onMeta);
      el.src = '';
    };
  }, [item.id, item.mediaKind, item.duration, fullUrl, onUpdateItem]);

  /* 多格式素材：非 image/gif 不走 sharp 缩略图，按类型各自渲染 */
  const kind: string = item.mediaKind || 'image';
  const isPlainImage = kind === 'image' || kind === 'gif';
  /** 自定义封面（后端对非图片素材只在有封面时返回缩略图） */
  const hasCover = !isPlainImage && item.coverTs > 0;
  const kindLabel = KIND_LABEL[kind] || '';
  const durationText = fmtDuration(item.duration);

  /**
   * 视频没有封面时，顺手把它定格的那一帧存成服务端封面。
   * 以前每张视频卡都要真的加载视频才能显示画面（格子里几十个视频同时拉流），
   * 落一次封面之后，后续渲染就是一张普通缩略图。
   */
  const autoCoverFromFrame = (v: HTMLVideoElement) => {
    if (kind !== 'video' || hasCover || autoCoverTried.has(item.id)) return;
    autoCoverTried.add(item.id);
    const dataUrl = videoElementDataUrl(v);
    if (!dataUrl) return;
    api
      .setCover(item.id, dataUrl, Math.max(0, v.currentTime || 0))
      .then((r) => r.image && onUpdateItem?.(r.image))
      .catch(() => undefined);
  };

  /**
   * 缩略图 404 的两种含义要分开：
   *   - 后端在后台补图（thumbPending）：占位 + 隔一两秒再要，生成好就自然出现
   *   - 连续多次拿不到（broken）：才当真的缺失，显示「文件缺失」
   * 以前一律立刻重试一次，赶上首屏几十张缺图时又要排队打满 CPU，反而更慢。
   */
  /**
   * 重试节奏：以前只给两次（1.2s、3s）就判「文件缺失」。
   * 但整库补图时（比如把上万个缺缩略图的老库接进来）服务端是排队一张张生成的，
   * 屏幕上一批卡片根本等不到自己那一张，4 秒后全部变「文件缺失」，看着就像图丢了。
   * 这里改成逐步退避、总共约 2.5 分钟：补图轮到它就自己出现，真的缺文件也只是晚一点报。
   */
  /** 缩略图加载成功：清掉待生成态与退避预算（偶发失败不该永久耗尽重试次数） */
  const onThumbLoad = () => {
    failedEverRef.current = false;
    retryCountRef.current = 0;
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = 0;
    }
    setThumbPending(false);
    setBroken(false);
  };

  const RETRY_DELAYS = [1200, 2500, 4000, 6000, 10000, 15000, 20000, 30000, 45000];
  const onThumbError = () => {
    failedEverRef.current = true;
    const next = retryCountRef.current + 1;
    retryCountRef.current = next;
    if (next > RETRY_DELAYS.length) {
      setThumbPending(false);
      setBroken(true);
      return;
    }
    setThumbPending(true);
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = 0;
      setRetryTick((t) => t + 1);
    }, RETRY_DELAYS[next - 1]);
  };

  const renderMedia = () => {
    if (broken) {
      // RAW / 设计稿本来就没有浏览器能直接显示的位图：拿不到内嵌预览时说「暂无预览」，
      // 说「文件缺失」会让用户以为照片丢了（文件其实好好在磁盘上）
      const noPreview = kind === 'raw' || kind === 'design';
      const ext = (item.title.split('.').pop() || '').toUpperCase();
      return (
        <div
          className="card-broken"
          title={
            noPreview
              ? `${item.title}（${KIND_LABEL[kind] || '该格式'}没有内嵌预览图；文件本身正常，可用原软件打开）`
              : `${item.title}（缩略图加载失败，可点「刷新」重试；文件确实丢失时到设置 → 数据维护清理）`
          }
        >
          <span>{noPreview ? KIND_GLYPH[kind] || '⚠' : '⚠'}</span>
          {noPreview ? '暂无预览' : '文件缺失'}
          <small>{noPreview ? `${ext}${item.width ? ` · ${item.width}×${item.height}` : ''}` : `${item.width}×${item.height}`}</small>
        </div>
      );
    }
    if (thumbPending) {
      return (
        <div className="card-thumb-pending">
          <div className="card-broken pending" title={`${item.title}（缩略图正在后台生成，稍后自动出现）`}>
            <span className="card-thumb-spin" aria-hidden />
            <small>
              {item.width}×{item.height}
            </small>
          </div>
          {/* 关键：<img> 必须保持挂载。以前这里是直接 return 占位、把 <img> 卸载掉，
              退避定时器改完 URL 已没有任何元素能再触发 onError/onLoad，
              thumbPending 永远为 true → 卡片永久转圈，「文件缺失」也永远不出现。
              这里用透明探针叠在占位之上：维持卡片高度，同时让重试链路活着。 */}
          <img
            className="card-thumb-probe"
            src={thumbSrc}
            alt=""
            aria-hidden
            onError={onThumbError}
            onLoad={onThumbLoad}
          />
        </div>
      );
    }
    if (kind === 'video') {
      return (
        <VideoThumb
          src={fullUrl}
          poster={hasCover ? thumbSrc : undefined}
          onFrame={autoCoverFromFrame}
        />
      );
    }
    if (hasCover) {
      // 音频 / 字体 / PDF 等可以自己指定封面，优先显示封面
      return <img src={thumbSrc} alt={item.title} loading="lazy" decoding="async" onError={() => setBroken(true)} />;
    }
    // 设计文件 / RAW / 网页书签：入库时已经备好了画面（PSD 合成图、Sketch 的
    // preview.png、RAW 内嵌 JPEG、网页 og:image），直接当缩略图用
    if (kind === 'design' || kind === 'raw' || kind === 'bookmark') {
      // 不能一次 onError 就判死：补图/换盘/首次打开时后台可能还没生成好，
      // 走统一的重试链路（URL 带 tick 变化，绕开可能被缓存的 404），多次拿不到才显示「暂无预览」。
      return <img src={thumbSrc} alt={item.title} loading="lazy" decoding="async" onError={onThumbError} onLoad={onThumbLoad} />;
    }
    if (kind === 'font') {
      return <FontThumb url={fullUrl} title={item.title} />;
    }
    if (!isPlainImage) {
      // 音频 / PDF / Office / 3D 等没有画面：卡片上给文件名 + 时长 + 大小，
      // 比只放一个类型图标更容易认出是哪一个（Eagle 的媒体卡也是这么做的）
      const bare = item.title.replace(/\.[a-z0-9]{2,5}$/i, '');
      return (
        <MediaGlyph
          kind={kind}
          size={item.sizeBytes}
          title={bare}
          label={[kindLabel, extOfPath(item.path || item.url)].filter(Boolean).join(' · ')}
          duration={item.duration}
        />
      );
    }
    return (
      <img
        src={thumbSrc}
        alt={item.title}
        loading="lazy"
        decoding="async"
        onError={onThumbError}
        onLoad={onThumbLoad}
      />
    );
  };

  /* 右键菜单：点击任意处 / Esc / 滚动 / 窗口尺寸变化时关闭（滚动不关会悬空错位） */
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // 菜单自己滚动（条目多时 .card-ctx 有 max-height 会内部滚）不能把它关掉，
    // 否则一滚就消失、下面的项永远点不到；只关「页面滚动导致悬空」的那种
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && menuRef.current?.contains(t)) return;
      setMenu(null);
    };
    // 互斥：先收起其他卡片的菜单，再注册自己；自己的清理只在注册仍是自己时摘除
    closeOpenCardMenu?.();
    closeOpenCardMenu = close;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      if (closeOpenCardMenu === close) closeOpenCardMenu = null;
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  /* 渲染后按菜单实际尺寸收进视口：靠右往左收、靠底往上收（useLayoutEffect 绘制前调整，无跳动） */
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))}px`;
  }, [menu]);

  /* 键盘操作：Enter 打开 · Space 勾选 · F 收藏 · D 下载 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(item);
    } else if (e.key === ' ') {
      e.preventDefault();
      onToggleSelect(item.id);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      onToggleFavorite(item);
    } else if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      onDownload(item);
    }
  };

  const copyLink = async () => {
    const ok = await copyText(fullUrl);
    if (ok) void api.bumpUsage('copy', [item.id]).catch(() => undefined);
    onToast?.(ok ? '图片链接已复制' : '复制失败：浏览器拒绝了剪贴板访问', ok ? 'info' : 'error');
  };

  const setWall = async () => {
    try {
      await api.wallpaper(item.id);
      onToast?.('已设为壁纸');
    } catch (err) {
      onToast?.((err as Error).message);
    }
  };

  /* 右键菜单进阶操作（旋转 / 标签 / 文件路径 / 回收站） */
  const rotate = async (dir: 'cw' | 'ccw') => {
    try {
      const res = await api.rotateImage(item.id, dir);
      onUpdateItem?.(res.item);
      onToast?.('已旋转');
    } catch (err) {
      onToast?.((err as Error).message);
    }
  };

  /* 设为封面：视频取当前帧、GIF 取首帧、字体把标题渲染成图（Eagle 的 Set as cover） */
  const canSetCover = kind === 'video' || kind === 'gif' || kind === 'font';
  const setCoverFromCard = async () => {
    setCoverBusy(true);
    try {
      let dataUrl = '';
      if (kind === 'video') dataUrl = await videoFrameDataUrl(fullUrl, item.coverTs || 0.2);
      else if (kind === 'font') dataUrl = await fontFrameDataUrl(fullUrl, item.title.replace(/\.[^.]+$/, ''));
      else dataUrl = await imageFrameDataUrl(fullUrl);
      const r = await api.setCover(item.id, dataUrl, kind === 'video' ? item.coverTs || 0.2 : 0);
      if (r.image) onUpdateItem?.(r.image);
      onToast?.('已设为封面');
    } catch (err) {
      onToast?.(`设置封面失败：${(err as Error).message}`);
    } finally {
      setCoverBusy(false);
    }
  };

  const resetCover = async () => {
    setCoverBusy(true);
    try {
      const r = await api.resetCover(item.id);
      if (r.image) onUpdateItem?.(r.image);
      onToast?.('已恢复默认缩略图');
    } catch (err) {
      onToast?.(`恢复失败：${(err as Error).message}`);
    } finally {
      setCoverBusy(false);
    }
  };

  const editTags = async () => {
    const input = await promptDialog('标签（用逗号分隔，留空清除全部标签）', (item.tags || []).join(', '));
    if (input === null) return; // 取消
    const list = input.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    try {
      const updated = await api.patch(item.id, { tags: list });
      onUpdateItem?.(updated);
      onToast?.(list.length ? `已保存 ${list.length} 个标签` : '已清除标签');
    } catch (err) {
      onToast?.((err as Error).message);
    }
  };

  const copyPath = async () => {
    const ok = await copyText(item.path);
    if (ok) void api.bumpUsage('copy', [item.id]).catch(() => undefined);
    onToast?.(ok ? '文件路径已复制' : '复制失败：浏览器拒绝了剪贴板访问', ok ? 'info' : 'error');
  };

  /** 把图片本身放进剪贴板（Chromium 只稳定支持写 PNG，这里统一转成 PNG） */
  const copyImage = async () => {
    try {
      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error(`读取失败 ${res.status}`);
      const src = await res.blob();
      const bmp = await createImageBitmap(src);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('画布不可用');
      ctx.drawImage(bmp, 0, 0);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('转换 PNG 失败');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      void api.bumpUsage('copy', [item.id]).catch(() => undefined);
      onToast?.('图片已复制到剪贴板');
    } catch (err) {
      onToast?.(`复制图片失败：${(err as Error).message}`, 'error');
    }
  };

  const reveal = async () => {
    try {
      await revealFile(item.path);
    } catch (err) {
      onToast?.((err as Error).message);
    }
  };

  const moveToTrash = async () => {
    if (!(await confirmDialog('把这张图片移入回收站？可在「设置 → 数据维护 → 回收站」恢复。'))) return;
    try {
      await api.remove(item.id);
      onDeleteItem?.(item);
      onToast?.('已移入回收站');
    } catch (err) {
      onToast?.((err as Error).message);
    }
  };

  return (
    <div
      className={`card-img kind-${kind}${selected ? ' selected' : ''}${dropHint ? ' drop-hint' : ''}${
        tagHint ? ' tag-hint' : ''
      }${stackHint ? ' stack-hint' : ''}${item.stackPrimary && (item.stackCount || 0) > 1 ? ' has-stack' : ''}`}
      data-image-id={item.id}
      onDragOver={(e) => {
        // 侧栏标签拖过来：整张卡都是落点（Eagle 里拖标签到图上就是打标）
        if (onDropTag && e.dataTransfer.types.includes(TAG_MIME)) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          if (!tagHint) setTagHint(true);
          return;
        }
        if (!e.dataTransfer.types.includes(IMAGE_MIME)) return;
        // 手动排序优先：那时候「拖到图上」的语义是插到它后面，不再叠堆
        if (manualSort && onReorderDrop) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!dropHint) setDropHint(true);
          return;
        }
        if (!onStackDrop) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (!stackHint) setStackHint(true);
      }}
      onDragLeave={() => {
        setDropHint(false);
        setTagHint(false);
        setStackHint(false);
      }}
      onDrop={(e) => {
        const tag = e.dataTransfer.getData(TAG_MIME);
        if (tag && onDropTag) {
          e.preventDefault();
          e.stopPropagation();
          setTagHint(false);
          onDropTag(item, tag);
          return;
        }
        const raw = e.dataTransfer.getData(IMAGE_MIME);
        setDropHint(false);
        setStackHint(false);
        if (!raw) return;
        const ids = raw
          .split(',')
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length || ids.includes(item.id)) return;
        if (manualSort && onReorderDrop) {
          e.preventDefault();
          e.stopPropagation();
          onReorderDrop(ids, item.id);
          return;
        }
        if (!onStackDrop) return;
        e.preventDefault();
        e.stopPropagation();
        onStackDrop(ids, item);
      }}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        // 阻止冒泡：页面的右键菜单（撤销/刷新/清理缺失…）只处理空白区域，
        // 右键卡片时只弹卡片自己的菜单，不要两个菜单一起冒出来。
        e.stopPropagation();
        // 记录光标位置；视口收拢在渲染后按菜单实际尺寸做（见 useLayoutEffect）
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="button"
      aria-label={item.title}
      aria-pressed={selected}
      draggable
      onDragStart={(e) => {
        // 桌面端：走系统级拖拽，拖到资源管理器/微信/PS 直接落成真实文件（Eagle 核心用法）。
        // 必须先 preventDefault 取消 HTML5 拖影，否则两套拖拽会互相打架。
        // 手动排序模式下不拖出系统：此时拖拽的语义是「调整顺序」，不是「拷文件」。
        // 按住 Alt 也不拖出系统：应用内「拖到图上叠成一堆」需要 HTML5 拖放（系统拖拽拿不到自定义 MIME）
        if (desktop?.dragOut && item.path && !manualSort && !e.altKey) {
          e.preventDefault();
          desktop.dragOut(item.path);
          return;
        }
        // 浏览器端：拖入其他标签页 / 支持图片直链的目标；应用内目标可读自定义类型拿到图片 id
        e.dataTransfer.setData('text/uri-list', fullUrl);
        e.dataTransfer.setData('text/plain', fullUrl);
        // 拖的是选中态卡片时带整批 id，侧栏文件夹树可一次收下多张
        e.dataTransfer.setData('application/x-tuku-image-id', (dragIds?.length ? dragIds : [item.id]).join(','));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={item.title}
    >
      {renderMedia()}
      {!item.viewed && <span className="unseen-dot" title="还没在大图预览里看过" />}
      {stackHint && (
        <span className="stack-drop-tip">
          ⧉ {item.stackPrimary && (item.stackCount || 0) > 1 ? '并入这堆' : '叠成一堆'}
        </span>
      )}
      {item.stackPrimary && (item.stackCount || 0) > 1 && (
        <button
          className="stack-badge"
          title={`堆叠 ${item.stackCount} 张：点开看同素材的其他版本`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenStack?.(item.stackId || item.id);
          }}
        >
          ⧉ {item.stackCount}
        </button>
      )}
      {kind === 'video' && durationText && (
        <span className="media-duration" title="时长">
          {durationText}
        </span>
      )}
      {!!dupeCount && dupeCount > 1 && (
        <span className="card-badge dupe" title={`有 ${dupeCount - 1} 张完全相同的重复文件`}>
          ×{dupeCount}
        </span>
      )}
      {!!annotationCount && annotationCount > 0 && (
        <span className="card-badge annot" title={`${annotationCount} 处标注`}>
          ✏ {annotationCount}
        </span>
      )}
      <div
        className={`check-box${selected ? ' on' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(item.id);
        }}
      >
        {selected ? '✓' : ''}
      </div>
      <div className="card-overlay">
        <div className="card-meta" style={{ alignSelf: 'flex-end' }}>
          {note && <span className="tag-pill">{note}</span>}
          {item.matchHex && (
            <span
              className="tag-pill"
              title={`命中色 ${item.matchHex}${typeof item.dist === 'number' ? ` · OKLab 距离 ${item.dist}` : ''}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 3,
                  background: item.matchHex,
                  boxShadow: '0 0 0 1px rgba(255,255,255,.35)',
                }}
              />
              同色
            </span>
          )}
          {!isPlainImage && <span className="tag-pill kind-pill">{kindLabel || '文件'}</span>}
          <span className="tag-pill">{SOURCE_LABELS[item.source] || item.source}</span>
          {item.width > 0 && item.height > 0 ? (
            <span className="tag-pill">
              {item.width}×{item.height}
            </span>
          ) : durationText ? (
            <span className="tag-pill">{durationText}</span>
          ) : (
            item.sizeBytes > 0 && <span className="tag-pill">{fmtSize(item.sizeBytes)}</span>
          )}
          {item.enhanced && (
            <span className="tag-pill enhanced" title={`已放大 ${item.enhanceScale} 倍（原 ${item.originalWidth}×${item.originalHeight}）`}>
              ✨{item.enhanceScale}×
            </span>
          )}
          {item.score < 60 && (
            <span className="tag-pill score-warn" title={item.scoreReason}>
              ⚠ {item.score}
            </span>
          )}
        </div>
        <div className="card-actions">
          <button
            className={`icon-btn${item.favorite ? ' on' : ''}`}
            title={item.favorite ? '取消收藏' : '收藏'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(item);
            }}
          >
            <IconHeart filled={item.favorite} />
          </button>
          <button
            className="icon-btn"
            title="下载"
            onClick={(e) => {
              e.stopPropagation();
              onDownload(item);
            }}
          >
            <IconDownload />
          </button>
          <button
            className="icon-btn"
            title="大图预览"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(item);
            }}
          >
            <IconExpand />
          </button>
        </div>
      </div>
      {menu &&
        createPortal(
          /* 传送到 body：卡片 hover 有 transform，会把 fixed 定位拖成相对卡片，
             坐标全歪；portal 到 body 后 fixed 以视口为基准，坐标即光标位置 */
          <div
            ref={menuRef}
            className="card-ctx"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
          <button
            onClick={() => {
              setMenu(null);
              // 不在这里重复实现命令表：交给 App 的命令面板，右键即可搜「导出 / 拼接 / 对比…」
              window.dispatchEvent(new CustomEvent('tuku:palette', { detail: { mode: 'command', itemId: item.id } }));
            }}
            title="按名字搜索所有命令（Ctrl+K 也能打开）"
          >
            🔍 搜索命令…
          </button>
          <div className="card-ctx-sep" />
          <button onClick={() => { setMenu(null); onOpen(item); }}>
            <IconExpand /> 大图预览
          </button>
          {(item.stackCount || 0) > 1 && onOpenStack && (
            <button onClick={() => { setMenu(null); onOpenStack(item.stackId || item.id); }}>
              ⧉ 查看堆叠（{item.stackCount} 张）
            </button>
          )}
          {!!item.stackId && onUngroupStack && (
            <button onClick={() => { setMenu(null); onUngroupStack(item.stackId || item.id); }}>
              ⧉ 解散这个堆叠
            </button>
          )}
          <button onClick={() => { setMenu(null); onToggleFavorite(item); }}>
            <IconHeart filled={item.favorite} /> {item.favorite ? '取消收藏' : '收藏'}
          </button>
          <button onClick={() => { setMenu(null); setWall(); }}>🖥 设为壁纸</button>
          {canSetCover && (
            <button disabled={coverBusy} onClick={() => { setMenu(null); setCoverFromCard(); }}>
              🖼 {coverBusy ? '生成封面中…' : kind === 'video' ? '用当前帧做封面' : kind === 'font' ? '用文字预览做封面' : '用首帧做封面'}
            </button>
          )}
          {item.coverTs > 0 && (
            <button disabled={coverBusy} onClick={() => { setMenu(null); resetCover(); }}>
              ↩ 恢复默认缩略图
            </button>
          )}
          <div className="card-ctx-sep" />
          <button onClick={() => { setMenu(null); rotate('cw'); }}>↻ 顺时针旋转</button>
          <button onClick={() => { setMenu(null); rotate('ccw'); }}>↺ 逆时针旋转</button>
          <button onClick={() => { setMenu(null); editTags(); }}>🏷 编辑标签…</button>
          <div className="card-ctx-sep" />
          <button onClick={() => { setMenu(null); void copyImage(); }}>📋 复制图片</button>
          <button onClick={() => { setMenu(null); copyLink(); }}>🔗 复制图片链接</button>
          {item.path && <button onClick={() => { setMenu(null); copyPath(); }}>📄 复制文件路径</button>}
          <button
            onClick={() => {
              setMenu(null);
              // 搜图面板由 App 统一挂载，这里只把目标丢过去
              window.dispatchEvent(
                new CustomEvent('tuku:reverse-search', {
                  detail: { imageId: item.id, title: item.title, previewUrl: `${BASE}${item.thumbUrl}` },
                })
              );
            }}
          >
            🔎 全网搜图…
          </button>
          {item.path && <button onClick={() => { setMenu(null); reveal(); }}>📂 打开所在文件夹</button>}
          <button onClick={() => { setMenu(null); onDownload(item); }}>
            <IconDownload /> 下载
          </button>
          {onDeleteItem && (
            <>
              <div className="card-ctx-sep" />
              <button className="danger" onClick={() => { setMenu(null); moveToTrash(); }}>
                🗑 移入回收站
              </button>
            </>
          )}
          </div>,
          document.body
        )}
    </div>
  );
});

export default ImageCard;
