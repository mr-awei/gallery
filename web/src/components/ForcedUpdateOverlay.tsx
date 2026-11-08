import React, { useEffect, useState } from 'react';
import { desktop, quiet, type UpdateState } from '../api';

/**
 * 更新就绪提示层。
 *
 * 只在一个时刻出现：**更新包已经下载到本地、可以立刻安装**时。
 * 检查与下载都在后台静默进行，用户照常使用，不会卡在「正在检查/正在下载」的遮罩上。
 *
 * 装不上时给出口：安装程序启动失败会显示「重试安装 / 本次先继续用」，
 * 避免用户被锁死在一个永远装不上的状态（下次启动仍会重新检查）。
 */
export default function ForcedUpdateOverlay() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!desktop?.updateState) return;
    let alive = true;
    desktop
      .updateState()
      .then((s) => {
        // 主进程可能在本组件挂载前就已经下载完成，先补一次快照
        if (alive) setState(s);
      })
      .catch(quiet);
    const off = desktop.onUpdateState?.((s) => setState(s));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  if (!state?.ready || state.dismissed) return null;

  const failed = state.status === 'error';
  const version = state.version || '新版本';
  const current = state.current || '';

  const retryInstall = async () => {
    setBusy(true);
    try {
      const r = await desktop?.updateInstall?.();
      if (r && !r.ok) {
        setState((s) => (s ? { ...s, status: 'error', error: r.msg || '安装未能启动' } : s));
      }
    } catch (err) {
      setState((s) =>
        s ? { ...s, status: 'error', error: (err as Error).message || '安装未能启动' } : s
      );
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    try {
      await desktop?.updateDismiss?.();
    } catch {
      /* 主进程没响应就只是关不掉，不影响继续用 */
    }
    setState((s) => (s ? { ...s, dismissed: true } : s));
  };

  return (
    <div style={overlayStyle} role="alertdialog" aria-modal="true" aria-label="应用更新">
      <div style={cardStyle}>
        <div style={badgeStyle}>图库</div>
        <h1 style={titleStyle}>{failed ? '更新安装未能启动' : '新版本已就绪'}</h1>
        <p style={descStyle}>
          新版本 <b style={strongStyle}>v{version}</b>
          {current ? `（当前 v${current}）` : ''} 已下载完成
          {failed ? '，但安装程序没能启动。' : '，正在重启安装，请稍候。'}
        </p>

        {!failed && (
          <>
            <div style={barWrapStyle}>
              <div style={{ ...barStyle, width: '100%' }} />
            </div>
            <div style={hintStyle}>更新包已在本地，无需再次下载</div>
          </>
        )}

        {failed && (
          <>
            <p style={errorStyle}>{state.error || '安装程序未能启动'}</p>
            <div style={rowStyle}>
              <button type="button" style={primaryBtnStyle} disabled={busy} onClick={retryInstall}>
                {busy ? '正在启动…' : '重试安装'}
              </button>
              <button type="button" style={ghostBtnStyle} onClick={dismiss}>
                本次先继续用
              </button>
            </div>
          </>
        )}

        <div style={footStyle}>
          {failed
            ? state.degraded
              ? '已连续多次装不上，强制更新已自动关闭：选择「本次先继续用」即可照常使用，下次启动也不会再被遮挡。想重试请到「设置 → 检查更新」手动触发，或退出后手动运行安装包。'
              : '选择「本次先继续用」后可以照常使用，下次启动会再次尝试安装；也可以退出应用后手动运行安装包。'
            : '安装过程会关闭并重新打开应用，图库数据不受影响。'}
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
