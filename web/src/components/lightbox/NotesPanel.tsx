/**
 * 素材笔记：普通文字笔记 + 视频 / 音频时间点笔记。
 *
 * 和「我的备注」（images.note 单字段）不同：这里可以写任意多条，音视频笔记还能钉在
 * 具体秒数上，点时间码直接跳到那一帧 —— 拉片时记「3:12 这里的光比很好用」比写一段总结有用。
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ImageNote } from '../../types';

/** 秒 → 0:00 / 0:00:00 */
function fmt(sec: number) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** 找到当前正在播放的媒体元素（灯箱里的视频 / 音频），读/写播放位置 */
function mediaEl(): HTMLMediaElement | null {
  return document.querySelector<HTMLMediaElement>('.mv-video, .mv-audio audio');
}

interface Props {
  imageId: number;
  /** 音视频时长（秒）；0 = 不显示「钉在此刻」 */
  duration?: number;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

export default function NotesPanel({ imageId, duration = 0, onToast }: Props) {
  const [notes, setNotes] = useState<ImageNote[]>([]);
  const [text, setText] = useState('');
  const [stickTs, setStickTs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setText('');
    setErr('');
    api
      .imageNotes(imageId)
      .then((r) => alive && setNotes(r.notes))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [imageId]);

  const add = async () => {
    const body = text.trim();
    if (!body) return;
    const ts = stickTs ? Math.max(0, mediaEl()?.currentTime || 0) : 0;
    setBusy(true);
    try {
      const r = await api.addImageNote(imageId, body, ts);
      setNotes((prev) => [...prev, r.note].sort((a, b) => a.ts - b.ts || a.id - b.id));
      setText('');
      onToast?.(ts > 0 ? `已记录 ${fmt(ts)} 的笔记` : '笔记已保存');
    } catch (e) {
      onToast?.((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: ImageNote) => {
    try {
      await api.deleteImageNote(n.id);
      setNotes((prev) => prev.filter((x) => x.id !== n.id));
    } catch (e) {
      onToast?.((e as Error).message, 'error');
    }
  };

  const jump = (n: ImageNote) => {
    if (!n.ts) return;
    const el = mediaEl();
    if (!el) return onToast?.('先打开这张素材的音视频预览');
    el.currentTime = Math.min(n.ts, el.duration || n.ts);
    void el.play?.().catch(() => undefined);
  };

  const canStick = duration > 0;

  return (
    <div className="lb-kv" style={{ alignItems: 'flex-start' }}>
      <b>笔记</b>
      <div style={{ flex: 1, minWidth: 0 }}>
        {err && <div className="qc-hint">{err}</div>}
        <div className="notes-list">
          {notes.map((n) => (
            <div className="note-item" key={n.id}>
              {n.ts > 0 && (
                <button className="note-ts" title="跳到这个时间点" onClick={() => jump(n)}>
                  {fmt(n.ts)}
                </button>
              )}
              <span className="note-body">{n.body}</span>
              <button className="note-del" title="删除这条笔记" onClick={() => void remove(n)}>
                ×
              </button>
            </div>
          ))}
          {!notes.length && !err && (
            <div className="qc-hint">
              {canStick ? '拉片时随手记：点「钉在此刻」把笔记挂到当前播放位置。' : '还没有笔记。'}
            </div>
          )}
        </div>
        <div className="note-input-row">
          <input
            className="input input-sm"
            style={{ flex: 1 }}
            placeholder={canStick ? '在当前位置记一条…（回车保存）' : '添加一条笔记…（回车保存）'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add();
            }}
          />
          {canStick && (
            <button
              className={`btn sm${stickTs ? ' primary' : ' ghost'}`}
              title={stickTs ? '保存时带上当前播放时间' : '保存为纯文本笔记'}
              onClick={() => setStickTs((v) => !v)}
            >
              ⏱ {stickTs ? '钉在此刻' : '纯文本'}
            </button>
          )}
          <button className="btn sm" disabled={busy || !text.trim()} onClick={() => void add()}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
