/**
 * 文件夹外观：emoji / 图标字符 + 主题色。
 *
 * Eagle 允许给文件夹上色、贴图标，侧栏一眼就能区分「设计稿 / 素材 / 归档」；
 * 这里做同一件事，只写 folders.icon / folders.color，不动磁盘目录。
 */
import { useState } from 'react';
import { api } from '../api';
import { useEscClose } from '../lib/useEscClose';
import type { FolderNode } from '../types';
import { IconClose } from './Icons';

const EMOJIS = [
  '📁', '📂', '🗂️', '🎨', '🖼️', '📷', '🎬', '🎵', '🔤', '🧊',
  '📐', '⭐', '🔥', '💡', '🧩', '🌸', '🐱', '🏷️', '📦', '🕹️',
];

const COLORS = [
  '#e05252', '#e08a3c', '#d9b53c', '#4ca64c', '#3c9ad9',
  '#6b5bd6', '#b45bd6', '#d65b9c', '#7a7a7a',
];

interface Props {
  folder: FolderNode;
  onClose: () => void;
  onSaved: (folders: FolderNode[]) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function FolderAppearanceDialog({ folder, onClose, onSaved, onToast }: Props) {
  const [icon, setIcon] = useState(folder.icon || '');
  const [color, setColor] = useState(folder.color || '');
  const [busy, setBusy] = useState(false);

  useEscClose(onClose);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.setFolderAppearance(folder.id, { icon, color });
      onSaved(r.folders);
      onToast(`已更新「${folder.name}」的外观`);
      onClose();
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>🎨 文件夹外观 · {folder.name}</b>
          <button className="btn ghost sm" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="appearance-preview">
            <span className="folder-icon" style={color ? { color } : undefined}>
              {icon || '📁'}
            </span>
            <span style={color ? { color } : undefined}>{folder.name}</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
              {folder.total || 0} 张
            </span>
          </div>

          <div className="field" style={{ marginBottom: 14 }}>
            <label>图标 / emoji</label>
            <div className="emoji-grid" style={{ marginBottom: 8 }}>
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`emoji-cell${icon === e ? ' on' : ''}`}
                  onClick={() => setIcon(icon === e ? '' : e)}
                  title={icon === e ? '再点一次清除' : '用这个图标'}
                >
                  {e}
                </button>
              ))}
            </div>
            <input
              className="input"
              style={{ width: '100%' }}
              value={icon}
              maxLength={4}
              placeholder="也可以直接输入一个字符（留空 = 显示封面缩略图）"
              onChange={(e) => setIcon(e.target.value)}
            />
          </div>

          <div className="field">
            <label>主题色</label>
            <div className="color-swatches">
              <button
                type="button"
                className={`color-swatch clear${color ? '' : ' on'}`}
                onClick={() => setColor('')}
                title="跟随主题（清除颜色）"
              >
                ✕
              </button>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch${color === c ? ' on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  title={c}
                />
              ))}
              <input
                type="color"
                className="input"
                style={{ width: 42, height: 26, padding: 0, border: 'none', background: 'transparent' }}
                value={color || '#3c9ad9'}
                onChange={(e) => setColor(e.target.value)}
                title="自定义颜色"
              />
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>只改库里的展示，不动磁盘目录名</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
