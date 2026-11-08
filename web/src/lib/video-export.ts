/**
 * 视频片段抽取（首尾裁剪）。
 *
 * 项目不引入 ffmpeg，浏览器原生能力就够了：
 *  - GIF：隐藏 <video> 逐个 seek 到目标时间点，canvas 抓 RGBA 帧，交给 gif.ts 编码
 *  - WebM：canvas.captureStream(fps) + MediaRecorder 实时录制目标区间（真正的视频片段）
 * 抽帧 / 录制都在独立的隐藏 video 上进行，不会打断灯箱里正在播放的那个 <video>。
 */
import { desktop } from '../api';
import { encodeGif } from './gif';
import { frameDelayMs, planFrameTimes } from './clip-plan';

/** 单帧：主线程已 seek 好并抽成 ImageBitmap，交由 Worker 取像素 + 编码 */
export interface GifCapture {
  width: number;
  height: number;
  bitmap: ImageBitmap;
  delayMs: number;
}

export { frameDelayMs, planFrameTimes } from './clip-plan';

export interface ClipRange {
  startSec: number;
  endSec: number;
  fps: number;
  width: number;
  /** 抽取帧数上限，避免长视频把内存吃光 */
  maxFrames?: number;
  onProgress?: (done: number, total: number) => void;
}

function sizeFor(video: HTMLVideoElement, width: number) {
  const w = Math.max(16, Math.min(1280, Math.round(width) || 480));
  const h = Math.max(16, Math.round((w * (video.videoHeight || 9)) / (video.videoWidth || 16)));
  return { width: w, height: h };
}

interface HiddenVideo {
  video: HTMLVideoElement;
  release: () => void;
}

/** 造一个与主播放器无关的隐藏 <video>，并等元数据就绪 */
async function openHiddenVideo(src: string): Promise<HiddenVideo> {
  const video = document.createElement('video');
  video.src = src;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  // 不设 crossOrigin：素材来自同源本地服务，设置了反而可能让 canvas 被判为污染而无法抓帧
  const release = () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('视频元数据读取超时（编码可能不受支持）')), 15000);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.addEventListener('loadedmetadata', done, { once: true });
    video.addEventListener(
      'error',
      () => {
        window.clearTimeout(timer);
        reject(new Error('视频无法解码（不支持的编码或文件已损坏）'));
      },
      { once: true }
    );
  });
  return { video, release };
}

async function seekTo(video: HTMLVideoElement, t: number) {
  if (Math.abs(video.currentTime - t) < 0.008) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`跳转到第 ${t.toFixed(1)} 秒超时`));
    }, 10000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('跳转时解码失败'));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try {
      video.currentTime = t;
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** 按时间点序列抓帧：主线程只 seek + 抽成 ImageBitmap（不取像素），像素与编码交给 Worker */
export async function captureFrames(src: string, opts: ClipRange): Promise<GifCapture[]> {
  const { video, release } = await openHiddenVideo(src);
  try {
    const times = planFrameTimes(opts.startSec, opts.endSec, opts.fps, opts.maxFrames);
    const { width, height } = sizeFor(video, opts.width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建画布');
    const frames: GifCapture[] = [];
    const delayMs = frameDelayMs(times, opts.endSec);
    for (let i = 0; i < times.length; i++) {
      await seekTo(video, Math.min(times[i], Math.max(0, (video.duration || Infinity) - 0.05)));
      ctx.drawImage(video, 0, 0, width, height);
      const bitmap = await createImageBitmap(canvas);
      frames.push({ width, height, bitmap, delayMs });
      opts.onProgress?.(i + 1, times.length);
    }
    return frames;
  } finally {
    release();
  }
}

/**
 * 在 Worker 里完成逐帧 getImageData + LZW 编码（长片段不再卡主线程）。
 * 没有 Worker / OffscreenCanvas 的极端环境回落到主线程编码。
 */
export async function encodeGifWorker(frames: GifCapture[], options: { loop?: number } = {}): Promise<Uint8Array> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return encodeGifMain(frames, options);
  }
  const payload = frames.map((f) => ({ width: f.width, height: f.height, bitmap: f.bitmap, delayMs: f.delayMs }));
  const transfers = payload.map((f) => f.bitmap as unknown as Transferable);
  return new Promise<Uint8Array>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./gif.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      encodeGifMain(frames, options).then(resolve, reject);
      return;
    }
    worker.onmessage = (
      e: MessageEvent<{ type: string; bytes?: Uint8Array; message?: string }>
    ) => {
      const m = e.data;
      if (m.type === 'done' && m.bytes) {
        resolve(m.bytes);
        worker.terminate();
      } else {
        reject(new Error(m.message || 'GIF 编码失败'));
        worker.terminate();
      }
    };
    worker.onerror = (err) => {
      reject(new Error(err.message || 'GIF 编码线程出错'));
      worker.terminate();
    };
    worker.postMessage({ type: 'encode', frames: payload, options }, transfers);
  });
}

