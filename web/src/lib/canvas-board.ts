/**
 * 无限画布的本地布局存储。
 *
 * 为什么放 localStorage 而不是新建数据库表：布局只属于「这台机器上的这个资源库」，
 * 不属于素材本身；更重要的是，加表会提升 schemaVersion，让已经安装的壳无法再吃热更包
 * （热更清单要求库版本一致），用户就得为了一个画布重新装一遍客户端。
 *
 * 存进去的只有 id + 位置 + 尺寸，素材数据每次打开时按 id 批量取；
 * 已删除的素材在恢复时自动剔除，不会留下打不开的空卡。
 */
import type { ImageItem } from '../types';

export type CanvasCard = {
  id: number;
  /** 世界坐标（画布左上为原点） */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CanvasView = {
  /** 平移量（屏幕像素） */
  x: number;
  y: number;
  zoom: number;
};

/** 便签外框：直角 / 圆角 / 椭圆 */
export type CanvasNoteShape = 'rect' | 'rounded' | 'ellipse';

/** 便签 / 文字：画布上的说明卡，不依赖图库素材 */
export type CanvasNote = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** 便签底色（CSS 颜色） */
  color: string;
  /** 字号（世界坐标 px） */
  fontSize: number;
  /** 文字颜色（CSS 颜色） */
  textColor: string;
  noteShape: CanvasNoteShape;
};

export type CanvasShapeKind =
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'star'
  | 'parallelogram';

/** 工具栏 / 样式面板里的形状顺序 */
export const SHAPE_KINDS: CanvasShapeKind[] = [
  'rect',
  'ellipse',
  'triangle',
  'diamond',
  'pentagon',
  'hexagon',
  'star',
  'parallelogram',
];

/**
 * 多边形的归一化顶点（0–100 的方格）。
 * 画布用 SVG、导出用 Canvas，两边共用同一份顶点，形状才完全一致。
 */
export function shapePolygon(kind: CanvasShapeKind): [number, number][] | null {
  switch (kind) {
    case 'triangle':
      return [
        [50, 2],
        [98, 98],
        [2, 98],
      ];
    case 'diamond':
      return [
        [50, 2],
        [98, 50],
        [50, 98],
        [2, 50],
      ];
    case 'pentagon':
      return [
        [50, 2],
        [98, 38],
        [80, 98],
        [20, 98],
        [2, 38],
      ];
    case 'hexagon':
      return [
        [25, 2],
        [75, 2],
        [98, 50],
        [75, 98],
        [25, 98],
        [2, 50],
      ];
    case 'star': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 20 : 48;
        const a = (-90 + i * 36) * (Math.PI / 180);
        pts.push([Math.round((50 + r * Math.cos(a)) * 10) / 10, Math.round((50 + r * Math.sin(a)) * 10) / 10]);
      }
      return pts;
    }
    case 'parallelogram':
      return [
        [22, 2],
        [98, 2],
        [78, 98],
        [2, 98],
      ];
    default:
      return null;
  }
}

/** 形状：矩形 / 圆形 / 多边形，用来给画布分区 */
export type CanvasShape = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: CanvasShapeKind;
  color: string;
};

/** 网页 / 视频链接卡 */
export type CanvasLink = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
  title: string;
};

/** 连线：两端都是世界坐标；连到节点上时由节点边缘出发/收束 */
export type CanvasArrow = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  /** 线宽（世界坐标像素），默认 2 */
  width: number;
};

export type CanvasDoc = {
  version: 1;
  cards: CanvasCard[];
  notes: CanvasNote[];
  shapes: CanvasShape[];
  links: CanvasLink[];
  arrows: CanvasArrow[];
  view: CanvasView;
};

export const CARD_W = 220;
export const CARD_MIN_W = 80;
export const CARD_MAX_W = 560;
export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 4;

/** 旧版单画布 key（v1），保留用于迁移 */
const LEGACY_PREFIX = 'tuku:canvas:';
const STORE_PREFIX = 'tuku:canvas:boards:';

const legacyKey = (libId: number | null) => `${LEGACY_PREFIX}${libId ?? 0}`;
const storeKey = (libId: number | null) => `${STORE_PREFIX}${libId ?? 0}`;

