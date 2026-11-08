import { useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadFile, formatSize } from '../api';
import type { ImageItem } from '../types';
import { IconClose, IconDownload } from './Icons';

interface Props {
  items: ImageItem[];
  onClose: () => void;
  onToast?: (m: string, kind?: 'info' | 'error') => void;
}

/**
 * 图片拼接 / 联系表：按顺序排成网格，可调列数、间距、底色、单元格大小与输出格式。
 * 预览与下载走同一个后端接口，看到的尺寸就是导出的尺寸。
 */
export default function StitchDialog({ items, onClose, onToast }: Props) {
  const [columns, setColumns] = useState(Math.min(3, Math.max(1, items.length)));
  const [gap, setGap] = useState(12);
  const [bg, setBg] = useState('#ffffff');
  const [cell, setCell] = useState(0); // 0 = 按原图自适应
  const [format, setFormat] = useState('jpeg');
  const [quality, setQuality] = useState(90);
  const [title, setTitle] = useState('拼接图');
  const [size, setSize] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);

  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const url = useMemo(
    () =>
      api.stitchUrl(ids, {
        columns,
        gap,
        bg,
        cell: cell || undefined,
        format,
        quality: format === 'png' ? undefined : quality,
        title,
      }),
    [ids, columns, gap, bg, cell, format, quality, title]
  );

  useEffect(() => {
    setLoading(true);
    setErr('');
    // 图被缓存（同一 URL 重新挂载）时不会再触发 onLoad，必须自己查一次：
    // 否则预览永远停在 35% 透明 + 转圈，看起来像没生成
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth) {
      setSize(`${el.naturalWidth}×${el.naturalHeight}`);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalBytes = items.reduce((n, i) => n + (i.sizeBytes || 0), 0);

  // 列数用分段按钮而不是滑杆：可选值本来就只有几个，拖动时数字一直跳很难对准
  const colOptions = useMemo(() => {
    const max = Math.max(1, Math.min(12, items.length));
    const out: number[] = [];
    for (let n = 1; n <= max; n++) out.push(n);
    return out;
  }, [items.length]);

  const swatches = ['#ffffff', '#000000', '#f2f2f7', '#1c1c22'];

  return (
    <div className="modal-backdrop tk-backdrop" onClick={onClose}>
      <div className="modal-card st-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>拼接图 / 联系表</b>
          <span className="tk-title">
            {items.length} 张 · 原图合计 {formatSize(totalBytes)}
            {size ? ` · 成品 ${size}` : ''}
          </span>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
            <IconClose />
          </button>
        </div>

        <div className="modal-body st-modal-body">
          <div className="st-body">
            <div className="st-stage">
              <div className="st-preview">
                {err ? (
                  <div className="tk-warn">{err}</div>
                ) : (
                  <img
                    ref={imgRef}
                    className="st-img"
                    src={url}
                    alt="拼接预览"
                    style={{ opacity: loading ? 0.35 : 1 }}
                    onLoad={(e) => {
                      const el = e.currentTarget;
                      setSize(`${el.naturalWidth}×${el.naturalHeight}`);
                      setLoading(false);
                    }}
                    onError={() => {
                      setErr('生成失败：可能包含损坏或非图片素材');
                      setLoading(false);
                    }}
                  />
                )}
                {loading && !err && <span className="spinner st-spin" />}
              </div>
              <div className="st-meta">
                <span>{items.length} 张</span>
                <span>原图 {formatSize(totalBytes)}</span>
                {size && <span className="st-meta-out">成品 {size}</span>}
                <span className="st-meta-tip">预览即导出结果</span>
              </div>
              <div className="st-order">
                <span className="st-order-label">顺序</span>
                <div className="st-picked">
                  {items.slice(0, 24).map((it, i) => (
                    <span className="st-pick" key={it.id} title={it.title}>
                      <img src={it.thumbUrl} alt="" loading="lazy" decoding="async" />
                      <i>{i + 1}</i>
                    </span>
                  ))}
                  {items.length > 24 && <span className="tk-hint">还有 {items.length - 24} 张…</span>}
                </div>
              </div>
            </div>

            <div className="st-side">
              <div className="st-group">
                <h5>文件</h5>
                <label className="st-field">
                  <span>文件名</span>
                  <input className="input" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
                </label>
              </div>

              <div className="st-group">
                <h5>版面</h5>
                <div className="st-row">
                  <span className="st-row-label">列数</span>
                  <div className="st-seg">
                    {colOptions.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={n === columns ? 'on' : ''}
                        onClick={() => setColumns(n)}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="st-field">
                  <span>
                    间距 <b>{gap}px</b>
                  </span>
                  <input
                    className="st-range"
                    type="range"
                    min={0}
                    max={64}
                    value={gap}
                    onChange={(e) => setGap(Number(e.target.value))}
                  />
                </label>
                <label className="st-field">
                  <span>
                    每格最长边 <b>{cell ? `${cell}px` : '自适应原图'}</b>
                  </span>
                  <input
                    className="st-range"
                    type="range"
                    min={0}
                    max={1200}
                    step={40}
                    value={cell}
                    onChange={(e) => setCell(Number(e.target.value))}
                  />
                </label>
              </div>

              <div className="st-group">
                <h5>外观</h5>
                <div className="st-row">
                  <span className="st-row-label">底色</span>
                  <div className="st-swatches">
                    {swatches.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`st-swatch${c.toLowerCase() === bg.toLowerCase() ? ' on' : ''}`}
                        style={{ background: c }}
                        title={c}
                        onClick={() => setBg(c)}
                      />
                    ))}
                    <label className="st-swatch st-swatch-custom" title="自定义颜色">
                      <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
                    </label>
                  </div>
                </div>
                <div className="st-row">
                  <span className="st-row-label">格式</span>
                  <div className="st-seg">
                    {(
                      [
                        ['jpeg', 'JPEG'],
                        ['png', 'PNG'],
                        ['webp', 'WebP'],
                      ] as const
                    ).map(([v, label]) => (
                      <button key={v} type="button" className={format === v ? 'on' : ''} onClick={() => setFormat(v)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {format !== 'png' && (
                  <div className="st-row">
                    <span className="st-row-label">质量</span>
                    <div className="st-seg">
                      {[95, 90, 82, 70].map((q) => (
                        <button
                          key={q}
                          type="button"
                          className={quality === q ? 'on' : ''}
                          onClick={() => setQuality(q)}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>
        </div>

        <div className="st-foot">
          <span className="tk-hint">最多 60 张；成品超过 20000px 会自动等比缩小。拼接只导出，不改原图。</span>
          <button
            className="btn primary"
            disabled={!ids.length}
            onClick={() => {
              downloadFile(url);
              onToast?.('已开始下载拼接图');
            }}
          >
            <IconDownload /> 下载拼接图
          </button>
        </div>
      </div>
    </div>
  );
}
