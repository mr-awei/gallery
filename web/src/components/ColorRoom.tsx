import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AdjustParams } from '../types';
import { wbFromRgb } from '../lib/tone';
import { autoToneFromPixels, autoWbFromPixels } from '../lib/auto-tone';
import { ADJUST_DEFAULTS } from '../types';
import { renderPixels } from '../lib/adjust';
import AdjustPanel, { type AdjustPanelHandle, type WbSample } from './AdjustPanel';
import Histogram from './Histogram';
import { IconClose } from './Icons';
import { api } from '../api';

/** 调色台底部的缩略图条（批量调色：一套参数、可切换预览对象） */
export interface FilmstripItem {
  id: number;
  /** 预览用大图（同源，吸管/直方图要读像素） */
  src: string;
  /** 缩略图地址 */
  thumb: string;
  title: string;
  meta?: string;
}

export interface ColorRoomProps {
  /** 预览用的原图地址（同源，吸管与直方图都要读像素） */
  src: string;
  title: string;
  meta?: string;
  /** 顶部标签，例如「批量 · 已选 12 张」 */
  badge?: string;
  /** 侧栏底部的说明文字 */
  note?: string;
  value: AdjustParams;
  onChange: (p: AdjustParams) => void;
  onClose: () => void;
  busy?: boolean;
  sample: WbSample | null;
  onSampleChange: (s: WbSample | null) => void;
  /** 缩略图条（不传则不显示，例如单张调色） */
  filmstrip?: FilmstripItem[];
  activeFilmId?: number;
  onSelectFilm?: (id: number) => void;
  /** 保存方式与保存按钮（单张 / 批量各自的逻辑，由调用方提供） */
  saveBar: React.ReactNode;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const hexOf = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * 快捷键表（?）。照抄像素蛋糕习惯：单键切工具、Tab 跳滑杆、↑↓ 微调、Ctrl+数字直达。
 * 和下面的 keydown 处理器是同一份口径 —— 改键必须两处一起改。
 */
const KEY_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: '工具',
    items: [
      ['I', '吸管取白平衡（再按退出）'],
      ['Ctrl+U', '全自动调色'],
      ['Ctrl+Shift+R', '复位全部参数'],
      ['E', '聚焦参数面板第一根滑杆'],
      ['Space', '按住看原图，松开恢复'],
    ],
  },
  {
    title: '调参数',
    items: [
      ['Tab / Shift+Tab', '下一根 / 上一根滑杆'],
      ['↑ / ↓', '滑杆 ±1（按住 Shift 十倍）'],
      ['Ctrl+1 ~ Ctrl+9', '直达第 1~9 根滑杆'],
      ['单击 / 双击滑杆', '点数值可直接输入 / 双击归零'],
    ],
  },
  {
    title: '历史',
    items: [
      ['Ctrl+Z', '撤销上一步'],
      ['Ctrl+Y / Ctrl+Shift+Z', '重做'],
      ['Shift+V', '展开 / 收起历史记录'],
    ],
  },
  {
    title: '视图与浏览',
    items: [
      ['Ctrl+= / Ctrl+-', '放大 / 缩小'],
      ['Ctrl+0 / 双击图片', '适应窗口'],
      ['滚轮', '以鼠标位置为中心缩放'],
      ['[ / ]', '上一张 / 下一张（批量调色）'],
      ['↑ / ↓（未选中滑杆时）', '上一张 / 下一张'],
      ['?', '打开 / 关闭这张表'],
      ['Esc', '关表 → 退吸管 → 关调色台'],
    ],
  },
];

/**
 * 全屏调色台（Camera Raw 布局）：左侧大图预览，右侧直方图 + 参数面板 + 保存区。
 * 单张与批量调色共用这一套界面，差别只在 saveBar 里传进来的保存方式。
 */
