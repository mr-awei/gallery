/**
 * 批量创建：一行一个名字，一次建一批文件夹或标签。
 * Eagle 里整理素材经常要「先铺好分类」——逐个新建太慢，这里支持换行 / 逗号分隔。
 */
import { useState } from 'react';
import { api } from '../api';
import { useEscClose } from '../lib/useEscClose';
import type { FolderNode, TagNode } from '../types';
import { IconClose } from './Icons';
import i18n from '../i18n';

interface Props {
  /** folder = 建文件夹；tag = 建标签 */
  mode: 'folder' | 'tag';
  /** 文件夹：父夹（null = 根级）；标签：所属分组 */
  parentId?: number | null;
  group?: string;
  parentName?: string;
  onClose: () => void;
  onFolders?: (folders: FolderNode[]) => void;
  onTags?: (r: { tags: TagNode[]; groups: string[] }) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function BatchCreateDialog({
  mode,
  parentId = null,
  group = '',
  parentName = '',
  onClose,
  onFolders,
  onTags,
  onToast,
}: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEscClose(onClose);

  const names = text
    .split(/[\r\n,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const submit = async () => {
    if (!names.length) return onToast(i18n.t('k7ccfbeee'));
    setBusy(true);
    try {
      if (mode === 'folder') {
        const r = await api.createFoldersBatch(names, parentId);
        onFolders?.(r.folders);
        const skipped = r.skipped?.length ? i18n.t('ke27e796f', { p0: r.skipped.length }) : '';
        onToast(i18n.t('ka44d4cd3', { p0: r.created.length, p1: skipped }));
      } else {
        const r = await api.createTagsBatch(names, group || undefined);
        onTags?.({ tags: r.tags, groups: r.groups });
        onToast(i18n.t('k007ec734', { p0: r.created.length, p1: group ? i18n.t('k6ac40686', { p0: group }) : '' }));
      }
      onClose();
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            {mode === 'folder' ? i18n.t('kc06d4a24') : i18n.t('k915b34b4')}
            {mode === 'folder' && parentName ? i18n.t('k2ea1da2e', { p0: parentName }) : ''}
          </b>
          <button className="btn ghost sm" onClick={onClose} title={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="field">
            <label>{i18n.t('kb3abc1d8')}</label>
            <textarea
              className="input"
              style={{ width: '100%', minHeight: 150, resize: 'vertical', fontFamily: 'inherit' }}
              value={text}
              autoFocus
              placeholder={mode === 'folder' ? i18n.t('k89a0f76e') : i18n.t('k3067ae3b')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          <div className="qc-hint">
            {mode === 'folder'
              ? i18n.t('k750d84c3')
              : i18n.t('kabf21169')}
            当前将创建 <b>{names.length}</b> {i18n.t('k23562975')}
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i18n.t('k0daa3ca7')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              {i18n.t('k625fb26b')}
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy || !names.length}
              onClick={() => void submit()}
            >
              {busy ? i18n.t('kd156b373') : i18n.t('k8da9e6ab', { p0: names.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
