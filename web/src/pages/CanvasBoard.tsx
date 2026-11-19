/**
 * 无限画布（灵感板）。
 *
 * 设计取舍：
 * - 像 Figma 一样用「滚轮缩放 + 空格/中键平移 + 框选」，但默认左键拖背景是框选，
 *   避免素材库用户习惯的「拖动空白 = 移动画布」误触把整板甩飞（工具栏提供手型模式）。
 * - 布局只存 id/位置/尺寸（localStorage，按资源库隔离），素材数据按 id 批量回查，
 *   图库里删掉的素材下次打开会自动剔除，不会留下打不开的空卡。
 * - 不清空数据库、不加表：热更包要求 schemaVersion 与安装的壳一致，加表就得强制换安装包。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, quiet } from '../api';
import type { ImageItem } from '../types';
import { promptDialog } from '../components/Dialogs';
import { DEFAULT_FILTERS } from '../lib/route';
import {
  CARD_MAX_W,
  CARD_MIN_W,
  CARD_W,
  ZOOM_MAX,
  ZOOM_MIN,
  boundsOf,
  cardHeight,
  clamp,
  emptyDoc,
  loadBoardStore,
  makeBoardId,
  makeNodeId,
  nextBoardName,
  saveBoardStore,
  SHAPE_KINDS,
  shapePolygon,
  takeQueuedCanvasAdd,
  type CanvasArrow,
  type CanvasCard,
  type CanvasDoc,
  type CanvasLink,
  type CanvasNote,
  type CanvasNoteShape,
  type CanvasShape,
  type CanvasShapeKind,
  type CanvasStore,
  type CanvasView,
} from '../lib/canvas-board';
import { filesFromDrop } from '../lib/drop-files';
import { downloadBlob, exportCanvasPdf, exportCanvasPng, renderCanvasPreview } from '../lib/canvas-export';
import {
  IconArrowUpRight,
  IconClose,
  IconDownload,
  IconExpand,
  IconFolderOpen,
  IconGrid,
  IconLayers,
  IconLink,
  IconMinus,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSquare,
  IconTrash,
  IconType,
} from '../components/Icons';
import i18n from '../i18n';

type Toast = (msg: string, kind?: 'info' | 'error') => void;

type DragState = { ids: Set<number>; dx: number; dy: number } | null;
type ResizeState = { id: number; w: number } | null;
type Marquee = { x: number; y: number; w: number; h: number } | null;

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number }
  | {
      kind: 'move';
      startX: number;
      startY: number;
      zoom: number;
      ids: number[];
      origin: Record<number, { x: number; y: number }>;
    }
  | { kind: 'resize'; startX: number; zoom: number; id: number; w: number; ratio: number }
  | { kind: 'marquee'; startX: number; startY: number; additive: boolean; base: Set<number> };

/** 节点拖拽：拖动期间只改本地偏移，松手才写回文档，避免每帧都触发持久化 */
function useNodeDrag(
  x: number,
  y: number,
  zoom: number,
  onCommit: (x: number, y: number) => void
) {
  const [off, setOff] = useState({ dx: 0, dy: 0 });
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('textarea,button,a,input,iframe')) return;
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    let dx = 0;
    let dy = 0;
    const move = (ev: PointerEvent) => {
      dx = (ev.clientX - sx) / zoom;
      dy = (ev.clientY - sy) / zoom;
      setOff({ dx, dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setOff({ dx: 0, dy: 0 });
      if (dx || dy) onCommit(x + dx, y + dy);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { off, down };
}

/** 节点缩放手柄：拖动期间只改本地尺寸，松手才写回文档 */
function useNodeResize(
  w: number,
  h: number,
  zoom: number,
  onCommit: (w: number, h: number) => void,
  minW = 80,
  minH = 60
) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    let nw = w;
    let nh = h;
    const move = (ev: PointerEvent) => {
      nw = Math.max(minW, w + (ev.clientX - sx) / zoom);
      nh = Math.max(minH, h + (ev.clientY - sy) / zoom);
      setSize({ w: Math.round(nw), h: Math.round(nh) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSize(null);
      if (Math.round(nw) !== Math.round(w) || Math.round(nh) !== Math.round(h)) {
        onCommit(Math.round(nw), Math.round(nh));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { size: size ?? { w, h }, down };
}

const NOTE_COLORS = ['#f5e6a8', '#cfd8f7', '#d8f0d0', '#f7d6e0', '#e7d9ff', '#ffe0c2', '#ffffff', '#262633'];
const NOTE_TEXT_COLORS = ['#241f16', '#5b5340', '#8a1f2d', '#1f3d8a', '#1f6b3a', '#ffffff'];
const NOTE_FONT_SIZES = [12, 14, 16, 20, 24];
const NOTE_SHAPES: CanvasNoteShape[] = ['rect', 'rounded', 'ellipse'];

function NoteView({
  note,
  zoom,
  onMove,
  onChange,
  onDelete,
  onStyle,
}: {
  note: CanvasNote;
  zoom: number;
  onMove: (id: string, x: number, y: number) => void;
  onChange: (id: string, patch: Partial<CanvasNote>) => void;
  onDelete: (id: string) => void;
  onStyle: (id: string) => void;
}) {
  const { off, down } = useNodeDrag(note.x, note.y, zoom, (x, y) => onMove(note.id, x, y));
  const { size, down: resizeDown } = useNodeResize(note.w, note.h, zoom, (w, h) =>
    onChange(note.id, { w, h })
  );
  const radius = note.noteShape === 'ellipse' ? '50%' : note.noteShape === 'rect' ? 4 : 10;
  return (
    <div
      className="cv-note"
      style={{
        left: note.x + off.dx,
        top: note.y + off.dy,
        width: size.w,
        height: size.h,
        background: note.color,
        borderRadius: radius,
      }}
    >
      {/* 文本域会吃掉指针事件，必须单独给一条可拖动的标题栏 */}
      <div className="cv-note-head" onPointerDown={down} title={i18n.t('k7c3f1c4e')}>
        <span className="cv-note-grip" />
        <span className="cv-note-actions">
          <button
            type="button"
            className="cv-note-style-btn"
            data-style-toggle="note"
            title={i18n.t('k7c3f1c59')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onStyle(note.id)}
          >
            Aa
          </button>
          <button
            type="button"
            className="cv-node-del inline"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onDelete(note.id)}
            title={i18n.t('k7c3f1a37')}
          >
            <IconClose size={11} />
          </button>
        </span>
      </div>
      <textarea
        value={note.text}
        placeholder={i18n.t('k7c3f1c01')}
        style={{ color: note.textColor, fontSize: note.fontSize }}
        onChange={(e) => onChange(note.id, { text: e.target.value.slice(0, 4000) })}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <span className="cv-resize" onPointerDown={resizeDown} title={i18n.t('k7c3f1c4f')} />
    </div>
  );
}

const SHAPE_COLORS = ['#7c6cf0', '#ff4d8d', '#34c88a', '#f5a623', '#4aa8ff', '#e04f4f'];
const SHAPE_LABEL_KEYS: Record<CanvasShapeKind, string> = {
  rect: 'k7c3f1c51',
  ellipse: 'k7c3f1c52',
  triangle: 'k7c3f1c53',
  diamond: 'k7c3f1c54',
  pentagon: 'k7c3f1c55',
  hexagon: 'k7c3f1c56',
  star: 'k7c3f1c57',
  parallelogram: 'k7c3f1c58',
};

/** 形状图形：SVG 预览与画布共用，preserveAspectRatio=none 让形状跟着节点拉伸 */
function ShapeGlyph({ kind, filled }: { kind: CanvasShapeKind; filled?: boolean }) {
  const fill = filled ? 'currentColor' : 'none';
  const fillOpacity = filled ? 0.14 : undefined;
  if (kind === 'ellipse') {
    return <ellipse cx={50} cy={50} rx={47} ry={47} fill={fill} fillOpacity={fillOpacity} stroke="currentColor" strokeWidth={3} vectorEffect="non-scaling-stroke" />;
  }
  if (kind === 'rect') {
    return <rect x={2} y={2} width={96} height={96} rx={9} fill={fill} fillOpacity={fillOpacity} stroke="currentColor" strokeWidth={3} vectorEffect="non-scaling-stroke" />;
  }
  const pts = shapePolygon(kind) || [];
  return (
    <polygon
      points={pts.map((p) => p.join(',')).join(' ')}
      fill={fill}
      fillOpacity={fillOpacity}
      stroke="currentColor"
      strokeWidth={3}
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function ShapeView({
  shape,
  zoom,
  onMove,
  onChange,
  onDelete,
  onStyle,
}: {
  shape: CanvasShape;
  zoom: number;
  onMove: (id: string, x: number, y: number) => void;
  onChange: (id: string, patch: Partial<CanvasShape>) => void;
  onDelete: (id: string) => void;
  onStyle: (id: string) => void;
}) {
  const { off, down } = useNodeDrag(shape.x, shape.y, zoom, (x, y) => onMove(shape.id, x, y));
  const { size, down: resizeDown } = useNodeResize(
    shape.w,
    shape.h,
    zoom,
    (w, h) => onChange(shape.id, { w, h }),
    40,
    40
  );
  return (
    <div
      className={`cv-shape ${shape.shape}`}
      style={{ left: shape.x + off.dx, top: shape.y + off.dy, width: size.w, height: size.h }}
      onPointerDown={down}
      onDoubleClick={() => onStyle(shape.id)}
      title={i18n.t('k7c3f1c02')}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <g style={{ color: shape.color }}>
          <ShapeGlyph kind={shape.shape} filled />
        </g>
      </svg>
      <button
        type="button"
        className="cv-shape-toggle"
        data-style-toggle="shape"
        title={i18n.t('k7c3f1c59')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onStyle(shape.id)}
      >
        <IconPencil size={11} />
      </button>
      <button
        type="button"
        className="cv-node-del"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onDelete(shape.id)}
        title={i18n.t('k7c3f1a37')}
      >
        <IconClose size={11} />
      </button>
      <span className="cv-resize" onPointerDown={resizeDown} title={i18n.t('k7c3f1c4f')} />
    </div>
  );
}

/** 把常见视频站点的链接转成可嵌入地址；其他站点只显示链接卡 */
function embedUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname.includes('youtube.com') || u.hostname === 'youtu.be') {
      const id = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
      return id ? `https://www.youtube.com/embed/${id}` : '';
    }
    if (u.hostname.includes('bilibili.com')) {
      const m = u.pathname.match(/\/video\/(BV[\w]+)/);
      return m ? `https://player.bilibili.com/player.html?bvid=${m[1]}` : '';
    }
    if (u.hostname.includes('vimeo.com')) {
      const id = u.pathname.split('/').filter(Boolean)[0] || '';
      return id ? `https://player.vimeo.com/video/${id}` : '';
    }
  } catch {
    return '';
  }
  return '';
}

type Rect = { x: number; y: number; w: number; h: number };

/** 画布上所有会占位的元素：图片卡、便签、形状、链接卡 */
const docRects = (doc: Pick<CanvasDoc, 'cards' | 'notes' | 'shapes' | 'links'>): Rect[] => [
  ...doc.cards,
  ...doc.notes,
  ...doc.shapes,
  ...doc.links,
];

/**
 * 找一块不压住已有元素的位置。
 * 之前只检查图片卡：便签/形状先放在中间时，新加的图片正好压上去，看着像「全叠在一起无法选择」。
 */
function freeSpot(rects: Rect[], blockW: number, blockH: number, cx: number, cy: number, gap = 20) {
  let x = Math.round(cx - blockW / 2);
  let y = Math.round(cy - blockH / 2);
  const collide = () =>
    rects.some(
      (r) => x < r.x + r.w + gap && x + blockW + gap > r.x && y < r.y + r.h + gap && y + blockH + gap > r.y
    );
  for (let guard = 0; collide() && guard < 300; guard++) {
    x += blockW + gap * 2;
    if (guard % 4 === 3) {
      x = Math.round(cx - blockW / 2);
      y += blockH + gap * 2;
    }
  }
  return { x, y };
}

/** 节点边缘上朝向目标点的位置：连线从卡片边缘出发，不会穿过素材 */
function edgeOf(r: Rect, toward: { x: number; y: number }) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? r.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? r.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** 点是否落在某个节点上（带一点容差），连线用它在两端吸附 */
function hitNode(rects: Rect[], p: { x: number; y: number }, pad = 12): Rect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad) return r;
  }
  return null;
}

