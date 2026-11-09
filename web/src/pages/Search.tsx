import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadFile, exportZipUrl } from '../api';
import type { ImageItem } from '../types';
import ImageCard from '../components/ImageCard';
import ColorPad from '../components/ColorPad';
import MasonryGrid from '../components/MasonryGrid';

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

  const runSearch = useCallback(
    async (fn: () => Promise<void>) => {
      setLoading(true);
      try {
        await fn();
      } catch (err) {
        onToast((err as Error).message, 'error');
      } finally {
        setLoading(false);
      }
    },
    [onToast]
  );

  /* ---- 颜色搜索：Eagle 式「停下即搜」 ----
   * 色盘拖动高频更新 hex/tol，这里 150ms 静止后才真正请求；
   * 用递增序号丢弃过期响应，快速拖动也不会出现旧结果盖新结果。 */
  const colorSeq = useRef(0);
  useEffect(() => {
    if (mode !== 'color') return;
    setEngineNote(''); // 颜色搜索没有 AI 参与，别留着上一次的引擎说明
    const my = ++colorSeq.current;
    const timer = setTimeout(async () => {
      try {
        setLoading(true);
        const r = await api.searchColor(hex, tol, 120);
        if (colorSeq.current !== my) return; // 已有更新的搜索，丢弃过期响应
        setItems(r.items);
        setTotal(r.total);
      } catch (err) {
        if (colorSeq.current === my) onToast((err as Error).message, 'error');
      } finally {
        if (colorSeq.current === my) setLoading(false);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [hex, tol, mode, onToast]);

  const byAi = () =>
    runSearch(async () => {
      const q = query.trim();
      if (!q) return onToast('请输入想找的图，例如「白底人像」「暖色调的日落海边」');
      let r = await api.hybridSearch(q, 60);
      // 文本塔首次加载要下载 ~85MB：后端会先回 loading，这里等它，最多等约 25 秒
      let tries = 0;
      while (r.engine === 'loading' && tries < 10) {
        tries++;
        setEngineNote(`正在加载本地语义模型（首次约 85MB）… ${tries}/10`);
        await new Promise((res) => setTimeout(res, 2500));
        r = await api.hybridSearch(q, 60);
      }
      setItems(r.items);
      setTotal(r.total);
      const cov = r.covered?.total ? `，已建模 ${r.covered.indexed}/${r.covered.total} 张` : '';
      setEngineNote(
        r.engine === 'hybrid'
          ? `匹配方式：混合检索（关键词 + 本地 CLIP 语义，按名次融合）${cov}`
          : r.engine === 'loading'
            ? '语义模型仍在加载，稍等几秒再点一次「搜索」'
            : r.degraded
              ? `语义侧不可用，当前只按关键词匹配（${r.reason || '原因未知'}）`
              : `按关键词「${q}」匹配标题 / 标签 / 采集词 / AI 描述（不是语义理解）`
      );
      if (!r.items.length) onToast('没有找到匹配的图（换个说法，或等向量索引建完）');
    });

  const byImage = (file: File) =>
    runSearch(async () => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error('读取图片失败'));
        fr.readAsDataURL(file);
      });
      setQueryPreview(dataUrl);
      const r = await api.searchByImage(dataUrl, 10, 24);
      setItems(r.items);
      setTotal(r.total);
      setEngineNote(
        r.engine === 'clip'
          ? '匹配方式：CLIP 深度特征（跨裁剪/滤镜的语义相似）'
          : '匹配方式：感知哈希 pHash（构图/像素级相似，不理解画面内容）'
      );
      if (!r.items.length) onToast('没有找到足够相似的图（可检查图片是否模糊/裁剪过度）');
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
    if (d <= 2) return '几乎相同';
    if (d <= 6) return '高度相似';
    return '构图相近';
  };

  /* 结果网格的选择态：以前勾选框是空函数，点了没反应；现在支持多选后批量收藏/打包下载 */
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const bulkFavorite = async () => {
    const targets = items.filter((it) => selected.has(it.id) && !it.favorite);
    if (!targets.length) return onToast('选中的图片都已在收藏里');
    try {
      for (const it of targets) {
        const updated = await api.patch(it.id, { favorite: true });
        setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      }
      onToast(`已收藏 ${targets.length} 张`);
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
        <h2>智能检索</h2>
        <p className="page-sub">
          自然语言搜图（本地 CLIP 跨模态召回）· 颜色搜图 · 以图搜图（CLIP 特征 / 感知哈希）
        </p>
      </div>

      <div className="seg">
        <button className={mode === 'ai' ? 'on' : ''} onClick={() => setMode('ai')}>
          语义检索
        </button>
        <button className={mode === 'color' ? 'on' : ''} onClick={() => setMode('color')}>
          颜色
        </button>
        <button className={mode === 'image' ? 'on' : ''} onClick={() => setMode('image')}>
          以图搜图
        </button>
      </div>

      <div className="search-bar">
        {mode === 'ai' && (
          <>
            <input
              className="inp"
              placeholder='自然语言，如「演唱会舞台」「有山景的红色写真」'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && byAi()}
            />
            <button className="btn primary" onClick={byAi} disabled={loading}>
              {loading ? '搜索中…' : '搜索'}
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
                准确度
                <input
                  type="range"
                  min={0}
                  max={160}
                  value={160 - tol}
                  onChange={(e) => setTol(160 - Number(e.target.value))}
                />
                <b>{160 - tol}</b>
              </label>
              <span className="hint">拖到想要的颜色，鼠标停下结果立即出现</span>
            </div>
          </div>
        )}

        {mode === 'image' && (
          <>
            <label className="btn primary file">
              选择图片
              <input type="file" accept="image/*" onChange={onFile} hidden />
            </label>
            {queryPreview && (
              <img
                src={queryPreview}
                alt="查询图"
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
                清除
              </button>
            )}
          </>
        )}
      </div>

      <div className="result-meta">
        {total > 0 ? `命中 ${total} 张` : loading ? '加载中…' : '暂无结果'}
        {engineNote && (
          <span className="hint" style={{ marginLeft: 10 }}>
            {engineNote}
          </span>
        )}
        {selected.size > 0 && (
          <span className="sel-actions">
            <b>已选 {selected.size} 张</b>
            <button className="btn sm" onClick={() => void bulkFavorite()}>
              加入收藏
            </button>
            <button
              className="btn sm"
              onClick={() => downloadFile(exportZipUrl([...selected]))}
            >
              打包下载 ZIP
            </button>
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
              取消选择
            </button>
          </span>
        )}
      </div>

      <MasonryGrid items={items} renderItem={grid} />
    </div>
  );
}
