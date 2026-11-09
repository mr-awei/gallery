/**
 * 文件夹收纳视图（Eagle 式「按文件夹分组」）。
 *
 * 与「图片展开」三视图并列，由顶部视图切换按钮自由选择：
 * - 当前层级的每个子文件夹是一张收纳卡：封面 / 名称 / 张数 / 子夹数一眼可见，
 *   点名称或封面进入该夹（含全部后代），点箭头就地展开组内图片；
 * - 组内图片按需懒加载（展开且进入视口才请求 /api/folders/:id/images），
 *   不会因 57 个文件夹一次性打出 57 个接口；
 * - 拖图片到收纳卡上 = 归入该夹；未归档素材单独一张卡，点它回到图片展开视图。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from 'react';
import { api } from '../api';
import { IMAGE_MIME } from '../lib/dnd';
import type { FolderNode, ImageItem } from '../types';

/** 每组最多展示的缩略图数；超出部分用「+N 张」进入文件夹查看 */
const PREVIEW_LIMIT = 18;

interface Preview {
  items: ImageItem[];
  total: number;
}

interface Props {
  folders: FolderNode[];
  /** 当前所在文件夹；null = 根级 */
  folderId: number | null;
  rootName: string;
  onOpenRoot: () => void;
  onOpenFolder: (id: number) => void;
  /** 点组内缩略图开灯箱，pool 传该组已加载的图片，保证左右导航范围正确 */
  onOpenImage: (item: ImageItem, pool: ImageItem[]) => void;
  onDropImages?: (folderId: number, ids: number[]) => void;
  /** 查看未归档素材：切回图片展开视图并套用「未分类」 */
  onShowUnfiled?: () => void;
  unfiledCount?: number;
  /** 导入 / 刷新后重新拉取已展开组的缩略图 */
  refreshSeq?: number;
  totalImages?: number;
}

