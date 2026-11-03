import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatDate, quiet } from '../api';
import type { Filters, ImageItem } from '../types';
import { IconLink, IconRefresh, IconSearch, IconTrash } from '../components/Icons';

interface Props {
  onToast?: (msg: string) => void;
  /** 打开大图（父级灯箱）：书签也能进灯箱看封面/改元数据 */
  onOpen: (item: ImageItem, list: ImageItem[]) => void;
  onLibraryChanged?: () => void;
}

const baseFilters: Filters = {
  q: '',
  source: [],
  favorite: 'all',
  orientation: 'all',
  bucket: [],
  tag: '',
  sort: 'new',
  seen: 'all',
  minRating: 0,
  hue: '',
  colorHex: '',
  colorTol: 24,
  kind: 'bookmark',
  pending: '',
};

/**
 * 书签浏览器：左边列表、右边直接看离线快照（后端以 CSP script-src 'none' 提供），
 * 同时能打开原网址、复制链接、重命名与删除。解决「存了书签只能在灯箱里看封面」的半截状态。
 */
export default function Bookmarks({ onToast, onOpen, onLibraryChanged }: Props) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [curId, setCurId] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api.images({ ...baseFilters, q }, 1, 300);
      if (my !== seq.current) return;
      setItems(r.items);
      setTotal(r.total);
      setCurId((prev) => (prev && r.items.some((i) => i.id === prev) ? prev : r.items[0]?.id ?? null));
    } catch (e) {
      if (my === seq.current) onToast?.((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [q, onToast]);

  useEffect(() => {
    const t = window.setTimeout(load, q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, q]);

  const cur = useMemo(() => items.find((i) => i.id === curId) || null, [items, curId]);

  useEffect(() => setMissing(false), [curId]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast?.('链接已复制');
    } catch {
      onToast?.('复制失败，请手动复制');
    }
  };

  const remove = async (it: ImageItem) => {
    if (!window.confirm(`删除书签「${it.title}」？快照文件也会一并删除。`)) return;
    try {
      await api.remove(it.id);
      onToast?.('已删除');
      onLibraryChanged?.();
      load();
    } catch (e) {
      onToast?.((e as Error).message);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">书签</h1>
          <div className="page-sub">
            共 {total} 个书签 · 右侧是入库时保存的离线快照（不执行网页脚本），断网也能看
          </div>
        </div>
        <div className="tk-row">
          <div className="search-box">
            <span className="icon">
              <IconSearch />
            </span>
            <input
              className="input"
              placeholder="搜标题 / 网址 / 备注…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button className="btn sm" onClick={load} title="重新载入">
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>

      <div className="bm-wrap">
        <div className="bm-body">
          <div className="bm-list">
            {items.map((it) => (
              <button
                key={it.id}
                className={`bm-item${it.id === curId ? ' on' : ''}`}
                onClick={() => setCurId(it.id)}
                onDoubleClick={() => onOpen(it, items)}
                title={`${it.title}\n${it.sourceUrl || ''}`}
              >
                {it.thumbUrl ? (
                  <img src={it.thumbUrl} alt="" loading="lazy" />
                ) : (
                  <span className="bm-thumb-empty">
                    <IconLink />
                  </span>
                )}
                <span className="bm-meta">
                  <b>{it.title}</b>
                  <small>{it.sourceUrl || it.path}</small>
                  <small>{formatDate(it.createdAt)}</small>
                </span>
              </button>
            ))}
            {!items.length && !loading && (
              <div className="bm-empty">
                {q ? '没有匹配的书签' : '还没有书签。用顶部「＋ 书签」粘贴网址即可保存。'}
              </div>
            )}
            {loading && <div className="bm-empty">载入中…</div>}
          </div>

          <div className="bm-frame">
            {cur ? (
              <>
                <div className="pdf-bar">
                  <b className="bm-cur-title" title={cur.title}>
                    {cur.title}
                  </b>
                  {cur.sourceUrl && (
                    <button className="btn sm" onClick={() => window.open(cur.sourceUrl, '_blank', 'noopener')}>
                      <IconLink /> 打开原网址
                    </button>
                  )}
                  {cur.sourceUrl && (
                    <button className="btn sm ghost" onClick={() => copy(cur.sourceUrl)}>
                      复制链接
                    </button>
                  )}
                  <button className="btn sm ghost" onClick={() => onOpen(cur, items)} title="进大图看封面 / 改标题标签">
                    详情
                  </button>
                  <button className="btn sm ghost danger" onClick={() => remove(cur)}>
                    <IconTrash /> 删除
                  </button>
                </div>
                <div className="bm-iframe-wrap">
                  <iframe
                    key={cur.id}
                    className="bm-iframe"
                    src={`/api/images/${cur.id}/snapshot`}
                    sandbox=""
                    referrerPolicy="no-referrer"
                    title={cur.title}
                    onLoad={() => setMissing(false)}
                  />
                  <div className="bm-snap-note">
                    快照不含脚本与外链 frame，排版可能与原网页有差异；需要完整内容请点「打开原网址」。
                    {missing && ' 快照文件可能已被清理。'}
                  </div>
                </div>
              </>
            ) : (
              <div className="bm-empty">从左侧选一个书签</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
