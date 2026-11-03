import React from 'react';

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
      `错误：${error?.message || String(error)}`,
      `时间：${new Date().toLocaleString()}`,
      `地址：${window.location.href}`,
      '',
      error?.stack || '',
      '',
      '组件栈：',
      info,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // 剪贴板权限被拒时退化成「让人手动选中」：把详情展开即可
      this.setState({ copied: false });
    }
  };

  render() {
    const { error, info, copied } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-title">这个页面渲染出错了</div>
          <div className="crash-msg">{error.message || String(error)}</div>
          <div className="crash-actions">
            <button className="btn sm" onClick={() => this.setState({ error: null, info: '', copied: false })}>
              重试
            </button>
            <button className="btn sm" onClick={this.copyReport}>
              {copied ? '已复制' : '复制错误信息'}
            </button>
            <button className="btn sm primary" onClick={() => window.location.reload()}>
              重新加载界面
            </button>
          </div>
          <details className="crash-details">
            <summary>技术细节（反馈问题时贴这段）</summary>
            <pre>{`${error.stack || error.message}\n\n组件栈：${info}`}</pre>
          </details>
          <div className="crash-hint">
            侧栏和顶栏还能用，可以先切到别的页面；反复出现请把上面的报错复制反馈出来。
          </div>
        </div>
      </div>
    );
  }
}
