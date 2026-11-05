import { useEffect, useState } from 'react';
import { api, formatDate } from '../api';
import type { ImageComment } from '../types';

/** 图上评论（对标 Eagle 的 Annotations 里「评论」部分）：按时间正序，可删除 */
interface Props {
  imageId: number;
  onCount?: (n: number) => void;
  onClose: () => void;
  onToast?: (msg: string) => void;
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
      onToast?.(`评论失败：${(err as Error).message}`);
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
      onToast?.(`删除失败：${(err as Error).message}`);
    }
  };

  return (
    <div className="cmt-panel" onClick={(e) => e.stopPropagation()}>
      <div className="cmt-head">
        <b>评论 · {list.length}</b>
        <button className="btn sm ghost" onClick={onClose} title="收起评论面板">
          ✕
        </button>
      </div>

      <div className="cmt-list">
        {!list.length && <div className="cmt-empty">还没有评论，记录一下这张图的用途或修改意见吧。</div>}
        {list.map((c) => (
          <div key={c.id} className="cmt-item">
            <div className="cmt-meta">
              <b>{c.author || '匿名'}</b>
              <span>{c.createdAt ? formatDate(c.createdAt) : ''}</span>
              <button className="cmt-del" onClick={() => remove(c.id)} title="删除这条评论">
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
          placeholder="署名"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
        />
        <textarea
          className="input cmt-textarea"
          placeholder="写评论…（Ctrl+Enter 发送）"
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
          {busy ? '发送中…' : '发表评论'}
        </button>
      </div>
    </div>
  );
}