export type CanvasBoardMeta = { id: string; name: string; doc: CanvasDoc };
export type CanvasStore = { version: 2; activeId: string; boards: CanvasBoardMeta[] };

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function defaultView(): CanvasView {
  return { x: 64, y: 64, zoom: 1 };
}

function sanitizeCard(raw: Partial<CanvasCard> | null | undefined): CanvasCard | null {
  if (!raw) return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const w = Number(raw.w);
  const h = Number(raw.h);
  return {
    id,
    x: Number.isFinite(Number(raw.x)) ? Math.round(Number(raw.x)) : 0,
    y: Number.isFinite(Number(raw.y)) ? Math.round(Number(raw.y)) : 0,
    w: clamp(Number.isFinite(w) ? w : CARD_W, CARD_MIN_W, CARD_MAX_W),
    h: clamp(Number.isFinite(h) ? h : CARD_W * 0.75, 40, 4000),
  };
}

function sanitizeView(raw: Partial<CanvasView> | null | undefined): CanvasView {
  const v = raw || {};
  return {
    x: Number.isFinite(Number(v.x)) ? Number(v.x) : 64,
    y: Number.isFinite(Number(v.y)) ? Number(v.y) : 64,
    zoom: clamp(Number.isFinite(Number(v.zoom)) ? Number(v.zoom) : 1, ZOOM_MIN, ZOOM_MAX),
  };
}

export function emptyDoc(): CanvasDoc {
  return { version: 1, cards: [], notes: [], shapes: [], links: [], arrows: [], view: defaultView() };
}

