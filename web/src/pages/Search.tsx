import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadFile, exportZipUrl } from '../api';
import type { ImageItem } from '../types';
import ImageCard from '../components/ImageCard';
import ColorPad from '../components/ColorPad';
import MasonryGrid from '../components/MasonryGrid';
import { ensureHardware } from '../lib/hardware';
import i18n from '../i18n';

type Mode = 'color' | 'ai' | 'image';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 打开大图预览（App 级 Lightbox，可在结果间左右导航） */
  onOpenItem?: (item: ImageItem, pool?: ImageItem[]) => void;
}

export default function Search({ onToast, onOpenItem }: Props) {
  const [mode, setMode] = useState<Mode>('ai');
  const [hex, setHex] = useState('#ff4d6d');
  const [tol, setTol] = useState(48);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [queryPreview, setQueryPreview] = useState(''); // 以图搜图的查询图预览
  /** 本次结果到底走的哪条通道（LLM 抽词 / 纯关键词 / CLIP / pHash）——
   *  以前四种情况在界面上没有任何区别，用户会以为「AI 语义搜索」在理解画面。 */
  const [engineNote, setEngineNote] = useState('');

  /** 三种搜索共用一个请求代次：旧响应不能覆盖新模式，也不能结束新请求的加载态 */
  const searchSeq = useRef(0);
  const runSearch = useCallback(
    async (fn: (isCurrent: () => boolean) => Promise<void>) => {
      const my = ++searchSeq.current;
      const isCurrent = () => searchSeq.current === my;
      setLoading(true);
      try {
        await fn(isCurrent);
      } catch (err) {
        if (isCurrent()) onToast((err as Error).message, 'error');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [onToast]
  );

  /* ---- 颜色搜索：Eagle 式「停下即搜」 ----
   * 色盘拖动高频更新 hex/tol，这里 150ms 静止后才真正请求；
   * 用递增序号丢弃过期响应，快速拖动也不会出现旧结果盖新结果。 */
  useEffect(() => {
    const my = ++searchSeq.current;
    if (mode !== 'color') {
      // 切走时让颜色 / AI / 以图搜图的在途响应全部失效
      setLoading(false);
      return;
    }
    setEngineNote(''); // 颜色搜索没有 AI 参与，别留着上一次的引擎说明
    const timer = setTimeout(async () => {
      try {
        setLoading(true);
        const r = await api.searchColor(hex, tol, 120);
        if (searchSeq.current !== my) return; // 已有更新的搜索，丢弃过期响应
        setItems(r.items);
        setTotal(r.total);
      } catch (err) {
        if (searchSeq.current === my) onToast((err as Error).message, 'error');
      } finally {
        if (searchSeq.current === my) setLoading(false);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [hex, tol, mode, onToast]);

  const byAi = () =>
    runSearch(async (isCurrent) => {
      const q = query.trim();
      if (!q) return onToast(i18n.t('k6bac639c'));
      // 语义检索要本地加载 CLIP 文本塔（约 85MB）：内存/核心不够时先说明，再让用户决定
      if (!(await ensureHardware('semantic')) || !isCurrent()) return;
      let r = await api.hybridSearch(q, 60);
      // 文本塔首次加载要下载 ~85MB：后端会先回 loading，这里等它，最多等约 25 秒
      let tries = 0;
      while (r.engine === 'loading' && tries < 10 && isCurrent()) {
        tries++;
        setEngineNote(i18n.t('k26a77290', { p0: tries }));
        await new Promise((res) => setTimeout(res, 2500));
        if (!isCurrent()) return;
        r = await api.hybridSearch(q, 60);
      }
      if (!isCurrent()) return;
      setItems(r.items);
      setTotal(r.total);
      const cov = r.covered?.total ? i18n.t('k5a0db73a', { p0: r.covered.indexed, p1: r.covered.total }) : '';
      setEngineNote(
        r.engine === 'hybrid'
          ? i18n.t('k7b10843f', { p0: cov })
          : r.engine === 'loading'
            ? i18n.t('k29e40f64')
            : r.degraded
              ? i18n.t('k9878f5f7', { p0: r.reason || i18n.t('k8027d6f8') })
              : i18n.t('kb294b5e5', { p0: q })
      );
      if (!r.items.length) onToast(i18n.t('kc40cd633'));
    });

  const byImage = (file: File) =>
    runSearch(async (isCurrent) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error(i18n.t('kd48083ae')));
        fr.readAsDataURL(file);
      });
      if (!isCurrent()) return;
      setQueryPreview(dataUrl);
      const r = await api.searchByImage(dataUrl, 10, 24);
      if (!isCurrent()) return;
      setItems(r.items);
      setTotal(r.total);
      setEngineNote(
        r.engine === 'clip'
          ? i18n.t('k58c51cf8')
          : i18n.t('k6862f12b')
      );
      if (!r.items.length) onToast(i18n.t('kf793ba1c'));
    });

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) byImage(f);
    e.target.value = '';
  };

  const toggleFavorite = async (item: ImageItem) => {
    const updated = await api.patch(item.id, { favorite: !item.favorite });
    setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
  };

  /** 汉明距离越小越像：64bit pHash，≤2 几乎同一张，≤6 高度相似，其余为构图相近 */
  const simLabel = (d?: number) => {
    if (typeof d !== 'number') return '';
    if (d <= 2) return i18n.t('k03ed3d39');
    if (d <= 6) return i18n.t('k9a79639b');
    return i18n.t('k94ec0635');
  };

  /* 结果网格的选择态：以前勾选框是空函数，点了没反应；现在支持多选后批量收藏/打包下载 */
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const bulkFavorite = async () => {
    const targets = items.filter((it) => selected.has(it.id) && !it.favorite);
    if (!targets.length) return onToast(i18n.t('k7fa0c3fd'));
    try {
      for (const it of targets) {
        const updated = await api.patch(it.id, { favorite: true });
        setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      }
      onToast(i18n.t('ka0f34a89', { p0: targets.length }));
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
  };

  const grid = useMemo(
    () => (it: ImageItem) => (
      <ImageCard
        item={it}
        note={simLabel((it as ImageItem & { hamming?: number }).hamming)}
        selected={selected.has(it.id)}
        onOpen={(i) => onOpenItem?.(i, items)}
        onToggleSelect={() =>
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(it.id)) next.delete(it.id);
            else next.add(it.id);
            return next;
          })
        }
        onToggleFavorite={toggleFavorite}
        onDownload={(x) => downloadFile(x.downloadUrl || x.url)}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, selected]
  );

  return (
    <div className="page">
      <div className="page-head">
        <h2>{i18n.t('k2c42fc30')}</h2>
        <p className="page-sub">
          {i18n.t('kd33fc356')}
        </p>
      </div>

      <div className="seg">
        <button className={mode === 'ai' ? 'on' : ''} onClick={() => setMode('ai')}>
          {i18n.t('kef5aae49')}
        </button>
        <button className={mode === 'color' ? 'on' : ''} onClick={() => setMode('color')}>
          {i18n.t('k6b36c6f7')}
        </button>
        <button className={mode === 'image' ? 'on' : ''} onClick={() => setMode('image')}>
          {i18n.t('kc30d6c94')}
        </button>
      </div>

      <div className="search-bar">
        {mode === 'ai' && (
          <>
            <input
              className="inp"
              placeholder={i18n.t('k448cbdcf')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && byAi()}
            />
            <button className="btn primary" onClick={byAi} disabled={loading}>
              {loading ? i18n.t('kc3fc93ab') : i18n.t('ke5f71fc3')}
            </button>
          </>
        )}

        {mode === 'color' && (
          <div className="color-live">
            <ColorPad value={hex} onChange={setHex} />
            <div className="color-side">
              <div className="color-hex-lg">
                <span className="color-chip" style={{ background: hex }} />
                <span className="color-hex">{hex.toUpperCase()}</span>
              </div>
              <label className="tol">
                {i18n.t('k3777c73e')}
                <input
                  type="range"
                  min={0}
                  max={160}
                  value={160 - tol}
                  onChange={(e) => setTol(160 - Number(e.target.value))}
                />
                <b>{160 - tol}</b>
              </label>
              <span className="hint">{i18n.t('kb00b23f4')}</span>
            </div>
          </div>
        )}

        {mode === 'image' && (
          <>
            <label className="btn primary file">
              {i18n.t('kba9fc45d')}
              <input type="file" accept="image/*" onChange={onFile} hidden />
            </label>
            {queryPreview && (
              <img
                src={queryPreview}
                alt={i18n.t('k02ad92be')}
                style={{
                  height: 64,
                  maxWidth: 160,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              />
            )}
            {queryPreview && (
              <button className="btn ghost sm" onClick={() => { setQueryPreview(''); setItems([]); setTotal(0); setEngineNote(''); }}>
                {i18n.t('k4403fca0')}
              </button>
            )}
          </>
        )}
      </div>

      <div className="result-meta">
        {total > 0 ? i18n.t('k6c8fa933', { p0: total }) : loading ? i18n.t('kfb4ca1cf') : i18n.t('k0ee4df3d')}
        {engineNote && (
          <span className="hint" style={{ marginLeft: 10 }}>
            {engineNote}
          </span>
        )}
        {selected.size > 0 && (
          <span className="sel-actions">
            <b>已选 {selected.size} 张</b>
            <button className="btn sm" onClick={() => void bulkFavorite()}>
              {i18n.t('k05b72da9')}
            </button>
            <button
              className="btn sm"
              onClick={() => downloadFile(exportZipUrl([...selected]))}
            >
              {i18n.t('kcc9f4334')}
            </button>
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
              {i18n.t('k76159d0d')}
            </button>
          </span>
        )}
      </div>

      <MasonryGrid items={items} renderItem={grid} />
    </div>
  );
}