export default function ColorRoom({
  src,
  title,
  meta,
  badge,
  note,
  value,
  onChange,
  onClose,
  busy,
  sample,
  onSampleChange,
  filmstrip,
  activeFilmId,
  onSelectFilm,
  saveBar,
}: ColorRoomProps) {
  const [picking, setPicking] = useState(false);
  const [point, setPoint] = useState<{ nx: number; ny: number; hex: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showRaw, setShowRaw] = useState(false);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const markRef = useRef<HTMLSpanElement | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  const loupeBoxRef = useRef<HTMLDivElement | null>(null);
  const loupeHexRef = useRef<HTMLSpanElement | null>(null);
  const loupeRgbRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  // 事件回调里要读最新参数，用 ref 兜住 props
  const valueRef = useRef(value);
  valueRef.current = value;
  const showRawRef = useRef(showRaw);
  showRawRef.current = showRaw;

  /* ---------------- 调色历史（带步骤名的记录列表，不是文件级的「撤销写回」） ---------------- */
  // 回调放进 ref：快捷键的 keydown 只在挂载时绑定一次，闭包里不能是旧的 onChange
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  interface HistEntry {
    params: AdjustParams;
    /** 这一步改了什么，历史列表里直接显示 */
    label: string;
  }
  /** entries[0] 永远是打开这张图时的参数；index 指向当前生效的那一步 */
  const histRef = useRef<{ entries: HistEntry[]; index: number; at: number }>({
    entries: [{ params: value, label: '打开' }],
    index: 0,
    at: 0,
  });
  // 历史栈是 ref（不参与渲染），用这个计数只为了刷新列表与按钮禁用态
  const [histTick, bumpHist] = useState(0);
  const [histOpen, setHistOpen] = useState(false);
  /** 快捷键表（?） */
  const [keysOpen, setKeysOpen] = useState(false);
  /** 调色参数面板 + 历史区的外壳，Ctrl+1~9 / E 要把面板滚进视野 */
  const panelBoxRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<AdjustPanelHandle | null>(null);

  /** 历史步数上限：设置里可改（默认 100），读一次就缓存 */
  const [histLimit, setHistLimit] = useState(100);
  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((s) => {
        const n = Number(s?.historySteps);
        if (alive && Number.isFinite(n)) setHistLimit(Math.min(500, Math.max(1, Math.round(n))));
      })
      .catch((err) => {
        // 读设置失败不影响调色，退回默认 100 步，但要留痕，别静默吞掉
        console.warn('读取调色历史步数失败，按默认 100 步处理', err);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 参数是否为同一份（滑块一路拖到底会连发几十次，得按值比较） */
  const sameParams = (a: AdjustParams, b: AdjustParams) => JSON.stringify(a) === JSON.stringify(b);

  /** 参数里改了什么，翻译成历史列表里的步骤名 */
  const labelOf = (prev: AdjustParams, next: AdjustParams): string => {
    const NAME: Record<string, string> = {
      temperature: '色温',
      tint: '色调',
      exposure: '曝光',
      contrast: '对比度',
      highlights: '高光',
      shadows: '阴影',
      whites: '白点',
      blacks: '黑点',
      saturation: '饱和度',
      vibrance: '自然饱和度',
      clarity: '清晰度',
      sharpen: '锐化',
      curves: '曲线',
      colorMixer: '混色器',
      hueSat: '色相/饱和度',
      colorGrade: '颜色分级',
    };
    const keys = Object.keys(NAME).filter(
      (key) =>
        JSON.stringify((prev as unknown as Record<string, unknown>)[key]) !==
        JSON.stringify((next as unknown as Record<string, unknown>)[key]),
    );
    if (!keys.length) return '微调';
    if (keys.length === 1) return NAME[keys[0]];
    return `${NAME[keys[0]]} 等 ${keys.length} 项`;
  };

  /**
   * 所有对参数的修改都从这里走，顺手记一步历史。
   * 700ms 内的连续修改并成一步：拖一次滑块只产生一个记录点，
   * 而不是拖 200px 要按 40 次 Ctrl+Z 才回到原位。
   */
  const handleChange = (next: AdjustParams, explicitLabel?: string) => {
    const prev = valueRef.current;
    if (sameParams(prev, next)) return;
    const h = histRef.current;
    const now = Date.now();
    const label = explicitLabel ?? labelOf(prev, next);
    const atEnd = h.index === h.entries.length - 1;
    if (atEnd && now - h.at <= 700 && h.entries.length > 1) {
      // 并入上一步：拖动中的连续变化算同一个动作
      h.entries[h.index] = { params: next, label: explicitLabel ?? h.entries[h.index].label };
    } else {
      // 从中间插一刀：后面的步骤作废（和普通编辑器的撤销树一致）
      h.entries = h.entries.slice(0, h.index + 1);
      h.entries.push({ params: next, label });
      if (h.entries.length > histLimit + 1) h.entries.shift();
      h.index = h.entries.length - 1;
    }
    h.at = now;
    bumpHist((v) => v + 1);
    onChangeRef.current(next);
  };

  /** 跳到历史里的第 i 步（不再记历史，否则撤销本身也会变成一步） */
  const goHistory = (i: number) => {
    const h = histRef.current;
    if (i < 0 || i >= h.entries.length || i === h.index) return;
    h.index = i;
    h.at = 0;
    bumpHist((v) => v + 1);
    onChangeRef.current(h.entries[i].params);
  };

  const undo = () => goHistory(histRef.current.index - 1);
  const redo = () => goHistory(histRef.current.index + 1);

  // 换图 / 换批量选中项：历史清空（上一张图的历史套到这一张上是灾难）
  useEffect(() => {
    histRef.current = { entries: [{ params: valueRef.current, label: '打开' }], index: 0, at: 0 };
    bumpHist((v) => v + 1);
  }, [src, activeFilmId]);

  /* ---------------- 预览：逐像素渲染到 canvas（与后端同一套管线） ---------------- */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 停手后的全精度预览长边 / 拖动中的快速预览长边（像素量约 1:5） */
  const FULL_MAX = 1600;
  const DRAG_MAX = 720;
  const baseRef = useRef<{ data: Uint8ClampedArray; w: number; h: number; src: string; max: number } | null>(null);
  /** 预览用的 ImageData 复用缓冲（尺寸变了才重建） */
  const frameRef = useRef<ImageData | null>(null);

  /** canvas 与 img 严格重叠：尺寸/位置/变换都同步（CSS 百分比在 flex 里会绕成循环依赖） */
  const syncCanvasBox = () => {
    const img = imgRef.current;
    const cv = canvasRef.current;
    if (!img || !cv) return;
    cv.style.width = `${img.clientWidth}px`;
    cv.style.height = `${img.clientHeight}px`;
    cv.style.left = `${img.offsetLeft}px`;
    cv.style.top = `${img.offsetTop}px`;
    cv.style.transform = img.style.transform;
  };

  /** 原图降采样后缓存在内存里（换图/换档才重建）；自动分析一律用 FULL_MAX */
  const buildBase = (max = FULL_MAX): boolean => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return false;
    const cached = baseRef.current;
    if (cached && cached.src === img.src && cached.max === max && cached.w === canvasRef.current?.width) return true;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, w, h);
    baseRef.current = { data: ctx.getImageData(0, 0, w, h).data, w, h, src: img.src, max };
    const cv = canvasRef.current;
    if (cv) {
      cv.width = w;
      cv.height = h;
    }
    return true;
  };

  /** quick=true：拖动帧只算 720 长边的小图；停手后必须回到 FULL_MAX 全精度 */
  const renderPreview = (quick = false) => {
    if (showRawRef.current) return;
    if (!buildBase(quick ? DRAG_MAX : FULL_MAX)) return;
    const cv = canvasRef.current;
    const base = baseRef.current;
    if (!cv || !base) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    // 复用一个 ImageData：1600×1600 每次新建就是 10MB 垃圾，
    // 拖滑块（50ms 一次）等于持续给主线程和 GC 加压
    let frame = frameRef.current;
    if (!frame || frame.width !== base.w || frame.height !== base.h) {
      frame = ctx.createImageData(base.w, base.h);
      frameRef.current = frame;
    }
    frame.data.set(base.data);
    renderPixels(frame.data, 4, valueRef.current);
    ctx.putImageData(frame, 0, 0);
    syncCanvasBox();
  };

  /** 取样标记按图片当前屏幕位置重算（缩放/平移后仍钉在取样点上） */
  const placeMark = () => {
    const mark = markRef.current;
    const img = imgRef.current;
    const stage = stageRef.current;
    const p = point;
    if (!mark) return;
    if (!img || !stage || !p) return;
    const sr = stage.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    mark.style.left = `${ir.left - sr.left + p.nx * ir.width}px`;
    mark.style.top = `${ir.top - sr.top + p.ny * ir.height}px`;
  };

  const applyView = () => {
    const img = imgRef.current;
    if (!img) return;
    const z = zoomRef.current;
    const o = offsetRef.current;
    img.style.transform = `translate(${o.x}px, ${o.y}px) scale(${z})`;
    syncCanvasBox();
    placeMark();
  };

  useEffect(() => {
    applyView();
  });

  // 拖动时每帧最多算一次低分辨率预览（rAF 合并连续 onChange），
  // 停手 180ms 后回到全精度预览：最终画面与成品用同一套逐像素公式，逐像素一致。
  useEffect(() => {
    const raf = requestAnimationFrame(() => renderPreview(true));
    const settle = window.setTimeout(() => renderPreview(false), 180);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [value]);

  // 「对比」：按住时露出底下的原图，松开恢复调色预览
  useEffect(() => {
    const cv = canvasRef.current;
    if (cv) cv.style.display = showRaw ? 'none' : 'block';
    if (!showRaw) renderPreview();
  }, [showRaw]);

  // 换图（批量缩略图切换）时清掉上一张的取样点与放大镜
  useEffect(() => {
    setPoint(null);
    hideLoupe();
  }, [src]);

  useEffect(() => {
    const onResize = () => syncCanvasBox();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const resetView = () => {
    zoomRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };
    setZoom(1);
  };

  const zoomBy = (factor: number) => {
    zoomRef.current = clamp(zoomRef.current * factor, 0.25, 4);
    setZoom(zoomRef.current);
  };

  /** 把调色面板滚进视野（快捷键唤起面板时用） */
  const revealPanel = () => panelBoxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  /** 缩略图条里切换上一张/下一张（[ ] 与 ↑↓ 共用） */
  const stepFilm = (dir: 1 | -1) => {
    if (!filmstrip || filmstrip.length < 2 || !onSelectFilm) return;
    const i = filmstrip.findIndex((f) => f.id === activeFilmId);
    const next = filmstrip[Math.min(filmstrip.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
    if (next && next.id !== activeFilmId) onSelectFilm(next.id);
  };

  /** 自动白平衡：统计原图预览像素里的中性像素与白点，反解色温/色调 */
  const autoWhite = () => {
    if (showRawRef.current) setShowRaw(false);
    if (!buildBase()) return;
    const base = baseRef.current;
    if (!base) return;
    const wb = autoWbFromPixels(base.data, 4);
    handleChange({ ...valueRef.current, ...wb }, '自动白平衡');
    onSampleChange(null);
    setPoint(null);
    setPicking(false);
    hideLoupe();
  };

  /** 全自动调色：一次算好白平衡、曝光、主曲线、影调与色彩（含肤色保护），整块覆盖参数 */
  const autoTone = () => {
    if (showRawRef.current) setShowRaw(false);
    if (!buildBase()) return;
    const base = baseRef.current;
    if (!base) return;
    const t = autoToneFromPixels(base.data, 4);
    // 从默认值出发：自动的语义是「重新给一版最优」，不是把结果叠在当前手工调整上，
    // 否则点两次会越来越亮、曲线/分级也会带着上一次的痕迹
    handleChange({ ...ADJUST_DEFAULTS, ...t }, '全自动');
    onSampleChange(null);
    setPoint(null);
    setPicking(false);
    hideLoupe();
  };

  /* ---------------- 吸管：离屏画布取色 + 放大镜 ---------------- */
  const ensureSampleCanvas = (): HTMLCanvasElement | null => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return null;
    const cached = sampleCanvasRef.current;
    if (cached && cached.dataset.src === img.src) return cached;
    const scale = Math.min(1, 1600 / img.naturalWidth);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * scale));
    cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    cv.dataset.src = img.src;
    sampleCanvasRef.current = cv;
    return cv;
  };

  const readColorAt = (clientX: number, clientY: number, half = 3) => {
    const img = imgRef.current;
    const cv = ensureSampleCanvas();
    if (!img || !cv) return null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const px = clamp(Math.round(nx * cv.width), 0, cv.width - 1);
    const py = clamp(Math.round(ny * cv.height), 0, cv.height - 1);
    const x0 = Math.max(0, px - half);
    const y0 = Math.max(0, py - half);
    const w = Math.min(half * 2 + 1, cv.width - x0);
    const h = Math.min(half * 2 + 1, cv.height - y0);
    const data = ctx.getImageData(x0, y0, w, h).data;
    let R = 0;
    let G = 0;
    let B = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      R += data[i];
      G += data[i + 1];
      B += data[i + 2];
      n++;
    }
    if (!n) return null;
    return { r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n), nx, ny, px, py, canvas: cv };
  };

  const hideLoupe = () => {
    const box = loupeBoxRef.current;
    if (box) box.style.display = 'none';
  };

  const onPickMove = (e: React.PointerEvent) => {
    if (!picking) return;
    const c = readColorAt(e.clientX, e.clientY, 1);
    const box = loupeBoxRef.current;
    if (!box) return;
    if (!c) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = `${e.clientX}px`;
    box.style.top = `${e.clientY}px`;
    const cv = loupeRef.current;
    if (cv) {
      const ctx = cv.getContext('2d');
      if (ctx) {
        const S = cv.width;
        const half = 6;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, S, S);
        ctx.drawImage(c.canvas, c.px - half, c.py - half, half * 2, half * 2, 0, 0, S, S);
        const cell = S / (half * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(S / 2 - cell / 2, S / 2 - cell / 2, cell, cell);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.strokeRect(S / 2 - cell / 2 - 1, S / 2 - cell / 2 - 1, cell + 2, cell + 2);
      }
    }
    const hex = hexOf(c);
    const hexEl = loupeHexRef.current;
    if (hexEl) {
      hexEl.textContent = hex.toUpperCase();
      hexEl.style.background = hex;
      hexEl.style.color = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 140 ? '#0b0b14' : '#fff';
    }
    const rgbEl = loupeRgbRef.current;
    if (rgbEl) rgbEl.textContent = `R${c.r} G${c.g} B${c.b}`;
  };

  const pickSample = (clientX: number, clientY: number) => {
    const c = readColorAt(clientX, clientY, 3);
    if (!c) return;
    handleChange({ ...valueRef.current, ...wbFromRgb(c.r, c.g, c.b) });
    onSampleChange({ r: c.r, g: c.g, b: c.b });
    setPoint({ nx: c.nx, ny: c.ny, hex: hexOf(c) });
    setPicking(false);
    hideLoupe();
  };

  /** 复位全部参数（Ctrl+Shift+R，和 Lightroom/ACR 一致） */
  const resetAll = () => handleChange({ ...ADJUST_DEFAULTS }, '复位');

  /* ---------------- 键盘：像素蛋糕同款（捕获阶段，先于外层组件处理） ----------------
   * Space 按住看原图 / E 进色彩面板 / I 吸管 / Ctrl+U 全自动 / Ctrl+Shift+R 复位
   * Ctrl+1~9 定位滑杆、Tab 上下切、↑↓ 微调（Shift 十倍）/ [ ] 换图 / Ctrl+= - 0 缩放
   * Shift+V 历史记录 / ? 快捷键表
   */
  useEffect(() => {
    const isTextTarget = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      if (!t) return false;
      if (t.isContentEditable) return true;
      if (t.tagName === 'TEXTAREA') return true;
      return t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range';
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const panel = panelRef.current;

      // Esc 永远优先：正在吸管就退吸管，否则关调色台
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (keysOpen) setKeysOpen(false);
        else if (picking) setPicking(false);
        else onClose();
        return;
      }
      // 在文本框里打字：除了 Esc 一律不抢（否则输入法/选框全乱）
      if (isTextTarget(e.target)) return;

      // 撤销 / 重做：调色台里优先于全局的「撤销写回」
      if (mod && k === 'z' && !e.shiftKey) {
        e.stopPropagation();
        e.preventDefault();
        undo();
        return;
      }
      if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        e.stopPropagation();
        e.preventDefault();
        redo();
        return;
      }
      // 全自动（AI 校准）
      if (mod && k === 'u') {
        e.preventDefault();
        e.stopPropagation();
        autoTone();
        return;
      }
      // 复位全部
      if (mod && e.shiftKey && k === 'r') {
        e.preventDefault();
        e.stopPropagation();
        resetAll();
        return;
      }
      // 缩放
      if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        zoomBy(1.25);
        return;
      }
      if (mod && k === '-') {
        e.preventDefault();
        zoomBy(0.8);
        return;
      }
      if (mod && k === '0') {
        e.preventDefault();
        resetView();
        return;
      }
      // Ctrl+1~9：定位到第 N 根滑杆（就是「色彩调节」面板里的顺序）
      if (mod && /^[1-9]$/.test(e.key)) {
        if (panel?.focusSlider(Number(e.key) - 1)) {
          e.preventDefault();
          revealPanel();
        }
        return;
      }
      if (mod) return; // 其余组合键交给系统/上层

      // 按住 Space 看原图
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!showRawRef.current) setShowRaw(true);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setKeysOpen((v) => !v);
        return;
      }
      if (k === 'v' && e.shiftKey) {
        e.preventDefault();
        setHistOpen((v) => !v);
        return;
      }
      if (k === 'e') {
        e.preventDefault();
        revealPanel();
        panel?.focusSlider(0);
        return;
      }
      if (k === 'i') {
        e.preventDefault();
        setPicking((v) => !v);
        return;
      }
      // Tab / Shift+Tab：上下切换滑杆（像素蛋糕：滑杆之间来回跳）
      if (e.key === 'Tab') {
        e.preventDefault();
        revealPanel();
        panel?.stepSlider(e.shiftKey ? -1 : 1);
        return;
      }
      // ↑↓：聚焦在滑杆上就微调，否则换上一张/下一张
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        if (panel?.activeKey()) {
          e.preventDefault();
          panel.nudge(dir, e.shiftKey ? 10 : 1);
          return;
        }
        if (filmstrip && filmstrip.length > 1) {
          e.preventDefault();
          stepFilm(dir < 0 ? -1 : 1);
        }
        return;
      }
      // [ ] 换图
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        stepFilm(e.key === ']' ? 1 : -1);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') setShowRaw(false);
    };

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
    // undo/redo/zoom 都只读 ref；这里只需要在外部状态变化时重绑
  }, [picking, onClose, keysOpen, filmstrip, activeFilmId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 滚轮缩放（要 preventDefault，必须非 passive） ---------------- */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  const onStageClick = (e: React.MouseEvent) => {
    if (!picking) return;
    e.stopPropagation();
    pickSample(e.clientX, e.clientY);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (picking || e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (picking) {
      onPickMove(e);
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    offsetRef.current = { x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) };
    applyView();
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  // 历史栈放在 ref 里（拖动时不必让整棵树走 diff），histTick 只负责触发列表重绘
  const hist = histRef.current;

  // 挂到 body：不在 lightbox / 批量弹窗的 DOM 里，滚轮、拖拽、点击都不会冒泡过去
  return createPortal(
    <div
      className="color-room"
      role="dialog"
      aria-modal="true"
      aria-label="调色台"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header className="cr-bar">
        <div className="cr-id">
          <b title={title}>{title}</b>
          <span>{meta}</span>
          {badge && <span className="cr-badge">{badge}</span>}
        </div>
        <div className="cr-tools">
          <button className="btn xs" onClick={() => zoomBy(1 / 1.25)} title="缩小">
            －
          </button>
          <button className="btn xs" onClick={resetView} title="适应窗口（双击图片同样效果）">
            {Math.round(zoom * 100)}%
          </button>
          <button className="btn xs" onClick={() => zoomBy(1.25)} title="放大">
            ＋
          </button>
          <button
            className="btn xs"
            title="按住查看原图（松开恢复调色预览）"
            onPointerDown={() => setShowRaw(true)}
            onPointerUp={() => setShowRaw(false)}
            onPointerLeave={() => setShowRaw(false)}
          >
            {showRaw ? '原图' : '对比'}
          </button>
          <button className="btn xs" title="快捷键表（?）" onClick={() => setKeysOpen((v) => !v)}>
            快捷键
          </button>
        </div>
        <button className="btn sm ghost cr-close" onClick={onClose} title="关闭调色台（Esc）">
          <IconClose />
        </button>
      </header>

      <div className="cr-main">
        <div className="cr-view">
        <div
          className="cr-stage"
          ref={stageRef}
          onClick={onStageClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => {
            endDrag();
            hideLoupe();
          }}
          onDoubleClick={resetView}
          style={{ cursor: picking ? 'crosshair' : zoom > 1.001 ? 'grab' : 'default' }}
        >
          <img
            ref={imgRef}
            src={src}
            alt={title}
            className="cr-img"
            draggable={false}
            onLoad={() => {
              baseRef.current = null;
              renderPreview();
              placeMark();
            }}
            style={{
              transform: `translate(${offsetRef.current.x}px, ${offsetRef.current.y}px) scale(${zoomRef.current})`,
            }}
          />
          {/* 调色预览：逐像素渲染，能表达色相/饱和度这类 sharp 原生滤镜表达不了的效果 */}
          <canvas ref={canvasRef} className="cr-canvas" aria-hidden="true" />

          {point && (
            <span
              ref={markRef}
              className="lb-sample-mark"
              style={{ left: 0, top: 0, background: point.hex }}
              title={`取样 ${point.hex}`}
            />
          )}

          {picking && (
            <div className="lb-loupe" ref={loupeBoxRef} style={{ display: 'none' }}>
              <canvas ref={loupeRef} width={96} height={96} className="lb-loupe-canvas" />
              <span className="lb-loupe-cross" />
              <span className="lb-loupe-hex" ref={loupeHexRef}>
                #000000
              </span>
              <span className="lb-loupe-rgb" ref={loupeRgbRef}>
                R0 G0 B0
              </span>
            </div>
          )}
        </div>

        {filmstrip && filmstrip.length > 1 && (
          <div className="cr-strip" role="tablist" aria-label="批量图片：点击切换预览，调色参数对整批一致">
            {filmstrip.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={f.id === activeFilmId}
                className={`cr-strip-item${f.id === activeFilmId ? ' on' : ''}`}
                title={`${f.title}${f.meta ? ` · ${f.meta}` : ''}`}
                onClick={() => {
                  if (f.id === activeFilmId) return;
                  resetView();
                  onSelectFilm?.(f.id);
                }}
              >
                <img src={f.thumb} alt={f.title} loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        )}
        </div>

        <aside className="cr-side">
          <div className="cr-hist-wrap">
            <Histogram src={src} params={value} />
            <div className="cr-hist-legend">
              <span style={{ color: '#ff6b6b' }}>R</span>
              <span style={{ color: '#4ade80' }}>G</span>
              <span style={{ color: '#60a5fa' }}>B</span>
              <span className="cr-hist-luma">亮度</span>
            </div>
          </div>

          {/* 历史区：每一步都带名字，点哪一步就回到那一步（后面的步骤保留，可再点回来） */}
          <div className="cr-log" data-rev={histTick}>
            <button
              type="button"
              className={`cr-log-head${histOpen ? ' open' : ''}`}
              onClick={() => setHistOpen((v) => !v)}
              aria-expanded={histOpen}
              title="调色历史（Shift+V）"
            >
              <span className="cr-log-caret" aria-hidden="true">
                {histOpen ? '▾' : '▸'}
              </span>
              <span>历史记录</span>
              <span className="cr-log-count">
                {hist.index + 1} / {hist.entries.length}
              </span>
            </button>
            {histOpen && (
              <div className="cr-log-list" role="listbox" aria-label="调色历史">
                {hist.entries.map((entry, i) => (
                  <button
                    key={`${i}-${entry.label}`}
                    type="button"
                    role="option"
                    aria-selected={i === hist.index}
                    className={`cr-log-item${i === hist.index ? ' on' : ''}${i > hist.index ? ' undone' : ''}`}
                    onClick={() => goHistory(i)}
                    title={i === hist.index ? '当前步骤' : '回到这一步'}
                  >
                    <span className="cr-log-no">{i + 1}</span>
                    <span className="cr-log-name">{entry.label}</span>
                  </button>
                ))}
                <div className="cr-log-foot">
                  最多保留 {histLimit} 步 · 设置里可改 · Ctrl+Z 逐步撤销
                </div>
              </div>
            )}
          </div>

          <div className="cr-panel" ref={panelBoxRef}>
            <AdjustPanel
              ref={panelRef}
              value={value}
              onChange={handleChange}
              disabled={busy}
              onUndo={undo}
              onRedo={redo}
              canUndo={hist.index > 0}
              canRedo={hist.index < hist.entries.length - 1}
              onPickWhite={() => {
                hideLoupe();
                setPicking((v) => !v);
              }}
              picking={picking}
              onAutoWhite={autoWhite}
              onAutoTone={autoTone}
              sample={sample}
              onClearSample={() => {
                onSampleChange(null);
                setPoint(null);
              }}
            />
            <p className="cr-note">
              {picking
                ? '移动鼠标看放大镜取色，点一下中性灰/白色位置即锁定白平衡'
                : note || 'Ctrl+Z 撤销 / Ctrl+Y 重做；滑块可双击归零；按 ? 看全部快捷键'}
            </p>
          </div>

          <div className="cr-save">{saveBar}</div>
        </aside>
      </div>

      {/* 快捷键表：点遮罩 / Esc / ? 都能关 */}
      {keysOpen && (
        <div className="cr-keys" role="dialog" aria-modal="true" aria-label="快捷键" onClick={() => setKeysOpen(false)}>
          <div className="cr-keys-box" onClick={(e) => e.stopPropagation()}>
            <header className="cr-keys-head">
              <div>
                <b>调色台快捷键</b>
                <span>照像素蛋糕的手感配的，? 随时叫出来</span>
              </div>
              <button className="btn sm ghost" onClick={() => setKeysOpen(false)} title="关闭（Esc）">
                <IconClose />
              </button>
            </header>
            <div className="cr-keys-grid">
              {KEY_GROUPS.map((g) => (
                <section key={g.title} className="cr-keys-group">
                  <h4>{g.title}</h4>
                  {g.items.map(([key, desc]) => (
                    <div className="cr-keys-row" key={key}>
                      <kbd>{key}</kbd>
                      <span>{desc}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <p className="cr-keys-note">
              鼠标在输入框里打字时不会抢键；组合键只在本窗口生效，不会影响其他软件。
            </p>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
