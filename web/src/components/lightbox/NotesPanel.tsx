/**
 * 素材笔记：普通文字笔记 + 视频 / 音频时间点笔记。
 *
 * 和「我的备注」（images.note 单字段）不同：这里可以写任意多条，音视频笔记还能钉在
 * 具体秒数上，点时间码直接跳到那一帧 —— 拉片时记「3:12 这里的光比很好用」比写一段总结有用。
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ImageNote } from '../../types';
import i18n from '../../i18n';

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
      onToast?.(ts > 0 ? i18n.t('k17e7df60', { p0: fmt(ts) }) : i18n.t('k68631187'));
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
    if (!el) return onToast?.(i18n.t('k104b5680'));
    el.currentTime = Math.min(n.ts, el.duration || n.ts);
    void el.play?.().catch(() => undefined);
  };

  const canStick = duration > 0;

  return (
    <div className="lb-kv" style={{ alignItems: 'flex-start' }}>
      <b>{i18n.t('k7051dc52')}</b>
      <div style={{ flex: 1, minWidth: 0 }}>
        {err && <div className="qc-hint">{err}</div>}
        <div className="notes-list">
          {notes.map((n) => (
            <div className="note-item" key={n.id}>
              {n.ts > 0 && (
                <button className="note-ts" title={i18n.t('k7f389ad9')} onClick={() => jump(n)}>
                  {fmt(n.ts)}
                </button>
              )}
              <span className="note-body">{n.body}</span>
              <button className="note-del" title={i18n.t('k14fade62')} onClick={() => void remove(n)}>
                ×
              </button>
            </div>
          ))}
          {!notes.length && !err && (
            <div className="qc-hint">
              {canStick ? i18n.t('ka16f2003') : i18n.t('k07172653')}
            </div>
          )}
        </div>
        <div className="note-input-row">
          <input
            className="input input-sm"
            style={{ flex: 1 }}
            placeholder={canStick ? i18n.t('k34c96521') : i18n.t('k53607300')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add();
            }}
          />
          {canStick && (
            <button
              className={`btn sm${stickTs ? ' primary' : ' ghost'}`}
              title={stickTs ? i18n.t('k77e07a65') : i18n.t('kbf68459f')}
              onClick={() => setStickTs((v) => !v)}
            >
              ⏱ {stickTs ? i18n.t('k8e2e2479') : i18n.t('kffb01e5b')}
            </button>
          )}
          <button className="btn sm" disabled={busy || !text.trim()} onClick={() => void add()}>
            {i18n.t('kb58c7549')}
          </button>
        </div>
      </div>
    </div>
  );
}
