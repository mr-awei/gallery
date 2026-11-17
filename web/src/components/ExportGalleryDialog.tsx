/**
 * 导出为 HTML 网页画廊。
 * 产物是单个 .html：缩略图 base64 内嵌，双击就能看，发给别人也不缺图。
 */
import { useState } from 'react';
import { downloadFile, galleryExportUrl } from '../api';
import { IconClose, IconDownload } from './Icons';
import i18n from '../i18n';

interface Props {
  /** 默认标题：当前库名 / 文件夹名 */
  defaultTitle: string;
  /** 当前文件夹（可选，用于「导出当前文件夹」） */
  folderId?: number | null;
  folderName?: string;
  /** 当前选中项（有值时提供「只导出选中」） */
  selectedIds?: number[];
  onClose: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

type Scope = 'all' | 'folder' | 'selection';

export default function ExportGalleryDialog({
  defaultTitle,
  folderId,
  folderName,
  selectedIds,
  onClose,
  onToast,
}: Props) {
  const hasSelection = !!selectedIds?.length;
  const [scope, setScope] = useState<Scope>(folderId ? 'folder' : hasSelection ? 'selection' : 'all');
  const [title, setTitle] = useState(() => {
    if (folderId && folderName) return folderName;
    if (hasSelection) return i18n.t('kb8cb189a', { p0: defaultTitle });
    return defaultTitle || i18n.t('kaac7495c');
  });
  const [columns, setColumns] = useState(4);
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');
  const [maxItems, setMaxItems] = useState(200);

  const run = () => {
    const url = galleryExportUrl({
      scope: scope === 'folder' ? 'folder' : 'all',
      folderId: scope === 'folder' ? folderId : null,
      ids: scope === 'selection' ? selectedIds : undefined,
      title: title.trim() || i18n.t('kaac7495c'),
      columns,
      theme,
      maxItems,
    });
    void downloadFile(url);
    onToast(i18n.t('kff9da3a0'));
    onClose();
  };

  const scopes: { key: Scope; label: string; hint: string }[] = [
    { key: 'all', label: i18n.t('k46bd07d6'), hint: i18n.t('kda7d7986', { p0: maxItems }) },
    ...(folderId ? [{ key: 'folder' as Scope, label: i18n.t('k1f9ea1b1'), hint: folderName || i18n.t('kb3d59989') }] : []),
    ...(hasSelection
      ? [{ key: 'selection' as Scope, label: i18n.t('kff8fd594', { p0: selectedIds!.length }), hint: i18n.t('k7c742355') }]
      : []),
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            <IconDownload /> {i18n.t('k02b428e3')}
          </b>
          <button className="btn ghost sm" onClick={onClose} title={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--muted)', marginBottom: 14 }}>
            {i18n.t('k6bf78f52')}
          </div>

          <div className="field">
            <label>{i18n.t('kdf011658')}</label>
            <div className="export-scope">
              {scopes.map((s) => (
                <label key={s.key} className={`export-scope-item${scope === s.key ? ' active' : ''}`}>
                  <input
                    type="radio"
                    name="gallery-scope"
                    checked={scope === s.key}
                    onChange={() => setScope(s.key)}
                  />
                  <span>
                    <b>{s.label}</b>
                    <i>{s.hint}</i>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label>{i18n.t('k32c65d8d')}</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={title}
              maxLength={60}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={i18n.t('k7427f3aa')}
            />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>{i18n.t('k9fde92a5')}</label>
              <select className="input" value={columns} onChange={(e) => setColumns(Number(e.target.value))}>
                {[2, 3, 4, 5, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} 列
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{i18n.t('k9ad79adf')}</label>
              <select
                className="input"
                value={theme}
                onChange={(e) => setTheme(e.target.value as 'auto' | 'light' | 'dark')}
              >
                <option value="auto">{i18n.t('k71bbc726')}</option>
                <option value="dark">{i18n.t('kadb7e531')}</option>
                <option value="light">{i18n.t('ka32b3b84')}</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{i18n.t('k726bfbe8')}</label>
              <select className="input" value={maxItems} onChange={(e) => setMaxItems(Number(e.target.value))}>
                {[50, 100, 200, 500].map((n) => (
                  <option key={n} value={n}>
                    {n} 张
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i18n.t('k01cfc47c')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              {i18n.t('k625fb26b')}
            </button>
            <button
              className="btn primary"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              onClick={run}
            >
              <IconDownload /> {i18n.t('k55405ea6')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
