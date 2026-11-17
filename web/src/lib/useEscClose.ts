import { useEffect } from 'react';

/**
 * 弹窗按 Esc 关闭。
 *
 * 用捕获阶段 + stopPropagation：全局快捷键（Delete / 空格 / F / Esc 清选择）挂在
 * window 冒泡阶段，不拦住的话「关弹窗」会和「删掉背后的选中项」同时发生。
 */
export function useEscClose(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, enabled]);
}
