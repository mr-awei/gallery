import { IconPalette } from './Icons';
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
import i18n from '../i18n';

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
      onToast(i18n.t('kf7f7145c', { p0: folder.name }));
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
          <b><IconPalette size={14} /> 文件夹外观 · {folder.name}</b>
          <button className="btn ghost sm" onClick={onClose} title={i18n.t('kb15d9127')}>
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
            <label>{i18n.t('kbc16aaa0')}</label>
            <div className="emoji-grid" style={{ marginBottom: 8 }}>
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`emoji-cell${icon === e ? ' on' : ''}`}
                  onClick={() => setIcon(icon === e ? '' : e)}
                  title={icon === e ? i18n.t('k654a6ff1') : i18n.t('kd16c6047')}
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
              placeholder={i18n.t('kf928d9c4')}
              onChange={(e) => setIcon(e.target.value)}
            />
          </div>

          <div className="field">
            <label>{i18n.t('kb47707f0')}</label>
            <div className="color-swatches">
              <button
                type="button"
                className={`color-swatch clear${color ? '' : ' on'}`}
                onClick={() => setColor('')}
                title={i18n.t('k06a78f0d')}
              >
                <IconClose size={14} />
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
                title={i18n.t('k255f442c')}
              />
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i18n.t('kbb2d06b7')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              {i18n.t('k625fb26b')}
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? i18n.t('k9b5d32d1') : i18n.t('kbe5fbbe3')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
