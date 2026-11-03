import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconClose, IconWallpaper } from './Icons';

/**
 * 壁纸效果预览：服务端按真实屏幕分辨率合成（完整居中 + 铺底），所见即将来桌面的样子。
 *
 * 两个细节都在这里收口：
 * - 舞台比例取自合成图本身（naturalWidth/Height），图片按 fill 铺满舞台 —— 之前舞台是固定
 *   宽高，图片 contain 居中，四周露出一圈深色底，看着像黑边。
 * - 切换铺底方式时用双层叠图：旧帧垫底、新帧解码完再淡入，不会闪一下黑屏。
 */
const STYLES = [
  { key: 'blur', label: '模糊同图铺底', note: '推荐：用同一张图放大模糊填满四周' },
  { key: 'solid', label: '主色铺底', note: '取图片主色做纯色背景' },
  { key: 'black', label: '纯黑铺底', note: '暗色桌面，突出图片本身' },
];

interface Props {
  itemId: number;
  title?: string;
  onClose: () => void;
  /** 按当前选中的铺底方式设为桌面壁纸（复用父级逻辑） */
  onApply?: (style: string) => void;
}

export default function WallpaperPreview({ itemId, title, onClose, onApply }: Props) {
  const [style, setStyle] = useState('blur');
  const [failed, setFailed] = useState('');
  /** 已上屏的帧（cur）和上一帧（prev，过渡期垫底用） */
  const [shown, setShown] = useState({ cur: '', prev: '' });
  const [ready, setReady] = useState(false);
  /** 合成图实际像素尺寸，舞台宽高比照它来，保证严丝合缝 */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const src = `/api/images/${itemId}/wallpaper-preview?style=${style}`;

  useEffect(() => {
    setReady(false);
    setFailed('');
    setShown((s) => ({ cur: s.cur, prev: s.cur }));
  }, [src]);

  /* 打开预览时吞掉快捷键（否则按数字/方向键会作用到底层大图），Esc 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // 舞台按合成图比例走；再用可用高度反推最大宽度，窗口矮时整块等比缩小而不是裁掉底部
  const ar = size ? size.w / size.h : 16 / 9;
  const stageStyle = {
    aspectRatio: size ? `${size.w} / ${size.h}` : '16 / 9',
    maxWidth: `calc((100vh * 0.88 - 160px) * ${ar})`,
  } as const;

  // 传送到 body：开在大图预览里时，.lightbox 的浅色 --text 会让白卡片上的标题与说明几乎看不见
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wp-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>壁纸效果预览{title ? ` · ${title}` : ''}</b>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
        <div className="modal-body wp-body">
          <div className={`wp-stage${ready ? ' ready' : ''}`} style={stageStyle}>
            {shown.prev && <img className="wp-frame prev" src={shown.prev} alt="" aria-hidden />}
            {!ready && !shown.prev && <span className="wp-loading">正在按屏幕分辨率合成…</span>}
            {failed ? (
              <span className="wp-error">{failed}</span>
            ) : (
              <img
                className={`wp-frame cur${ready ? ' on' : ''}`}
                src={src}
                alt="壁纸预览"
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0) {
                    setSize({ w: img.naturalWidth, h: img.naturalHeight });
                  }
                  setShown({ cur: src, prev: '' });
                  setReady(true);
                }}
                onError={() => {
                  setReady(false);
                  setFailed('预览生成失败：可能是图片文件缺失或屏幕尺寸读取不到');
                }}
              />
            )}
          </div>
          <div className="wp-side">
            {STYLES.map((s) => (
              <button
                key={s.key}
                className={`wp-style${style === s.key ? ' on' : ''}`}
                onClick={() => setStyle(s.key)}
              >
                <b>{s.label}</b>
                <span>{s.note}</span>
              </button>
            ))}
            <p className="exp-hint">
              预览按当前主屏分辨率{size ? `（${size.w} × ${size.h}）` : ''}生成，不裁切、不拉伸；
              设置壁纸时才落盘写入。
            </p>
          </div>
        </div>
        <div className="modal-foot">
          <span className="exp-hint">只是预览，不会改系统壁纸</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm ghost" onClick={onClose}>
              关闭
            </button>
            {onApply && (
              <button className="btn sm primary" onClick={() => onApply(style)}>
                <IconWallpaper /> 就用这个效果设为壁纸
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
