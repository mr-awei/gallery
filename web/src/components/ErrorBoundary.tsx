import React from 'react';
import { copyText } from '../api';
import i18n from '../i18n';

/**
 * 错误边界：某个页面在渲染期抛错时，React 会卸载整棵树 —— 用户看到的就是
 * 一片纯白（侧栏、顶栏全没了，只能关掉软件）。这里把错误截在内容区，
 * 侧栏/顶栏还在，可以直接切别的页面，也能重试或重新加载。
 *
 * resetKey 变化（换页面）自动清掉错误状态，避免一次崩溃永久卡住。
 */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: unknown },
  { error: Error | null; info: string; copied: boolean }
> {
  state: { error: Error | null; info: string; copied: boolean } = { error: null, info: '', copied: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 渲染期崩溃不会进 window.onerror，必须在这里留一份带组件栈的日志，
    // 否则用户反馈「白屏了」时完全没法定位是哪个组件
    console.error('[render crash]', error, info.componentStack);
    this.setState({ info: info.componentStack || '' });
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, info: '', copied: false });
    }
  }

  private copyReport = async () => {
    const { error, info } = this.state;
    const text = [
      i18n.t('k3cbd8ca0', { p0: error?.message || String(error) }),
      i18n.t('kbdb32f86', { p0: new Date().toLocaleString() }),
      i18n.t('k24a53b48', { p0: window.location.href }),
      '',
      error?.stack || '',
      '',
      i18n.t('k992860b1'),
      info,
    ].join('\n');
    const ok = await copyText(text);
    this.setState({ copied: ok });
    if (ok) window.setTimeout(() => this.setState({ copied: false }), 2000);
  };

  render() {
    const { error, info, copied } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-title">{i18n.t('k30e99755')}</div>
          <div className="crash-msg">{error.message || String(error)}</div>
          <div className="crash-actions">
            <button className="btn sm" onClick={() => this.setState({ error: null, info: '', copied: false })}>
              {i18n.t('k132c5cdc')}
            </button>
            <button className="btn sm" onClick={this.copyReport}>
              {copied ? i18n.t('k52e6abbe') : i18n.t('kd49ace21')}
            </button>
            <button className="btn sm primary" onClick={() => window.location.reload()}>
              {i18n.t('k59fcfadb')}
            </button>
          </div>
          <details className="crash-details">
            <summary>{i18n.t('ka127c450')}</summary>
            <pre>{i18n.t('k0666a993', { p0: error.stack || error.message, p1: info })}</pre>
          </details>
          <div className="crash-hint">
            {i18n.t('k3e1b3918')}
          </div>
        </div>
      </div>
    );
  }
}
