/// <reference lib="webworker" />
/**
 * GIF 编码 Worker：把逐帧 getImageData + LZW 编码从主线程挪开，
 * 长片段导出时不再卡 UI。主线程只负责 seek 视频 + createImageBitmap，
 * 把 ImageBitmap 用 transfer 传进来，这里画到 OffscreenCanvas 取像素再编码。
 */
import { encodeGif, type GifFrame } from './gif';

interface FrameInput {
  width: number;
  height: number;
  bitmap: ImageBitmap;
  delayMs: number;
}
interface EncodeRequest {
  type: 'encode';
  frames: FrameInput[];
  options?: { loop?: number };
}

self.onmessage = (e: MessageEvent<EncodeRequest>) => {
  const msg = e.data;
  if (!msg || msg.type !== 'encode') return;
  try {
    const gifFrames: GifFrame[] = msg.frames.map((f) => {
      const canvas = new OffscreenCanvas(f.width, f.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('worker 无法创建离屏画布');
      ctx.drawImage(f.bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, f.width, f.height).data;
      f.bitmap.close();
      return { width: f.width, height: f.height, data, delayMs: f.delayMs };
    });
    const bytes = encodeGif(gifFrames, msg.options);
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'done', bytes }, [bytes.buffer]);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
