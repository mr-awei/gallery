/**
 * 视频「扫帧」预览：把 N 个时间点的画面拼成一张雪碧图，hover 时按鼠标位置切换。
 *
 * 为什么在浏览器里做：抽帧要么上 ffmpeg（体积与分发风险大），要么依赖服务端转码；
 * 而 <video> + canvas 本来就能取帧。代价是只在鼠标真的悬停时才解码，
 * 一张雪碧图按 URL 缓存，同一张卡反复 hover 不重复解码。
 */

export interface SpriteResult {
  /** 雪碧图 dataURL（横向 N 帧） */
  url: string;
  frames: number;
  /** 视频时长（秒），0 表示未知 */
  duration: number;
}

const cache = new Map<string, SpriteResult>();
const inflight = new Map<string, Promise<SpriteResult | null>>();
const MAX_CACHE = 60;

function pickFrameTimes(duration: number, frames: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0.1];
  // 跳过片头片尾各 4%：很多片子开头是黑场、结尾是台标
  const start = duration * 0.04;
  const end = duration * 0.96;
  const step = (end - start) / Math.max(1, frames - 1);
  return Array.from({ length: frames }, (_, i) => start + step * i);
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
      reject(new Error('视频抽帧失败'));
    };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    try {
      video.currentTime = time;
    } catch (err) {
      fail();
    }
    // 某些容器不触发 seeked：给一个兜底，避免 hover 永远等不到结果
    setTimeout(done, 1200);
  });
}

/** 抓取雪碧图；失败返回 null（调用方回退到首帧海报，不报错） */
export function captureVideoSprite(url: string, frames = 6): Promise<SpriteResult | null> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(url);
  if (running) return running;

  const task = (async (): Promise<SpriteResult | null> => {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    try {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('视频无法加载')), { once: true });
        setTimeout(() => reject(new Error('视频加载超时')), 8000);
      });
      const duration = video.duration || 0;
      const times = pickFrameTimes(duration, frames);
      const w = Math.min(480, video.videoWidth || 320);
      const h = Math.round((w * (video.videoHeight || 180)) / (video.videoWidth || 320));
      const canvas = document.createElement('canvas');
      canvas.width = w * times.length;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      for (let i = 0; i < times.length; i++) {
        await seek(video, times[i]);
        ctx.drawImage(video, i * w, 0, w, h);
      }
      const result: SpriteResult = { url: canvas.toDataURL('image/jpeg', 0.72), frames: times.length, duration };
      if (cache.size >= MAX_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(url, result);
      return result;
    } catch {
      return null;
    } finally {
      video.removeAttribute('src');
      video.load();
      inflight.delete(url);
    }
  })();

  inflight.set(url, task);
  return task;
}

/** 鼠标横向位置（0~1）→ 第几帧 */
export function frameIndexAt(ratio: number, frames: number): number {
  const r = Math.min(0.9999, Math.max(0, ratio));
  return Math.floor(r * frames);
}
