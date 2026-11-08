/**
 * 文件夹卡片（Eagle 式）：图库顶上把当前层级的子文件夹摆成一排卡片。
 *
 * 侧栏树只显示「图标 / 颜色 / 数量」，看不到封面；文件夹卡片把封面、emoji、主题色、
 * 张数一次呈现，点卡片进入，拖图到卡片上直接归档。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { FolderNode } from '../types';
import { IMAGE_MIME } from '../lib/dnd';

interface Props {
  folders: FolderNode[];
  /** 当前所在文件夹；null = 根级 */
  folderId: number | null;
  onOpenFolder: (id: number) => void;
  /** 拖图到文件夹卡片上 = 把这批图归入该夹 */
  onDropImages?: (folderId: number, ids: number[]) => void;
}

const COLLAPSE_KEY = 'tuku:folder-cards:open';

export default function FolderCards({ folders, folderId, onOpenFolder, onDropImages }: Props) {
  const [open, setOpen] = useState(() => localStorage.getItem(COLLAPSE_KEY) !== '0');
  const [overId, setOverId] = useState<number | null>(null);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, open ? '1' : '0');
  }, [open]);

  const children = folders
    .filter((f) => (f.parent_id ?? null) === (folderId ?? null))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  if (!children.length) return null;

  return (
    <div className="folder-cards">
      <div className="folder-cards-head">
        <button className="folder-cards-toggle" onClick={() => setOpen((v) => !v)} title={open ? '收起文件夹' : '展开文件夹'}>
          {open ? '▾' : '▸'} 文件夹 · {children.length}
        </button>
        {open && onDropImages && <span className="folder-cards-hint">把图片拖到文件夹卡片上即可归档</span>}
      </div>
      {open && (
        <div className="folder-cards-grid">
          {children.map((f) => (
            <div
              key={f.id}
              className={`folder-card${overId === f.id ? ' drop' : ''}`}
              style={f.color ? ({ '--fc': f.color } as CSSProperties) : undefined}
              title={`${f.name}（${f.total} 张）`}
              data-folder-id={f.id}
              onClick={() => onOpenFolder(f.id)}
              onDragOver={(e) => {
                if (!onDropImages || !e.dataTransfer.types.includes(IMAGE_MIME)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                if (overId !== f.id) setOverId(f.id);
              }}
              onDragLeave={() => setOverId(null)}
              onDrop={(e) => {
                setOverId(null);
                if (!onDropImages) return;
                const raw = e.dataTransfer.getData(IMAGE_MIME);
                if (!raw) return;
                e.preventDefault();
                e.stopPropagation();
                const ids = raw
                  .split(',')
                  .map((s) => Number(s))
                  .filter((n) => Number.isFinite(n) && n > 0);
                if (ids.length) onDropImages(f.id, ids);
              }}
            >
              <div className="folder-card-cover">
                {f.cover?.thumbUrl ? (
                  <img src={f.cover.thumbUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="folder-card-empty">{f.icon || '📁'}</span>
                )}
                {f.icon && f.cover?.thumbUrl && <span className="folder-card-emoji">{f.icon}</span>}
                <span className="folder-card-count">{f.total}</span>
              </div>
              <div className="folder-card-name">
                {f.color && <span className="folder-card-dot" style={{ background: f.color }} />}
                {f.name}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
