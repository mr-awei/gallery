/**
 * 选文件夹封面：从夹内（含子夹）的素材里挑一张。
 * Eagle 的封面是「演示性质」的——没手动设置时用夹内最新一张，这里保留同样的兜底。
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { FolderNode, ImageItem } from '../types';
import { IconClose } from './Icons';

interface Props {
  folder: FolderNode;
  onClose: () => void;
  onSaved: (folders: FolderNode[], msg: string) => void;
  onToast: (msg: string) => void;
}

export default function FolderCoverDialog({ folder, onClose, onSaved, onToast }: Props) {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    api
      .folderImages(folder.id, 1, 60, { signal: ctrl.signal })
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch(() => {
        /* 取消或失败：保持空列表 */
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [folder.id]);

  const apply = async (imageId: number | null) => {
    setBusy(true);
    try {
      const r = await api.setFolderCover(folder.id, imageId);
      onSaved(r.folders, imageId ? '已设为文件夹封面' : '已恢复自动封面（夹内最新一张）');
      onClose();
    } catch (err) {
      onToast((err as Error).message);
      setBusy(false);
    }
  };

  const currentId = folder.cover?.imageId || null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>「{folder.name}」的封面</b>
          <button className="btn ghost sm" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--muted)', marginBottom: 12 }}>
            点一张图设为封面。不手动设置时，侧栏会自动用这个夹里最新的一张
            {total > items.length ? `（这里只列出最新 ${items.length} 张，共 ${total} 张）` : ''}。
          </div>

          {loading ? (
            <div className="muted small" style={{ padding: 24 }}>
              读取中…
            </div>
          ) : items.length ? (
            <div className="cover-pick-grid">
              {items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={`cover-pick${currentId === it.id ? ' active' : ''}`}
                  disabled={busy}
                  title={it.title || `#${it.id}`}
                  onClick={() => void apply(it.id)}
                >
                  <img src={it.thumbUrl} alt={it.title} loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          ) : (
            <div className="muted small" style={{ padding: 24 }}>
              这个文件夹还没有素材，先往里面加几张再挑封面。
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" disabled={busy} onClick={() => void apply(null)}>
            恢复自动封面
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
