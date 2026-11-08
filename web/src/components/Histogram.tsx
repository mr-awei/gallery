import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdjustParams } from '../types';
import { renderPixels } from '../lib/adjust';

interface Bins {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
}

interface Sample {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

interface Props {
  /** 预览图地址（同源，才能读像素） */
  src: string;
  /** 当前调色参数：直方图显示的是「调色后」的分布 */
  params: AdjustParams;
  height?: number;
}

/** 原图缩到 240px 宽取样（够准且不占内存） */
function sampleImage(img: HTMLImageElement): Sample | null {
  const S = 240;
  const cw = Math.max(1, Math.min(S, img.naturalWidth));
  const ch = Math.max(1, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * cw));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, cw, ch);
  const imgData = ctx.getImageData(0, 0, cw, ch);
  return { data: imgData.data, w: cw, h: ch };
}

/** 统计调色后的分布 */
function buildBins(data: Uint8ClampedArray): Bins {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 24) continue; // 透明区域不计入
    const R = data[i];
    const G = data[i + 1];
    const B = data[i + 2];
    r[R]++;
    g[G]++;
    b[B]++;
    luma[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
  }
  return { r, g, b, luma };
}

/**
 * RGB 直方图：红/绿/蓝三通道叠加 + 亮度底衬。
 * 直接跑与后端同一套像素管线，所以色相/饱和度这类非 LUT 调整也能反映出来。
 */
export default function Histogram({ src, params, height = 96 }: Props) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let dead = false;
    setSample(null);
    setError('');
    if (!src) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (dead) return;
      const s = sampleImage(img);
      if (s) setSample(s);
      else setError('无法读取像素');
    };
    img.onerror = () => {
      if (!dead) setError('图片加载失败');
    };
    img.src = src;
    return () => {
      dead = true;
    };
  }, [src]);

  const bins = useMemo(() => {
    if (!sample) return null;
    const data = new Uint8ClampedArray(sample.data);
    renderPixels(data, 4, params);
    return buildBins(data);
  }, [sample, params]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !bins) return;
    const W = 256;
    const H = height;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 网格：四分格
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const x = Math.round((W * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    const chans = [
      { bins: bins.luma, fill: 'rgba(255,255,255,0.14)', stroke: 'rgba(255,255,255,0.35)' },
      { bins: bins.r, fill: 'rgba(255,72,72,0.42)', stroke: 'rgba(255,110,110,0.85)' },
      { bins: bins.g, fill: 'rgba(70,220,110,0.42)', stroke: 'rgba(110,240,150,0.85)' },
      { bins: bins.b, fill: 'rgba(70,140,255,0.42)', stroke: 'rgba(120,175,255,0.9)' },
    ];

    // 汇总峰值：加总后的分布再归一化，三通道整体不被单通道尖峰吃掉
    let peak = 1;
    for (let i = 0; i < 256; i++) {
      const v = chans[1].bins[i] + chans[2].bins[i] + chans[3].bins[i];
      if (v > peak) peak = v;
    }
    const y = (n: number) => H - Math.sqrt(Math.min(1, n / peak)) * (H - 2) - 1;

    for (const c of chans) {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        // 每 2 个 bin 取平均，抹掉逐像素锯齿
        const n = (c.bins[i] + (c.bins[i + 1] || 0)) / 2;
        ctx.lineTo(i + 0.5, y(n));
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = c.fill;
      ctx.fill();
      ctx.strokeStyle = c.stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }, [bins, height]);

  return (
    <div className="cr-hist" style={{ height }}>
      <canvas ref={canvasRef} className="cr-hist-canvas" />
      <span className="cr-hist-tag">RGB</span>
      {!bins && <span className="cr-hist-empty">{error || (src ? '分析中…' : '无预览图')}</span>}
    </div>
  );
}
