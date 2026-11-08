import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';
import { blobToDataUrl, bytesToDataUrl } from '../lib/gif';
import { captureFrames, encodeGifWorker, planFrameTimes, recordClip, saveExport } from '../lib/video-export';

interface Props {
  item: ImageItem;
  /** 灯箱里正在播放的 <video>：用于「循环预览裁剪区间」 */
  videoRef: RefObject<HTMLVideoElement>;
  onReplaceItem?: (item: ImageItem) => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

const MAX_GIF_FRAMES = 120;
const boxStyle: CSSProperties = {
  padding: '10px 12px',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px 16px',
  alignItems: 'center',
  fontSize: 12.5,
};
const rangeStyle: CSSProperties = { flex: 1, minWidth: 150, accentColor: 'var(--accent)' };

function safeStem(title: string) {
  const stem = title.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return (stem || 'clip').slice(0, 60);
}

/** 视频首尾裁剪 + 截帧导出 GIF / 导出 WebM 片段（不依赖 ffmpeg） */
export default function VideoTrimExport({ item, videoRef, onReplaceItem, onToast }: Props) {
  const duration = Math.max(0, item.duration || 0);
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(item.trimStart || 0);
  const [end, setEnd] = useState(item.trimEnd && item.trimEnd > 0 ? item.trimEnd : duration);
  const [fps, setFps] = useState(8);
  const [width, setWidth] = useState(480);
  const [format, setFormat] = useState<'gif' | 'webm'>('gif');
  const [loop, setLoop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  // ref 在父组件 commit 之后才赋值，放到 effect 里取，避免首帧拿到 null 让区间循环失效
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    setVideoEl(videoRef.current);
  }, [videoRef, item.id, open]);

  useEffect(() => {
    setStart(item.trimStart || 0);
    setEnd(item.trimEnd && item.trimEnd > 0 ? item.trimEnd : duration || 0);
    setProgress(0);
  }, [item.id, item.trimStart, item.trimEnd, duration]);

  /** 区间循环预览：超出尾部就跳回起点，超出起点就纠正 */
  useEffect(() => {
    const v = videoEl;
    if (!loop || !v || busy) return;
    const onTime = () => {
      if (v.currentTime >= end - 0.03 || v.currentTime < start - 0.2) v.currentTime = start;
    };
    v.addEventListener('timeupdate', onTime);
    if (v.currentTime < start || v.currentTime >= end) v.currentTime = start;
    return () => v.removeEventListener('timeupdate', onTime);
  }, [loop, start, end, videoEl, busy]);

  const hi = Math.max(start + 0.1, duration || 10);
  const effectiveEnd = Math.min(Math.max(end, start + 0.1), hi);
  const frames = useMemo(
    () => planFrameTimes(start, effectiveEnd, fps, MAX_GIF_FRAMES).length,
    [start, effectiveEnd, fps]
  );
  const seconds = Math.max(0, effectiveEnd - start);

  const toast = (msg: string, kind?: 'info' | 'error') => onToast?.(msg, kind);

  const saveRange = async () => {
    try {
      const r = await api.patchMedia(item.id, { trimStart: start, trimEnd: effectiveEnd });
      if (r.image) onReplaceItem?.(r.image);
      toast('裁剪区间已保存到这张素材');
    } catch (err) {
      toast(`保存区间失败：${(err as Error).message}`, 'error');
    }
  };

