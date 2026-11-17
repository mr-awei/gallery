import { IconFilm, IconMusic, IconCamera, IconPalette, IconBox } from './Icons';
import { Suspense, lazy, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { api, formatSize, revealFile } from '../api';
import { fontFrameDataUrl, imageFrameDataUrl } from '../lib/coverFrame';
import ModelViewer from './ModelViewer';
import VideoTrimExport from './VideoTrimExport';
import type { ImageItem } from '../types';
import i18n from '../i18n';

/**
 * Office 预览要带上 SheetJS / mammoth / JSZip（压缩后仍近 600KB），
 * 而打开一张普通照片根本用不到。静态导入会把它们全塞进灯箱 chunk，
 * 让「第一次点开大图」多等一截；改成按需加载，只有真的打开 docx/xlsx 才下载。
 */
const OfficeViewer = lazy(() => import('./OfficeViewer'));
/** EPUB 同理：解析在服务端，这里只是阅读界面，别拖累首包 */
const EpubViewer = lazy(() => import('./EpubViewer'));

/**
 * 大图预览里的多格式素材播放/预览（Eagle 式）：
 * - video：原生播放器 + 时长/分辨率回写 + 「用当前帧做封面」
 * - gif：直接播放原文件
 * - audio：原生播放器 + 假波形视觉
 * - font：可改文案的实时预览（FontFace 动态挂载）
 * - pdf / office / model / other：内嵌或系统应用兜底
 * 图片仍走 Lightbox 原有的 <img>（要支持缩放/裁切/调色）。
 */
interface Props {
  item: ImageItem;
  onReplaceItem?: (item: ImageItem) => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

/**
 * 真实波形：把音频解码后按峰值分桶，得到与声音对得上的柱状图（Eagle 的音频预览同款）。
 * 用 OfflineAudioContext 解码——不需要用户手势，也不会真的出声。
 * 解不出来就如实说「解析失败」，绝不拿一条正弦曲线冒充声波。
 */
function useWaveform(url: string, bars = 80) {
  const [peaks, setPeaks] = useState<number[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  useEffect(() => {
    if (!url) {
      setPeaks([]);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(i18n.t('k32238818', { p0: res.status }));
        const buf = await res.arrayBuffer();
        const AC: typeof OfflineAudioContext =
          window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
        const audio = await new AC(1, 1, 44100).decodeAudioData(buf);
        if (cancelled) return;
        const data = audio.getChannelData(0);
        const block = Math.max(1, Math.floor(data.length / bars));
        const out: number[] = [];
        for (let i = 0; i < bars; i++) {
          let peak = 0;
          const end = Math.min(data.length, (i + 1) * block);
          for (let j = i * block; j < end; j++) {
            const v = Math.abs(data[j]);
            if (v > peak) peak = v;
          }
          out.push(peak);
        }
        const max = Math.max(...out, 0.0001);
        if (!cancelled) {
          setPeaks(out.map((p) => Math.max(0.07, p / max)));
          setStatus('ready');
        }
      } catch {
        if (!cancelled) {
          setPeaks([]);
          setStatus('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, bars]);
  return { peaks, status };
}

function useFontFamily(url: string) {
  const [family, setFamily] = useState('');
  useEffect(() => {
    let cancelled = false;
    const fam = `tukufont-lb-${Math.random().toString(36).slice(2, 9)}`;
    let face: FontFace | null = null;
    try {
      face = new FontFace(fam, `url("${url}")`);
      face
        .load()
        .then((loaded) => {
          if (cancelled) return;
          document.fonts.add(loaded);
          setFamily(fam);
        })
        .catch(() => undefined);
    } catch {
      /* 老浏览器忽略 */
    }
    return () => {
      cancelled = true;
      if (face) {
        try {
          document.fonts.delete(face);
        } catch {
          /* noop */
        }
      }
    };
  }, [url]);
  return family;
}

/**
 * PDF 阅读器：
 * - 页数来自后端对 PDF 目录的解析（不装 pdf.js 也能给出总页；解析不到就说「未知」而不是瞎猜）；
 * - 翻页靠 iframe 的 #page=N 锚点，Chrome/Electron 内建阅读器会跟着跳；
 * - 缩略图位置只放页码按钮——浏览器内建阅读器不暴露逐页渲染接口，硬造封面会变成假功能。
 */
function PdfViewer({ item, onToast }: { item: ImageItem; onToast?: (m: string, kind?: 'info' | 'error') => void }) {
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .pdfInfo(item.id)
      .then((r) => {
        if (!alive) return;
        setPages(r.pages);
        if (!r.exact) setNote(i18n.t('k41ed1778'));
      })
      .catch((e) => alive && setNote((e as Error).message));
    return () => {
      alive = false;
    };
  }, [item.id]);

  useEffect(() => setPage(1), [item.id]);

  const jump = (n: number) => {
    const next = Math.max(1, pages ? Math.min(pages, n) : n);
    setPage(next);
  };

  return (
    <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
      <div className="pdf-bar">
        <button className="btn sm ghost" disabled={page <= 1} onClick={() => jump(page - 1)} title={i18n.t('kf4f85316')}>
          ‹
        </button>
        <span className="pdf-pages">
          第{' '}
          <input
            className="input pdf-page-input"
            type="number"
            min={1}
            max={pages || undefined}
            value={page}
            onChange={(e) => jump(Number(e.target.value) || 1)}
          />{' '}
          / {pages || '?'} 页
        </span>
        <button className="btn sm ghost" disabled={!!pages && page >= pages} onClick={() => jump(page + 1)} title={i18n.t('kb4e1b508')}>
          ›
        </button>
        {pages > 1 && (
          <div className="pdf-thumbs">
            {Array.from({ length: Math.min(pages, 60) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                className={`pdf-thumb${n === page ? ' on' : ''}`}
                onClick={() => jump(n)}
                title={i18n.t('kd6c2c042', { p0: n })}
              >
                {n}
              </button>
            ))}
            {pages > 60 && <span className="pdf-pages">…共 {pages} 页</span>}
          </div>
        )}
        <button className="btn sm ghost" onClick={() => revealFile(item.path)} title={i18n.t('k08c3f4df')}>
          {i18n.t('k28398c2d')}
        </button>
        {note && <span className="pdf-pages" title={note}>{note}</span>}
      </div>
      <div className="pdf-stage">
        <iframe
          className="mv-frame"
          src={`${item.url}#page=${page}&view=FitH&toolbar=1`}
          title={item.title}
          onError={() => onToast?.(i18n.t('k7b256bf4'))}
        />
      </div>
    </div>
  );
}

export default function MediaViewer({ item, onReplaceItem, onToast }: Props) {
  const kind = item.mediaKind || 'image';
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [fontText, setFontText] = useState(i18n.t('k5fcdce51'));
  const [fontSize, setFontSize] = useState(48);
  const [coverBusy, setCoverBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  /** 编码不受 Chromium 支持（mkv/avi/flv/wmv 等）时的兜底提示 */
  const [videoError, setVideoError] = useState(false);
  /** RAW / 设计稿的内嵌预览图取不到（后端 404）：不是文件丢了，只是没预览 */
  const [thumbFailed, setThumbFailed] = useState(false);
  const family = useFontFamily(kind === 'font' ? item.url : '');
  const wave = useWaveform(kind === 'audio' ? item.url : '');

  /* 切换素材时重置播放进度（波形高亮）与解码错误态 */
  useEffect(() => {
    setProgress(0);
    setVideoError(false);
    setThumbFailed(false);
  }, [item.id]);

  /* 读元数据后回写时长/分辨率（只写有变化的，避免每次预览都打库） */
  const patchMeta = (duration: number, width: number, height: number) => {
    const d = Math.round(duration || 0);
    if (d === Math.round(item.duration || 0) && width === item.width && height === item.height) return;
    api
      .patchMedia(item.id, { duration: d, width, height })
      .then((r) => r.image && onReplaceItem?.(r.image))
      .catch(() => undefined);
  };

  const setCoverFromFrame = async () => {
    const v = videoRef.current;
    if (!v || coverBusy) return;
    setCoverBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 640;
      canvas.height = v.videoHeight || 360;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(i18n.t('k6cf6e4bd'));
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
      const r = await api.setCover(item.id, dataUrl, v.currentTime);
      if (r.image) onReplaceItem?.(r.image);
      onToast?.(i18n.t('k042d36e2', { p0: Math.round(v.currentTime) }));
    } catch (err) {
      onToast?.(i18n.t('k55bd00a1', { p0: (err as Error).message }));
    } finally {
      setCoverBusy(false);
    }
  };

  if (kind === 'video') {
    if (videoError) {
      return (
        <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
          <div className="mv-fallback">
            <div className="mv-fallback-icon"><IconFilm size={48} /></div>
            <b>{item.title}</b>
            <p>
              {i18n.t('ka4272407')}
              <br />
              {i18n.t('k29d9cf58')}
            </p>
            <button className="btn" onClick={() => revealFile(item.path)}>
              {i18n.t('ka0f822d9')}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
        <video
          ref={videoRef}
          key={item.id}
          className="mv-video"
          src={item.url}
          controls
          preload="metadata"
          onError={() => {
            setVideoError(true);
            onToast?.(i18n.t('k43c94ac8'));
          }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            patchMeta(v.duration, v.videoWidth, v.videoHeight);
            // 已保存的裁剪区间要真的生效：以前只影响导出，常规播放仍从头到尾，
            // 用户会以为「保存区间」没用。起点在这里跳，终点由 onTimeUpdate 收口。
            const s = Number(item.trimStart || 0);
            if (s > 0 && s < v.duration) v.currentTime = s;
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            const s = Number(item.trimStart || 0);
            const end = Number(item.trimEnd || 0);
            if (end > s && v.currentTime >= end - 0.05) v.pause();
          }}
        />
        <div className="mv-bar">
          <span>{item.width > 0 ? `${item.width} × ${item.height}` : i18n.t('k7ee19436')}</span>
          {Number(item.trimEnd || 0) > Number(item.trimStart || 0) && (
            <span>已保存区间 {Number(item.trimStart || 0).toFixed(1)}–{Number(item.trimEnd || 0).toFixed(1)}s，播放到此自动暂停</span>
          )}
          <span>{formatSize(item.sizeBytes)}</span>
          <button className="btn sm" disabled={coverBusy} onClick={setCoverFromFrame} title={i18n.t('k64c1f9ed')}>
            {coverBusy ? i18n.t('k9b5d32d1') : i18n.t('kd3ac3424')}
          </button>
          {item.coverTs > 0 && (
            <button
              className="btn sm ghost"
              disabled={coverBusy}
              onClick={async () => {
                setCoverBusy(true);
                try {
                  const r = await api.resetCover(item.id);
                  if (r.image) onReplaceItem?.(r.image);
                  onToast?.(i18n.t('k84eae279'));
                } catch (err) {
                  onToast?.(i18n.t('k29923a84', { p0: (err as Error).message }));
                } finally {
                  setCoverBusy(false);
                }
              }}
            >
              {i18n.t('kb7220f6e')}
            </button>
          )}
          <button className="btn sm ghost" onClick={() => revealFile(item.path)}>
            {i18n.t('k69c50ffd')}
          </button>
        </div>
        <VideoTrimExport item={item} videoRef={videoRef} onReplaceItem={onReplaceItem} onToast={onToast} />
      </div>
    );
  }

  /** 通用：把任意 canvas 结果设为封面（GIF 首帧 / 字体当前文案） */
  const applyCover = async (build: () => Promise<string>, tip: string) => {
    if (coverBusy) return;
    setCoverBusy(true);
    try {
      const dataUrl = await build();
      const r = await api.setCover(item.id, dataUrl, 0);
      if (r.image) onReplaceItem?.(r.image);
      onToast?.(tip);
    } catch (err) {
      onToast?.(i18n.t('k55bd00a1', { p0: (err as Error).message }));
    } finally {
      setCoverBusy(false);
    }
  };

  /* 恢复默认缩略图：清掉自定义封面帧，回到素材本身的渲染 */
  const resetCover = async () => {
    setCoverBusy(true);
    try {
      const r = await api.resetCover(item.id);
      if (r.image) onReplaceItem?.(r.image);
      onToast?.(i18n.t('k84eae279'));
    } catch (err) {
      onToast?.(i18n.t('k29923a84', { p0: (err as Error).message }));
    } finally {
      setCoverBusy(false);
    }
  };

  if (kind === 'gif') {
    return (
      <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
        <img className="mv-image" src={item.url} alt={item.title} draggable={false} />
        <div className="mv-bar">
          <span>GIF · {formatSize(item.sizeBytes)}</span>
          <button
            className="btn sm"
            disabled={coverBusy}
            onClick={() => applyCover(() => imageFrameDataUrl(item.url), i18n.t('k018b3ebb'))}
            title={i18n.t('k379683f0')}
          >
            {coverBusy ? i18n.t('k9b5d32d1') : i18n.t('k72425b5f')}
          </button>
          {item.coverTs > 0 && (
            <button className="btn sm ghost" disabled={coverBusy} onClick={resetCover}>
              {i18n.t('kb7220f6e')}
            </button>
          )}
          <button className="btn sm ghost" onClick={() => revealFile(item.path)}>
            {i18n.t('k69c50ffd')}
          </button>
        </div>
      </div>
    );
  }

  if (kind === 'audio') {
    // 还没解出波形时给一条平直的灰条（仅作点击定位用），不伪造起伏
    const bars = wave.peaks.length ? wave.peaks : Array.from({ length: 80 }, () => 0.12);
    const seekByClick = (e: ReactMouseEvent<HTMLDivElement>) => {
      const a = audioRef.current;
      if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      a.currentTime = ratio * a.duration;
    };
    return (
      <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
        <div className="mv-audio">
          <div className="mv-audio-icon"><IconMusic size={44} /></div>
          <div className="mv-audio-title">{item.title}</div>
          <div
            className="mv-wave"
            role="slider"
            tabIndex={0}
            aria-label={i18n.t('k9db047de')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            title={i18n.t('k7feda921')}
            onClick={seekByClick}
            // 键盘可达：左右 5 秒，Home/End 首尾（滑块类控件的常规约定）
            onKeyDown={(e) => {
              const a = audioRef.current;
              if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
              const step = 5;
              if (e.key === 'ArrowRight') a.currentTime = Math.min(a.duration, a.currentTime + step);
              else if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - step);
              else if (e.key === 'Home') a.currentTime = 0;
              else if (e.key === 'End') a.currentTime = a.duration;
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {bars.map((h, i) => (
              <i
                key={i}
                className={i / bars.length <= progress ? 'on' : ''}
                style={{ height: `${Math.max(4, h * 100)}%` }}
              />
            ))}
          </div>
          {wave.status === 'failed' && (
            <div className="hint" style={{ margin: '4px 0 0' }}>
              {i18n.t('kdc30b00b')}
            </div>
          )}
          <audio
            ref={audioRef}
            src={item.url}
            controls
            autoPlay={false}
            onLoadedMetadata={(e) => patchMeta(e.currentTarget.duration, 0, 0)}
            onTimeUpdate={(e) => {
              const a = e.currentTarget;
              if (a.duration > 0) setProgress(a.currentTime / a.duration);
            }}
            onEnded={() => setProgress(0)}
          />
          <div className="mv-bar">
            <span>{item.duration > 0 ? i18n.t('ked6e7d9c', { p0: Math.round(item.duration) }) : i18n.t('k0b9f5dc8')}</span>
            <span>{formatSize(item.sizeBytes)}</span>
            <button className="btn sm ghost" onClick={() => revealFile(item.path)}>
              {i18n.t('k69c50ffd')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (kind === 'font') {
    return (
      <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
        <div className="mv-font">
          <div
            className="mv-font-preview"
            style={{ fontFamily: family ? `"${family}", sans-serif` : undefined, fontSize }}
          >
            {fontText || i18n.t('kec102a04')}
          </div>
          <div className="mv-bar">
            <input
              className="input"
              style={{ flex: 1, minWidth: 180 }}
              value={fontText}
              onChange={(e) => setFontText(e.target.value)}
              placeholder={i18n.t('kf8f999d2')}
            />
            <input
              type="range"
              min={14}
              max={140}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              title={i18n.t('kc661c45d', { p0: fontSize })}
            />
            <span>{item.title}</span>
            <button
              className="btn sm"
              disabled={coverBusy}
              onClick={() =>
                applyCover(() => fontFrameDataUrl(item.url, fontText, { size: fontSize }), i18n.t('k463b202f'))
              }
              title={i18n.t('k8fb8800b')}
            >
              {coverBusy ? i18n.t('k9b5d32d1') : i18n.t('k84263f6f')}
            </button>
            <button className="btn sm ghost" onClick={() => revealFile(item.path)}>
              {i18n.t('k69c50ffd')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* PDF：保留浏览器原生阅读器，另加页码导航（#page=N 是 Chrome/Electron 原生支持的锚点） */
  if (kind === 'pdf') return <PdfViewer item={item} onToast={onToast} />;

  /* EPUB：电子书走阅读器（目录 + 正文 + 插图），别塞进 Office 解析器 */
  if (kind === 'office' && /\.epub$/i.test(item.path || '')) {
    return (
      <div className="mv-wrap mv-epub" onClick={(e) => e.stopPropagation()}>
        <Suspense fallback={<div className="mv-fallback">{i18n.t('k5e6742b3')}</div>}>
          <EpubViewer item={item} onToast={onToast} />
        </Suspense>
      </div>
    );
  }

  /* Office：docx 渲染正文、xlsx 转表格、pptx 给大纲，全部离线解析（见 OfficeViewer） */
  if (kind === 'office') {
    return (
      <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
        <Suspense fallback={<div className="mv-fallback">{i18n.t('k660ce95d')}</div>}>
          <OfficeViewer item={item} onToast={onToast} />
        </Suspense>
        <div className="mv-bar">
          <span>{item.title}</span>
          <button className="btn sm ghost" onClick={() => revealFile(item.path)}>
            {i18n.t('k69c50ffd')}
          </button>
        </div>
      </div>
    );
  }

  /* 设计文件 / RAW：浏览器渲染不了原文件，但入库时已把文件内嵌的预览图抽成缩略图。
   * 有些文件压根没写内嵌预览（或解析失败），这时不能说「文件缺失」——文件好端端在磁盘上。 */
  if (kind === 'design' || kind === 'raw') {
    const kindLabel = kind === 'raw' ? 'RAW' : i18n.t('kfdb21fa1');
    const ext = (item.title.split('.').pop() || '').toUpperCase();
    return (
      <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
        {thumbFailed ? (
          <div className="mv-fallback">
            <div className="mv-fallback-icon">{kind === 'raw' ? <IconCamera size={48} /> : <IconPalette size={48} />}</div>
            <b>{item.title}</b>
            <p>
              这个 {kindLabel} 文件里没有可显示的内嵌预览图
              <br />
              文件本身正常{ext ? `（${ext}）` : ''}，可用原软件打开查看或编辑。
            </p>
            <button className="btn" onClick={() => revealFile(item.path)}>
              {i18n.t('ka0f822d9')}
            </button>
          </div>
        ) : (
          <img
            src={item.thumbUrl}
            alt={item.title}
            draggable={false}
            onError={() => setThumbFailed(true)}
            style={{ maxWidth: '92vw', maxHeight: '80vh', objectFit: 'contain', borderRadius: 8 }}
          />
        )}
        <div className="mv-bar">
          <span>
            {item.title}
            {item.width > 0 ? ` · ${item.width}×${item.height}` : ''} · {formatSize(item.sizeBytes)}
            {!thumbFailed && <span style={{ opacity: 0.6 }}> {i18n.t('k8ca2a856')}</span>}
          </span>
          <button className="btn sm ghost" onClick={() => revealFile(item.path)}>
            {i18n.t('ka0f822d9')}
          </button>
        </div>
      </div>
    );
  }

  /* 3D 模型：three.js 按需加载，拖拽旋转 / 滚轮缩放 / 右键平移 */
  if (kind === 'model') {
    return (
      <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
        <ModelViewer item={item} onToast={onToast} />
        <div className="mv-bar">
          <span>
            {item.title} · {formatSize(item.sizeBytes)}
          </span>
          <button className="btn sm ghost" onClick={() => revealFile(item.path)}>
            {i18n.t('k69c50ffd')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mv-wrap" onClick={(e) => e.stopPropagation()}>
      <div className="mv-fallback">
        <div className="mv-fallback-icon"><IconBox size={48} /></div>
        <b>{item.title}</b>
        <p>
          文件：{formatSize(item.sizeBytes)}
          <br />
          {i18n.t('k2d5d6742')}
        </p>
        <button className="btn" onClick={() => revealFile(item.path)}>
          {i18n.t('ka0f822d9')}
        </button>
      </div>
    </div>
  );
}
