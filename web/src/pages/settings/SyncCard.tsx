import { useEffect, useState } from 'react';
import { api, pickFolder } from '../../api';
import Card from './Card';

type SyncState = Awaited<ReturnType<typeof api.syncStatus>>;

interface Props {
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
  onLibraryChanged?: () => void | Promise<void>;
}

/** 多端同步：同步文件夹 + revision 快照。不假装是实时云账号。 */
export default function SyncCard({ onToast, onLibraryChanged }: Props) {
  const [state, setState] = useState<SyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [force, setForce] = useState(false);

  const refresh = async () => {
    try {
      setState(await api.syncStatus());
    } catch (err) {
      onToast?.(`读取同步状态失败：${(err as Error).message}`, 'error');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    try {
      await api.syncConfigure(String(dir));
      onToast?.('同步文件夹已设置', 'info');
      await refresh();
    } catch (err) {
      onToast?.(`设置失败：${(err as Error).message}`, 'error');
    }
  };

  const run = async (kind: 'publish' | 'pull' | 'off') => {
    if (busy) return;
    setBusy(true);
    try {
      let r: { note?: string; reason?: string; revision?: number; unchanged?: boolean; skipped?: boolean; libraryName?: string };
      if (kind === 'publish') r = await api.syncPublish(force);
      else if (kind === 'pull') r = await api.syncPull(force);
      else r = await api.syncConfigure('');
      onToast?.(r.note || r.reason || (kind === 'pull' ? `已拉取到 ${r.libraryName || '新资源库'}` : '操作完成'), 'info');
      await refresh();
      if (kind === 'pull' && !r.skipped) await onLibraryChanged?.();
    } catch (err) {
      onToast?.(`${kind === 'publish' ? '发布' : kind === 'pull' ? '拉取' : '关闭'}失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="云同步 / 多端"
      desc="把任意一个网盘 / 共享盘文件夹当传输层：一端发布带版本号的元数据快照，另一端拉取。不做在线账号，也不做实时行级合并。"
    >
      <div className="hint" style={{ lineHeight: 1.9 }}>
        · 快照只含数据库与元数据清单（<b>不含原图</b>）；原图请让素材目录自己走同步盘
        <br />· 内容没变时不写同步盘，已是最新版本时不重复拉取（增量跳过）
        <br />· 两端都改过时会明确报冲突，只有勾选「强制」才允许放弃本机未发布的改动
        <br />· 拉取会登记为<b>一个新的资源库</b>，不会覆盖当前库；确认无误后可自行删除旧库
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>同步文件夹</label>
        <div className="hint" style={{ wordBreak: 'break-all' }}>{state?.syncDir || '（未设置）'}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => void choose()} disabled={busy}>选择文件夹…</button>
          {state?.enabled && <button className="btn sm" onClick={() => void run('off')} disabled={busy}>关闭同步</button>}
          <button className="btn sm" onClick={() => void refresh()} disabled={busy}>刷新状态</button>
        </div>
      </div>

      {state && (
        <div className="field">
          <label>状态</label>
          <div className="hint" style={{ lineHeight: 1.9 }}>
            本机第 {state.localRevision} 版 · 同步盘第 {state.remoteRevision} 版
            {state.remoteDevice ? `（由 ${state.remoteDevice.slice(0, 8)}… 于 ${state.publishedAt.slice(0, 19).replace('T', ' ')} 发布）` : ''}
            <br />本机设备：{state.deviceId.slice(0, 8)}…
            {state.dirty && <><br /><b style={{ color: 'var(--warn, #c47f17)' }}>本机有未发布的改动</b></>}
            {state.manifestError && <><br /><b style={{ color: 'var(--err, #c33)' }}>{state.manifestError}</b></>}
          </div>
        </div>
      )}

      <div className="switch-row">
        <span>强制操作（发布时忽略「无变化」跳过 / 拉取时放弃本机未发布改动）</span>
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn sm primary" onClick={() => void run('publish')} disabled={busy || !state?.enabled}>发布本机快照</button>
        <button className="btn sm" onClick={() => void run('pull')} disabled={busy || !state?.enabled}>拉取远端快照</button>
      </div>
    </Card>
  );
}
