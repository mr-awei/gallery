import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { api, desktop } from '../api';
import i18n from '../i18n';

interface Props {
  onImported: (count: number) => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIZE = 4;

/**
 * 截图入库（Eagle 三件套之三）：主进程抓全屏底图 → 这里画框选区 → canvas 裁剪 → 走普通上传入库。
 * 快捷键 / 托盘 / 界面按钮都会派发 tuku:screenshot，统一进这个遮罩。
 */
export default function ScreenshotOverlay({ onImported, onToast }: Props) {
  const [shot, setShot] = useState<{ src: string; w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  // 主进程抓完屏会把窗口切到全屏，视口尺寸会变；跟着 resize 更新，换算才不会错位
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const open = useCallback(async () => {
    if (!desktop?.grabScreen) {
      onToast?.(i18n.t('k4fa631a5'));
      return;
    }
    try {
      const g = await desktop.grabScreen();
      if (!g?.dataUrl) return;
      setShot({ src: g.dataUrl, w: g.width, h: g.height });
      setRect(null);
    } catch (err) {
      onToast?.(i18n.t('k6da53556', { p0: (err as Error).message }));
    }
  }, [onToast]);

  /* 全局入口：界面按钮（自定义事件）+ 主进程快捷键/托盘 */
  useEffect(() => {
    const handler = () => void open();
    window.addEventListener('tuku:screenshot', handler);
    const off = desktop?.onShotRequest?.(handler);
    return () => {
      window.removeEventListener('tuku:screenshot', handler);
      off?.();
    };
  }, [open]);

  const close = useCallback(() => {
    setShot(null);
    setRect(null);
    startRef.current = null;
    // 框选期间主进程把窗口临时放大了，结束时还原成进框选前的尺寸/显示状态
    void desktop?.endShot?.();
  }, []);

  const onDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };

  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    setRect({
      x: Math.min(start.x, e.clientX),
      y: Math.min(start.y, e.clientY),
      w: Math.abs(e.clientX - start.x),
      h: Math.abs(e.clientY - start.y),
    });
  };

  const onUp = () => {
    startRef.current = null;
  };

  /** 选区（视口坐标）→ 原图物理像素裁剪 → PNG 文件入库 */
  const save = useCallback(
    async (area?: Rect) => {
      if (!shot) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const target: Rect = area ?? { x: 0, y: 0, w: vw, h: vh };
      if (target.w < MIN_SIZE || target.h < MIN_SIZE) {
        onToast?.(i18n.t('k73391509'));
        return;
      }
      setBusy(true);
      try {
        const scaleX = shot.w / vw;
        const scaleY = shot.h / vh;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(target.w * scaleX));
        canvas.height = Math.max(1, Math.round(target.h * scaleY));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error(i18n.t('k2352bf26'));
        const img = new Image();
        img.src = shot.src;
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(i18n.t('ka2b7ddb1')));
        });
        ctx.drawImage(
          img,
          Math.round(target.x * scaleX),
          Math.round(target.y * scaleY),
          canvas.width,
          canvas.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(i18n.t('kdd51ab50')))), 'image/png')
        );
        const t = new Date();
        const p2 = (n: number) => String(n).padStart(2, '0');
        const name = `Screenshot_${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}_${p2(t.getHours())}${p2(
          t.getMinutes()
        )}${p2(t.getSeconds())}.png`;
        await api.uploadFile(new File([blob], name, { type: 'image/png' }), { tags: i18n.t('k369abff3') });
        onImported(1);
        onToast?.(i18n.t('k38b1b0e9', { p0: name }));
        close();
      } catch (err) {
        onToast?.(i18n.t('k8676af8d', { p0: (err as Error).message }));
      } finally {
        setBusy(false);
      }
    },
    [shot, onImported, onToast, close]
  );

  /* Esc 取消 / Enter 确认当前选区 */
  useEffect(() => {
    if (!shot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void save(rect && rect.w > MIN_SIZE ? rect : undefined);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shot, rect, save, close]);

  if (!shot) return null;

  const vw = vp.w;
  const vh = vp.h;
  const r = rect ?? { x: 0, y: 0, w: 0, h: 0 };
  const showMasks = r.w > 0 && r.h > 0;

  return (
    <div
      className={`shot-mask${startRef.current ? ' grabbing' : ''}`}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      role="presentation"
    >
      <img className="shot-bg" src={shot.src} alt="" draggable={false} />
      {/* 四块遮罩把选区外的屏幕压暗（不用 clip-path，兼容性最稳） */}
      <div className="shot-dim" style={{ top: 0, left: 0, right: 0, height: showMasks ? r.y : 0, display: showMasks ? 'block' : 'none' }} />
      <div
        className="shot-dim"
        style={{ top: showMasks ? r.y + r.h : 0, left: 0, right: 0, bottom: 0, display: showMasks ? 'block' : 'none' }}
      />
      <div className="shot-dim" style={{ top: r.y, left: 0, width: showMasks ? r.x : 0, height: r.h, display: showMasks ? 'block' : 'none' }} />
      <div
        className="shot-dim"
        style={{ top: r.y, left: showMasks ? r.x + r.w : 0, right: 0, height: r.h, display: showMasks ? 'block' : 'none' }}
      />
      {showMasks && (
        <>
          <div className="shot-frame" style={{ top: r.y, left: r.x, width: r.w, height: r.h }} />
          <div className="shot-size" style={{ top: Math.max(6, r.y - 26), left: Math.max(6, r.x) }}>
            {Math.round(r.w * (shot.w / vw))} × {Math.round(r.h * (shot.h / vh))}
          </div>
        </>
      )}
      <div className="shot-bar" onMouseDown={(e) => e.stopPropagation()}>
        <span className="shot-hint">{i18n.t('kbcef2bc8')}</span>
        <button className="btn sm" disabled={busy || r.w < MIN_SIZE} onClick={() => void save(r)}>
          {busy ? i18n.t('k9b5d32d1') : i18n.t('k3add5f84')}
        </button>
        <button className="btn sm ghost" disabled={busy} onClick={() => void save()}>
          {i18n.t('k7851c887')}
        </button>
        <button className="btn sm ghost" disabled={busy} onClick={close}>
          {i18n.t('k625fb26b')}
        </button>
      </div>
    </div>
  );
}
