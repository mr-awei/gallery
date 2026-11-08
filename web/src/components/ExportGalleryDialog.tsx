/**
 * 导出为 HTML 网页画廊。
 * 产物是单个 .html：缩略图 base64 内嵌，双击就能看，发给别人也不缺图。
 */
import { useState } from 'react';
import { downloadFile, galleryExportUrl } from '../api';
import { IconClose, IconDownload } from './Icons';

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
    if (hasSelection) return `${defaultTitle} · 精选`;
    return defaultTitle || '图库画廊';
  });
  const [columns, setColumns] = useState(4);
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');
  const [maxItems, setMaxItems] = useState(200);

  const run = () => {
    const url = galleryExportUrl({
      scope: scope === 'folder' ? 'folder' : 'all',
      folderId: scope === 'folder' ? folderId : null,
      ids: scope === 'selection' ? selectedIds : undefined,
      title: title.trim() || '图库画廊',
      columns,
      theme,
      maxItems,
    });
    void downloadFile(url);
    onToast('正在生成 HTML 画廊：图片内嵌，文件会大一些');
    onClose();
  };

  const scopes: { key: Scope; label: string; hint: string }[] = [
    { key: 'all', label: '全库最新', hint: `按入库时间倒序，最多 ${maxItems} 张` },
    ...(folderId ? [{ key: 'folder' as Scope, label: '当前文件夹', hint: folderName || '含子文件夹' }] : []),
    ...(hasSelection
      ? [{ key: 'selection' as Scope, label: `已选 ${selectedIds!.length} 张`, hint: '只导出选中的素材' }]
      : []),
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            <IconDownload /> 导出为 HTML 画廊
          </b>
          <button className="btn ghost sm" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--muted)', marginBottom: 14 }}>
            生成一个单文件网页：缩略图、标题、标签、尺寸全内嵌，可离线打开，也可以直接丢到静态站点当作品集。
          </div>

          <div className="field">
            <label>范围</label>
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
            <label>标题</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={title}
              maxLength={60}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：2026 春季选品"
            />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>每行张数</label>
              <select className="input" value={columns} onChange={(e) => setColumns(Number(e.target.value))}>
                {[2, 3, 4, 5, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} 列
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>配色</label>
              <select
                className="input"
                value={theme}
                onChange={(e) => setTheme(e.target.value as 'auto' | 'light' | 'dark')}
              >
                <option value="auto">跟随系统</option>
                <option value="dark">暗色</option>
                <option value="light">亮色</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>上限</label>
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
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>桌面端会弹「另存为」，浏览器里直接下载</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button
              className="btn primary"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              onClick={run}
            >
              <IconDownload /> 导出
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
