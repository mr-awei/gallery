import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, getStoredTheme } from './theme';
import { watchUiScale } from './lib/screen-scale';
import './styles.css';

// 渲染前先定好主题，避免启动瞬间闪成暗色
applyTheme(getStoredTheme());
// 弹窗尺寸系数：按屏幕分辨率算一次，之后跟随窗口 resize
watchUiScale();

/**
 * 全局兜底：事件回调、定时器、未被 catch 的 await 抛错时，React 的错误边界
 * 是接不到的 —— 以前这些错只会出现在 DevTools 控制台，用户侧表现为「点了没反应」。
 * 这里统一转成 `tuku:error` 事件，由 App 用 toast 呈现，并保留原始堆栈方便排查。
 */
function reportError(message: string, detail?: unknown) {
  console.error('[uncaught]', detail ?? message);
  window.dispatchEvent(new CustomEvent('tuku:error', { detail: message }));
}

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { message?: string } | string | undefined;
  const msg = typeof reason === 'string' ? reason : reason?.message || '未知错误';
  reportError(msg, e.reason);
});

window.addEventListener('error', (e) => {
  // 资源加载失败（img/script）也会触发 error，但它们的 error 为空、target 是元素；
  // 那种情况由对应的组件自己兜底，这里只处理真正的运行时异常
  if (!e.error) return;
  reportError((e.error as Error)?.message || '脚本异常', e.error);
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
