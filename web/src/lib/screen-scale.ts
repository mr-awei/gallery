/**
 * 按屏幕分辨率给弹窗定尺寸系数（写进根节点 CSS 变量 --ui-scale）。
 *
 * 之前所有对话框都写死 640~880px，1080p 上只占半屏、2K/4K 上像张邮票。
 * 系数同时受两个约束：
 * - 屏幕：以 1440×900 为基准，2K/4K 放大但封顶 1.55；
 * - 窗口：留 120px 边距，别让放大后的卡片顶到窗口边缘（CSS 里还有 width:100% 兜底）。
 * 只放大不缩小 —— 窗口很小时弹窗已经自适应撑满，再缩字会挤成一团。
 */
const BASE_W = 1440;
const BASE_H = 900;
const MAX_SCALE = 1.55;
/** 卡片的设计基准宽度（modal-card 默认 760、最大的 1080，按 1080 算窗口余量） */
const DESIGN_W = 1080;

export function computeUiScale(): number {
  const screenW = window.screen?.availWidth || window.innerWidth || BASE_W;
  const screenH = window.screen?.availHeight || window.innerHeight || BASE_H;
  const byScreen = Math.min(screenW / BASE_W, screenH / BASE_H);
  const byWindow = (window.innerWidth - 120) / DESIGN_W;
  const raw = Math.min(byScreen, byWindow);
  return Math.min(MAX_SCALE, Math.max(1, Number(raw.toFixed(3)) || 1));
}

export function applyUiScale(): number {
  const scale = computeUiScale();
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  return scale;
}

/** 启动时调用一次并跟随窗口尺寸变化；返回取消函数 */
export function watchUiScale(): () => void {
  applyUiScale();
  let raf = 0;
  const onResize = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => applyUiScale());
  };
  window.addEventListener('resize', onResize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
  };
}
