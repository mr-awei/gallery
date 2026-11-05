import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AnnotationItem } from '../types';
import { confirmDialog } from './Dialogs';
import {
  annFontSize,
  annScale,
  arrowGeom,
  boxOf,
  clamp01,
  clampNum,
  composeAnnotated,
  hitTest,
  mapPoints,
  resizeBox,
  type Ann,
} from '../lib/annotationDraw';

/**
 * 图上标注（对标 Eagle 4 Annotations）：
 * - 矩形 / 箭头 / 高亮 / 文字（就地输入）/ 马赛克 / 画笔
 * - 坐标存相对原图比例，整层 JSON 落 image_annotations，改完 500ms 防抖自动保存
 * - 选中后可拖动、拖手柄缩放、Del 删除；Ctrl+Z / Ctrl+Shift+Z 撤销重做
 * - 「导出图片」把原图与标注合成 PNG 另存
 */
type Tool = 'rect' | 'arrow' | 'highlight' | 'text' | 'mosaic' | 'brush';

interface Props {
  imageId: number;
  imageUrl?: string;
  frame: { left: number; top: number; width: number; height: number };
  onCount?: (n: number) => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

const TOOLS: { key: Tool; label: string; icon: string }[] = [
  { key: 'rect', label: '矩形框（Shift 锁正方形）', icon: '▭' },
  { key: 'arrow', label: '箭头（Shift 锁 15°）', icon: '↗' },
  { key: 'highlight', label: '高亮', icon: '▤' },
  { key: 'text', label: '文字（图上直接输入）', icon: 'T' },
  { key: 'mosaic', label: '马赛克', icon: '▦' },
  { key: 'brush', label: '画笔', icon: '✎' },
];

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000'];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * 马赛克预览：从底图取这一块的像素，先缩到「格子数」大小再关掉插值放大，
 * 打出来的块和导出 PNG 里的是同一套（导出见 composeAnnotated）。
 */
function MosaicPatch({ a, img, W, H }: { a: Ann; img: HTMLImageElement | null; W: number; H: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const b = boxOf(a, W, H);
  const cw = Math.max(1, Math.round(b.w * W));
  const ch = Math.max(1, Math.round(b.h * H));
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !img || !img.naturalWidth) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(cw * dpr));
    cv.height = Math.max(1, Math.round(ch * dpr));
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const block = Math.max(6, Math.round((a.size || 3) * annScale(cw) * 3));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(cv.width / block));
    small.height = Math.max(1, Math.round(cv.height / block));
    const sctx = small.getContext('2d');
    if (!sctx) return;
    sctx.drawImage(
      img,
      b.x * img.naturalWidth,
      b.y * img.naturalHeight,
      b.w * img.naturalWidth,
      b.h * img.naturalHeight,
      0,
      0,
      small.width,
      small.height,
    );
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(small, 0, 0, cv.width, cv.height);
  }, [img, cw, ch, a, W, H]);
  return <canvas ref={ref} className="ann-mosaic" data-ann-id={a.id} style={{ left: b.x * W, top: b.y * H, width: cw, height: ch }} />;
}

type Drag =
  | { mode: 'draw'; start: { x: number; y: number } }
  | { mode: 'move'; origin: Ann; start: { x: number; y: number }; snapshot: Ann[] }
  | { mode: 'resize'; origin: Ann; handle: Handle; start: { x: number; y: number }; snapshot: Ann[] }
  | { mode: 'arrowEnd'; origin: Ann; end: 'from' | 'to'; snapshot: Ann[] };

