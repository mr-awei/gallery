import { useEffect, useState } from 'react';
import { api, pickFolder } from '../../api';
import Card from './Card';
import i18n from '../../i18n';

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
      onToast?.(i18n.t('kd6187407', { p0: (err as Error).message }), 'error');
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
      onToast?.(i18n.t('k6dcba80d'), 'info');
      await refresh();
    } catch (err) {
      onToast?.(i18n.t('k161e1f3e', { p0: (err as Error).message }), 'error');
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
      onToast?.(r.note || r.reason || (kind === 'pull' ? i18n.t('k93a894e7', { p0: r.libraryName || i18n.t('k8c9c922c') }) : i18n.t('k04fe5af3')), 'info');
      await refresh();
      if (kind === 'pull' && !r.skipped) await onLibraryChanged?.();
    } catch (err) {
      onToast?.(i18n.t('kddb5e0d1', { p0: kind === 'publish' ? i18n.t('k83611abd') : kind === 'pull' ? i18n.t('k1d0274a5') : i18n.t('kb15d9127'), p1: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={i18n.t('kdb8ad3b5')}
      desc={i18n.t('k9353a5c4')}
    >
      <div className="hint" style={{ lineHeight: 1.9 }}>
        {i18n.t('kca4252dd')}<b>{i18n.t('kf5a2b734')}</b>{i18n.t('k63dcd2ae')}
        <br />{i18n.t('k46b256b3')}
        <br />{i18n.t('k64c8e437')}
        <br />{i18n.t('kc3c02037')}<b>{i18n.t('k38284205')}</b>{i18n.t('k4d990baf')}
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>{i18n.t('k19edb1c3')}</label>
        <div className="hint" style={{ wordBreak: 'break-all' }}>{state?.syncDir || i18n.t('k19e21887')}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => void choose()} disabled={busy}>{i18n.t('ka0249eda')}</button>
          {state?.enabled && <button className="btn sm" onClick={() => void run('off')} disabled={busy}>{i18n.t('kbf971021')}</button>}
          <button className="btn sm" onClick={() => void refresh()} disabled={busy}>{i18n.t('k4f8d48ef')}</button>
        </div>
      </div>

      {state && (
        <div className="field">
          <label>{i18n.t('k3fea7ca7')}</label>
          <div className="hint" style={{ lineHeight: 1.9 }}>
            本机第 {state.localRevision} 版 · 同步盘第 {state.remoteRevision} 版
            {state.remoteDevice ? i18n.t('k638c4e11', { p0: state.remoteDevice.slice(0, 8), p1: state.publishedAt.slice(0, 19).replace('T', ' ') }) : ''}
            <br />本机设备：{state.deviceId.slice(0, 8)}…
            {state.dirty && <><br /><b style={{ color: 'var(--warn, #c47f17)' }}>{i18n.t('k08cd88c0')}</b></>}
            {state.manifestError && <><br /><b style={{ color: 'var(--err, #c33)' }}>{state.manifestError}</b></>}
          </div>
        </div>
      )}

      <div className="switch-row">
        <span>{i18n.t('k2e1ff4dc')}</span>
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn sm primary" onClick={() => void run('publish')} disabled={busy || !state?.enabled}>{i18n.t('k09fd789c')}</button>
        <button className="btn sm" onClick={() => void run('pull')} disabled={busy || !state?.enabled}>{i18n.t('k86b82c8d')}</button>
      </div>
    </Card>
  );
}
