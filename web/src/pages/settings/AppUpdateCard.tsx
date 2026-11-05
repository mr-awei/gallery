import React, { useEffect, useState } from 'react';
import type { AppInfo, UpdateState } from '../../api';
import type { Settings as SettingsType } from '../../types';
import { desktop, quiet } from '../../api';
import Card from './Card';

interface Props {
  appInfo: AppInfo | null;
  patch: (p: Partial<SettingsType>) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

const EMPTY_STATE: UpdateState = {
  status: 'idle',
  percent: 0,
  version: '',
  notes: '',
  error: '',
  supported: false,
};

/**
 * 「应用与更新」卡片。
 * - 安装版走 electron-updater：检查 → 后台下载（带进度）→ 重启安装，不用再手动去浏览器下 exe
 * - 开发态（无安装包可替换）保留原来的「跳发布页下载」
 */
export default function AppUpdateCard({ appInfo, patch, onToast }: Props) {
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [up, setUp] = useState<UpdateState>(EMPTY_STATE);

  useEffect(() => {
    desktop?.getAutoLaunch?.().then(setAutoLaunch).catch(quiet);
    desktop?.updateState?.().then(setUp).catch(quiet);
    // 下载进度由主进程持续广播，这里只订阅，避免轮询
    return desktop?.onUpdateState?.((s) => setUp(s));
  }, []);

  const supported = up.supported;

  /** 开发态回退：比较 GitHub release 版本号，把用户送到发布页 */
  const checkWeb = async () => {
    const r = await desktop?.checkForUpdates?.();
    if (!r?.ok) {
      setMsg(r?.msg || '检查失败');
      return;
    }
    if (r.hasUpdate) {
      setMsg(`发现新版本 v${r.latest}（当前 v${r.current}），请到发布页下载`);
      if (r.url) window.open(r.url, '_blank', 'noopener');
    } else {
      setMsg(`已是最新版本 v${r.current}`);
    }
  };

  const check = async () => {
    setBusy(true);
    setMsg('');
    try {
      if (!supported) {
        await checkWeb();
        return;
      }
      const r = await desktop?.updateCheck?.();
      if (!r?.ok) {
        setMsg(r?.msg || '检查失败');
      } else if (!r.hasUpdate) {
        setMsg(`已是最新版本 v${r.current}`);
      } else {
        setMsg(`发现新版本 v${r.latest}，可下载后一键重启安装`);
      }
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const r = await desktop?.updateDownload?.();
      if (!r?.ok) setMsg(r?.msg || '开始下载失败');
      else onToast('已开始后台下载更新包');
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const r = await desktop?.updateInstall?.();
    if (!r?.ok) setMsg(r?.msg || '安装失败');
  };

  return (
    <Card
      title="应用与更新"
      desc="随系统启动；安装版每次启动都会在后台静默向 GitHub Releases 查询并下载新版本，这期间可以照常使用。只有更新包下载完成、可以立刻安装时才会提示重启安装。"
    >
      {desktop && (
        <div className="switch-row">
          <span>开机自动启动</span>
          <input
            type="checkbox"
            checked={autoLaunch}
            onChange={async (e) => {
              const next = e.target.checked;
              setAutoLaunch(next);
              try {
                const applied = (await desktop?.setAutoLaunch?.(next)) ?? next;
                setAutoLaunch(applied);
                patch({ autoLaunch: applied });
                onToast(applied ? '已开启开机自启' : '已关闭开机自启');
              } catch {
                setAutoLaunch(!next);
                onToast('设置开机自启失败');
              }
            }}
          />
        </div>
      )}
      <div className="hint">当前版本：v{appInfo?.version || '?'}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy || up.status === 'downloading'} onClick={check}>
          {busy || up.status === 'checking' ? '检查中…' : '检查更新'}
        </button>
        {supported && up.status === 'available' && (
          <button className="btn primary" disabled={busy} onClick={download}>
            下载 v{up.version}
          </button>
        )}
        {supported && up.status === 'downloaded' && (
          <button className="btn primary" onClick={install}>
            重启并安装 v{up.version}
          </button>
        )}
      </div>
      {supported && up.status === 'downloading' && (
        <div style={{ marginTop: 8 }}>
          <div className="hint" style={{ margin: '0 0 4px' }}>
            正在下载更新包：{up.percent}%
          </div>
          <progress value={up.percent} max={100} style={{ width: '100%', height: 8 }} />
        </div>
      )}
      {supported && up.status === 'downloaded' && (
        <div className="hint">更新包已就绪，点「重启并安装」会关闭应用并自动完成升级。</div>
      )}
      {supported && up.status === 'error' && up.error && (
        <div className="hint" style={{ color: 'var(--warn)' }}>更新失败：{up.error}</div>
      )}
      {msg && <div className="hint">{msg}</div>}
    </Card>
  );
}
