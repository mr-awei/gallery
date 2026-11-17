import React, { useState } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import { formatSize } from '../api';
import { IconClose, IconTrash } from './Icons';
import i18n from '../i18n';

export const REASON_OPTIONS = [
  { key: 'blur', label: i18n.t('kc3f69d7a') },
  { key: 'lowres', label: i18n.t('kf20fd188') },
  { key: 'watermark', label: i18n.t('kd60f1419') },
  { key: 'notHer', label: i18n.t('k5013302d') },
  { key: 'duplicate', label: i18n.t('k46048d6a') },
  { key: 'tinyPerson', label: i18n.t('k36994cac') },
  { key: 'faceCovered', label: i18n.t('kbedd5d59') },
  { key: 'expression', label: i18n.t('kf36a543a') },
  { key: 'pose', label: i18n.t('k8bc9bc7b') },
  { key: 'composition', label: i18n.t('k1c6b93b2') },
  { key: 'cropped', label: i18n.t('kb2263008') },
  { key: 'background', label: i18n.t('kf01ff25a') },
  { key: 'lighting', label: i18n.t('k75f61576') },
  { key: 'color', label: i18n.t('k309dd351') },
  { key: 'noise', label: i18n.t('k1ea59300') },
  { key: 'overedited', label: i18n.t('k78773bcc') },
  { key: 'outfit', label: i18n.t('k3311bc9e') },
  { key: 'era', label: i18n.t('k5b1024ae') },
  { key: 'notWallpaper', label: i18n.t('k93bbc3c2') },
  { key: 'ad', label: i18n.t('k9860d937') },
  { key: 'other', label: i18n.t('k0d98c747') },
];

/** 把内部原因代码翻译成中文（notHer → 不是目标人物） */
export const reasonLabel = (key: string) =>
  REASON_OPTIONS.find((r) => r.key === key)?.label || key;

interface Props {
  item: ImageItem;
  onCancel: () => void;
  onConfirm: (payload: {
    reasons: string[];
    note: string;
    aiAnalysis: string;
    learn: boolean;
  }) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

export default function DeleteReasonDialog({ item, onCancel, onConfirm, onToast }: Props) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [aiText, setAiText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [learn, setLearn] = useState(true);

  const toggle = (key: string) =>
    setReasons((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const runAi = async () => {
    setAnalyzing(true);
    try {
      const res = await api.aiAnalyze(item.id);
      const text = [res.description, res.issues?.length ? i18n.t('k33e72acc', { p0: res.issues.join('、') }) : '', res.quality ? i18n.t('k0673040d', { p0: res.quality }) : '']
        .filter(Boolean)
        .join('\n');
      setAiText(text);
      if (!reasons.length && res.issues?.length) {
        const guess = res.issues.join(' ');
        const matched = REASON_OPTIONS.filter((r) =>
          [r.label, ...guess].length && (guess.includes(r.label.slice(0, 2)) || guess.includes(r.label))
        ).map((r) => r.key);
        if (matched.length) setReasons(matched.slice(0, 2));
      }
      onToast(i18n.t('k84573978'));
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>
            <IconTrash /> {i18n.t('kadbc923e')}
          </b>
          <button className="btn ghost sm" onClick={onCancel} aria-label={i18n.t('kb15d9127')}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body">
          <img src={item.thumbUrl} alt={item.title} loading="lazy" decoding="async" />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.9 }}>
              {item.width}×{item.height} · {formatSize(item.sizeBytes)} · 来源 {item.source}
              <br />
              关键词：{item.keyword || '—'} · 智能分 {item.score}
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={learn}
                  onChange={(e) => setLearn(e.target.checked)}
                />
                {i18n.t('ke4e08b06')}
              </label>
              {learn && (
                <label style={{ marginTop: 8, display: 'block' }}>
                  {i18n.t('k0bcb7553')}
                </label>
              )}
              {learn && (
                <div className="reason-chips">
                  {REASON_OPTIONS.map((r) => (
                    <button
                      key={r.key}
                      className={`chip${reasons.includes(r.key) ? ' active' : ''}`}
                      onClick={() => toggle(r.key)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {learn && (
              <>
                <div className="field">
                  <label>{i18n.t('k467c125c')}</label>
                  <textarea
                    className="input"
                    rows={2}
                    value={note}
                    placeholder={i18n.t('kd1f7f341')}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn sm" onClick={runAi} disabled={analyzing}>
                    {analyzing ? i18n.t('k993d3a9e') : i18n.t('k0596419e')}
                  </button>
                  {aiText && <span style={{ fontSize: 12, color: 'var(--ok)' }}>{i18n.t('k82554885')}</span>}
                </div>
                {aiText && <div className="ai-result">{aiText}</div>}
              </>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {learn
              ? i18n.t('ke99b47b2')
              : i18n.t('k1e6d05ed')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onCancel}>
              {i18n.t('k625fb26b')}
            </button>
            <button
              className="btn danger"
              onClick={() => onConfirm({ reasons, note, aiAnalysis: aiText, learn })}
            >
              <IconTrash /> {learn ? i18n.t('k608d123b') : i18n.t('k1742c8b3')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
