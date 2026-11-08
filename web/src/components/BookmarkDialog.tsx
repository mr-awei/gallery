/**
 * 保存网页：粘一个网址 → 抓标题/描述/封面 + 存离线快照。
 * 入口在顶栏（和剪贴板/拖拽并列的第三种「收集」方式）。
 */
import { useState } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import { IconClose, IconLink } from './Icons';

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
    if (!u) return onToast('先粘一个网址');
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
      onToast(r.item?.width ? '已保存网页（含封面和离线快照）' : '已保存网页（这个页面没有封面图）');
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
            <IconLink /> 保存网页
          </b>
          <button className="btn ghost sm" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'block' }}>
          <div style={{ marginBottom: 14, fontSize: 13, lineHeight: 1.7, color: 'var(--muted)' }}>
            存下标题、简介、封面图和一份离线 HTML 快照。网页以后改版或删掉，快照还在库里。
          </div>

          <div className="field">
            <label>网址</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={url}
              placeholder="粘贴网址，例如 https://www.behance.net/…"
              autoFocus
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="field">
            <label>标签（可选，空格或逗号分隔）</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={tags}
              placeholder="灵感 参考"
              onChange={(e) => setTags(e.target.value)}
            />
          </div>

          <div className="field">
            <label>备注（可选）</label>
            <input
              className="input"
              style={{ width: '100%' }}
              value={note}
              placeholder="为什么存它"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>抓取失败时会提示原因，不会留下空记录</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              className="btn"
              style={{ background: 'var(--accent)', borderColor: 'transparent', color: '#fff' }}
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? '抓取中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