function FolderGroup({
  folder,
  childCount,
  open,
  preview,
  loading,
  failed,
  onToggle,
  onNeedPreview,
  onRetry,
  onOpenFolder,
  onOpenImage,
  onDropImages,
}: {
  folder: FolderNode;
  childCount: number;
  open: boolean;
  preview?: Preview;
  loading: boolean;
  failed: boolean;
  onToggle: () => void;
  onNeedPreview: () => void;
  onRetry: () => void;
  onOpenFolder: (id: number) => void;
  onOpenImage: (item: ImageItem, pool: ImageItem[]) => void;
  onDropImages?: (folderId: number, ids: number[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

  /** 展开不代表立刻要数据：滚到附近再拉，避免「全部展开」时的请求风暴 */
  useEffect(() => {
    if (!open || preview || loading || failed) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onNeedPreview();
          io.disconnect();
        }
      },
      { rootMargin: '300px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [open, preview, loading, failed, onNeedPreview]);

  const parseIds = (raw: string): number[] =>
    raw
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);

  return (
    <div
      ref={ref}
      className={`fg-group${open ? ' open' : ''}${over ? ' drop' : ''}`}
      style={folder.color ? ({ '--fg': folder.color } as CSSProperties) : undefined}
      data-folder-id={folder.id}
      onDragOver={(e: DragEvent<HTMLDivElement>) => {
        if (!onDropImages || !e.dataTransfer.types.includes(IMAGE_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent<HTMLDivElement>) => {
        setOver(false);
        if (!onDropImages) return;
        const ids = parseIds(e.dataTransfer.getData(IMAGE_MIME));
        if (!ids.length) return;
        e.preventDefault();
        e.stopPropagation();
        onDropImages(folder.id, ids);
      }}
    >
      <div className="fg-head">
        <button
          type="button"
          className="fg-chevron"
          onClick={onToggle}
          title={open ? '收起这组图片' : '就地展开这组图片'}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'}
        </button>
        <button
          type="button"
          className="fg-cover"
          onClick={() => onOpenFolder(folder.id)}
          title={`进入「${folder.name}」`}
        >
          {folder.cover?.thumbUrl ? (
            <img src={folder.cover.thumbUrl} alt="" loading="lazy" decoding="async" />
          ) : (
            <span>{folder.icon || '📁'}</span>
          )}
        </button>
        <button type="button" className="fg-title" onClick={() => onOpenFolder(folder.id)} title={`进入「${folder.name}」`}>
          <span className="fg-name">
            {folder.color && <i className="fg-dot" style={{ background: folder.color }} />}
            {folder.name}
          </span>
          <span className="fg-meta">
            {folder.total} 张图片{childCount ? ` · ${childCount} 个子文件夹` : ''}
            {folder.locked ? ' · 已加锁' : ''}
          </span>
        </button>
        <button type="button" className="fg-expand" onClick={onToggle}>
          {open ? '收起图片' : '展开图片'}
        </button>
        <button type="button" className="fg-enter" onClick={() => onOpenFolder(folder.id)}>
          进入 →
        </button>
      </div>

      {open && (
        <div className="fg-body">
          {loading && !preview && <div className="fg-status">正在载入这组图片…</div>}
          {failed && (
            <div className="fg-status">
              这组图片没加载出来
              <button type="button" className="btn sm" onClick={onRetry}>
                重试
              </button>
            </div>
          )}
          {preview && !preview.items.length && <div className="fg-status">这个文件夹还没有图片</div>}
          {preview && preview.items.length > 0 && (
            <div className="fg-thumbs">
              {preview.items.map((it) => (
                <button
                  type="button"
                  key={it.id}
                  className="fg-thumb"
                  title={it.title}
                  onClick={() => onOpenImage(it, preview.items)}
                >
                  <img src={it.thumbUrl} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
              {preview.total > preview.items.length && (
                <button type="button" className="fg-thumb more" onClick={() => onOpenFolder(folder.id)}>
                  +{preview.total - preview.items.length} 张
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FolderGroupView({
  folders,
  folderId,
  rootName,
  onOpenRoot,
  onOpenFolder,
  onOpenImage,
  onDropImages,
  onShowUnfiled,
  unfiledCount = 0,
  refreshSeq,
  totalImages = 0,
}: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [previews, setPreviews] = useState<Record<number, Preview>>({});
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set());
  const [errorIds, setErrorIds] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const requested = useRef<Set<number>>(new Set());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  /** 面包屑：从当前夹沿 parent_id 回溯到根，防环 */
  const crumbs = useMemo(() => {
    const chain: FolderNode[] = [];
    const guard = new Set<number>();
    let cur = folderId != null ? byId.get(folderId) : undefined;
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.unshift(cur);
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
  }, [byId, folderId]);

  const childCountOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const f of folders) if (f.parent_id != null) m.set(f.parent_id, (m.get(f.parent_id) || 0) + 1);
    return m;
  }, [folders]);

  const children = useMemo(
    () =>
      folders
        .filter((f) => (f.parent_id ?? null) === (folderId ?? null))
        .filter((f) => !query.trim() || f.name.toLowerCase().includes(query.trim().toLowerCase()))
        .sort(
          (a, b) =>
            (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN')
        ),
    [folders, folderId, query]
  );

  const loadPreview = useCallback((id: number) => {
    if (requested.current.has(id)) return;
    requested.current.add(id);
    setLoadingIds((prev) => new Set(prev).add(id));
    api
      .folderImages(id, 1, PREVIEW_LIMIT)
      .then((r) => {
        if (!mounted.current) return;
        setPreviews((prev) => ({ ...prev, [id]: { items: r.items, total: r.total } }));
        setErrorIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      })
      .catch(() => {
        if (!mounted.current) return;
        // 显式失败态 + 可重试，不允许静默吞掉
        requested.current.delete(id);
        setErrorIds((prev) => new Set(prev).add(id));
      })
      .finally(() => {
        if (!mounted.current) return;
        setLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      });
  }, []);

  /** 导入 / 手动刷新后清掉缓存，已展开的组由各自可见性观察器重新拉取 */
  const lastSeq = useRef(refreshSeq);
  useEffect(() => {
    if (lastSeq.current === refreshSeq) return;
    lastSeq.current = refreshSeq;
    requested.current.clear();
    setPreviews({});
    setErrorIds(new Set());
  }, [refreshSeq]);

  /** 切换文件夹层级时清空展开与搜索，避免上一层级的展开状态串到下一层 */
  useEffect(() => {
    setExpanded(new Set());
    setQuery('');
  }, [folderId]);

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allExpanded = children.length > 0 && children.every((f) => expanded.has(f.id));

  return (
    <div className="folder-groups" data-tour="folder-view">
      <div className="fg-crumbs">
        <button type="button" className="fg-crumb" onClick={onOpenRoot}>
          全部素材
        </button>
        {crumbs.map((f) => (
          <span key={f.id} className="fg-crumb-seg">
            <span className="fg-crumb-sep">/</span>
            <button
              type="button"
              className={`fg-crumb${f.id === folderId ? ' current' : ''}`}
              onClick={() => onOpenFolder(f.id)}
            >
              {f.name}
            </button>
          </span>
        ))}
        <span className="fg-crumb-note">按文件夹收纳 · 点箭头就地展开图片</span>
      </div>

      <div className="fg-bar">
        <div className="fg-bar-title">
          {children.length} 个文件夹{crumbs.length ? `位于「${crumbs[crumbs.length - 1].name}」` : '（顶层）'}
          {!folderId && totalImages > 0 && <span className="fg-bar-sub"> · 全库 {totalImages.toLocaleString('zh-CN')} 张</span>}
        </div>
        <input
          className="input fg-search"
          value={query}
          placeholder="按名称找文件夹"
          aria-label="按名称筛选当前层级的文件夹"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="fg-bar-acts">
          <button
            type="button"
            className="btn sm"
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(children.map((f) => f.id)))}
            disabled={!children.length}
          >
            {allExpanded ? '全部收起' : '全部展开'}
          </button>
        </div>
      </div>

      {children.map((f) => (
        <FolderGroup
          key={f.id}
          folder={f}
          childCount={childCountOf.get(f.id) || 0}
          open={expanded.has(f.id)}
          preview={previews[f.id]}
          loading={loadingIds.has(f.id)}
          failed={errorIds.has(f.id)}
          onToggle={() => toggle(f.id)}
          onNeedPreview={() => loadPreview(f.id)}
          onRetry={() => loadPreview(f.id)}
          onOpenFolder={onOpenFolder}
          onOpenImage={onOpenImage}
          onDropImages={onDropImages}
        />
      ))}

      {!children.length && (
        <div className="fg-blank">
          {query.trim() ? `没有名称包含「${query.trim()}」的文件夹` : '这一层还没有子文件夹'}
          <span>在左侧「文件夹」旁的 ＋ 新建，或把图片拖进左侧文件夹树归档。</span>
        </div>
      )}

      {onShowUnfiled && !folderId && unfiledCount > 0 && (
        <div className="fg-unfiled">
          <span className="fg-unfiled-icon">🗂️</span>
          <span className="fg-unfiled-text">
            还有 <b>{unfiledCount.toLocaleString('zh-CN')}</b> 张素材没放进任何文件夹
          </span>
          <button type="button" className="btn sm" onClick={onShowUnfiled}>
            展开查看 →
          </button>
        </div>
      )}

      <div className="fg-foot">当前资源库：{rootName} · 切到「图片展开」视图可用搜索与筛选浏览全部素材</div>
    </div>
  );
}
