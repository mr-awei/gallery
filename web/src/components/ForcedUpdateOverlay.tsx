import React, { useEffect, useState } from 'react';
import { desktop, quiet, type UpdateState } from '../api';

/**
 * 强制更新遮罩。
 *
 * 主进程确认「有新版本」后广播 force=true，这层全屏遮罩接管界面：
 * 没有关闭按钮、没有「稍后再说」，下载完自动重启安装。
 * 只有一种情况给出口 —— 下载/安装反复失败，那时允许重试或退出应用，
 * 否则用户会被永久挡在一个什么也干不了的黑屏上。
 */
const VISIBLE: UpdateState['status'][] = ['available', 'downloading', 'downloaded', 'error'];

export default function ForcedUpdateOverlay() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!desktop?.updateState) return;
    let alive = true;
    desktop
      .updateState()
      .then((s) => {
        // 主进程可能在本组件挂载前就已经检查出结果，先补一次快照
        if (alive) setState(s);
      })
      .catch(quiet);
    const off = desktop.onUpdateState?.((s) => setState(s));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  if (!desktop || !state?.force || !state.status || !VISIBLE.includes(state.status)) return null;

  const { status } = state;
  const percent = Math.max(0, Math.min(100, Number(state.percent) || 0));
  const shown = status === 'downloaded' ? 100 : percent;
  const version = state.version || '新版本';
  const current = state.current || '';

  const hint =
    status === 'downloaded'
      ? '下载完成，正在重启安装…'
      : status === 'downloading'
        ? `${percent}% · 正在下载安装包`
        : status === 'available'
          ? '正在准备下载…'
          : '更新中断';

  const retry = async () => {
    setRetrying(true);
    try {
      // 主进程此时仍是强制模式：重新检查到新版会自动开始下载
      const r = await desktop?.updateCheck?.();
      if (!r?.ok) {
        setState((s) => (s ? { ...s, status: 'error', error: r?.msg || '检查更新失败' } : s));
      }
    } catch (err) {
      setState((s) => (s ? { ...s, status: 'error', error: (err as Error).message } : s));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div style={overlayStyle} role="alertdialog" aria-modal="true" aria-label="应用更新">
      <div style={cardStyle}>
        <div style={badgeStyle}>图库</div>
        <h1 style={titleStyle}>需要更新后才能继续使用</h1>
        <p style={descStyle}>
          发现新版本 <b style={strongStyle}>v{version}</b>
          {current ? `（当前 v${current}）` : ''}，正在自动升级，请稍候。
        </p>

        <div style={barWrapStyle}>
          <div style={{ ...barStyle, width: `${shown}%` }} />
        </div>
        <div style={hintStyle}>{hint}</div>

        {status === 'error' && (
          <>
            <p style={errorStyle}>{state.error || '更新下载失败'}</p>
            <div style={rowStyle}>
              <button type="button" style={primaryBtnStyle} disabled={retrying} onClick={retry}>
                {retrying ? '重试中…' : '重试'}
              </button>
              <button type="button" style={ghostBtnStyle} onClick={() => void desktop?.quit?.()}>
                退出应用
              </button>
            </div>
          </>
        )}

        <div style={footStyle}>
          为保证数据与新功能一致，旧版本不再提供使用入口。更新完成后应用会自动重新打开。
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'radial-gradient(1200px 600px at 50% 0%, #1d2033 0%, #0a0a12 60%)',
  // 遮罩固定深色：无论用户当前是亮色还是暗色主题，这一层都要一眼看出「被锁住了」
  color: '#e8e8f0',
  fontFamily: 'inherit',
};

const cardStyle: React.CSSProperties = {
  width: 'min(440px, calc(100vw - 48px))',
  padding: '36px 32px 28px',
  borderRadius: 18,
  background: 'rgba(24, 26, 38, 0.92)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)',
  textAlign: 'center',
};

const badgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 56,
  height: 56,
  padding: '0 12px',
  borderRadius: 14,
  background: 'linear-gradient(135deg, #4f6bff, #8b5cf6)',
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: 1,
  color: '#fff',
};

const titleStyle: React.CSSProperties = {
  margin: '18px 0 8px',
  fontSize: 20,
  fontWeight: 700,
};

const descStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.7,
  color: 'rgba(232, 232, 240, 0.72)',
};

const strongStyle: React.CSSProperties = { color: '#fff' };

const barWrapStyle: React.CSSProperties = {
  height: 6,
  margin: '22px 0 10px',
  borderRadius: 999,
  background: 'rgba(255, 255, 255, 0.1)',
  overflow: 'hidden',
};

const barStyle: React.CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: 'linear-gradient(90deg, #4f6bff, #a78bfa)',
  transition: 'width 0.25s ease',
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'rgba(232, 232, 240, 0.6)',
  fontVariantNumeric: 'tabular-nums',
};

const errorStyle: React.CSSProperties = {
  margin: '14px 0 0',
  fontSize: 12,
  lineHeight: 1.6,
  color: '#ff9a9a',
  wordBreak: 'break-all',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  justifyContent: 'center',
  marginTop: 16,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '9px 20px',
  borderRadius: 10,
  border: 'none',
  background: 'linear-gradient(135deg, #4f6bff, #7c6bff)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const ghostBtnStyle: React.CSSProperties = {
  padding: '9px 18px',
  borderRadius: 10,
  border: '1px solid rgba(255, 255, 255, 0.16)',
  background: 'transparent',
  color: 'rgba(232, 232, 240, 0.8)',
  fontSize: 13,
  cursor: 'pointer',
};

const footStyle: React.CSSProperties = {
  marginTop: 20,
  paddingTop: 16,
  borderTop: '1px solid rgba(255, 255, 255, 0.07)',
  fontSize: 11,
  lineHeight: 1.7,
  color: 'rgba(232, 232, 240, 0.42)',
};
