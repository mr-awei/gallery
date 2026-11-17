/**
 * 保存网页：粘一个网址 → 抓标题/描述/封面 + 存离线快照。
 * 入口在顶栏（和剪贴板/拖拽并列的第三种「收集」方式）。
 */
import { useState } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import { IconClose, IconLink } from './Icons';
import i18n from '../i18n';

interface Props {
  onClose: () => void;
  onSaved: (item: ImageItem) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function BookmarkDialog({ onClose, onSaved, onToast }: Props) {
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const u = url.trim();
    if (!u) return onToast(i18n.t('k33832557'));
    setBusy(true);
    try {
      const r = await api.saveBookmark({
        url: u,
        tags: tags
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        note: note.trim(),
      });
      onToast(r.item?.width ? i18n.t('kff795b05') : i18n.t('k3ec98963'));
      onSaved(r.item);
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName === 'INPUT') void submit();
        }}
      >
        <div className="modal-head">
          <b>
            <IconLink /> {i18n.t('k597224e6')}
          </b>
          <button className="btn ghost sm" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div style={{ marginBottom: 14, fontSize: 13, lineHeight: 1.7, color: 'var(--muted)' }}>
            {i18n.t('kb417ae7f')}
          </div>

          <div className="field">
            <label>{i18n.t('kb3b91f77')}</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={url}
              placeholder={i18n.t('kf0b80a6b')}
              autoFocus
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="field">
            <label>{i18n.t('kb8322a8f')}</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={tags}
              placeholder={i18n.t('k42d18bd1')}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>

          <div className="field">
            <label>{i18n.t('k67f6a89e')}</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={note}
              placeholder={i18n.t('k0005597b')}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i18n.t('k08278d08')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              {i18n.t('k625fb26b')}
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? i18n.t('ked8c7720') : i18n.t('kbe5fbbe3')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
