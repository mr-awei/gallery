import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageItem } from '../types';
import { api, BUCKET_LABELS, SOURCE_LABELS, formatDate, formatSize, quiet, revealFile } from '../api';
import {
  IconClose,
  IconDownload,
  IconFolder,
  IconHeart,
  IconRotateCcw,
  IconRotateCw,
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
  onSetWallpaper: (item: ImageItem) => void;
  onReplaceItem: (item: ImageItem) => void;
  onEnhance: (item: ImageItem) => void;
  enhancing?: boolean;
  /** 标记已看后回传，父级同步列表状态（未看过角标会消失） */
  onViewed?: (item: ImageItem) => void;
  onDownload?: (item: ImageItem) => void;
  /** 星级 / 备注等自定义字段 */
  onPatch?: (item: ImageItem, patch: Partial<Pick<ImageItem, 'rating' | 'note'>>) => void;
  /** 按主色系筛选（跳到图库并只看同色系） */
  onFindColor?: (hue: number) => void;
  /** 跳到某张相似图：pool 为「当前图 + 相似结果」，id 为要看的图 */
  onOpenSimilar?: (pool: ImageItem[], id: number) => void;
  /** 去背景等操作的结果提示 */
  onChangeToast?: (msg: string) => void;
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const SLIDE_SECONDS = [3, 5, 10, 20];
/** 缩略图条只渲染当前附近的这些张，避免几百张时卡顿 */
const THUMB_WINDOW = 48;

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
  onEnhance,
  enhancing,
  onViewed,
  onDownload,
  onPatch,
  onFindColor,
  onOpenSimilar,
  onChangeToast,
}: Props) {
  const item = items[index];
  const [tagInput, setTagInput] = useState('');
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

  /* ------------------------- 切换图片：重置视图并标记已看 ------------------------- */
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
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

  /* ------- 预加载前后各一张：切换时新图已在缓存里，避免解码瞬间的塌缩抖动 ------- */
  useEffect(() => {
    for (const it of [items[index + 1], items[index - 1]]) {
      if (!it) continue;
      const img = new Image();
      img.src = it.url;
    }
  }, [index, items]);

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
      // 信息栏 / 缩略图条自己可以滚动，不拦截
      if ((e.target as HTMLElement)?.closest?.('.lightbox-info, .lightbox-thumbs')) return;
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
    if (content) content.style.overflow = 'hidden';
    return () => {
      if (content) content.style.overflow = prev;
      // overflow 恢复不会触发 scroll/resize，MasonryGrid 缓存的可视区间不会重算，
      // 关闭预览后网格会停在打开前那一刻（表现像卡死）。手动踢一次 resize 重测。
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
      const i = indexRef.current;
      if (e.key === 'Escape') {
        if (playing) setPlaying(false);
        else onClose();
      } else if (e.key === 'ArrowLeft') {
        onIndex(Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        onIndex(Math.min(items.length - 1, i + 1));
      } else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === '+' || e.key === '=') {
        const r = bodyRef.current?.getBoundingClientRect();
        zoomAt((r?.left || 0) + (r?.width || 0) / 2, (r?.top || 0) + (r?.height || 0) / 2, 1.25);
      } else if (e.key === '-') {
        const r = bodyRef.current?.getBoundingClientRect();
        zoomAt((r?.left || 0) + (r?.width || 0) / 2, (r?.top || 0) + (r?.height || 0) / 2, 1 / 1.25);
      } else if (e.key === '0') {
        resetZoom();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [items.length, playing, onClose, onIndex, resetZoom, zoomAt]);

  if (!item) return null;

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
    if (playing) return; // 播放中点击不关闭
    onClose();
  };
  const toggleZoom = (e: React.MouseEvent) => {
    if (zoomRef.current > 1.001) resetZoom();
    else zoomAt(e.clientX, e.clientY, 2.5);
  };

  // 缩略图条：只渲染当前附近的一段
  const from = Math.max(0, Math.min(index - THUMB_WINDOW / 2, items.length - THUMB_WINDOW));
  const to = Math.min(items.length, from + THUMB_WINDOW);
  const strip = items.slice(from, to);

  return (
    <div
      ref={rootRef}
      className={`lightbox${playing ? ' playing' : ''}${chrome ? '' : ' hide-chrome'}`}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <div className="lightbox-top" onClick={(e) => e.stopPropagation()}>
        <button className="btn ghost sm" onClick={onClose}>
          <IconClose /> 关闭 (ESC)
        </button>
        <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
          {index + 1} / {items.length}
        </span>
        <span className="lightbox-hint">滚轮切换 · Ctrl+滚轮缩放 · 空格幻灯片 · ← → · ESC</span>
        <button
          className={`btn sm${playing ? ' primary' : ''}`}
          onClick={() => setPlaying((p) => !p)}
          title="幻灯片自动播放（空格切换）"
        >
          {playing ? '⏸ 暂停' : '▶ 幻灯片'}
        </button>
        <select
          className="select select-sm"
          value={slideSec}
          title="幻灯片间隔"
          onChange={(e) => setSlideSec(Number(e.target.value))}
        >
          {SLIDE_SECONDS.map((s) => (
            <option key={s} value={s}>
              {s} 秒
            </option>
          ))}
        </select>
        <button
          className={`btn sm${showThumbs ? ' primary' : ''}`}
          onClick={() => setShowThumbs((v) => !v)}
          title="显示/隐藏底部缩略图条"
        >
          缩略图
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            className={`btn sm${item.favorite ? ' primary' : ''}`}
            onClick={() => onToggleFavorite(item)}
          >
            <IconHeart filled={item.favorite} /> {item.favorite ? '已收藏' : '收藏'}
          </button>
          <button
            className="btn sm"
            title="按「设置 → 画质增强」里的目标标准与模型放大（AI 模型需先下载运行库），结果覆盖原文件"
            disabled={!!rotating || !!enhancing}
            onClick={() => onEnhance(item)}
          >
            <IconWand /> {enhancing ? '增强中…' : '画质增强'}
          </button>
          <button
            className="btn sm"
            title="AI 抠图：生成透明背景 PNG 存为新图（原图保留），模型约 4.5MB"
            disabled={matting}
            onClick={async () => {
              setMatting(true);
              try {
                const r = await api.removeBackground(item.id);
                if (r.ok) onChangeToast?.('已生成去背景版本，已存入图库');
                else onChangeToast?.(`去背景失败：${r.reason || '未知原因'}`);
              } catch (err) {
                onChangeToast?.(`去背景失败：${(err as Error).message}`);
              } finally {
                setMatting(false);
              }
            }}
          >
            {matting ? '抠图中…' : '✂ 去背景'}
          </button>
          <button className="btn sm" title="逆时针旋转 90° 并保存" disabled={!!rotating} onClick={() => rotate('ccw')}>
            <IconRotateCcw /> {rotating === 'ccw' ? '保存中…' : '左转 90°'}
          </button>
          <button className="btn sm" title="顺时针旋转 90° 并保存" disabled={!!rotating} onClick={() => rotate('cw')}>
            <IconRotateCw /> {rotating === 'cw' ? '保存中…' : '右转 90°'}
          </button>
          <button
            className="btn sm"
            title="竖版图会合成为「完整竖图居中 + 模糊同图铺底」，不裁切"
            onClick={() => onSetWallpaper(item)}
          >
            <IconWallpaper /> 设为桌面壁纸
          </button>
          {onDownload && (
            <button className="btn sm" onClick={() => onDownload(item)} title="另存为">
              <IconDownload /> 下载
            </button>
          )}
          <button className="btn sm" onClick={() => revealFile(item.path)}>
            <IconFolder /> 在文件夹中显示
          </button>
          <button className="btn sm danger" onClick={() => onDelete(item)}>
            <IconTrash /> 删除
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
        <img
          key={item.id}
          ref={imgRef}
          src={item.url}
          alt={item.title}
          decoding="async"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={toggleZoom}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: dragging ? 'none' : 'transform 0.16s ease-out',
            cursor: zoom > 1.001 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
          }}
        />
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

      {showThumbs && items.length > 1 && (
        <div className="lightbox-thumbs" ref={stripRef} onClick={(e) => e.stopPropagation()}>
          {strip.map((it, i) => (
            <button
              key={it.id}
              data-thumb={it.id}
              className={`lb-thumb${from + i === index ? ' on' : ''}`}
              title={it.title}
              onClick={() => onIndex(from + i)}
            >
              <img src={it.thumbUrl} alt="" loading="lazy" draggable={false} />
            </button>
          ))}
          {to - from < items.length && (
            <span className="lb-thumb-more" title={`共 ${items.length} 张，左右滚动切换到的缩略图会随之更新`}>
              共 {items.length} 张
            </span>
          )}
        </div>
      )}

      <div className="lightbox-info" onClick={(e) => e.stopPropagation()}>
        <div className="meta-item">
          <b>分辨率</b>
          {item.width} × {item.height}（{BUCKET_LABELS[item.bucket]}）
          {item.enhanced && (
            <span className="enhanced-tag" title="该图由「画质增强」放大过，磁盘文件已是当前尺寸">
              ✨ 已增强 {item.enhanceScale}×（原 {item.originalWidth}×{item.originalHeight}）
            </span>
          )}
        </div>
        <div className="meta-item">
          <b>文件大小</b>
          {formatSize(item.sizeBytes)}
        </div>
        <div className="meta-item">
          <b>采集来源</b>
          {SOURCE_LABELS[item.source] || item.source}
        </div>
        <div className="meta-item">
          <b>关键词</b>
          {item.keyword || '—'}
        </div>
        <div className="meta-item">
          <b>采集时间</b>
          {formatDate(item.createdAt)}
        </div>
        <div className="meta-item">
          <b>浏览情况</b>
          {item.viewCount ? `看过 ${item.viewCount} 次` : '还没看过'}
        </div>
        <div className="meta-item">
          <b>我的星级</b>
          <span className="stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={`star${(item.rating || 0) >= n ? ' on' : ''}`}
                title={`${n} 星`}
                onClick={() => onPatch?.(item, { rating: item.rating === n ? 0 : n })}
              >
                ★
              </button>
            ))}
            {!!item.rating && (
              <button className="star-clear" onClick={() => onPatch?.(item, { rating: 0 })}>
                清除
              </button>
            )}
          </span>
        </div>
        <div className="meta-item" style={{ minWidth: 220 }}>
          <b>我的备注</b>
          <input
            key={item.id}
            className="input"
            style={{ width: '100%', padding: '4px 9px', fontSize: 12 }}
            placeholder="记点什么…（回车保存）"
            defaultValue={item.note}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onPatch?.(item, { note: (e.target as HTMLInputElement).value });
                (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={(e) => {
              if (e.target.value !== item.note) onPatch?.(item, { note: e.target.value });
            }}
          />
        </div>
        <div className="meta-item">
          <b>主色系</b>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              className="color-chip"
              style={{ background: item.dominant || 'rgba(255,255,255,0.15)' }}
              title={item.dominant || '未提取主色'}
            />
            <span style={{ fontSize: 12 }}>{item.dominant || '—'}</span>
            {onFindColor &&
              (() => {
                const first = (item.hue || '').split(',').filter(Boolean)[0];
                return first !== undefined ? (
                  <button className="btn sm ghost" title="跳到图库，只看同色系的图片" onClick={() => onFindColor(Number(first))}>
                    找同色系
                  </button>
                ) : null;
              })()}
          </span>
        </div>
        <div className="meta-item">
          <b>找相似</b>
          <button
            className={`btn sm${sim.open ? ' primary' : ''}`}
            onClick={() => setSim((s) => ({ ...s, open: !s.open }))}
            title="用 CLIP 深度特征找出与这张最像的其他图（相似度可调）"
          >
            {sim.open ? '✕ 收起面板' : '🔍 找相似'}
          </button>
        </div>
        <div className="meta-item" style={{ minWidth: 260, flex: 1 }}>
          <b>AI 识图</b>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <button
              className="btn sm"
              disabled={aiBusy}
              onClick={async () => {
                setAiBusy(true);
                try {
                  const d = await api.analyzeImage(item.id);
                  setAiDesc(d);
                } catch (err) {
                  onChangeToast?.(`AI 识图失败：${(err as Error).message}`);
                } finally {
                  setAiBusy(false);
                }
              }}
            >
              {aiBusy ? '识别中…' : aiDesc?.description ? '重新识别' : 'AI 识图'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 420 }}>
              {aiDesc?.description || '（还没识别，点左侧按钮让 AI 描述这张图，之后可用自然语言搜索）'}
            </span>
          </div>
          {!!aiDesc?.issues?.length && (
            <div className="hint" style={{ color: 'var(--warn)', width: '100%' }}>
              可能的问题：{aiDesc.issues.join('、')}
            </div>
          )}
        </div>
        <div className="meta-item" style={{ maxWidth: 320 }}>
          <b>本地文件</b>
          <span
            style={{ cursor: 'pointer', color: 'var(--accent)' }}
            title={item.path}
            onClick={() => revealFile(item.path)}
          >
            {item.path ? item.path.replace(/^.*[\\/]/, '') : '—'}
          </span>
        </div>
        <div className="meta-item" style={{ flex: 1, minWidth: 220 }}>
          <b>标签</b>
          <div className="tag-editor">
            {item.tags.map((t) => (
              <span className="tag-pill" key={t}>
                {t}
                <button onClick={() => onSaveTags(item, item.tags.filter((x) => x !== t))}>×</button>
              </span>
            ))}
            <input
              className="input"
              style={{ width: 110, padding: '4px 9px', fontSize: 12 }}
              placeholder="添加标签…"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTag();
              }}
            />
            <button className="btn sm" onClick={addTag}>
              添加
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