type SnapAnchor = { x: number; y: number; rect: Rect };

/** 节点的 8 个吸附锚点：4 个角 + 4 条边的中点（中心不参与，避免线头缩在卡片里） */
function anchorsOf(r: Rect): { x: number; y: number }[] {
  const mx = r.x + r.w / 2;
  const my = r.y + r.h / 2;
  return [
    { x: r.x, y: r.y },
    { x: mx, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: my },
    { x: r.x + r.w, y: r.y + r.h },
    { x: mx, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
    { x: r.x, y: my },
  ];
}

/**
 * 在阈值内找最近的角 / 边中点。
 * 连线起点只要靠近任意实体（图片卡、便签、形状、链接卡）的锚点，就直接吸上去，
 * 不再依赖「必须点进卡片里」，画出来的线头也整齐。
 */
function snapAnchor(rects: Rect[], p: { x: number; y: number }, tol: number): SnapAnchor | null {
  let best: SnapAnchor | null = null;
  let bestDist = tol;
  for (const r of rects) {
    for (const a of anchorsOf(r)) {
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d <= bestDist) {
        bestDist = d;
        best = { x: a.x, y: a.y, rect: r };
      }
    }
  }
  return best;
}

/** 贝塞尔连线的控制点：按两点的主方向弯，读起来像 Figma 的连接线而不是一条呆板直线 */
function curveOf(a: { x1: number; y1: number; x2: number; y2: number }) {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const mx = a.x1 + dx / 2;
    return { c1x: mx, c1y: a.y1, c2x: mx, c2y: a.y2 };
  }
  const my = a.y1 + dy / 2;
  return { c1x: a.x1, c1y: my, c2x: a.x2, c2y: my };
}

/** 连线可选颜色 / 粗细（新线用当前选择，选中旧线时直接改那一条） */
const ARROW_COLORS = ['#ff4d8d', '#7c6cf0', '#38c8ff', '#4cd964', '#ffcc00', '#8f8fab'];
const ARROW_WIDTHS = [1, 2, 4];

function LinkView({
  link,
  zoom,
  onMove,
  onDelete,
}: {
  link: CanvasLink;
  zoom: number;
  onMove: (id: string, x: number, y: number) => void;
  onDelete: (id: string) => void;
}) {
  const { off, down } = useNodeDrag(link.x, link.y, zoom, (x, y) => onMove(link.id, x, y));
  const embed = embedUrl(link.url);
  let host = link.url;
  try {
    host = new URL(link.url).hostname.replace(/^www\./, '');
  } catch {
    /* 保留原串 */
  }
  return (
    <div
      className="cv-link"
      style={{ left: link.x + off.dx, top: link.y + off.dy, width: link.w, height: link.h }}
    >
      <div className="cv-link-head" onPointerDown={down}>
        <IconLink size={12} />
        <span>{link.title || host}</span>
        <a href={link.url} target="_blank" rel="noreferrer" title={link.url}>
          <IconArrowUpRight size={12} />
        </a>
        <button type="button" className="cv-node-del inline" onClick={() => onDelete(link.id)}>
          <IconClose size={11} />
        </button>
      </div>
      {embed ? (
        <iframe src={embed} title={link.title || host} allowFullScreen loading="lazy" />
      ) : (
        <div className="cv-link-body">
          <b>{link.title || host}</b>
          <span>{link.url}</span>
        </div>
      )}
    </div>
  );
}

const CardView = memo(function CardView({
  card,
  item,
  selected,
  offset,
  overrideW,
  onPointerDown,
  onResizeDown,
  onOpen,
}: {
  card: CanvasCard;
  item?: ImageItem;
  selected: boolean;
  /** 拖动中的临时位移（世界坐标） */
  offset?: { dx: number; dy: number };
  /** 缩放中的临时宽度（世界坐标） */
  overrideW?: number;
  onPointerDown: (e: React.PointerEvent, card: CanvasCard) => void;
  onResizeDown: (e: React.PointerEvent, card: CanvasCard) => void;
  onOpen: (id: number) => void;
}) {
  const w = overrideW ?? card.w;
  const h = overrideW ? Math.max(40, Math.round(overrideW * (card.h / card.w))) : card.h;
  return (
    <div
      className={`cv-card${selected ? ' selected' : ''}`}
      style={{
        left: card.x,
        top: card.y,
        width: w,
        height: h,
        transform: offset ? `translate(${offset.dx}px, ${offset.dy}px)` : undefined,
        zIndex: selected ? 5 : 1,
      }}
      onPointerDown={(e) => onPointerDown(e, card)}
      onDoubleClick={() => onOpen(card.id)}
      title={item?.title || ''}
    >
      {item ? (
        <img src={item.thumbUrl} alt={item.title} draggable={false} loading="lazy" decoding="async" />
      ) : (
        <span className="cv-card-ph" />
      )}
      <span className="cv-card-name">{item?.title || ''}</span>
      <span className="cv-resize" onPointerDown={(e) => onResizeDown(e, card)} />
    </div>
  );
});