export default function AnnotationLayer({ imageId, imageUrl, frame, onCount, onToast }: Props) {
  const [items, setItems] = useState<Ann[]>([]);
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(3);
  const [draft, setDraft] = useState<Ann | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textEdit, setTextEdit] = useState<{ id?: string; x: number; y: number; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [histTick, setHistTick] = useState(0);
  const [exporting, setExporting] = useState(false);

  const dragRef = useRef<Drag | null>(null);
  /** 底图像素：马赛克预览要从原图取色块，光靠 backdrop-filter 糊不出来 */
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const pastRef = useRef<Ann[][]>([]);
  const futureRef = useRef<Ann[][]>([]);
  const itemsRef = useRef<Ann[]>([]);
  itemsRef.current = items;

  const W = frame.width;
  const H = frame.height;
  // 粗细/字号的显示换算：size 按参考宽度存储，屏幕与导出走同一套比例
  const annK = annScale(W);

  // 标注层要用的底图（仅马赛克预览取色用；加载失败就不画格子）
  useEffect(() => {
    if (!imageUrl) {
      setBgImg(null);
      return;
    }
    const im = new Image();
    im.onload = () => setBgImg(im);
    im.onerror = () => setBgImg(null);
    im.src = imageUrl;
    return () => {
      im.onload = null;
      im.onerror = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setDraft(null);
    setSelectedId(null);
    setTextEdit(null);
    setSavedAt('');
    pastRef.current = [];
    futureRef.current = [];
    api
      .annotations(imageId)
      .then((r) => {
        if (cancelled) return;
        setItems(r.items as Ann[]);
        onCount?.(r.items.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  /**
   * 落库改成「单通道队列」：同一时刻只允许一个请求在飞，期间产生的新快照排在
   * pendingRef 里，等前一个请求结束后再补交最新快照。
   * 旧实现是「每次 commit 起一个请求」，两次提交间隔大于 500ms 就会并发，
   * 先发的旧快照后到 → 把新快照覆盖掉（丢标注）。
   */
  const pendingRef = useRef<Ann[] | null>(null);
  const inflightRef = useRef(false);
  const saveSeqRef = useRef(0);

  const flushNow = useCallback(async () => {
    if (inflightRef.current) return; // 在飞的请求收尾时会自动接手
    const next = pendingRef.current;
    if (!next) return;
    pendingRef.current = null;
    inflightRef.current = true;
    const seq = ++saveSeqRef.current;
    setSaving(true);
    try {
      await api.saveAnnotations(imageId, next);
      if (seq === saveSeqRef.current) {
        setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      }
    } catch (err) {
      onToast?.(`标注保存失败：${(err as Error).message}`);
    } finally {
      inflightRef.current = false;
      if (pendingRef.current) void flushNow();
      else setSaving(false);
    }
  }, [imageId, onToast]);

  /** 防抖入口：delay 内连续改动只发一次 */
  const persist = useCallback(
    (next: Ann[], delay = 500) => {
      pendingRef.current = next;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flushNow(), delay);
    },
    [flushNow]
  );

  // 关闭查看器 / 切图时立刻补交，别让 500ms 防抖把最后一次改动吃掉
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (pendingRef.current) void flushNow();
    };
  }, [flushNow]);

  /** record=false 用于拖动过程中的连续更新，松手时才记一步历史 */
  const commit = useCallback(
    (next: Ann[], record = true) => {
      if (record) {
        pastRef.current.push(itemsRef.current);
        if (pastRef.current.length > 80) pastRef.current.shift();
        futureRef.current = [];
        setHistTick((v) => v + 1);
      }
      setItems(next);
      onCount?.(next.length);
      setDraft(null);
      persist(next);
    },
    [persist, onCount]
  );

  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push(itemsRef.current);
    setItems(prev);
    onCount?.(prev.length);
    setSelectedId(null);
    setHistTick((v) => v + 1);
    persist(prev, 300);
  }, [onCount, persist]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(itemsRef.current);
    setItems(next);
    onCount?.(next.length);
    setSelectedId(null);
    setHistTick((v) => v + 1);
    persist(next, 300);
  }, [onCount, persist]);

  const delSelected = useCallback(() => {
    const id = selectedId;
    if (!id) return;
    setSelectedId(null);
    commit(itemsRef.current.filter((a) => a.id !== id));
  }, [commit, selectedId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        e.stopPropagation();
        delSelected();
        return;
      }
      if (e.key === 'Escape' && selectedId) {
        // 只清选中：必须拦下事件，否则灯箱那边同一颗 Esc 会顺手退出标注模式
        e.preventDefault();
        e.stopPropagation();
        setSelectedId(null);
        return;
      }
      // 工具快捷键（同类工具都是单键切工具，手不离键盘）
      const map: Record<string, Tool> = { r: 'rect', a: 'arrow', h: 'highlight', t: 'text', m: 'mosaic', b: 'brush' };
      const k = e.key.toLowerCase();
      if (!mod && map[k]) {
        e.preventDefault();
        setTool(map[k]);
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [delSelected, redo, selectedId, undo]);

  const norm = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / Math.max(1, r.width)), y: clamp01((e.clientY - r.top) / Math.max(1, r.height)) };
  };

  /**
   * 按住 Shift 约束：箭头锁 15° 一档，矩形/高亮/马赛克锁正方形。
   * 换算必须在像素空间做 —— 归一化坐标里「dx=dy」放到宽图上是个扁矩形。
   */
  const constrain = (s: { x: number; y: number }, p: { x: number; y: number }, mode: 'angle' | 'square') => {
    const dx = (p.x - s.x) * W;
    const dy = (p.y - s.y) * H;
    const len = Math.hypot(dx, dy);
    if (len < 2) return p;
    if (mode === 'angle') {
      const step = Math.PI / 12;
      const ang = Math.round(Math.atan2(dy, dx) / step) * step;
      return {
        x: clamp01(s.x + (Math.cos(ang) * len) / Math.max(1, W)),
        y: clamp01(s.y + (Math.sin(ang) * len) / Math.max(1, H)),
      };
    }
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: clamp01(s.x + ((Math.sign(dx) || 1) * m) / Math.max(1, W)),
      y: clamp01(s.y + ((Math.sign(dy) || 1) * m) / Math.max(1, H)),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (textEdit) return;
    const p = norm(e);
    const target = e.target as HTMLElement;
    const handle = target.dataset?.handle as Handle | undefined;
    const annId = target.closest?.('[data-ann-id]')?.getAttribute('data-ann-id') || undefined;

    if (handle && selectedId) {
      const origin = items.find((a) => a.id === selectedId);
      if (origin) {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { mode: 'resize', origin, handle, start: p, snapshot: items };
        return;
      }
    }
    const endAttr = (target.dataset?.end || target.closest?.('[data-end]')?.getAttribute('data-end')) as 'from' | 'to' | undefined;
    if (endAttr && selectedId) {
      const origin = items.find((a) => a.id === selectedId);
      if (origin) {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { mode: 'arrowEnd', origin, end: endAttr, snapshot: items };
        return;
      }
    }
    const hit = (annId ? items.find((a) => a.id === annId) : null) || hitTest(items, p, W, H);
    if (hit) {
      setSelectedId(hit.id);
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { mode: 'move', origin: hit, start: p, snapshot: items };
      return;
    }
    setSelectedId(null);
    if (tool === 'text') {
      // 延迟到这次 pointerup/click 之后再挂输入框，否则浏览器把焦点移走会立刻 blur 掉
      window.setTimeout(() => setTextEdit({ x: p.x, y: p.y, value: '' }), 0);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: 'draw', start: p };
    if (tool === 'brush') setDraft({ id: newId(), kind: 'brush', color, size, text: '', points: [[p.x, p.y]] });
    else setDraft({ id: newId(), kind: tool, color, size, text: '', x: p.x, y: p.y, w: 0, h: 0, to: { ...p } });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = norm(e);
    if (drag.mode === 'draw') {
      if (draft?.kind === 'brush') {
        setDraft({ ...draft, points: [...(draft.points || []), [p.x, p.y] as [number, number]].slice(-400) });
        return;
      }
      if (!draft) return;
      const s = drag.start;
      const q = e.shiftKey ? constrain(s, p, draft.kind === 'arrow' ? 'angle' : 'square') : p;
      if (draft.kind === 'arrow') {
        // 箭头有方向：起点必须是按下的那一点，终点是当前点。
        // 旧实现把 x/y 也归一化成外接框左上角，从右往左拉时起点=终点，
        // 箭头直接缩成一个点（这就是「反向拉没有箭头」的原因）。
        setDraft({ ...draft, x: s.x, y: s.y, to: q });
        return;
      }
      setDraft({ ...draft, x: Math.min(s.x, q.x), y: Math.min(s.y, q.y), w: Math.abs(q.x - s.x), h: Math.abs(q.y - s.y) });
      return;
    }
    if (drag.mode === 'move') {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      const o = drag.origin;
      setItems((cur) =>
        cur.map((a) => {
          if (a.id !== o.id) return a;
          if (a.kind === 'brush' || a.kind === 'pen') {
            return { ...a, points: (o.points || []).map(([x, y]) => [clamp01(x + dx), clamp01(y + dy)] as [number, number]) };
          }
          if (a.kind === 'arrow') {
            return {
              ...a,
              x: clamp01((o.x ?? 0) + dx),
              y: clamp01((o.y ?? 0) + dy),
              to: { x: clamp01((o.to?.x ?? o.x ?? 0) + dx), y: clamp01((o.to?.y ?? o.y ?? 0) + dy) },
            };
          }
          return { ...a, x: clamp01((o.x ?? 0) + dx), y: clamp01((o.y ?? 0) + dy) };
        })
      );
      return;
    }
    if (drag.mode === 'resize') {
      const o = drag.origin;
      const oldBox = boxOf(o, W, H);
      const next = resizeBox(oldBox, drag.handle, p.x - drag.start.x, p.y - drag.start.y);
      setItems((cur) =>
        cur.map((a) => {
          if (a.id !== o.id) return a;
          if (a.kind === 'brush' || a.kind === 'pen') return { ...a, points: mapPoints(o.points || [], oldBox, next) };
          if (a.kind === 'text') {
            const k = next.h / Math.max(1e-6, oldBox.h);
            return { ...a, x: next.x, y: next.y, size: clampNum(Math.round((o.size || 3) * k), 1, 40) };
          }
          return { ...a, x: next.x, y: next.y, w: next.w, h: next.h };
        })
      );
      return;
    }
    const o = drag.origin;
    // 拖箭头端点时也支持 Shift 锁角度，基准是对面那一端
    const anchor = drag.end === 'from' ? { x: o.to?.x ?? 0, y: o.to?.y ?? 0 } : { x: o.x ?? 0, y: o.y ?? 0 };
    const q = e.shiftKey ? constrain(anchor, p, 'angle') : p;
    setItems((cur) =>
      cur.map((a) => {
        if (a.id !== o.id) return a;
        return drag.end === 'from' ? { ...a, x: q.x, y: q.y } : { ...a, to: { x: q.x, y: q.y } };
      })
    );
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === 'draw') {
      if (!draft) return;
      if (draft.kind === 'brush') {
        if ((draft.points || []).length > 1) commit([...items, draft]);
        else setDraft(null);
        return;
      }
      // 用实际像素长度判定「是不是误点」：箭头没有 w/h（方向由 x,y → to 表示），
      // 旧实现按 w/h 判断会把每一根箭头都当成误点丢掉。
      const px =
        draft.kind === 'arrow'
          ? Math.hypot(((draft.to?.x ?? 0) - (draft.x ?? 0)) * W, ((draft.to?.y ?? 0) - (draft.y ?? 0)) * H)
          : Math.max((draft.w || 0) * W, (draft.h || 0) * H);
      if (px < 6) {
        setDraft(null);
        return;
      }
      commit([...items, draft]);
      setSelectedId(draft.id);
      return;
    }
    // 拖动/缩放结束：与起点快照不同才记一步历史，然后落库
    const next = itemsRef.current;
    if (next === drag.snapshot) return;
    pastRef.current.push(drag.snapshot);
    if (pastRef.current.length > 80) pastRef.current.shift();
    futureRef.current = [];
    setHistTick((v) => v + 1);
    onCount?.(next.length);
    persist(next);
  };

  /** 文字提交：新元素 or 改已有文字 */
  const submitText = (raw: string) => {
    const t = raw.trim().slice(0, 500);
    const cur = textEdit;
    setTextEdit(null);
    if (!cur || !t) return;
    if (cur.id) commit(items.map((a) => (a.id === cur.id ? { ...a, text: t } : a)));
    else commit([...items, { id: newId(), kind: 'text', color, size, text: t, x: cur.x, y: cur.y, w: 0, h: 0 }]);
  };

  const clearAll = async () => {
    if (!items.length) return;
    if (await confirmDialog(`确定删除这张图的 ${items.length} 处标注？此操作不可撤销。`)) commit([]);
  };

  const exportPng = async () => {
    if (exporting) return;
    if (!imageUrl) {
      onToast?.('底图未就绪，稍后再试');
      return;
    }
    setExporting(true);
    try {
      const blob = await composeAnnotated(imageUrl, items);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `annotated-${imageId}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      onToast?.('已导出带标注的图片');
    } catch (err) {
      onToast?.(`导出失败：${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  /**
   * 合成结果直接存成一个新素材（而不是只落在浏览器下载目录）。
   * 以前「导出图片」只是浏览器另存一份，标注完的成图游离在素材库之外，
   * 想发出去还得再去文件夹里翻。
   */
  const saveToLibrary = async () => {
    if (exporting) return;
    if (!imageUrl || !items.length) return;
    setExporting(true);
    try {
      const blob = await composeAnnotated(imageUrl, items);
      const file = new File([blob], `annotated-${imageId}.png`, { type: 'image/png' });
      const r = await api.uploadFile(file, { tags: '标注', keyword: 'annotated' });
      onToast?.(r.image ? `已存为新素材「${r.image.title}」` : '已存入图库');
    } catch (err) {
      onToast?.(`存入图库失败：${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  if (W <= 0 || H <= 0) return null;

  const all = draft ? [...items, draft] : items;
  const selected = items.find((a) => a.id === selectedId) || null;
  const selBox = selected ? boxOf(selected, W, H) : null;
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  void histTick;

  return (
    <div
      className="ann-layer"
      style={{ left: frame.left, top: frame.top, width: W, height: H }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg className="ann-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {all.map((a) => {
          if (a.kind === 'arrow') {
            const g = arrowGeom(a, W, H);
            return (
              <g key={a.id} data-ann-id={a.id} style={{ cursor: 'move' }}>
                <line
                  x1={g.sx}
                  y1={g.sy}
                  x2={g.bodyX}
                  y2={g.bodyY}
                  stroke={a.color}
                  strokeWidth={g.width}
                  strokeLinecap="round"
                />
                <path d={`M ${g.tx} ${g.ty} L ${g.leftX} ${g.leftY} L ${g.rightX} ${g.rightY} Z`} fill={a.color} />
              </g>
            );
          }
          if (a.kind === 'brush' || a.kind === 'pen') {
            return (
              <polyline
                key={a.id}
                data-ann-id={a.id}
                points={(a.points || []).map(([x, y]) => `${x * W},${y * H}`).join(' ')}
                fill="none"
                stroke={a.color}
                strokeWidth={a.size * annK}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ cursor: 'move' }}
              />
            );
          }
          return null;
        })}
      </svg>

      {all.map((a) => {
        const b = boxOf(a, W, H);
        const common = { key: a.id, 'data-ann-id': a.id, style: { cursor: 'move' as const } };
        if (a.kind === 'rect') {
          return (
            <div
              {...common}
              className="ann-rect"
              style={{
                left: b.x * W,
                top: b.y * H,
                width: b.w * W,
                height: b.h * H,
                borderColor: a.color,
                borderWidth: a.size * annK,
                cursor: 'move',
              }}
            />
          );
        }
        if (a.kind === 'highlight') {
          return (
            <div
              {...common}
              className="ann-hl"
              style={{ left: b.x * W, top: b.y * H, width: b.w * W, height: b.h * H, background: a.color, cursor: 'move' }}
            />
          );
        }
        if (a.kind === 'mosaic') return <MosaicPatch key={a.id} a={a} img={bgImg} W={W} H={H} />;
        if (a.kind === 'text') {
          return (
            <div
              {...common}
              className={`ann-text${selectedId === a.id ? ' on' : ''}`}
              onDoubleClick={() => setTextEdit({ id: a.id, x: a.x ?? 0, y: a.y ?? 0, value: a.text || '' })}
              style={{
                left: (a.x ?? 0) * W,
                top: (a.y ?? 0) * H,
                color: a.color,
                fontSize: annFontSize(a.size) * annK,
                cursor: 'move',
              }}
            >
              {a.text}
            </div>
          );
        }
        return null;
      })}

      {selBox && (
        <div
          className={`ann-sel${selected?.kind === 'text' ? ' tight' : ''}`}
          style={{ left: selBox.x * W - 3, top: selBox.y * H - 3, width: selBox.w * W + 6, height: selBox.h * H + 6 }}
        >
          {selected?.kind === 'arrow' ? (
            <>
              <span
                className="ann-dot"
                data-end="from"
                style={{ left: (selected.x ?? 0) * W - selBox.x * W - 3, top: (selected.y ?? 0) * H - selBox.y * H - 3 }}
              />
              <span
                className="ann-dot"
                data-end="to"
                style={{
                  left: (selected.to?.x ?? 0) * W - selBox.x * W - 3,
                  top: (selected.to?.y ?? 0) * H - selBox.y * H - 3,
                }}
              />
            </>
          ) : (
            HANDLES.map((h) => <span key={h} className={`ann-handle h-${h}`} data-handle={h} />)
          )}
        </div>
      )}

      {textEdit && (
        <input
          className="ann-text-input"
          autoFocus
          value={textEdit.value}
          placeholder="输入文字，Enter 确认"
          style={{
            left: textEdit.x * W,
            top: textEdit.y * H,
            color,
            fontSize: annFontSize(size) * annK,
          }}
          onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
          onBlur={(e) => submitText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitText(textEdit.value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setTextEdit(null);
            }
            e.stopPropagation();
          }}
        />
      )}

      <div className="ann-toolbar" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {TOOLS.map((t) => (
          <button key={t.key} className={`ann-tool${tool === t.key ? ' on' : ''}`} title={t.label} onClick={() => setTool(t.key)}>
            {t.icon}
          </button>
        ))}
        <span className="ann-sep" />
        {COLORS.map((c) => (
          <button
            key={c}
            className={`ann-color${color === c ? ' on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => setColor(c)}
          />
        ))}
        <input className="ann-size" type="range" min={1} max={12} value={size} title={`线条粗细 ${size}`} onChange={(e) => setSize(Number(e.target.value))} />
        <span className="ann-sep" />
        <button className="ann-btn" onClick={undo} disabled={!canUndo} title="撤销（Ctrl+Z）">
          撤销
        </button>
        <button className="ann-btn" onClick={redo} disabled={!canRedo} title="重做（Ctrl+Shift+Z）">
          重做
        </button>
        <button className="ann-btn" onClick={delSelected} disabled={!selected} title="删除选中（Delete）">
          删除
        </button>
        <button className="ann-btn" onClick={clearAll} disabled={!items.length} title="清空这一张的所有标注">
          清空
        </button>
        <button className="ann-btn" onClick={exportPng} disabled={exporting || !items.length} title="原图 + 标注合成 PNG 下载到本地">
          {exporting ? '导出中…' : '导出图片'}
        </button>
        <button
          className="ann-btn"
          onClick={saveToLibrary}
          disabled={exporting || !items.length}
          title="原图 + 标注合成后作为新素材入库（不会覆盖原图）"
        >
          存入图库
        </button>
        <span className="ann-state">{saving ? '保存中…' : savedAt ? `已保存 ${savedAt}` : `${items.length} 处标注`}</span>
      </div>
    </div>
  );
}
