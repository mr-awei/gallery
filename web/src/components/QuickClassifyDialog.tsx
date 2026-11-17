/**
 * 快速分类（快捷键 F）：选中一批素材后，不用离开网格就能「放进文件夹 + 打标签」。
 *
 * Eagle 的手感是按一下键、鼠标走两下就分完类；这里把最常用的两个动作放在同一个面板：
 * 文件夹（单选，整批一起进）+ 标签（逗号分隔，逐个追加，不清空原有标签）。
 */
import { useMemo, useState } from 'react';
import { api } from '../api';
import { useEscClose } from '../lib/useEscClose';
import type { FolderNode } from '../types';
import { IconClose } from './Icons';
import { IconZap } from './Icons';
import i18n from '../i18n';

interface Props {
  ids: number[];
  folders: FolderNode[];
  currentFolderId?: number | null;
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function QuickClassifyDialog({ ids, folders, currentFolderId, onClose, onDone, onToast }: Props) {
  const [folderId, setFolderId] = useState<number | null>(currentFolderId ?? null);
  const [keyword, setKeyword] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  useEscClose(onClose);

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const byParent = new Map<number | null, FolderNode[]>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      const arr = byParent.get(key) || [];
      arr.push(f);
      byParent.set(key, arr);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }
    const out: { f: FolderNode; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const f of byParent.get(parent) || []) {
        const hit = !kw || f.name.toLowerCase().includes(kw);
        // 命中子夹时父夹也保留（否则树断开，看不出它属于哪里）
        if (hit) out.push({ f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders, keyword]);

  const submit = async () => {
    const tagList = tags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t, i, a) => a.indexOf(t) === i);
    if (!folderId && !tagList.length) return onToast(i18n.t('k6191b652'));
    setBusy(true);
    try {
      let added = 0;
      if (folderId) {
        const r = await api.addToFolder(folderId, ids);
        added = r.added;
      }
      for (const t of tagList) await api.batch(ids, 'addTag', t);
      const parts = [];
      if (folderId) parts.push(i18n.t('k59e83a62', { p0: added }));
      if (tagList.length) parts.push(i18n.t('k82182597', { p0: tagList.length }));
      onToast(i18n.t('k0f14e17e', { p0: ids.length, p1: parts.join('、') }));
      onDone();
      onClose();
    } catch (err) {
      onToast((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b><IconZap size={14} /> 快速分类 · {ids.length} 张</b>
          <button className="btn ghost sm" onClick={onClose} title={i18n.t('k01aadfea')}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div className="qc-section">
            <h4>{i18n.t('kf7fdd8a0')}</h4>
            <input
              className="input"
              style={{ width: '100%', marginBottom: 8 }}
              placeholder={i18n.t('k6bbbc182')}
              value={keyword}
              autoFocus
              onChange={(e) => setKeyword(e.target.value)}
            />
            <div className="qc-chips">
              <button
                className={`qc-chip${folderId === null ? ' on' : ''}`}
                onClick={() => setFolderId(null)}
                title={i18n.t('k389f658e')}
              >
                {i18n.t('kf890fc93')}
              </button>
              {list.map(({ f, depth }) => (
                <button
                  key={f.id}
                  className={`qc-chip${folderId === f.id ? ' on' : ''}`}
                  style={{ marginLeft: depth ? 8 : 0 }}
                  onClick={() => setFolderId(folderId === f.id ? null : f.id)}
                  title={i18n.t('k7b65ed56', { p0: f.name, p1: f.total || 0 })}
                >
                  {f.icon ? `${f.icon} ` : ''}
                  {f.name}
                </button>
              ))}
              {!list.length && <span className="qc-hint">{i18n.t('k6b461729')}</span>}
            </div>
          </div>

          <div className="qc-section">
            <h4>{i18n.t('kd6f2f5ed')}</h4>
            <input
              className="input"
              style={{ width: '100%' }}
              placeholder={i18n.t('k187faea1')}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            <div className="qc-hint" style={{ marginTop: 6 }}>
              {i18n.t('k7ded9ecc')}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i18n.t('k2999a44f')}</span>
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
              {busy ? i18n.t('k9a6c9650') : i18n.t('k5b0520a9')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
