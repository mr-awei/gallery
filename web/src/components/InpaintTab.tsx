import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../api';
import type { ImageItem } from '../types';

/** 擦除修复面板：在原图上涂白色蒙版，白色区域由内容感知扩散补上。 */
interface Props {
  item: ImageItem;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
  onReplaced?: (item: ImageItem) => void;
}

export default function InpaintTab({ item, onToast, onReplaced }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [brush, setBrush] = useState(28);
  const [strength, setStrength] = useState(30);
  const [busy, setBusy] = useState(false);
  const [coverage, setCoverage] = useState<number | null>(null);
  // 默认不动原图：擦除是不可逆的内容替换，副本模式下还能回头比对
  const [saveCopy, setSaveCopy] = useState(true);

  const point = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * c.width) / Math.max(1, r.width),
      y: ((e.clientY - r.top) * c.height) / Math.max(1, r.height),
    };
  };

  const paint = (from: { x: number; y: number } | null, to: { x: number; y: number }) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = brush;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (!from) {
      ctx.beginPath();
      ctx.arc(to.x, to.y, brush / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    last.current = null;
    paint(null, point(e));
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const p = point(e);
    paint(last.current, p);
    last.current = p;
  };
  const onUp = () => {
    drawing.current = false;
    last.current = null;
  };

  const clearMask = () => {
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setCoverage(null);
  };

  /** 透明画布导出的 PNG 在灰度化后白笔画仍为白；先垫黑底保证黑区明确是「保留」 */
  const maskDataUrl = () => {
    const c = canvasRef.current;
    if (!c) return '';
    const out = document.createElement('canvas');
    out.width = c.width;
    out.height = c.height;
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(c, 0, 0);
    return out.toDataURL('image/png');
  };

  const apply = async (copy: boolean) => {
    if (busy) return;
    const mask = maskDataUrl();
    if (!mask) return;
    setBusy(true);
    try {
      const r = await api.inpaintImage(item.id, {
        mask,
        strength,
        saveMode: copy ? 'copy' : 'overwrite',
        addToLibrary: copy,
      });
      setCoverage(r.coverage);
      onToast?.(`擦除完成（覆盖 ${(r.coverage * 100).toFixed(1)}%）`, 'info');
      if (r.item) onReplaced?.(r.item);
    } catch (err) {
      onToast?.(`擦除失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="hint" style={{ marginBottom: 10 }}>
        用白色画笔涂出要擦掉的部分（划痕、水印、电线、小物件），再点「擦除并写回」。
        这是<b>内容感知扩散</b>，不是生成式 AI：大面积缺失只会得到平滑过渡，建议改用裁切。
        写回原图前会自动留备份，可用「撤销上次编辑」回退。
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 420px', minWidth: 280, maxWidth: 760 }}>
          <img
            src={`/api/images/${item.id}/preview?v=${Date.now()}`}
            alt="待修复图片"
            style={{ width: '100%', display: 'block', borderRadius: 6 }}
            onLoad={(e) => {
              const img = e.currentTarget;
              const c = canvasRef.current;
              if (!c) return;
              c.width = img.naturalWidth || 800;
              c.height = img.naturalHeight || 600;
            }}
            draggable={false}
          />
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              cursor: 'crosshair',
              touchAction: 'none',
              opacity: 0.62,
            }}
          />
        </div>
        <div style={{ flex: '0 0 220px' }}>
          <div className="field">
            <label>画笔粗细：{brush}px</label>
            <input type="range" min={4} max={120} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>扩散强度：{strength} 轮</label>
            <input type="range" min={4} max={80} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
          </div>
          <div className="switch-row">
            <span>另存副本（不动原图）</span>
            <input type="checkbox" checked={saveCopy} onChange={(e) => setSaveCopy(e.target.checked)} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={clearMask} disabled={busy}>清空画笔</button>
            <button className="btn sm primary" onClick={() => apply(saveCopy)} disabled={busy}>
              {busy ? '处理中…' : saveCopy ? '擦除并另存' : '擦除并写回'}
            </button>
          </div>
          {coverage !== null && <div className="hint" style={{ marginTop: 10 }}>本次擦除面积：{(coverage * 100).toFixed(1)}%</div>}
        </div>
      </div>
    </div>
  );
}