/** 右侧素材抽屉：复用图库接口，点一下就加到画布中心 */
function CanvasPicker({
  chosen,
  onPick,
  onDragStart,
  onClose,
}: {
  chosen: Set<number>;
  onPick: (item: ImageItem) => void;
  /** 按住拖到画布上，可精确决定落点 */
  onDragStart: (item: ImageItem) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        api
          .images({ ...DEFAULT_FILTERS, q: q.trim() }, 1, 60)
          .then((r) => {
            if (seq !== seqRef.current) return;
            setList(r.items);
            setTotal(r.total);
            setPage(1);
          })
          .catch(quiet)
          .finally(() => {
            if (seq === seqRef.current) setLoading(false);
          });
      },
      q ? 260 : 0
    );
    return () => window.clearTimeout(timer);
  }, [q]);

  const more = () => {
    const next = page + 1;
    setLoading(true);
    api
      .images({ ...DEFAULT_FILTERS, q: q.trim() }, next, 60)
      .then((r) => {
        setList((prev) => [...prev, ...r.items]);
        setTotal(r.total);
        setPage(next);
      })
      .catch(quiet)
      .finally(() => setLoading(false));
  };

  return (
    <aside className="cv-picker">
      <header>
        <b>{i18n.t('k7c3f1a30')}</b>
        <button type="button" className="cv-icon-btn" onClick={onClose} title={i18n.t('kb15d9127')}>
          <IconClose size={14} />
        </button>
      </header>
      <label className="cv-picker-search">
        <IconSearch size={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={i18n.t('k7c3f1a3f')}
          autoFocus
        />
      </label>
      <div className="cv-picker-grid">
        {list.map((it) => (
          <button
            type="button"
            key={it.id}
            className={chosen.has(it.id) ? 'on' : ''}
            draggable
            onDragStart={(e) => {
              onDragStart(it);
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('text/plain', String(it.id));
            }}
            onClick={() => onPick(it)}
            title={it.title}
          >
            <img src={it.thumbUrl} alt="" loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
      {loading && <div className="cv-picker-note">{i18n.t('k7c3f1a3e')}</div>}
      {!loading && list.length < total && (
        <button type="button" className="btn sm cv-picker-more" onClick={more}>
          {i18n.t('k7c3f1a41')}
        </button>
      )}
      {!loading && !list.length && <div className="cv-picker-note">{i18n.t('k7c3f1a40')}</div>}
    </aside>
  );
}

export default function CanvasBoard({
  onToast,
  onOpen,
}: {
  onToast: Toast;
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
}) {
  const [libId, setLibId] = useState<number | null | undefined>(undefined);
  const [store, setStore] = useState<CanvasStore | null>(null);
  const [items, setItems] = useState<Record<number, ImageItem>>({});
  /** 待选画布：从图库/灯箱/粘贴等入口进来时先问「加到哪张」，避免默认塞进当前画布 */
  const [pendingIds, setPendingIds] = useState<number[] | null>(null);
  /** 连线模式：第一次点击定起点，第二次定终点 */
  const [arrowMode, setArrowMode] = useState(false);
  /**
   * 起点：fixed=true 表示已经吸附到角/边中点；
   * 否则 rect 存在时按「朝向另一端」实时求边缘，都没有则是自由点。
   */
  const [arrowFrom, setArrowFrom] = useState<{
    x: number;
    y: number;
    rect: Rect | null;
    fixed: boolean;
  } | null>(null);
  /** 连线过程中的跟随点：第二下没落之前也要看得见线 */
  const [arrowCursor, setArrowCursor] = useState<{ x: number; y: number } | null>(null);
  /** 最近的角 / 边中点：悬停时高亮，提示「松手就吸这里」 */
  const [snapHint, setSnapHint] = useState<SnapAnchor | null>(null);
  /** 新连线使用的颜色 / 粗细；选中已有连线时改的是那一条 */
  const [arrowStyle, setArrowStyle] = useState<{ color: string; width: number }>({ color: '#ff4d8d', width: 2 });
  const [arrowSel, setArrowSel] = useState<string | null>(null);
  const [templateMenu, setTemplateMenu] = useState(false);
  /** 工具条里的形状菜单：一次给出全部形状 */
  const [shapeMenu, setShapeMenu] = useState(false);
  /** 新建形状沿用上次选择的颜色 */
  const [shapeColor, setShapeColor] = useState(SHAPE_COLORS[0]);
  /**
   * 便签 / 形状的样式面板放在视口层而不是节点内部：
   * 节点都在 .cv-stage 的 transform 里，层级永远压不过工具条；拎出来才能不被遮挡。
   */
  const [styleTarget, setStyleTarget] = useState<{ kind: 'note' | 'shape'; id: string } | null>(null);
  const [exporting, setExporting] = useState('');
  /** 导出前预览：所见即所得，确认后才真正下载 */
  const [exportPreview, setExportPreview] = useState<{ kind: 'png' | 'pdf'; dataUrl: string } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [drag, setDrag] = useState<DragState>(null);
  const [resize, setResize] = useState<ResizeState>(null);
  const [marquee, setMarquee] = useState<Marquee>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 文件拖到画布上方时的落点提示 */
  const [dropHint, setDropHint] = useState(false);

  const doc = useMemo<CanvasDoc | null>(() => {
    if (!store) return null;
    return store.boards.find((b) => b.id === store.activeId)?.doc ?? null;
  }, [store]);

  /** 所有修改都落到「当前 board」；切画布后旧闭包也不会写错画布 */
  const setDoc = useCallback((updater: (prev: CanvasDoc) => CanvasDoc) => {
    setStore((prev) => {
      if (!prev) return prev;
      const idx = prev.boards.findIndex((b) => b.id === prev.activeId);
      if (idx < 0) return prev;
      const cur = prev.boards[idx].doc;
      const next = updater(cur);
      if (next === cur) return prev;
      const boards = prev.boards.slice();
      boards[idx] = { ...boards[idx], doc: next };
      return { ...prev, boards };
    });
  }, []);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragItemRef = useRef<ImageItem | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  /** 记录已经适配过窗口的画布 id：切换画布时重新适应一次 */
  const fittedBoardRef = useRef('');
  const queueDoneRef = useRef(false);
  const docRef = useRef<CanvasDoc | null>(null);
  docRef.current = doc;
  const latestRef = useRef<{ lib: number | null | undefined; store: CanvasStore | null }>({
    lib: undefined,
    store: null,
  });
  latestRef.current = { lib: libId, store };

  const view = doc?.view ?? { x: 64, y: 64, zoom: 1 };
  const viewRef = useRef<CanvasView>(view);
  viewRef.current = view;

  /* --------------------------- 节点样式面板 --------------------------- */

  // 点空白、点工具条、点其它节点都收起面板；点样式按钮本身除外（否则刚打开就被关掉）
  useEffect(() => {
    if (!styleTarget) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.cv-node-style') || t?.closest('[data-style-toggle]')) return;
      setStyleTarget(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [styleTarget]);

  // 节点被删掉 / 切了画布：面板跟着消失，别停在一个不存在的对象上
  useEffect(() => {
    if (!styleTarget || !doc) return;
    const exists =
      styleTarget.kind === 'note'
        ? doc.notes.some((n) => n.id === styleTarget.id)
        : doc.shapes.some((s) => s.id === styleTarget.id);
    if (!exists) setStyleTarget(null);
  }, [doc, styleTarget]);

  // 形状 / 模板两个下拉互斥：点外面时一起收起，避免两块面板叠在一起
  useEffect(() => {
    if (!shapeMenu && !templateMenu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.cv-toolbar')) return;
      setShapeMenu(false);
      setTemplateMenu(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [shapeMenu, templateMenu]);

  /* ------------------------------ 载入与保存 ------------------------------ */

  useEffect(() => {
    let alive = true;
    api
      .libraries()
      .then((r) => {
        if (!alive) return;
        const id = r.activeId ?? null;
        setLibId(id);
        setStore(loadBoardStore(id, i18n.t('k7c3f1a5a')));
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setLibId(null);
        setStore(loadBoardStore(null, i18n.t('k7c3f1a5a')));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 防抖保存（整份画布列表）；离开页面时再强制落一次
  useEffect(() => {
    if (libId === undefined || !store) return;
    const timer = window.setTimeout(() => saveBoardStore(libId, store), 300);
    return () => window.clearTimeout(timer);
  }, [libId, store]);

  useEffect(
    () => () => {
      const { lib, store: last } = latestRef.current;
      if (lib !== undefined && last) saveBoardStore(lib, last);
    },
    []
  );

  /* --------------------------- 素材数据回查与剔除 --------------------------- */

  const cardIds = useMemo(() => doc?.cards.map((c) => c.id) ?? [], [doc?.cards]);

  useEffect(() => {
    const missing = cardIds.filter((id) => !items[id]).slice(0, 500);
    if (!missing.length) return;
    let alive = true;
    const wanted = new Set(missing);
    api
      .imagesByIds(missing)
      .then((r) => {
        if (!alive) return;
        const got = new Map(r.items.map((it) => [it.id, it]));
        setItems((prev) => {
          const next = { ...prev };
          for (const it of r.items) next[it.id] = it;
          return next;
        });
        // 图库里已经删掉的 id：从画布上剔除，避免留下永远加载不出来的空卡
        if (got.size < wanted.size) {
          setDoc((prev) =>
            prev
              ? { ...prev, cards: prev.cards.filter((c) => !wanted.has(c.id) || got.has(c.id)) }
              : prev
          );
        }
      })
      .catch(quiet);
    return () => {
      alive = false;
    };
  }, [cardIds, items]);

  /* ------------------------------- 视口尺寸 ------------------------------- */

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitView = useCallback((cards?: CanvasCard[]) => {
    const el = viewportRef.current;
    if (!el) return;
    const list = cards ?? docRef.current?.cards ?? [];
    const rect = el.getBoundingClientRect();
    const b = boundsOf(list);
    if (!b) {
      setDoc((prev) =>
        prev ? { ...prev, view: { x: rect.width / 2 - CARD_W / 2, y: rect.height / 2 - 160, zoom: 1 } } : prev
      );
      return;
    }
    const pad = 120;
    const zoom = clamp(Math.min((rect.width - pad) / b.w, (rect.height - pad) / b.h), ZOOM_MIN, 1.2);
    setDoc((prev) =>
      prev
        ? {
            ...prev,
            view: {
              x: (rect.width - b.w * zoom) / 2 - b.x * zoom,
              y: (rect.height - b.h * zoom) / 2 - b.y * zoom,
              zoom,
            },
          }
        : prev
    );
  }, []);

  // 打开 / 切到另一张画布且已有内容：自动适应窗口，避免停在空白角落
  useEffect(() => {
    if (!doc || !store) return;
    const boardId = store.activeId;
    if (fittedBoardRef.current === boardId) return;
    if (!doc.cards.length || sizeRef.current.w <= 0) return;
    fittedBoardRef.current = boardId;
    fitView(doc.cards);
  }, [doc, store, fitView]);

  /* ------------------------------- 添加素材 ------------------------------- */

  const addItems = useCallback(
    (list: ImageItem[], opts?: { select?: boolean; at?: { x: number; y: number } }) => {
      if (!list.length) return;
      setItems((prev) => {
        const next = { ...prev };
        for (const it of list) next[it.id] = it;
        return next;
      });
      const known = new Set((docRef.current?.cards ?? []).map((c) => c.id));
      const fresh = list.filter((it) => !known.has(it.id));
      if (!fresh.length) return;
      setDoc((prev) => {
        if (!prev) return prev;
        const el = viewportRef.current;
        const rect = el?.getBoundingClientRect();
        const v = prev.view;
        // 有落点（拖放/粘贴）就围着落点铺，否则放视口中心。
        // 素材抽屉展开时中心要左移，否则新卡片正好被抽屉盖住，看起来像「没加进来」。
        const reserveRight = pickerOpen ? 340 : 0;
        const cx = opts?.at?.x ?? (rect ? (rect.width - reserveRight) / 2 / v.zoom - v.x / v.zoom : 0);
        const cy = opts?.at?.y ?? (rect ? (rect.height / 2 - v.y) / v.zoom : 0);
        const gap = 20;

        // 列数同时受「数量」和「当前视口能放几列」限制：窄窗口里不会把新卡片排到屏幕外
        const availW = rect ? (rect.width - reserveRight) / v.zoom - 64 : 1200;
        const maxCols = Math.max(1, Math.floor((availW + gap) / (CARD_W + gap)));
        const cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(fresh.length))));
        const rowsItems: ImageItem[][] = [];
        for (let i = 0; i < fresh.length; i += cols) rowsItems.push(fresh.slice(i, i + cols));
        const rowHeights = rowsItems.map((row) => Math.max(...row.map((it) => cardHeight(it, CARD_W))));
        const blockW = Math.max(...rowsItems.map((row) => row.length * CARD_W + (row.length - 1) * gap));
        const blockH = rowHeights.reduce((a, b) => a + b, 0) + (rowsItems.length - 1) * gap;

        // 整块作为一个矩形找空地：便签/形状/链接卡也算障碍物
        const { x: x0, y: y0 } = freeSpot(docRects(prev), blockW, blockH, cx, cy, gap);

        const cards = [...prev.cards];
        let y = y0;
        rowsItems.forEach((row, ri) => {
          const rowW = row.length * CARD_W + (row.length - 1) * gap;
          let x = x0 + (blockW - rowW) / 2;
          for (const it of row) {
            cards.push({ id: it.id, x: Math.round(x), y, w: CARD_W, h: cardHeight(it, CARD_W) });
            x += CARD_W + gap;
          }
          y += rowHeights[ri] + gap;
        });
        return { ...prev, cards };
      });
      if (opts?.select !== false) setSelected(new Set(fresh.map((it) => it.id)));
      // 一次加很多张：自动缩放到能看全，避免新卡片落在当前视口外让人以为没加进来
      if (fresh.length >= 6) requestAnimationFrame(() => fitView());
    },
    [fitView, pickerOpen]
  );

  /* ------------------------- 粘贴 / 拖入 / 文件夹导入 ------------------------- */

  /** 本地文件先入库，再摆到画布上（粘贴、系统拖入、文件夹导入共用） */
  const uploadAndAdd = useCallback(
    async (files: File[], at?: { x: number; y: number }) => {
      const media = files.filter(
        (f) =>
          f.type.startsWith('image/') ||
          f.type.startsWith('video/') ||
          /\.(jpe?g|png|webp|gif|bmp|avif|heic|tiff?|svg|mp4|webm|mov|mkv)$/i.test(f.name)
      );
      if (!media.length) return;
      const queue = [...media];
      const added: ImageItem[] = [];
      let failed = 0;
      const worker = async () => {
        for (;;) {
          const f = queue.shift();
          if (!f) return;
          try {
            const r = await api.uploadFile(f);
            if (r?.image) added.push(r.image);
            else failed++;
          } catch {
            failed++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
      if (added.length) {
        addItems(added, { at });
        onToast(i18n.t('k7c3f1a4f', { p0: added.length }));
      }
      if (failed) onToast(i18n.t('k7c3f1a50'), 'error');
    },
    [addItems, onToast]
  );

  // Ctrl+V：截图或复制的图片文件直接落到画布
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // 大图预览打开时不抢粘贴
      if (document.querySelector('.lightbox')) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) {
        return;
      }
      const files = Array.from(e.clipboardData?.files || []);
      if (!files.length) return;
      e.preventDefault();
      void uploadAndAdd(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadAndAdd]);

  /** 直接加到「当前画布」：扩展采集等后台来源不弹选择框，避免打断用户 */
  const addIdsToActive = useCallback(
    async (ids: number[]) => {
      const known = new Set(docRef.current?.cards.map((c) => c.id) ?? []);
      const missing = ids.filter((id) => !known.has(id)).slice(0, 500);
      if (!missing.length) return;
      const r = await api.imagesByIds(missing).catch(() => null);
      if (!r?.items.length) return;
      addItems(r.items);
      onToast(i18n.t('k7c3f1a4f', { p0: r.items.length }));
    },
    [addItems, onToast]
  );

  // 图库/灯箱「发送到画布」：先问加到哪张画布，不再默认塞进当前画布
  useEffect(() => {
    const merge = (ids: number[]) => {
      if (!ids.length) return;
      setPendingIds((prev) => [...new Set([...(prev || []), ...ids])]);
    };
    const onAdd = (e: Event) => {
      const d = (e as CustomEvent<{ ids?: number[] }>).detail;
      merge(Array.isArray(d?.ids) ? d.ids.map(Number).filter((n) => n > 0) : []);
      // 画布已经开着时队列没人消费，清掉，避免下次进来又弹一次选择框
      window.setTimeout(() => takeQueuedCanvasAdd(), 0);
    };
    // 扩展采集等后台来源：不抢当前页面，直接落到当前画布
    const onPush = (e: Event) => {
      const d = (e as CustomEvent<{ ids?: number[] }>).detail;
      const ids = Array.isArray(d?.ids) ? d.ids.map(Number).filter((n) => n > 0) : [];
      if (!ids.length) return;
      window.setTimeout(() => takeQueuedCanvasAdd(), 0);
      void addIdsToActive(ids);
    };
    window.addEventListener('tuku:canvas-add', onAdd);
    window.addEventListener('tuku:canvas-push', onPush);
    return () => {
      window.removeEventListener('tuku:canvas-add', onAdd);
      window.removeEventListener('tuku:canvas-push', onPush);
    };
  }, [addIdsToActive]);

  // 从图库切过来时，暂存的 id 交给选择框处理
  useEffect(() => {
    if (libId === undefined || !store || queueDoneRef.current) return;
    queueDoneRef.current = true;
    const ids = takeQueuedCanvasAdd();
    if (ids.length) setPendingIds(ids);
  }, [libId, store]);

  /* ------------------------------- 画布管理 ------------------------------- */

  const switchBoard = useCallback(
    (id: string) => {
      setStore((prev) => (prev && prev.activeId !== id ? { ...prev, activeId: id } : prev));
      setSelected(new Set());
    },
    []
  );

  const createBoard = useCallback(() => {
    setStore((prev) => {
      if (!prev) return prev;
      const board = {
        id: makeBoardId(),
        name: nextBoardName(prev.boards, i18n.t('k7c3f1a3b')),
        doc: emptyDoc(),
      };
      return { ...prev, boards: [...prev.boards, board], activeId: board.id };
    });
    setSelected(new Set());
    onToast(i18n.t('k7c3f1a54'));
  }, [onToast]);

  const renameBoard = useCallback(async () => {
    const cur = store?.boards.find((b) => b.id === store.activeId);
    if (!cur) return;
    // Electron 不支持 window.prompt，必须用应用内对话框
    const input = await promptDialog(i18n.t('k7c3f1a58'), cur.name);
    const name = String(input || '').trim();
    if (!name || name === cur.name) return;
    setStore((prev) =>
      prev
        ? { ...prev, boards: prev.boards.map((b) => (b.id === cur.id ? { ...b, name } : b)) }
        : prev
    );
  }, [store]);

  const deleteBoard = useCallback(() => {
    setStore((prev) => {
      if (!prev) return prev;
      const cur = prev.boards.find((b) => b.id === prev.activeId);
      if (!cur) return prev;
      if (!window.confirm(i18n.t('k7c3f1a57', { p0: cur.name }))) return prev;
      let boards = prev.boards.filter((b) => b.id !== cur.id);
      if (!boards.length) {
        boards = [{ id: makeBoardId(), name: i18n.t('k7c3f1a5a'), doc: emptyDoc() }];
      }
      return { ...prev, boards, activeId: boards[0].id };
    });
    setSelected(new Set());
  }, []);

  /**
   * 选择框确认：把待加入的素材放到指定画布（或新建一张）。
   * addItems 读的是「当前 board」，所以先切画布，等状态落地后再落图。
   */
  const chooseTarget = useCallback(
    async (target: string) => {
      const ids = pendingIds || [];
      setPendingIds(null);
      if (!ids.length) return;
      const r = await api.imagesByIds(ids.slice(0, 500)).catch(() => null);
      if (!r?.items.length) {
        onToast(i18n.t('k7c3f1a40'), 'error');
        return;
      }
      if (target === 'new') {
        const board = {
          id: makeBoardId(),
          name: nextBoardName(store?.boards ?? [], i18n.t('k7c3f1a3b')),
          doc: emptyDoc(),
        };
        setStore((prev) => (prev ? { ...prev, boards: [...prev.boards, board], activeId: board.id } : prev));
      } else {
        setStore((prev) => (prev ? { ...prev, activeId: target } : prev));
      }
      requestAnimationFrame(() => {
        addItems(r.items, { select: true });
        onToast(i18n.t('k7c3f1a4f', { p0: r.items.length }));
      });
    },
    [pendingIds, store, addItems, onToast]
  );

  /* ------------------------------- 视图操作 ------------------------------- */

  const zoomBy = useCallback((factor: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const v = viewRef.current;
    const zoom = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (zoom === v.zoom) return;
    const wx = (rect.width / 2 - v.x) / v.zoom;
    const wy = (rect.height / 2 - v.y) / v.zoom;
    setDoc((prev) =>
      prev ? { ...prev, view: { x: rect.width / 2 - wx * zoom, y: rect.height / 2 - wy * zoom, zoom } } : prev
    );
  }, []);

  const arrange = useCallback(() => {
    setDoc((prev) => {
      if (!prev || !prev.cards.length) return prev;
      const rect = viewportRef.current?.getBoundingClientRect();
      const worldW = ((rect?.width || 1200) - 120) / prev.view.zoom;
      const gap = 24;
      const cols = Math.max(1, Math.floor(worldW / (CARD_W + gap)));
      const sorted = [...prev.cards].sort((a, b) => a.y - b.y || a.x - b.x);
      const rows: CanvasCard[][] = [];
      for (let i = 0; i < sorted.length; i += cols) rows.push(sorted.slice(i, i + cols));
      let y = 0;
      const cards: CanvasCard[] = [];
      for (const row of rows) {
        const rowH = Math.max(...row.map((c) => c.h));
        let x = 0;
        for (const c of row) {
          cards.push({ ...c, x, y });
          x += c.w + gap;
        }
        y += rowH + gap;
      }
      return { ...prev, cards };
    });
    // 等布局状态落地后再适配一次窗口
    window.setTimeout(() => fitView(), 0);
    onToast(i18n.t('k7c3f1a43'));
  }, [fitView, onToast]);

  const removeSelected = useCallback(() => {
    if (!selected.size) return;
    const ids = selected;
    setDoc((prev) => (prev ? { ...prev, cards: prev.cards.filter((c) => !ids.has(c.id)) } : prev));
    setSelected(new Set());
    onToast(i18n.t('k7c3f1a42'));
  }, [selected, onToast]);

  const clearBoard = useCallback(() => {
    const d = docRef.current;
    if (!d || (!d.cards.length && !d.notes.length && !d.shapes.length && !d.links.length && !d.arrows.length)) return;
    if (!window.confirm(i18n.t('k7c3f1a3d'))) return;
    // 清空是「整张画布」：便签/形状/链接/连线一起清，避免留下孤立的线
    setDoc((prev) => ({ ...prev, cards: [], notes: [], shapes: [], links: [], arrows: [] }));
    setSelected(new Set());
    onToast(i18n.t('k7c3f1a3c'));
  }, [onToast]);

  /** 空画布一键铺入最近素材：不用先打开抽屉也能把画布填满 */
  const fillRecent = useCallback(() => {
    api
      .images(DEFAULT_FILTERS, 1, 60)
      .then((r) => {
        if (!r.items.length) {
          onToast(i18n.t('k7c3f1a40'));
          return;
        }
        addItems(r.items);
        onToast(i18n.t('k7c3f1a35'));
      })
      .catch((e) => onToast((e as Error).message, 'error'));
  }, [addItems, onToast]);

  const openById = useCallback(
    (id: number) => {
      const item = items[id];
      if (!item) return;
      const pool = (docRef.current?.cards ?? []).map((c) => items[c.id]).filter(Boolean) as ImageItem[];
      onOpen(item, pool.length ? pool : [item]);
    },
    [items, onOpen]
  );

  /* ------------------------------ 指针手势 ------------------------------ */

  const handleMove = useCallback((e: PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.kind === 'pan') {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      setDoc((prev) =>
        prev ? { ...prev, view: { ...prev.view, x: g.viewX + dx, y: g.viewY + dy } } : prev
      );
      return;
    }
    if (g.kind === 'move') {
      setDrag({
        ids: new Set(g.ids),
        dx: (e.clientX - g.startX) / g.zoom,
        dy: (e.clientY - g.startY) / g.zoom,
      });
      return;
    }
    if (g.kind === 'resize') {
      const w = clamp(g.w + (e.clientX - g.startX) / g.zoom, CARD_MIN_W, CARD_MAX_W);
      setResize({ id: g.id, w });
      return;
    }
    const x = Math.min(g.startX, e.clientX);
    const y = Math.min(g.startY, e.clientY);
    setMarquee({ x, y, w: Math.abs(e.clientX - g.startX), h: Math.abs(e.clientY - g.startY) });
  }, []);

  const handleUp = useCallback((e: PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.kind === 'move') {
      const dx = (e.clientX - g.startX) / g.zoom;
      const dy = (e.clientY - g.startY) / g.zoom;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        setDoc((prev) =>
          prev
            ? {
                ...prev,
                cards: prev.cards.map((c) =>
                  g.origin[c.id] ? { ...c, x: Math.round(g.origin[c.id].x + dx), y: Math.round(g.origin[c.id].y + dy) } : c
                ),
              }
            : prev
        );
      }
    } else if (g.kind === 'resize') {
      const w = clamp(g.w + (e.clientX - g.startX) / g.zoom, CARD_MIN_W, CARD_MAX_W);
      const ratio = g.ratio;
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              cards: prev.cards.map((c) =>
                c.id === g.id ? { ...c, w: Math.round(w), h: Math.max(40, Math.round(w * ratio)) } : c
              ),
            }
          : prev
      );
    } else if (g.kind === 'marquee') {
      const el = viewportRef.current;
      const v = viewRef.current;
      const x1 = (Math.min(g.startX, e.clientX) - (el?.getBoundingClientRect().left || 0) - v.x) / v.zoom;
      const y1 = (Math.min(g.startY, e.clientY) - (el?.getBoundingClientRect().top || 0) - v.y) / v.zoom;
      const x2 = (Math.max(g.startX, e.clientX) - (el?.getBoundingClientRect().left || 0) - v.x) / v.zoom;
      const y2 = (Math.max(g.startY, e.clientY) - (el?.getBoundingClientRect().top || 0) - v.y) / v.zoom;
      const hit = (docRef.current?.cards ?? []).filter(
        (c) => c.x < x2 && c.x + c.w > x1 && c.y < y2 && c.y + c.h > y1
      );
      const next = new Set(g.additive ? g.base : []);
      for (const c of hit) next.add(c.id);
      setSelected(next);
    }
    gestureRef.current = null;
    setDrag(null);
    setResize(null);
    setMarquee(null);
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleUp);
  }, [handleMove]);

  const beginGesture = useCallback(
    (g: Gesture) => {
      gestureRef.current = g;
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    },
    [handleMove, handleUp]
  );

  const onViewportDown = (e: React.PointerEvent) => {
    // 连线模式：两次点击定两端；第一下到第二下之间实时画预览线
    if (arrowMode) {
      if (e.button !== 0) return;
      e.preventDefault();
      const p = worldAt(e.clientX, e.clientY);
      const rects = docRects(docRef.current ?? emptyDoc());
      const tol = 18 / viewRef.current.zoom;
      const snap = snapAnchor(rects, p, tol);
      const rect = snap?.rect ?? hitNode(rects, p);
      const center = snap ? { x: snap.x, y: snap.y } : rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : p;
      if (!arrowFrom) {
        // 吸附到角/边中点时直接记住坐标；否则落到节点内则走「边缘出发」
        setArrowFrom({ ...center, rect: snap ? null : rect, fixed: !!snap });
        setArrowCursor(center);
        setSnapHint(snap);
      } else {
        if (!snap && !rect && !arrowFrom.fixed && !arrowFrom.rect && Math.hypot(center.x - arrowFrom.x, center.y - arrowFrom.y) < 4) {
          setArrowFrom(null);
          setArrowCursor(null);
          setSnapHint(null);
          return;
        }
        // 起点：吸附点保持不动；落在节点内则从朝向终点的边缘出发；自由点保留落点
        const start = arrowFrom.fixed
          ? { x: arrowFrom.x, y: arrowFrom.y }
          : arrowFrom.rect
            ? edgeOf(arrowFrom.rect, snap ?? (rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : p))
            : { x: arrowFrom.x, y: arrowFrom.y };
        // 终点：吸附点精确落位；落在节点内则收束到朝向起点的边缘
        const end = snap ? { x: snap.x, y: snap.y } : rect ? edgeOf(rect, start) : { x: center.x, y: center.y };
        setDoc((prev) => ({
          ...prev,
          arrows: [
            ...prev.arrows,
            {
              id: makeNodeId('a'),
              x1: start.x,
              y1: start.y,
              x2: end.x,
              y2: end.y,
              color: arrowStyle.color,
              width: arrowStyle.width,
            },
          ],
        }));
        setArrowFrom(null);
        setArrowCursor(null);
        setSnapHint(null);
        setArrowMode(false);
      }
      return;
    }
    if (arrowSel) setArrowSel(null);
    // 中键 / 右键 / 空格 / 手型模式都进入平移；默认左键拖空白是框选
    if (e.button === 1 || e.button === 2 || spaceHeld || tool === 'pan') {
      e.preventDefault();
      beginGesture({ kind: 'pan', startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y });
      return;
    }
    if (e.button !== 0) return;
    // 点在空白处：框选（按住 Shift/Ctrl 追加）
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) setSelected(new Set());
    beginGesture({
      kind: 'marquee',
      startX: e.clientX,
      startY: e.clientY,
      additive: e.ctrlKey || e.metaKey || e.shiftKey,
      base: new Set(selected),
    });
  };

  const onCardDown = (e: React.PointerEvent, card: CanvasCard) => {
    if (e.button !== 0 || spaceHeld || tool === 'pan') return; // 交给画布平移
    e.stopPropagation();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    let next = selected;
    if (additive) {
      next = new Set(selected);
      if (next.has(card.id)) next.delete(card.id);
      else next.add(card.id);
    } else if (!selected.has(card.id)) {
      next = new Set([card.id]);
    }
    setSelected(next);
    if (!next.has(card.id)) return;
    const origin: Record<number, { x: number; y: number }> = {};
    for (const c of docRef.current?.cards ?? []) if (next.has(c.id)) origin[c.id] = { x: c.x, y: c.y };
    beginGesture({
      kind: 'move',
      startX: e.clientX,
      startY: e.clientY,
      zoom: viewRef.current.zoom,
      ids: [...next],
      origin,
    });
  };

  const onResizeDown = (e: React.PointerEvent, card: CanvasCard) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    beginGesture({
      kind: 'resize',
      startX: e.clientX,
      zoom: viewRef.current.zoom,
      id: card.id,
      w: card.w,
      ratio: card.h / card.w,
    });
  };

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    },
    [handleMove, handleUp]
  );

  /* ------------------------------ 滚轮与键盘 ------------------------------ */

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const zoom = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX);
      if (zoom === v.zoom) return;
      const wx = (px - v.x) / v.zoom;
      const wy = (py - v.y) / v.zoom;
      setDoc((prev) =>
        prev ? { ...prev, view: { x: px - wx * zoom, y: py - wy * zoom, zoom } } : prev
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const isTyping = () => {
      const a = document.activeElement;
      return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      // 大图预览 / 工具箱打开时让位：空格在大图里是播放/退出预览，不能同时进平移
      if (document.querySelector('.lightbox, .tk-backdrop, .cmp-overlay')) return;
      if (e.code === 'Space' && !isTyping()) {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (isTyping()) return;
      if (e.key === 'Escape') {
        setSelected(new Set());
        setPickerOpen(false);
        setArrowMode(false);
        setArrowFrom(null);
        setArrowCursor(null);
        setSnapHint(null);
        setArrowSel(null);
        setTemplateMenu(false);
        setShapeMenu(false);
        setStyleTarget(null);
        setExportPreview(null);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (arrowSel) {
          e.preventDefault();
          setDoc((prev) => (prev ? { ...prev, arrows: prev.arrows.filter((a) => a.id !== arrowSel) } : prev));
          setArrowSel(null);
        } else if (selected.size) {
          e.preventDefault();
          removeSelected();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(docRef.current?.cards.map((c) => c.id) ?? []));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [selected, removeSelected, arrowSel, setDoc]);

  /* ------------------------------ 画布元素 ------------------------------ */

  /** 视口中心对应的世界坐标（新元素默认落在这里） */
  const centerWorld = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (rect ? rect.width / 2 - v.x : 0) / v.zoom,
      y: (rect ? rect.height / 2 - v.y : 0) / v.zoom,
    };
  };

  const addNote = useCallback(
    (text = '', color = '#f5e6a8') => {
      const c = centerWorld();
      setDoc((prev) => {
        const spot = freeSpot(docRects(prev), 240, 160, c.x, c.y);
        return {
          ...prev,
          notes: [
            ...prev.notes,
            {
              id: makeNodeId('n'),
              x: spot.x,
              y: spot.y,
              w: 240,
              h: 160,
              text,
              color,
              fontSize: 14,
              textColor: '#241f16',
              noteShape: 'rounded',
            },
          ],
        };
      });
    },
    [setDoc]
  );

  const addShape = useCallback(
    (shape: CanvasShapeKind = 'rect') => {
      const c = centerWorld();
      setDoc((prev) => {
        const spot = freeSpot(docRects(prev), 320, 240, c.x, c.y);
        return {
          ...prev,
          shapes: [
            ...prev.shapes,
            {
              id: makeNodeId('s'),
              x: spot.x,
              y: spot.y,
              w: 320,
              h: 240,
              shape,
              color: shapeColor,
            },
          ],
        };
      });
    },
    [setDoc, shapeColor]
  );

  const addLink = useCallback(async () => {
    const input = await promptDialog(i18n.t('k7c3f1c04'), 'https://', 'https://example.com');
    const url = String(input || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      onToast(i18n.t('k7c3f1c4c'), 'error');
      return;
    }
    let title = url;
    try {
      title = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* 保留原串 */
    }
    const c = centerWorld();
    setDoc((prev) => {
      const spot = freeSpot(docRects(prev), 360, 240, c.x, c.y);
      return {
        ...prev,
        links: [
          ...prev.links,
          { id: makeNodeId('l'), x: spot.x, y: spot.y, w: 360, h: 240, url, title },
        ],
      };
    });
  }, [setDoc, onToast]);

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      setDoc((prev) => ({
        ...prev,
        notes: prev.notes.map((n) => (n.id === id ? { ...n, x, y } : n)),
        shapes: prev.shapes.map((s) => (s.id === id ? { ...s, x, y } : s)),
        links: prev.links.map((l) => (l.id === id ? { ...l, x, y } : l)),
      }));
    },
    [setDoc]
  );

  const changeNote = useCallback(
    (id: string, patch: Partial<CanvasNote>) => {
      setDoc((prev) => ({ ...prev, notes: prev.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
    },
    [setDoc]
  );

  const changeShape = useCallback(
    (id: string, patch: Partial<CanvasShape>) => {
      if (patch.color) setShapeColor(patch.color);
      setDoc((prev) => ({ ...prev, shapes: prev.shapes.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
    },
    [setDoc]
  );

  /** 改连线样式：没有选中线时只影响下一条，选中时立刻改当前这条 */
  const applyArrowStyle = useCallback(
    (patch: Partial<{ color: string; width: number }>) => {
      setArrowStyle((prev) => ({ ...prev, ...patch }));
      if (!arrowSel) return;
      setDoc((prev) =>
        prev
          ? { ...prev, arrows: prev.arrows.map((a) => (a.id === arrowSel ? { ...a, ...patch } : a)) }
          : prev
      );
    },
    [arrowSel, setDoc]
  );

  const deleteNode = useCallback(
    (id: string) => {
      setDoc((prev) => ({
        ...prev,
        notes: prev.notes.filter((n) => n.id !== id),
        shapes: prev.shapes.filter((s) => s.id !== id),
        links: prev.links.filter((l) => l.id !== id),
        arrows: prev.arrows.filter((a) => a.id !== id),
      }));
    },
    [setDoc]
  );

  /** 模板：用「2/3/5 列网格」铺便签，和已有元素自动错开，落地后每个节点都能拖动缩放 */
  const addTemplate = useCallback(
    (kind: 'mood' | 'character' | 'competitor' | 'storyboard' | 'journey' | 'swot' | 'kanban') => {
      const titles =
        kind === 'mood'
          ? [i18n.t('k7c3f1c13'), i18n.t('k7c3f1c14'), i18n.t('k7c3f1c15'), i18n.t('k7c3f1c16')]
          : kind === 'character'
            ? [i18n.t('k7c3f1c17'), i18n.t('k7c3f1c18'), i18n.t('k7c3f1c19'), i18n.t('k7c3f1c20')]
            : kind === 'competitor'
              ? [i18n.t('k7c3f1c21'), i18n.t('k7c3f1c22'), i18n.t('k7c3f1c23'), i18n.t('k7c3f1c24')]
              : kind === 'storyboard'
                ? [1, 2, 3, 4, 5, 6].map((n) => i18n.t('k7c3f1c38', { p0: n }))
                : kind === 'journey'
                  ? [
                      i18n.t('k7c3f1c3a'),
                      i18n.t('k7c3f1c3b'),
                      i18n.t('k7c3f1c3c'),
                      i18n.t('k7c3f1c3d'),
                      i18n.t('k7c3f1c3e'),
                    ]
                  : kind === 'swot'
                    ? [
                        i18n.t('k7c3f1c40'),
                        i18n.t('k7c3f1c41'),
                        i18n.t('k7c3f1c42'),
                        i18n.t('k7c3f1c43'),
                      ]
                    : [i18n.t('k7c3f1c45'), i18n.t('k7c3f1c46'), i18n.t('k7c3f1c47')];
      const cols = kind === 'journey' ? 5 : kind === 'storyboard' || kind === 'kanban' ? 3 : 2;
      const nw = kind === 'journey' ? 200 : kind === 'kanban' ? 230 : 240;
      const nh = kind === 'kanban' ? 320 : kind === 'storyboard' ? 150 : 160;
      const gap = 20;
      const palette =
        kind === 'swot'
          ? ['#d8f0d0', '#f7d6e0', '#cfd8f7', '#f5e6a8']
          : ['#f5e6a8', '#cfd8f7', '#d8f0d0', '#f7d6e0', '#e7d9ff', '#ffe0c2'];
      const rows = Math.ceil(titles.length / cols);
      const blockW = cols * nw + (cols - 1) * gap;
      const blockH = rows * nh + (rows - 1) * gap;
      setDoc((prev) => {
        const v = prev.view;
        const rect = viewportRef.current?.getBoundingClientRect();
        // 工具条悬浮在左上角：模板的落点和随后的取景都要让开它，不能把第一行便签塞到工具条底下
        const toolbar = document.querySelector('.cv-toolbar') as HTMLElement | null;
        const tb = toolbar?.getBoundingClientRect();
        const safeTop = rect && tb ? Math.max(0, tb.bottom - rect.top + 20) : 76;
        const vw = rect?.width ?? 1200;
        const vh = rect?.height ?? 800;
        const anchorCy = Math.max(vh / 2, safeTop + (blockH * v.zoom) / 2 + 8);
        const cx = (vw / 2 - v.x) / v.zoom;
        const cy = (anchorCy - v.y) / v.zoom;
        const spot = freeSpot(docRects(prev), blockW, blockH, cx, cy, gap);
        const notes = titles.map((t, i) => ({
          id: makeNodeId('n'),
          x: spot.x + (i % cols) * (nw + gap),
          y: spot.y + Math.floor(i / cols) * (nh + gap),
          w: nw,
          h: nh,
          text: t,
          color: palette[i % palette.length],
          fontSize: 14,
          textColor: '#241f16',
          noteShape: 'rounded' as const,
        }));
        // 模板可能被 freeSpot 挪到视口外：把取景移到模板上，保证一眼能看到全部便签
        const availW = Math.max(120, vw - 48);
        const availH = Math.max(120, vh - safeTop - 24);
        const zoom = clamp(Math.min(v.zoom, availW / blockW, availH / blockH), ZOOM_MIN, ZOOM_MAX);
        const view = {
          x: vw / 2 - (spot.x + blockW / 2) * zoom,
          y: (safeTop + vh) / 2 - (spot.y + blockH / 2) * zoom,
          zoom,
        };
        return { ...prev, notes: [...prev.notes, ...notes], view };
      });
      setTemplateMenu(false);
      onToast(i18n.t('k7c3f1c25'));
    },
    [setDoc, onToast]
  );

  const doExport = useCallback(
    async (kind: 'png' | 'pdf') => {
      if (!doc) return;
      setExportPreview(null);
      setExporting(kind);
      try {
        const name = store?.boards.find((b) => b.id === store.activeId)?.name || 'canvas';
        const blob = kind === 'png' ? await exportCanvasPng(doc, items) : await exportCanvasPdf(doc, items);
        downloadBlob(blob, `${name}.${kind}`);
        onToast(i18n.t('k7c3f1c26'));
      } catch (err) {
        onToast((err as Error).message || i18n.t('k7c3f1c27'), 'error');
      } finally {
        setExporting('');
      }
    },
    [doc, items, store, onToast]
  );

  /** 先渲染一张低分辨率预览，用户确认后再走完整导出 */
  const openExport = useCallback(
    async (kind: 'png' | 'pdf') => {
      if (!doc) return;
      setExporting(kind);
      try {
        setExportPreview({ kind, dataUrl: await renderCanvasPreview(doc, items) });
      } catch (err) {
        onToast((err as Error).message || i18n.t('k7c3f1c27'), 'error');
      } finally {
        setExporting('');
      }
    },
    [doc, items, onToast]
  );

  /* ------------------------------ 拖放与导入 ------------------------------ */

  /** 屏幕坐标 → 画布世界坐标（缩放/平移都折算进去） */
  const worldAt = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - (rect?.left || 0) - v.x) / v.zoom,
      y: (clientY - (rect?.top || 0) - v.y) / v.zoom,
    };
  };

  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault();
    setDropHint(false);
    const at = worldAt(e.clientX, e.clientY);
    // 素材抽屉里拖出来的：按松手位置落一张
    const picked = dragItemRef.current;
    dragItemRef.current = null;
    if (picked) {
      addItems([picked], { at });
      return;
    }
    void filesFromDrop(e.dataTransfer).then((files) => {
      if (files.length) void uploadAndAdd(files, at);
    });
  };

  const onFolderPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) void uploadAndAdd(files);
  };

  /* -------------------------------- 渲染 -------------------------------- */

  const { visible, cullCount } = useMemo(() => {
    const cards = doc?.cards ?? [];
    const el = viewportRef.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    if (!w || !h) return { visible: cards, cullCount: 0 };
    const x1 = (-view.x) / view.zoom - 240;
    const y1 = (-view.y) / view.zoom - 240;
    const x2 = (w - view.x) / view.zoom + 240;
    const y2 = (h - view.y) / view.zoom + 240;
    const list = cards.filter((c) => c.x < x2 && c.x + c.w > x1 && c.y < y2 && c.y + c.h > y1);
    return { visible: list, cullCount: cards.length - list.length };
  }, [doc?.cards, view.x, view.y, view.zoom]);

  const chosen = useMemo(() => new Set(doc?.cards.map((c) => c.id) ?? []), [doc?.cards]);

  /** 样式面板跟随节点：用世界坐标 × 当前缩放/平移算屏幕位置，缩放拖动时不会跑偏 */
  const styleNote =
    styleTarget?.kind === 'note' ? (doc?.notes.find((n) => n.id === styleTarget.id) ?? null) : null;
  const styleShape =
    styleTarget?.kind === 'shape' ? (doc?.shapes.find((s) => s.id === styleTarget.id) ?? null) : null;
  const styleNode = styleNote ?? styleShape;
  const vpW = viewportRef.current?.clientWidth ?? 0;
  const vpH = viewportRef.current?.clientHeight ?? 0;
  const stylePos = styleNode
    ? {
        left: clamp(styleNode.x * view.zoom + view.x, 8, Math.max(8, vpW - 252)),
        top: clamp((styleNode.y + styleNode.h) * view.zoom + view.y + 8, 8, Math.max(8, vpH - 264)),
      }
    : undefined;

  return (
    <div className={`cv-root${tool === 'pan' || spaceHeld ? ' panning' : ''}`}>
      <div
        ref={viewportRef}
        className="cv-viewport"
        style={{
          backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={onViewportDown}
        onPointerMove={(e) => {
          if (!arrowMode) return;
          const p = worldAt(e.clientX, e.clientY);
          setSnapHint(snapAnchor(docRects(docRef.current ?? emptyDoc()), p, 18 / view.zoom));
          if (arrowFrom) setArrowCursor(p);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!dropHint) setDropHint(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(false);
        }}
        onDrop={onDropFiles}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) fitView();
        }}
      >
        <div
          className="cv-stage"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
        >
          {doc?.shapes.map((s) => (
            <ShapeView
              key={s.id}
              shape={s}
              zoom={view.zoom}
              onMove={moveNode}
              onChange={changeShape}
              onDelete={deleteNode}
              onStyle={(id) => setStyleTarget({ kind: 'shape', id })}
            />
          ))}
          {visible.map((card) => (
            <CardView
              key={card.id}
              card={card}
              item={items[card.id]}
              selected={selected.has(card.id)}
              offset={drag && drag.ids.has(card.id) ? { dx: drag.dx, dy: drag.dy } : undefined}
              overrideW={resize?.id === card.id ? resize.w : undefined}
              onPointerDown={onCardDown}
              onResizeDown={onResizeDown}
              onOpen={openById}
            />
          ))}

          <svg className="cv-arrows" width="1" height="1" aria-hidden="true">
            {doc?.arrows.map((a) => {
              const { c1x, c1y, c2x, c2y } = curveOf(a);
              const d = `M ${a.x1} ${a.y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${a.x2} ${a.y2}`;
              const ang = Math.atan2(a.y2 - c2y, a.x2 - c2x);
              const s = 8 + a.width * 1.8;
              const p1 = `${a.x2 - s * Math.cos(ang - 0.42)},${a.y2 - s * Math.sin(ang - 0.42)}`;
              const p2 = `${a.x2 - s * Math.cos(ang + 0.42)},${a.y2 - s * Math.sin(ang + 0.42)}`;
              const on = arrowSel === a.id;
              return (
                <g
                  key={a.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setArrowSel(a.id);
                    setArrowStyle({ color: a.color, width: a.width });
                  }}
                  onDoubleClick={() => deleteNode(a.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(16, a.width + 14)} />
                  <path
                    d={d}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={on ? a.width + 1.5 : a.width}
                    strokeLinecap="round"
                  />
                  <polygon points={`${a.x2},${a.y2} ${p1} ${p2}`} fill={a.color} />
                </g>
              );
            })}

            {/* 连线预览：第一次点击后跟着指针走，第二下才真正落线 */}
            {arrowMode &&
              arrowFrom &&
              (arrowCursor || snapHint) &&
              (() => {
                const end = snapHint ? { x: snapHint.x, y: snapHint.y } : arrowCursor!;
                // 起点落在卡片里时，预览也要从朝向指针的边缘出发，和最终落线一致
                const start = arrowFrom.fixed
                  ? { x: arrowFrom.x, y: arrowFrom.y }
                  : arrowFrom.rect
                    ? edgeOf(arrowFrom.rect, end)
                    : { x: arrowFrom.x, y: arrowFrom.y };
                const preview = { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
                const { c1x, c1y, c2x, c2y } = curveOf(preview);
                const d = `M ${preview.x1} ${preview.y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${preview.x2} ${preview.y2}`;
                const ang = Math.atan2(preview.y2 - c2y, preview.x2 - c2x);
                const s = 8 + arrowStyle.width * 1.8;
                const p1 = `${preview.x2 - s * Math.cos(ang - 0.42)},${preview.y2 - s * Math.sin(ang - 0.42)}`;
                const p2 = `${preview.x2 - s * Math.cos(ang + 0.42)},${preview.y2 - s * Math.sin(ang + 0.42)}`;
                return (
                  <g pointerEvents="none">
                    <path
                      d={d}
                      fill="none"
                      stroke={arrowStyle.color}
                      strokeWidth={arrowStyle.width}
                      strokeDasharray="6 5"
                      strokeLinecap="round"
                      opacity={0.85}
                    />
                    <polygon points={`${preview.x2},${preview.y2} ${p1} ${p2}`} fill={arrowStyle.color} opacity={0.85} />
                  </g>
                );
              })()}

            {/* 吸附提示：指针靠近实体的角 / 边中点时，高亮那个锚点 */}
            {arrowMode && snapHint && (
              <g pointerEvents="none">
                <circle
                  cx={snapHint.x}
                  cy={snapHint.y}
                  r={9 / view.zoom}
                  fill="none"
                  stroke={arrowStyle.color}
                  strokeWidth={2 / view.zoom}
                  opacity={0.9}
                />
                <circle cx={snapHint.x} cy={snapHint.y} r={3.5 / view.zoom} fill={arrowStyle.color} />
              </g>
            )}
          </svg>

          {doc?.links.map((l) => (
            <LinkView key={l.id} link={l} zoom={view.zoom} onMove={moveNode} onDelete={deleteNode} />
          ))}

          {doc?.notes.map((n) => (
            <NoteView
              key={n.id}
              note={n}
              zoom={view.zoom}
              onMove={moveNode}
              onChange={changeNote}
              onDelete={deleteNode}
              onStyle={(id) => setStyleTarget({ kind: 'note', id })}
            />
          ))}
        </div>

        {/* 便签 / 形状样式面板：独立于舞台，层级高于工具条，不会被遮挡 */}
        {styleNode && (
          <div
            className="cv-node-style"
            style={stylePos}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {styleNote && (
              <>
                <div className="cv-style-sec">
                  <span className="cv-style-label">{i18n.t('k7c3f1c5a')}</span>
                  <div className="cv-style-opts">
                    {NOTE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`cv-swatch${styleNote.color === c ? ' on' : ''}`}
                        style={{ background: c }}
                        title={c}
                        onClick={() => changeNote(styleNote.id, { color: c })}
                      />
                    ))}
                    <input
                      type="color"
                      className="cv-color-input"
                      value={styleNote.color}
                      title={i18n.t('k7c3f1c61')}
                      onChange={(e) => changeNote(styleNote.id, { color: e.target.value })}
                    />
                  </div>
                </div>
                <div className="cv-style-sec">
                  <span className="cv-style-label">{i18n.t('k7c3f1c5b')}</span>
                  <div className="cv-style-opts">
                    {NOTE_TEXT_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`cv-swatch${styleNote.textColor === c ? ' on' : ''}`}
                        style={{ background: c }}
                        title={c}
                        onClick={() => changeNote(styleNote.id, { textColor: c })}
                      />
                    ))}
                    <input
                      type="color"
                      className="cv-color-input"
                      value={styleNote.textColor}
                      title={i18n.t('k7c3f1c61')}
                      onChange={(e) => changeNote(styleNote.id, { textColor: e.target.value })}
                    />
                  </div>
                </div>
                <div className="cv-style-sec">
                  <span className="cv-style-label">{i18n.t('k7c3f1c5c')}</span>
                  <div className="cv-style-opts">
                    {NOTE_FONT_SIZES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`cv-opt${styleNote.fontSize === s ? ' on' : ''}`}
                        onClick={() => changeNote(styleNote.id, { fontSize: s })}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cv-style-sec">
                  <span className="cv-style-label">{i18n.t('k7c3f1c5d')}</span>
                  <div className="cv-style-opts">
                    {NOTE_SHAPES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`cv-opt${styleNote.noteShape === s ? ' on' : ''}`}
                        onClick={() => changeNote(styleNote.id, { noteShape: s })}
                      >
                        {i18n.t(s === 'rect' ? 'k7c3f1c5e' : s === 'rounded' ? 'k7c3f1c5f' : 'k7c3f1c60')}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {styleShape && (
              <>
                <div className="cv-style-sec">
                  <span className="cv-style-label">{i18n.t('k7c3f1c08')}</span>
                  <div className="cv-shape-kinds">
                    {SHAPE_KINDS.map((k) => (
                      <button
                        key={k}
                        type="button"
                        className={`cv-shape-pick${styleShape.shape === k ? ' on' : ''}`}
                        title={i18n.t(SHAPE_LABEL_KEYS[k])}
                        onClick={() => changeShape(styleShape.id, { shape: k })}
                      >
                        <svg viewBox="0 0 100 100">
                          <ShapeGlyph kind={k} />
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cv-style-sec">
                  <span className="cv-style-label">{i18n.t('k7c3f1c62')}</span>
                  <div className="cv-style-opts">
                    {SHAPE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`cv-swatch${styleShape.color === c ? ' on' : ''}`}
                        style={{ background: c }}
                        title={c}
                        onClick={() => changeShape(styleShape.id, { color: c })}
                      />
                    ))}
                    <input
                      type="color"
                      className="cv-color-input"
                      value={styleShape.color}
                      title={i18n.t('k7c3f1c61')}
                      onChange={(e) => changeShape(styleShape.id, { color: e.target.value })}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {(arrowMode || arrowSel) && (
          <div className="cv-arrow-panel" onPointerDown={(e) => e.stopPropagation()}>
            <span className="cv-arrow-label">{i18n.t('k7c3f1c48')}</span>
            {ARROW_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`cv-swatch${arrowStyle.color === c ? ' on' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => applyArrowStyle({ color: c })}
              />
            ))}
            <span className="cv-tool-sep" />
            {ARROW_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className={`cv-width${arrowStyle.width === w ? ' on' : ''}`}
                title={`${i18n.t('k7c3f1c49')} ${w}px`}
                onClick={() => applyArrowStyle({ width: w })}
              >
                {w}
              </button>
            ))}
          </div>
        )}

        {arrowMode && (
          <div className="cv-arrow-hint">
            {arrowFrom ? i18n.t('k7c3f1c05') : i18n.t('k7c3f1c06')}
          </div>
        )}

        {marquee && (
          <div
            className="cv-marquee"
            style={{ left: marquee.x - (viewportRef.current?.getBoundingClientRect().left || 0), top: marquee.y - (viewportRef.current?.getBoundingClientRect().top || 0), width: marquee.w, height: marquee.h }}
          />
        )}

        {dropHint && <div className="cv-drop">{i18n.t('k7c3f1a4d')}</div>}

        {!loading &&
          doc &&
          !doc.cards.length &&
          !doc.notes.length &&
          !doc.shapes.length &&
          !doc.links.length &&
          !doc.arrows.length && (
          <div className="cv-empty">
            <div className="cv-empty-icon">
              <IconLayers size={34} />
            </div>
            <b>{i18n.t('k7c3f1a36')}</b>
            <p>{i18n.t('k7c3f1a2f')}</p>
            <button type="button" className="btn primary" onClick={() => setPickerOpen(true)}>
              <IconPlus size={14} />
              {i18n.t('k7c3f1a30')}
            </button>
            <button type="button" className="btn" onClick={fillRecent}>
              {i18n.t('k7c3f1a4b')}
            </button>
          </div>
        )}

        {loading && <div className="cv-loading">{i18n.t('k7c3f1a3e')}</div>}
      </div>

      <div className="cv-toolbar">
        <select
          className="cv-board-select"
          value={store?.activeId ?? ''}
          onChange={(e) => switchBoard(e.target.value)}
          title={i18n.t('k7c3f1a53')}
        >
          {store?.boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button type="button" className="cv-icon-btn" onClick={createBoard} title={i18n.t('k7c3f1a54')}>
          <IconPlus size={14} />
        </button>
        <button type="button" className="cv-icon-btn" onClick={() => renameBoard()} title={i18n.t('k7c3f1a55')}>
          <IconPencil size={14} />
        </button>
        <button type="button" className="cv-icon-btn" onClick={deleteBoard} title={i18n.t('k7c3f1a56')}>
          <IconTrash size={14} />
        </button>
        <span className="cv-tool-sep" />
        <button type="button" className="btn sm primary" onClick={() => setPickerOpen(true)}>
          <IconPlus size={14} />
          {i18n.t('k7c3f1a30')}
        </button>
        <button type="button" className="btn sm" onClick={() => folderInputRef.current?.click()}>
          <IconFolderOpen size={14} />
          {i18n.t('k7c3f1a4c')}
        </button>
        <span className="cv-tool-sep" />
        <button type="button" className="cv-icon-btn" title={i18n.t('k7c3f1c07')} onClick={() => addNote()}>
          <IconType size={14} />
        </button>
        <div className="cv-template-wrap">
          <button
            type="button"
            className="cv-icon-btn"
            title={i18n.t('k7c3f1c08')}
            onClick={() => {
              setShapeMenu((v) => !v);
              setTemplateMenu(false);
            }}
          >
            <IconSquare size={14} />
          </button>
          {shapeMenu && (
            <div className="cv-shape-menu">
              {SHAPE_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  title={i18n.t(SHAPE_LABEL_KEYS[k])}
                  onClick={() => {
                    addShape(k);
                    setShapeMenu(false);
                  }}
                >
                  <svg viewBox="0 0 100 100" style={{ color: shapeColor }}>
                    <ShapeGlyph kind={k} />
                  </svg>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="cv-icon-btn" title={i18n.t('k7c3f1c09')} onClick={() => void addLink()}>
          <IconLink size={14} />
        </button>
        <button
          type="button"
          className={`cv-icon-btn${arrowMode ? ' on' : ''}`}
          title={i18n.t('k7c3f1c0a')}
          onClick={() => {
            setArrowMode((v) => !v);
            setArrowFrom(null);
            setArrowCursor(null);
            setSnapHint(null);
          }}
        >
          <IconArrowUpRight size={14} />
        </button>
        <div className="cv-template-wrap">
          <button
            type="button"
            className="cv-icon-btn"
            title={i18n.t('k7c3f1c0b')}
            onClick={() => {
              setTemplateMenu((v) => !v);
              setShapeMenu(false);
            }}
          >
            <IconGrid size={14} />
          </button>
          {templateMenu && (
            <div className="cv-template-menu">
              <button type="button" onClick={() => addTemplate('mood')}>
                {i18n.t('k7c3f1c10')}
              </button>
              <button type="button" onClick={() => addTemplate('character')}>
                {i18n.t('k7c3f1c11')}
              </button>
              <button type="button" onClick={() => addTemplate('competitor')}>
                {i18n.t('k7c3f1c12')}
              </button>
              <button type="button" onClick={() => addTemplate('storyboard')}>
                {i18n.t('k7c3f1c37')}
              </button>
              <button type="button" onClick={() => addTemplate('journey')}>
                {i18n.t('k7c3f1c39')}
              </button>
              <button type="button" onClick={() => addTemplate('swot')}>
                {i18n.t('k7c3f1c3f')}
              </button>
              <button type="button" onClick={() => addTemplate('kanban')}>
                {i18n.t('k7c3f1c44')}
              </button>
            </div>
          )}
        </div>
        <span className="cv-tool-sep" />
        <button
          type="button"
          className="cv-icon-btn"
          title={i18n.t('k7c3f1c28')}
          disabled={!doc || !!exporting}
          onClick={() => void openExport('png')}
        >
          <IconDownload size={14} />
        </button>
        <button
          type="button"
          className="cv-icon-btn cv-text-btn"
          title={i18n.t('k7c3f1c29')}
          disabled={!doc || !!exporting}
          onClick={() => void openExport('pdf')}
        >
          PDF
        </button>
        <span className="cv-tool-sep" />
        <button type="button" className="btn sm" disabled={!doc?.cards.length} onClick={arrange}>
          <IconGrid size={14} />
          {i18n.t('k7c3f1a31')}
        </button>
        <button type="button" className="btn sm" disabled={!doc?.cards.length} onClick={() => fitView()}>
          <IconExpand size={14} />
          {i18n.t('k7c3f1a32')}
        </button>
        <button type="button" className="btn sm" disabled={!selected.size} onClick={removeSelected}>
          <IconTrash size={14} />
          {i18n.t('k7c3f1a37')}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={
            !doc ||
            (!doc.cards.length && !doc.notes.length && !doc.shapes.length && !doc.links.length && !doc.arrows.length)
          }
          onClick={clearBoard}
        >
          {i18n.t('k7c3f1a33')}
        </button>
        <span className="cv-tool-sep" />
        <button
          type="button"
          className={`btn sm${tool === 'pan' ? ' on' : ''}`}
          onClick={() => setTool((t) => (t === 'pan' ? 'select' : 'pan'))}
          title={i18n.t('k7c3f1a3a')}
        >
          {tool === 'pan' ? '✋' : '⬚'} {tool === 'pan' ? i18n.t('k7c3f1a45') : i18n.t('k7c3f1a46')}
        </button>
        <span className="cv-count">
          {doc?.cards.length ?? 0} {i18n.t('k7c3f1a47')}
          {cullCount > 0 ? ` · ${i18n.t('k7c3f1a48')} ${cullCount}` : ''}
        </span>
      </div>

      <div className="cv-zoom">
        <button type="button" className="cv-icon-btn" onClick={() => zoomBy(1 / 1.25)} title={i18n.t('k7c3f1a49')}>
          <IconMinus size={14} />
        </button>
        <button type="button" className="cv-zoom-val" onClick={() => fitView()} title={i18n.t('k7c3f1a39')}>
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" className="cv-icon-btn" onClick={() => zoomBy(1.25)} title={i18n.t('k7c3f1a4a')}>
          <IconPlus size={14} />
        </button>
      </div>

      <div className="cv-hint">{i18n.t('k7c3f1a3a')}</div>

      {pickerOpen && (
        <CanvasPicker
          chosen={chosen}
          onPick={(it) => addItems([it])}
          onDragStart={(it) => {
            dragItemRef.current = it;
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {pendingIds && (
        <div
          className="cv-mask"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setPendingIds(null);
          }}
        >
          <div className="cv-modal">
            <b>{i18n.t('k7c3f1a53')}</b>
            <p>{i18n.t('k7c3f1a5d', { p0: pendingIds.length })}</p>
            <div className="cv-board-list">
              {store?.boards.map((b) => (
                <button type="button" key={b.id} onClick={() => void chooseTarget(b.id)}>
                  <span>{b.name}</span>
                  <em>{b.doc.cards.length}</em>
                </button>
              ))}
            </div>
            <div className="cv-modal-actions">
              <button type="button" className="btn" onClick={() => setPendingIds(null)}>
                {i18n.t('k7c3f1a5c')}
              </button>
              <button type="button" className="btn primary" onClick={() => void chooseTarget('new')}>
                <IconPlus size={14} />
                {i18n.t('k7c3f1a54')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 文件夹批量导入：webkitdirectory 需要直接设 DOM 属性，React 没有对应类型 */}
      <input
        ref={(el) => {
          folderInputRef.current = el;
          if (el) {
            el.setAttribute('webkitdirectory', '');
            el.setAttribute('directory', '');
          }
        }}
        className="cv-file-input"
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={onFolderPicked}
      />

      {/* 导出前预览：所见即所得，确认后再真正生成文件 */}
      {exportPreview && (
        <div
          className="cv-mask cv-export-preview"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setExportPreview(null);
          }}
        >
          <div className="cv-modal cv-export-modal">
            <b>
              {i18n.t('k7c3f1c2a')} · {exportPreview.kind === 'png' ? 'PNG' : 'PDF'}
            </b>
            <img src={exportPreview.dataUrl} alt={i18n.t('k7c3f1c2a')} />
            <div className="cv-modal-actions">
              <button type="button" className="btn" onClick={() => setExportPreview(null)}>
                {i18n.t('k7c3f1c2c')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!!exporting}
                onClick={() => void doExport(exportPreview.kind)}
              >
                <IconDownload size={14} />
                {exporting ? i18n.t('k7c3f1c2d') : i18n.t('k7c3f1c2b')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
