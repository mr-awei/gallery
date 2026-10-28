import { useState } from 'react';
import { api, isDesktop, pickFolder } from '../api';

/**
 * 首次启动引导：让用户选择一个图片文件夹，软件扫描其中的图片并开始管理。
 * 桌面端用系统目录选择对话框；网页端（浏览器）退化为手填路径。
 * 完成后置 onboarded=true，之后不再弹出。
 */
export default function Onboarding({ onDone }: { onDone: (dir: string | null) => void }) {
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    const d = await pickFolder();
    if (d) setDir(d);
  };

  const finish = async (useDir: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      const patch: { storageDir?: string; onboarded: boolean } = { onboarded: true };
      if (useDir) patch.storageDir = useDir;
      await api.saveSettings(patch);
      onDone(useDir);
    } catch {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(10, 12, 20, 0.6)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          width: 'min(92vw, 480px)',
          padding: '36px 32px',
          borderRadius: 18,
          // --bg-soft 在暗色/明亮两套主题都有定义（暗 #10101c / 明亮 #ffffff），
          // 之前误用了不存在的 --surface，fallback 暗色底 + 明亮模式深色文字导致看不清
          background: 'var(--bg-soft, #10101c)',
          color: 'var(--text, #e8e9f0)',
          border: '1px solid var(--panel-strong)',
          boxShadow: '0 24px 64px rgba(15, 23, 42, 0.28)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 44, marginBottom: 8 }}>🖼️</div>
        <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>欢迎使用图库</h1>
        <p style={{ margin: '0 0 22px', opacity: 0.75, lineHeight: 1.6 }}>
          选择一个图片文件夹，软件会立即扫描其中的图片并开始管理。
          <br />
          之后也能在「设置 → 图片保存文件夹」随时更改。
        </p>

        {isDesktop ? (
          <button
            className="btn"
            onClick={choose}
            disabled={busy}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {dir ? `已选择：${dir}` : '选择图片文件夹'}
          </button>
        ) : (
          <input
            className="input"
            placeholder="输入图片文件夹完整路径，例如 D:\\图片"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            style={{ width: '100%' }}
          />
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button
            className="btn primary"
            style={{ flex: 1, justifyContent: 'center' }}
            disabled={busy || (isDesktop && !dir)}
            onClick={() => finish(dir.trim() || null)}
          >
            开始使用
          </button>
          <button className="btn ghost" style={{ justifyContent: 'center' }} disabled={busy} onClick={() => finish(null)}>
            跳过
          </button>
        </div>
      </div>
    </div>
  );
}
