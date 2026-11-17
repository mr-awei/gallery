import React, { useEffect, useState } from 'react';
import { desktop, quiet, type UpdateState } from '../api';
import i18n from '../i18n';

/**
 * 更新提示层。
 *
 * 三种形态：
 *  1. 普通（刚下载完）——**由用户二选一**：「立即安装并重启」/「下次打开时安装」。
 *     不再像以前那样 1.2 秒后自动重启，用户手里的活不会被打断。
 *  2. 延后到期（上次选了「下次打开时安装」，这次启动）——必须先装完：
 *     下载期间整页遮挡并显示进度（不许一边用旧版一边等），装不上时只给
 *     「重试安装 / 退出应用」，没有「继续用」。
 *  3. 安装失败——普通态下仍保留「本次先继续用」这个出口；
 *     连续失败多次由主进程降级成非强制（此时不会再次遮挡）。
 */
export default function ForcedUpdateOverlay() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  // 这不是普通弹窗，用户可能正在别处敲键盘：出现即把焦点移到卡片上，
  // 否则读屏只念一句 role=alertdialog，后面 Tab 却从背后的图库开始走。
  useEffect(() => {
    if (state) cardRef.current?.focus({ preventScroll: true });
  }, [state?.ready, state?.mandatory, state?.status]);

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

  if (!state) return null;

  const mandatory = !!state.mandatory;
  const ready = !!state.ready;
  // 延后到期时，下载/检查阶段也要遮挡（否则等于让人继续用旧版）
  if (!ready && !mandatory) return null;
  if (!mandatory && state.dismissed) return null;

  const failed = state.status === 'error';
  const version = state.version || state.deferredVersion || i18n.t('kb6c4f3de');
  const current = state.current || '';

  const retryInstall = async () => {
    setBusy(true);
    try {
      const r = await desktop?.updateInstall?.();
      if (r && !r.ok) {
        setState((s) => (s ? { ...s, status: 'error', error: r.msg || i18n.t('k585af0a0') } : s));
      }
    } catch (err) {
      setState((s) =>
        s ? { ...s, status: 'error', error: (err as Error).message || i18n.t('k585af0a0') } : s
      );
    } finally {
      setBusy(false);
    }
  };

  /** 下载/检查失败后的重试：知道具体版本就直接重下，否则重新检查 */
  const retryPrepare = async () => {
    setBusy(true);
    try {
      if (state.version) await desktop?.updateDownload?.();
      else await desktop?.updateCheck?.();
    } catch {
      /* 失败态已经有文案，重试失败不额外打扰 */
    } finally {
      setBusy(false);
    }
  };

  /** 「立即安装并重启」 */
  const installNow = async () => {
    await retryInstall();
  };

  /** 「下次打开时安装」：本次放行，下次启动必须先装完 */
  const defer = async () => {
    setBusy(true);
    try {
      const r = await desktop?.updateDefer?.();
      if (r && !r.ok) {
        setState((s) => (s ? { ...s, status: 'error', error: r.msg || i18n.t('k60df9707') } : s));
        return;
      }
      setState((s) => (s ? { ...s, dismissed: true, deferred: true, mandatory: false } : s));
    } catch (err) {
      setState((s) =>
        s ? { ...s, status: 'error', error: (err as Error).message || i18n.t('k60df9707') } : s
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

  const quit = () => {
    void desktop?.quit?.().catch(quiet);
  };

  /* ------------------------------ 文案 ------------------------------ */

  const title = !ready
    ? i18n.t('ke4daa83b')
    : failed
      ? i18n.t('ka6f1f643')
      : mandatory
        ? i18n.t('k563e44d5')
        : i18n.t('k91630c33');

  const desc = !ready
    ? i18n.t('k1fc14b7f', { p0: version, p1: current ? i18n.t('k5b5df527', { p0: current }) : '' })
    : failed
      ? i18n.t('k0728a96d', { p0: version })
      : mandatory
        ? i18n.t('k6d41f582', { p0: version })
        : i18n.t('k2de06a98', { p0: version, p1: current ? i18n.t('k5b5df527', { p0: current }) : '' });

  const progress = Math.max(0, Math.min(100, state.percent || 0));

  return (
    <div style={overlayStyle} role="alertdialog" aria-modal="true" aria-label={i18n.t('k3f91e9b8')}>
      <div style={cardStyle} ref={cardRef} tabIndex={-1}>
        <div style={badgeStyle}>{i18n.t('k6084bc4b')}</div>
        <h1 style={titleStyle}>{title}</h1>
        <p style={descStyle}>{desc}</p>

        {/* 延后到期：下载阶段给进度，别让人对着空白遮罩等 */}
        {!ready && (
          <>
            <div
              style={barWrapStyle}
              role="progressbar"
              aria-label={i18n.t('k64d77599')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={failed || state.status === 'checking' ? undefined : progress}
            >
              <div style={{ ...barStyle, width: `${state.status === 'checking' ? 2 : progress}%` }} />
            </div>
            <div style={hintStyle} role="status" aria-live="polite">
              {failed
                ? i18n.t('k65e200d3')
                : state.status === 'checking'
                  ? i18n.t('k037647ef')
                  : i18n.t('kd1bade2a', { p0: progress })}
            </div>
            {failed && <p style={errorStyle}>{state.error || i18n.t('kb30dce9c')}</p>}
            <div style={rowStyle}>
              <button type="button" style={primaryBtnStyle} disabled={busy} onClick={retryPrepare}>
                {busy ? i18n.t('k4cc14a6c') : i18n.t('k132c5cdc')}
              </button>
              <button type="button" style={ghostBtnStyle} onClick={quit}>
                {i18n.t('k7498c202')}
              </button>
            </div>
          </>
        )}

        {/* 普通态：下载完成，二选一 */}
        {ready && !failed && (
          <>
            <div style={barWrapStyle}>
              <div style={{ ...barStyle, width: '100%' }} />
            </div>
            <div style={hintStyle}>{i18n.t('k62bc773c')}</div>
            {!mandatory && (
              <div style={rowStyle}>
                <button type="button" style={primaryBtnStyle} disabled={busy} onClick={installNow}>
                  {busy ? i18n.t('k7bc27521') : i18n.t('kcba94149')}
                </button>
                <button type="button" style={ghostBtnStyle} disabled={busy} onClick={defer}>
                  {i18n.t('kcc3576f1')}
                </button>
              </div>
            )}
          </>
        )}

        {/* 安装失败 */}
        {ready && failed && (
          <>
            <p style={errorStyle}>{state.error || i18n.t('k981fe96b')}</p>
            <div style={rowStyle}>
              <button type="button" style={primaryBtnStyle} disabled={busy} onClick={retryInstall}>
                {busy ? i18n.t('k7bc27521') : i18n.t('kc2b4c1af')}
              </button>
              {mandatory && !state.degraded ? (
                // 延后到期：装不上就只能退出，没有「先用旧版」这条路
                <button type="button" style={ghostBtnStyle} onClick={quit}>
                  {i18n.t('k7498c202')}
                </button>
              ) : (
                <button type="button" style={ghostBtnStyle} onClick={dismiss}>
                  {i18n.t('k9793bcc9')}
                </button>
              )}
            </div>
          </>
        )}

        <div style={footStyle}>
          {!ready
            ? i18n.t('kfd6c1563')
            : failed
              ? state.degraded
                ? i18n.t('k9cda6940')
                : mandatory
                  ? i18n.t('k00bbb4c3')
                  : i18n.t('k25777dc4')
              : i18n.t('k1d7f63dd')}
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
