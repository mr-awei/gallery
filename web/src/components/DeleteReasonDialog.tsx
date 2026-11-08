import React, { useState } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import { formatSize } from '../api';
import { IconClose, IconTrash } from './Icons';

export const REASON_OPTIONS = [
  { key: 'blur', label: '模糊 / 低清' },
  { key: 'lowres', label: '分辨率太低' },
  { key: 'watermark', label: '有水印或平台 Logo' },
  { key: 'notHer', label: '不是目标人物' },
  { key: 'duplicate', label: '重复画面' },
  { key: 'tinyPerson', label: '人物画面占比过小' },
  { key: 'faceCovered', label: '脸被遮挡 / 看不清' },
  { key: 'expression', label: '表情不好 / 闭眼' },
  { key: 'pose', label: '动作 / 姿态别扭' },
  { key: 'composition', label: '构图不好' },
  { key: 'cropped', label: '截取不全 / 变形' },
  { key: 'background', label: '背景太乱' },
  { key: 'lighting', label: '光线差 / 过曝欠曝' },
  { key: 'color', label: '色调不喜欢' },
  { key: 'noise', label: '噪点多 / 压缩痕迹重' },
  { key: 'overedited', label: '修图过度 / 不自然' },
  { key: 'outfit', label: '穿搭 / 造型不喜欢' },
  { key: 'era', label: '不是我喜欢的时期' },
  { key: 'notWallpaper', label: '不适合做壁纸（比例/方向）' },
  { key: 'ad', label: '广告 / 宣传图' },
  { key: 'other', label: '其他' },
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
      const text = [res.description, res.issues?.length ? `问题：${res.issues.join('、')}` : '', res.quality ? `画质分：${res.quality}` : '']
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
      onToast('AI 已看完这张图');
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
            <IconTrash /> 删除这张图
          </b>
          <button className="btn ghost sm" onClick={onCancel}>
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
                记录原因供 AI 学习（不勾选则直接删除，不做任何记录）
              </label>
              {learn && (
                <label style={{ marginTop: 8, display: 'block' }}>
                  不满意的原因（可多选，只做记录，不影响删除速度）
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
                  <label>补充说明（可选）</label>
                  <textarea
                    className="input"
                    rows={2}
                    value={note}
                    placeholder="例如：脸被挡住了 / 背景太乱 / 不是我喜欢的时期"
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn sm" onClick={runAi} disabled={analyzing}>
                    {analyzing ? 'AI 看图中…' : '让 AI 看图分析（可选）'}
                  </button>
                  {aiText && <span style={{ fontSize: 12, color: 'var(--ok)' }}>AI 已补充分析</span>}
                </div>
                {aiText && <div className="ai-result">{aiText}</div>}
              </>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {learn
              ? '文件会移到回收站，可随时恢复；原因会记入知识库，供以后采集降权参考'
              : '文件会移到回收站，可随时恢复；本次不做任何记录'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onCancel}>
              取消
            </button>
            <button
              className="btn danger"
              onClick={() => onConfirm({ reasons, note, aiAnalysis: aiText, learn })}
            >
              <IconTrash /> {learn ? '记录原因并删除' : '直接删除'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
