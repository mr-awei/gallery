import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, downloadFile, exportImageUrl, exportZipUrl, formatSize } from '../api';
import type { ImageItem } from '../types';
import { IconClose } from './Icons';

/**
 * 导出为图片（对标 Eagle「导出」）：格式 / 质量 / 最长边。
 * - 单张：服务端按需用 sharp 重编码，不落临时文件，桌面端会自动弹「另存为」。
 * - 多张（传 ids）：打包成 zip，逐张按同样参数重编码；选「保持原格式」则原样打包。
 */
interface Props {
  /** 单张导出时的图片 */
  item?: ImageItem;
  /** 批量导出时的图片 id 列表（优先于 item） */
  ids?: number[];
  onClose: () => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

const FORMATS = [
  { key: 'jpeg', label: 'JPEG', note: '体积小，适合分享' },
  { key: 'png', label: 'PNG', note: '无损，透明图首选' },
  { key: 'webp', label: 'WebP', note: '同画质更小' },
  { key: 'avif', label: 'AVIF', note: '压缩率最高' },
];
const QUALITIES = [95, 90, 82, 70];
const SIDES = [
  { v: 0, l: '原始尺寸' },
  { v: 4096, l: '最长边 4096' },
  { v: 2048, l: '最长边 2048' },
  { v: 1024, l: '最长边 1024' },
  { v: 512, l: '最长边 512' },
];

export default function ExportDialog({ item, ids, onClose, onToast }: Props) {
  const list = ids && ids.length ? ids : null;
  const batch = !!list;
  const [format, setFormat] = useState(batch ? '' : 'jpeg');
  const [quality, setQuality] = useState(90);
  const [maxSide, setMaxSide] = useState(0);
  const [busy, setBusy] = useState(false);

  // 格式 / 质量 / 尺寸候选来自服务端单一来源（/api/export/options），避免前端硬编码与后端漂移；
  // 拉取失败则回退到下面这组内置默认值，导出功能不至于整体不可用。
  const [opts, setOpts] = useState<{
    formats: { key: string; label: string; ext: string; note: string }[];
    qualities: number[];
    maxSides: number[];
  } | null>(null);
  useEffect(() => {
    api.exportOptions().then(setOpts).catch(() => {});
  }, []);
  const Fs = opts?.formats || FORMATS;
  const Qs = opts?.qualities || QUALITIES;
  // 尺寸档位是稳定的展示文案，保留前端硬编码；只有格式 / 质量这类可能随后端演化的才走服务端
  const Ss = SIDES;

  const url = useMemo(() => {
    if (list) return exportZipUrl(list, { format: format || undefined, quality, maxSide });
    return exportImageUrl(item?.id ?? 0, { format: format || 'jpeg', quality, maxSide });
  }, [list, item?.id, format, quality, maxSide]);

  const lossy = format !== 'png' && format !== '';
  const outSize = useMemo(() => {
    if (batch) {
      return maxSide ? `共 ${list!.length} 张 · 最长边限制 ${maxSide}` : `共 ${list!.length} 张 · 保持原始尺寸`;
    }
    const w = item?.width || 0;
    const h = item?.height || 0;
    if (!maxSide || Math.max(w, h) <= maxSide) return `${w} × ${h}`;
    const k = maxSide / Math.max(w, h);
    return `${Math.round(w * k)} × ${Math.round(h * k)}（原 ${w} × ${h}）`;
  }, [batch, list, item?.width, item?.height, maxSide]);

  const go = async () => {
    setBusy(true);
    try {
      await downloadFile(url);
      onToast?.(batch ? `已开始打包导出 ${list!.length} 张` : '已开始导出');
      onClose();
    } catch (err) {
      onToast?.(`导出失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 传送到 body：开在大图预览里时不能继承 .lightbox 的深色浮层变量（否则白卡片白字）
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
      <div className="modal-card exp-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{batch ? `批量导出 ${list!.length} 张` : '导出图片'}</b>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
        <div className="modal-body exp-body">
          {batch ? (
            <div className="exp-batch-thumb" aria-hidden>
              {list!.length}
              <span>张</span>
            </div>
          ) : (
            item && <img src={item.thumbUrl || item.url} alt="" loading="lazy" decoding="async" />
          )}
          <div className="exp-form">
            <div className="exp-field">
              <label>格式</label>
              <div className="exp-chips">
                {batch && (
                  <button
                    className={`exp-chip${format === '' ? ' on' : ''}`}
                    title="不重新编码，直接打包原文件（最快，画质零损失）"
                    onClick={() => setFormat('')}
                  >
                    保持原格式
                  </button>
                )}
                {Fs.map((f) => (
                  <button key={f.key} className={`exp-chip${format === f.key ? ' on' : ''}`} title={f.note} onClick={() => setFormat(f.key)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="exp-field">
              <label>质量</label>
              <div className="exp-chips">
                {Qs.map((q) => (
                  <button
                    key={q}
                    className={`exp-chip${quality === q ? ' on' : ''}`}
                    disabled={!lossy}
                    title={lossy ? '数值越高画质越好、体积越大' : 'PNG / 原格式无需设置质量'}
                    onClick={() => setQuality(q)}
                  >
                    {q}
                  </button>
                ))}
                {!lossy && <span className="exp-hint">{format === 'png' ? 'PNG 无损，忽略此项' : '保持原格式时忽略此项'}</span>}
              </div>
            </div>
            <div className="exp-field">
              <label>尺寸</label>
              <div className="exp-chips">
                {Ss.map((s) => (
                  <button key={s.v} className={`exp-chip${maxSide === s.v ? ' on' : ''}`} onClick={() => setMaxSide(s.v)}>
                    {s.l}
                  </button>
                ))}
              </div>
            </div>
            <div className="exp-hint">
              输出 {outSize}
              {!batch && item ? ` · 源文件 ${formatSize(item.sizeBytes)}` : ''}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="exp-hint">{batch ? '打包成 zip 下载，不改动原文件' : '导出不改动原图，可放心试不同格式'}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn sm primary" disabled={busy} onClick={go}>
              {busy ? '导出中…' : batch ? '打包导出' : '导出'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
