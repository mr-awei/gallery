import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, downloadFile, exportImageUrl, exportZipUrl, formatSize } from '../api';
import type { ImageItem } from '../types';
import { IconClose } from './Icons';
import i18n from '../i18n';

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
  { key: 'jpeg', label: 'JPEG', note: i18n.t('k08f88e16') },
  { key: 'png', label: 'PNG', note: i18n.t('k6c43040c') },
  { key: 'webp', label: 'WebP', note: i18n.t('kc1bf7ca1') },
  { key: 'avif', label: 'AVIF', note: i18n.t('k59de65f2') },
];
const QUALITIES = [100, 95, 90, 82];
const SIDES = [
  { v: 0, l: i18n.t('k21f3929a') },
  { v: 4096, l: i18n.t('k1b520a63') },
  { v: 2048, l: i18n.t('k379265ce') },
  { v: 1024, l: i18n.t('k292f7fcc') },
  { v: 512, l: i18n.t('kb915080b') },
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
      return maxSide ? i18n.t('kaa7763ca', { p0: list!.length, p1: maxSide }) : i18n.t('k540b88c9', { p0: list!.length });
    }
    const w = item?.width || 0;
    const h = item?.height || 0;
    if (!maxSide || Math.max(w, h) <= maxSide) return `${w} × ${h}`;
    const k = maxSide / Math.max(w, h);
    return i18n.t('kf336f851', { p0: Math.round(w * k), p1: Math.round(h * k), p2: w, p3: h });
  }, [batch, list, item?.width, item?.height, maxSide]);

  const go = async () => {
    setBusy(true);
    try {
      await downloadFile(url);
      onToast?.(batch ? i18n.t('k73c6336d', { p0: list!.length }) : i18n.t('k02386ca9'));
      onClose();
    } catch (err) {
      onToast?.(i18n.t('k246e218d', { p0: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  // 传送到 body：开在大图预览里时不能继承 .lightbox 的深色浮层变量（否则白卡片白字）
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
      <div className="modal-card exp-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{batch ? i18n.t('k7308e29b', { p0: list!.length }) : i18n.t('k0130accd')}</b>
          <button className="icon-btn" onClick={onClose} title={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body exp-body">
          {batch ? (
            <div className="exp-batch-thumb" aria-hidden>
              {list!.length}
              <span>{i18n.t('k6499fc74')}</span>
            </div>
          ) : (
            item && <img src={item.thumbUrl || item.url} alt="" loading="lazy" decoding="async" />
          )}
          <div className="exp-form">
            <div className="exp-field">
              <label>{i18n.t('ke3127cc1')}</label>
              <div className="exp-chips">
                {batch && (
                  <button
                    className={`exp-chip${format === '' ? ' on' : ''}`}
                    title={i18n.t('k959afe84')}
                    onClick={() => setFormat('')}
                  >
                    {i18n.t('k8392fec0')}
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
              <label>{i18n.t('k3a7170b9')}</label>
              <div className="exp-chips">
                {Qs.map((q) => (
                  <button
                    key={q}
                    className={`exp-chip${quality === q ? ' on' : ''}`}
                    disabled={!lossy}
                    title={lossy ? i18n.t('k5e4bc6df') : i18n.t('k62de648c')}
                    onClick={() => setQuality(q)}
                  >
                    {q}
                  </button>
                ))}
                {!lossy && <span className="exp-hint">{format === 'png' ? i18n.t('kdaa0d585') : i18n.t('k6b82cb61')}</span>}
              </div>
            </div>
            <div className="exp-field">
              <label>{i18n.t('kc8339fd2')}</label>
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
              {!batch && item ? i18n.t('k8f1ad508', { p0: formatSize(item.sizeBytes) }) : ''}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="exp-hint">{batch ? i18n.t('k624a347a') : i18n.t('k2888feec')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm ghost" onClick={onClose}>
              {i18n.t('k625fb26b')}
            </button>
            <button className="btn sm primary" disabled={busy} onClick={go}>
              {busy ? i18n.t('k86f99e94') : batch ? i18n.t('kf71a15e9') : i18n.t('k55405ea6')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