  const exportClip = async () => {
    if (busy) return;
    if (!duration) {
      toast('还没读到视频时长，请先播放一次让应用记录元数据', 'error');
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const common = {
        startSec: start,
        endSec: effectiveEnd,
        fps,
        width,
        onProgress: (done: number, total: number) => setProgress(total > 0 ? done / total : 0),
      };
      let dataUrl: string;
      if (format === 'gif') {
        const gifFrames = await captureFrames(item.url, { ...common, maxFrames: MAX_GIF_FRAMES });
        const bytes = await encodeGifWorker(gifFrames, { loop: 0 });
        dataUrl = bytesToDataUrl(bytes);
      } else {
        const blob = await recordClip(item.url, common);
        dataUrl = await blobToDataUrl(blob);
      }
      const saved = await saveExport(dataUrl, `${safeStem(item.title)}-${start.toFixed(1)}-${effectiveEnd.toFixed(1)}.${format}`);
      toast(`已导出 ${format.toUpperCase()}：${saved}`);
    } catch (err) {
      toast(`导出失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mv-trim" onClick={(e) => e.stopPropagation()}>
      <div className="mv-bar">
        <button className="btn sm ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '收起片段裁剪' : '首尾裁剪 / 导出 GIF'}
        </button>
        {open && (
          <span style={{ color: 'var(--muted)' }}>
            区间 {start.toFixed(1)}s → {effectiveEnd.toFixed(1)}s（{seconds.toFixed(1)}s · {frames} 帧）
          </span>
        )}
      </div>
      {open && (
        <div style={boxStyle}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 260, flex: 2 }}>
            <span>起点</span>
            <input
              type="range"
              style={rangeStyle}
              min={0}
              max={hi}
              step={0.1}
              value={Math.min(start, hi)}
              onChange={(e) => setStart(Math.min(Number(e.target.value), effectiveEnd - 0.1))}
            />
            <span style={{ width: 46, textAlign: 'right' }}>{start.toFixed(1)}s</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 260, flex: 2 }}>
            <span>终点</span>
            <input
              type="range"
              style={rangeStyle}
              min={0}
              max={hi}
              step={0.1}
              value={Math.min(effectiveEnd, hi)}
              onChange={(e) => setEnd(Math.max(Number(e.target.value), start + 0.1))}
            />
            <span style={{ width: 46, textAlign: 'right' }}>{effectiveEnd.toFixed(1)}s</span>
          </label>
          <label>
            帧率
            <input
              className="input"
              type="number"
              min={1}
              max={30}
              value={fps}
              style={{ width: 64, marginLeft: 6 }}
              onChange={(e) => setFps(Math.max(1, Math.min(30, Number(e.target.value) || 8)))}
            />
          </label>
          <label>
            宽度
            <input
              className="input"
              type="number"
              min={160}
              max={1280}
              step={40}
              value={width}
              style={{ width: 74, marginLeft: 6 }}
              onChange={(e) => setWidth(Math.max(160, Math.min(1280, Number(e.target.value) || 480)))}
            />
          </label>
          <label>
            格式
            <select
              className="select"
              style={{ marginLeft: 6 }}
              value={format}
              onChange={(e) => setFormat(e.target.value as 'gif' | 'webm')}
            >
              <option value="gif">GIF 动图（截帧合成）</option>
              <option value="webm">WebM 视频片段</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={loop}
              onChange={(e) => {
                setLoop(e.target.checked);
                if (e.target.checked && videoEl) {
                  videoEl.currentTime = start;
                  void videoEl.play().catch(() => undefined);
                }
              }}
            />
            循环预览区间
          </label>
          <button className="btn sm" disabled={busy} onClick={saveRange}>
            保存区间
          </button>
          <button className="btn sm" disabled={busy} onClick={exportClip}>
            {busy ? `导出中 ${Math.round(progress * 100)}%` : '导出片段'}
          </button>
          {busy && (
            <div style={{ width: '100%', height: 4, background: 'var(--border)', borderRadius: 2 }}>
              <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', background: 'var(--accent)' }} />
            </div>
          )}
          <div className="hint" style={{ width: '100%', color: 'var(--muted)' }}>
            不引入 ffmpeg：GIF 用浏览器逐帧 seek + 纯 JS GIF89a 编码；WebM 用 canvas.captureStream + MediaRecorder 实时录制。
            帧数上限 {MAX_GIF_FRAMES}，超长片段会自动抽稀并拉长每帧停留时间。
          </div>
        </div>
      )}
    </div>
  );
}
