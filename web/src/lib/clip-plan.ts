/** 视频片段抽帧的纯计算部分：不碰 DOM / API，方便单测直接跑。 */

/**
 * 算出实际要抓取的时间点。
 * 帧数超上限时等距抽稀（而不是截掉尾部），保证首尾都在、时长比例不变。
 */
export function planFrameTimes(startSec: number, endSec: number, fps: number, maxFrames = 120): number[] {
  const s = Math.max(0, Number(startSec) || 0);
  const e = Math.max(s, Number(endSec) || 0);
  const f = Math.max(1, Math.min(30, Number(fps) || 8));
  const cap = Math.max(1, Math.floor(maxFrames) || 120);
  if (e <= s) return [s];
  const count = Math.max(1, Math.min(cap, Math.ceil((e - s) * f)));
  const step = (e - s) / count;
  return Array.from({ length: count }, (_, i) => Math.round((s + i * step) * 1000) / 1000);
}

/** 每帧实际停留时间（抽稀后要相应变长，否则 GIF 播放会变快） */
export function frameDelayMs(times: number[], endSec: number): number {
  if (times.length < 2) return 100;
  return Math.max(20, Math.round(((endSec - times[0]) * 1000) / times.length));
}