export function makeNodeId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function sanitizeDoc(raw: Partial<CanvasDoc> | null | undefined): CanvasDoc {
  if (!raw || !Array.isArray(raw.cards)) return emptyDoc();
  const seen = new Set<number>();
  const cards: CanvasCard[] = [];
  for (const c of raw.cards) {
    const card = sanitizeCard(c);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  // 便签 / 形状 / 链接 / 连线：逐项校验，坏数据直接丢，不让整张画布打不开
  const notes = Array.isArray(raw.notes)
    ? raw.notes
        .map((n) => {
          if (!n || typeof n.id !== 'string' || !n.id) return null;
          return {
            id: n.id,
            x: Number(n.x) || 0,
            y: Number(n.y) || 0,
            w: clamp(Number(n.w) || 240, 80, 1200),
            h: clamp(Number(n.h) || 160, 60, 1200),
            text: String(n.text || '').slice(0, 4000),
            color: String(n.color || '#f5e6a8').slice(0, 40),
            fontSize: clamp(Number(n.fontSize) || 14, 10, 48),
            textColor: String(n.textColor || '#241f16').slice(0, 40),
            noteShape: n.noteShape === 'rect' || n.noteShape === 'ellipse' ? n.noteShape : 'rounded',
          } satisfies CanvasNote;
        })
        .filter(Boolean) as CanvasNote[]
    : [];
  const shapes = Array.isArray(raw.shapes)
    ? raw.shapes
        .map((s) => {
          if (!s || typeof s.id !== 'string' || !s.id) return null;
          return {
            id: s.id,
            x: Number(s.x) || 0,
            y: Number(s.y) || 0,
            w: clamp(Number(s.w) || 320, 40, 4000),
            h: clamp(Number(s.h) || 240, 40, 4000),
            shape: SHAPE_KINDS.includes(s.shape as CanvasShapeKind) ? (s.shape as CanvasShapeKind) : 'rect',
            color: String(s.color || '#7c6cf0').slice(0, 40),
          } satisfies CanvasShape;
        })
        .filter(Boolean) as CanvasShape[]
    : [];
  const links = Array.isArray(raw.links)
    ? raw.links
        .map((l) => {
          if (!l || typeof l.id !== 'string' || !l.id) return null;
          const url = String(l.url || '');
          if (!/^https?:\/\//i.test(url)) return null;
          return {
            id: l.id,
            x: Number(l.x) || 0,
            y: Number(l.y) || 0,
            w: clamp(Number(l.w) || 320, 120, 1600),
            h: clamp(Number(l.h) || 220, 90, 1600),
            url,
            title: String(l.title || '').slice(0, 200),
          } satisfies CanvasLink;
        })
        .filter(Boolean) as CanvasLink[]
    : [];
  const arrows = Array.isArray(raw.arrows)
    ? raw.arrows
        .map((a) => {
          if (!a || typeof a.id !== 'string' || !a.id) return null;
          return {
            id: a.id,
            x1: Number(a.x1) || 0,
            y1: Number(a.y1) || 0,
            x2: Number(a.x2) || 0,
            y2: Number(a.y2) || 0,
            color: String(a.color || '#ff4d8d').slice(0, 40),
            width: clamp(Number(a.width) || 2, 1, 10),
          } satisfies CanvasArrow;
        })
        .filter(Boolean) as CanvasArrow[]
    : [];

  return {
    version: 1,
    cards,
    notes,
    shapes,
    links,
    arrows,
    view: sanitizeView(raw.view),
  };
}

export function makeBoardId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 生成不重名的默认画布名（「画布 2」「画布 3」…） */
export function nextBoardName(boards: CanvasBoardMeta[], base: string): string {
  for (let i = boards.length + 1; ; i++) {
    const name = `${base} ${i}`;
    if (!boards.some((b) => b.name === name)) return name;
  }
}

function sanitizeBoard(raw: Partial<CanvasBoardMeta> | null | undefined, fallbackName: string): CanvasBoardMeta | null {
  if (!raw) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : makeBoardId();
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallbackName;
  return { id, name, doc: sanitizeDoc(raw.doc) };
}

/**
 * 读取某个资源库的画布列表。老版本只有一个画布（`tuku:canvas:<lib>`），
 * 这里自动包装成一个画布，用户升级后原来的排布不会丢。
 */
export function loadBoardStore(libId: number | null, defaultName: string): CanvasStore {
  try {
    const raw = localStorage.getItem(storeKey(libId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CanvasStore> | null;
      if (parsed?.version === 2 && Array.isArray(parsed.boards)) {
        const boards = parsed.boards
          .map((b) => sanitizeBoard(b, defaultName))
          .filter(Boolean) as CanvasBoardMeta[];
        if (boards.length) {
          const activeId = boards.some((b) => b.id === parsed.activeId)
            ? String(parsed.activeId)
            : boards[0].id;
          return { version: 2, activeId, boards };
        }
      }
    }
  } catch {
    /* 存储损坏：回落到空画布，不让画布页整体挂掉 */
  }
  let legacy: CanvasDoc | null = null;
  try {
    const raw = localStorage.getItem(legacyKey(libId));
    if (raw) legacy = sanitizeDoc(JSON.parse(raw) as Partial<CanvasDoc> | null);
  } catch {
    legacy = null;
  }
  const board: CanvasBoardMeta = { id: makeBoardId(), name: defaultName, doc: legacy || emptyDoc() };
  return { version: 2, activeId: board.id, boards: [board] };
}

export function saveBoardStore(libId: number | null, store: CanvasStore): void {
  try {
    localStorage.setItem(storeKey(libId), JSON.stringify(store));
  } catch {
    /* 配额满 / 隐私模式：布局丢失不影响素材安全，静默即可 */
  }
}

/** 卡片高度按素材宽高比算（取不到尺寸时给 4:3） */
export function cardHeight(item: Pick<ImageItem, 'width' | 'height'>, w: number): number {
  const iw = Number(item.width) || 0;
  const ih = Number(item.height) || 0;
  const ratio = iw > 0 && ih > 0 ? ih / iw : 0.75;
  return clamp(Math.round(w * ratio), 40, 4000);
}

export function boundsOf(cards: CanvasCard[]): { x: number; y: number; w: number; h: number } | null {
  if (!cards.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const c of cards) {
    x1 = Math.min(x1, c.x);
    y1 = Math.min(y1, c.y);
    x2 = Math.max(x2, c.x + c.w);
    y2 = Math.max(y2, c.y + c.h);
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

/* --------------------- 跨页面的「加入画布」暂存 --------------------- */

let pendingIds: number[] = [];

/** 图库选中项 → 画布：先暂存 id，再由画布挂载后取走 */
export function queueCanvasAdd(ids: number[]): void {
  const clean = ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  pendingIds = [...new Set([...pendingIds, ...clean])];
}

export function takeQueuedCanvasAdd(): number[] {
  const out = pendingIds;
  pendingIds = [];
  return out;
}
