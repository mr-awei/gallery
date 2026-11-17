import { IconClose } from './Icons';
import { useEffect, useState } from 'react';
import { api, formatDate } from '../api';
import type { ImageComment } from '../types';
import i18n from '../i18n';

/** 图上评论（对标 Eagle 的 Annotations 里「评论」部分）：按时间正序，可删除 */
interface Props {
  imageId: number;
  onCount?: (n: number) => void;
  onClose: () => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

export default function CommentsPanel({ imageId, onCount, onClose, onToast }: Props) {
  const [list, setList] = useState<ImageComment[]>([]);
  const [body, setBody] = useState('');
  const [author, setAuthor] = useState(() => localStorage.getItem('tuku:author') || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .comments(imageId)
      .then((r) => {
        if (cancelled) return;
        setList(r.comments);
        onCount?.(r.comments.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      localStorage.setItem('tuku:author', author.trim());
      const r = await api.addComment(imageId, text, author.trim());
      setList((l) => [...l, r.comment]);
      onCount?.([...list, r.comment].length);
      setBody('');
    } catch (err) {
      onToast?.(i18n.t('k283aa40b', { p0: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.deleteComment(id);
      const next = list.filter((c) => c.id !== id);
      setList(next);
      onCount?.(next.length);
    } catch (err) {
      onToast?.(i18n.t('k94229cac', { p0: (err as Error).message }));
    }
  };

  return (
    <div className="cmt-panel" onClick={(e) => e.stopPropagation()}>
      <div className="cmt-head">
        <b>评论 · {list.length}</b>
        <button className="btn sm ghost" onClick={onClose} title={i18n.t('kddf26bba')}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="cmt-list">
        {!list.length && <div className="cmt-empty">{i18n.t('k61b100b8')}</div>}
        {list.map((c) => (
          <div key={c.id} className="cmt-item">
            <div className="cmt-meta">
              <b>{c.author || i18n.t('k1a75c1c8')}</b>
              <span>{c.createdAt ? formatDate(c.createdAt) : ''}</span>
              <button className="cmt-del" onClick={() => remove(c.id)} title={i18n.t('k5b8542ce')}>
                ×
              </button>
            </div>
            <div className="cmt-body">{c.body}</div>
          </div>
        ))}
      </div>

      <div className="cmt-compose">
        <input
          className="input"
          style={{ width: 96, padding: '4px 9px', fontSize: 12 }}
          placeholder={i18n.t('k4f64c69f')}
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
        />
        <textarea
          className="input cmt-textarea"
          placeholder={i18n.t('kc64e0471')}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="btn sm primary" disabled={busy || !body.trim()} onClick={submit}>
          {busy ? i18n.t('k08815707') : i18n.t('k7451eb17')}
        </button>
      </div>
    </div>
  );
}