/** 主线程兜底编码（仅在无法创建 Worker 时使用） */
async function encodeGifMain(frames: GifCapture[], options: { loop?: number } = {}): Promise<Uint8Array> {
  const gifFrames = frames.map((f) => {
    const canvas = document.createElement('canvas');
    canvas.width = f.width;
    canvas.height = f.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.drawImage(f.bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, f.width, f.height).data;
    f.bitmap.close();
    return { width: f.width, height: f.height, data, delayMs: f.delayMs };
  });
  return encodeGif(gifFrames, options);
}

/** 用 MediaRecorder 录制裁剪区间，产出 webm Blob（无 ffmpeg 的原生视频片段导出） */
export async function recordClip(src: string, opts: ClipRange): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') throw new Error('当前环境不支持 MediaRecorder');
  const { video, release } = await openHiddenVideo(src);
  let stream: MediaStream | null = null;
  try {
    const start = Math.max(0, opts.startSec);
    const duration = Math.max(0.1, opts.endSec - start);
    const { width, height } = sizeFor(video, opts.width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    const fps = Math.max(1, Math.min(30, opts.fps));
    stream = canvas.captureStream(fps);
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const finished = new Promise<Blob>((resolve, reject) => {
      rec.onstop = () => {
        if (!chunks.length) reject(new Error('录制没有产生数据'));
        else resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
      };
      rec.onerror = () => reject(new Error('录制失败'));
    });
    // play() 失败等路径会直接拒绝外层 Promise，此时没人 await finished；
    // 先挂一个空 catch，避免「录制没有产生数据」变成未处理的 Promise 拒绝。
    void finished.catch(() => {});

    let raf = 0;
    const draw = () => {
      if (!video.paused && !video.ended) ctx.drawImage(video, 0, 0, width, height);
      raf = requestAnimationFrame(draw);
    };
    return await new Promise<Blob>((resolve, reject) => {
      let stopped = false;
      // 函数声明提升：stop() 可能先于 onTime 赋值执行（超时路径），引用不会踩 TDZ
      function onTime() {
        const elapsed = video.currentTime - start;
        opts.onProgress?.(Math.min(1, Math.max(0, elapsed / duration)), 1);
        if (video.currentTime >= opts.endSec - 0.02 || video.ended) void stop();
      }
      const stop = async () => {
        if (stopped) return; // 超时与 timeupdate 可能同时到达，只能结算一次
        stopped = true;
        window.clearTimeout(watchdog);
        cancelAnimationFrame(raf);
        video.removeEventListener('timeupdate', onTime);
        video.pause();
        try {
          if (rec.state !== 'inactive') rec.stop();
          resolve(await finished);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      const watchdog = window.setTimeout(() => {
        // 超时兜底：某些编码跳转后不推进 currentTime。必须走同一个 stop()
        // 结算 finished，否则外层 Promise 永远挂着（以前这里只调 rec.stop()）。
        void stop();
      }, (duration + 12) * 1000);
      video.addEventListener('timeupdate', onTime);
      rec.start(250);
      draw();
      video.currentTime = start;
      video
        .play()
        .then(() => {
          if (video.currentTime >= opts.endSec - 0.02) void stop();
        })
        .catch((err) => {
          stopped = true;
          window.clearTimeout(watchdog);
          cancelAnimationFrame(raf);
          video.removeEventListener('timeupdate', onTime);
          try {
            if (rec.state !== 'inactive') rec.stop();
          } catch {
            /* 已经停了 */
          }
          reject(new Error(`无法播放视频：${err?.message || err}`));
        });
    });
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    release();
  }
}

/** 导出产物保存：桌面端经 IPC 弹「另存为」，网页端回落 a[download] */
export async function saveExport(dataUrl: string, filename: string): Promise<string> {
  if (desktop?.saveExport) {
    const r = await desktop.saveExport({ dataUrl, filename });
    if (!r?.ok) throw new Error(r?.error || '保存失败');
    return r.path || filename;
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return filename;
}
