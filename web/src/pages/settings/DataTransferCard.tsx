import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, formatSize, pickFolder } from '../../api';
import { confirmDialog } from '../../components/Dialogs';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  onLibraryChanged: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

type Preview = Awaited<ReturnType<typeof api.transferPreview>>;

/**
 * 数据出口：备份 / 恢复 / 元数据导出 / Eagle 迁移。
 * 每一条都给出「文件到底去哪了」的真实路径，而不是只说一句「导出成功」。
 */
export default function DataTransferCard({ onLibraryChanged, onToast }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState('');
  const [includeThumbs, setIncludeThumbs] = useState(true);
  const [lastBackup, setLastBackup] = useState('');
  const [restoreSrc, setRestoreSrc] = useState('');
  const [restoreRoot, setRestoreRoot] = useState('');
  const [restoreName, setRestoreName] = useState('');
  const [eagleSrc, setEagleSrc] = useState('');
  const [eagleRoot, setEagleRoot] = useState('');
  const [eagleLeft, setEagleLeft] = useState(0);
  const [eagleSize, setEagleSize] = useState<Awaited<ReturnType<typeof api.eagleExportPreview>> | null>(null);
  const [eagleJob, setEagleJob] = useState<{ id: number; done: number; total: number; status: string } | null>(null);
  const [log, setLog] = useState('');

  /** 导出规模：进页面就显示，用户不必先点「预览」才知道要占多少盘 */
  const loadEagleSize = useCallback(() => {
    api
      .eagleExportPreview()
      .then(setEagleSize)
      .catch(() => setEagleSize(null));
  }, []);

  useEffect(loadEagleSize, [loadEagleSize]);

  const eagleRunning = !!eagleJob && (eagleJob.status === 'running' || eagleJob.status === 'queued');

  /* 概览读不到时整张卡片是空的（素材数/路径都显示 —），得给个重试入口 */
  const [loadErr, setLoadErr] = useState('');
  const load = useCallback(() => {
    api
      .transferPreview()
      .then((p) => {
        setPreview(p);
        setLoadErr('');
      })
      .catch((err) => {
        setLoadErr((err as Error).message);
        onToast(i18n.t('k08896d04', { p0: (err as Error).message }), 'error');
      });
  }, [onToast]);

  useEffect(load, [load]);

  /* 自动备份配置：与手动备份同一个面板，用户不用去别处找「多久备一次」 */
  const [autoBackup, setAutoBackup] = useState<Awaited<ReturnType<typeof api.transferAuto>> | null>(null);
  useEffect(() => {
    api
      .transferAuto()
      .then(setAutoBackup)
      .catch((err) => onToast(i18n.t('k5bdfcfd6', { p0: (err as Error).message }), 'error'));
  }, [onToast]);

  const saveAuto = async (patch: { enabled?: boolean; dir?: string; everyDays?: number; keep?: number }) => {
    try {
      setAutoBackup(await api.transferAutoSave(patch));
    } catch (e) {
      onToast(i18n.t('k68dbe931', { p0: (e as Error).message }), 'error');
    }
  };

  const runAutoNow = async () => {
    setBusy('auto');
    try {
      const r = await api.transferAutoRun();
      if (r.skipped) onToast(r.reason || i18n.t('k4a085478'), 'info');
      else {
        onToast(
          i18n.t('kacabe346', { p0: r.dir, p1: r.removed ? i18n.t('k4fba55e2', { p0: r.removed }) : '' }),
        );
        setLastBackup(r.dir || '');
      }
      setAutoBackup(await api.transferAuto());
    } catch (e) {
      onToast(i18n.t('ka240a306', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  const backup = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    setBusy('backup');
    setLog('');
    try {
      const r = await api.transferBackup(dir, includeThumbs);
      setLastBackup(r.dir);
      setLog(
        i18n.t('k8a3eef78', { p0: r.counts.images, p1: r.thumbsBytes ? i18n.t('k40742a56', { p0: formatSize(r.thumbsBytes) }) : '', p2: r.dir }),
      );
      onToast(i18n.t('kbb3c649c'));
    } catch (e) {
      // 备份失败只落在小字 log 里太容易被忽略（尤其卡片下半屏），同时弹提示
      setLog(i18n.t('ka359988f', { p0: (e as Error).message }));
      onToast(i18n.t('ka359988f', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  const restore = async () => {
    if (!restoreSrc) return setLog(i18n.t('kb4ba5c7a'));
    if (!restoreRoot) return setLog(i18n.t('kff30fbb9'));
    // 先预检再动手：半途失败的备份要在这里挡下，并说清缺什么，
    // 而不是等拷贝到一半才炸（那时已经建了库、改过注册表）
    setBusy('restore');
    setLog('');
    try {
      const pre = await api.transferVerify(restoreSrc);
      if (!pre.ok) {
        setLog(i18n.t('kd7acdd1b', { p0: pre.problems.join('；') }));
        onToast(i18n.t('k371518b7'), 'error');
        return;
      }
      if (pre.warnings?.length) setLog(i18n.t('k05f16fc3', { p0: pre.warnings.join('；') }));
    } catch (e) {
      setLog(i18n.t('k49b3686d', { p0: (e as Error).message }));
      onToast(i18n.t('k49b3686d', { p0: (e as Error).message }), 'error');
      return;
    } finally {
      setBusy('');
    }
    if (!(await confirmDialog(i18n.t('kcb53c241')))) return;
    setBusy('restore');
    setLog('');
    try {
      const r = await api.transferRestore(restoreSrc, restoreName || undefined, restoreRoot);
      setLog(
        i18n.t('kd53ede30', { p0: r.name, p1: r.dbPath, p2: r.remapped ? i18n.t('ke5f4a350', { p0: r.remapped }) : '', p3: r.missing ? i18n.t('k3c52d9e1', { p0: r.missing }) : '' }),
      );
      onToast(i18n.t('k50cee25e'));
      onLibraryChanged();
    } catch (e) {
      setLog(i18n.t('k29923a84', { p0: (e as Error).message }));
      onToast(i18n.t('k29923a84', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  const importEagle = async () => {
    if (!eagleSrc) return setLog(i18n.t('k452a555c'));
    setBusy('eagle');
    setLog('');
    try {
      const r = await api.transferImportEagle(eagleSrc, undefined, eagleRoot || undefined);
      setEagleLeft(r.remaining || 0);
      setLog(
        i18n.t('k866c126f', { p0: r.total, p1: r.processed, p2: r.imported }) +
            i18n.t('k1409ce80', { p0: r.existing }) +
            `${r.skipped ? `、无原图或已删除 ${r.skipped} 个` : ''}` +
            `${r.folders ? `、新建文件夹 ${r.folders} 个` : ''}` +
            `${r.failed ? `、失败 ${r.failed} 张（${r.errors.slice(0, 3).join('；')}）` : ''}` +
            `${r.remaining ? `。还剩 ${r.remaining} 个，点「继续迁移」接着来` : i18n.t('kae459313')}`,
      );
      onToast(
        r.remaining
          ? i18n.t('kc867f061', { p0: r.imported, p1: r.remaining })
          : i18n.t('kd05cd28c', { p0: r.imported }),
      );
      onLibraryChanged();
    } catch (e) {
      setLog(i18n.t('kbe711113', { p0: (e as Error).message }));
      onToast(i18n.t('kbe711113', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  /**
   * 整库导出 Eagle 库：后台任务 + 轮询进度。
   * 几千张原图是分钟级的，同步请求既看不到进度又会超时。
   */
  const exportEagle = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    setBusy('eagle-out');
    setLog('');
    setEagleJob(null);
    try {
      const { jobId } = await api.exportEagleStart(dir);
      setEagleJob({ id: jobId, done: 0, total: 0, status: 'running' });
      let job = (await api.jobs('eagle-export', 1))[0];
      while (job && job.id === jobId && (job.status === 'running' || job.status === 'queued')) {
        setEagleJob({ id: jobId, done: job.done, total: job.total, status: job.status });
        await new Promise((r) => setTimeout(r, 800));
        job = (await api.jobs('eagle-export', 1))[0];
      }
      setEagleJob(null);
      if (!job || job.id !== jobId) {
        setLog(i18n.t('k23de6425'));
      } else if (job.status === 'done') {
        const r = (job.result || {}) as { dir?: string; exported?: number; folders?: number; missing?: number; errors?: string[] };
        const errs = Array.isArray(r.errors) ? r.errors : [];
        setLog(
          i18n.t('k48b3cb72', { p0: r.exported ?? 0, p1: r.folders ?? 0, p2: r.dir || dir }) +
              `${r.missing ? `；${r.missing} 个原文件读不到已跳过` : ''}` +
              `${errs.length ? `（${errs.slice(0, 3).join('；')}）` : ''}`,
        );
        onToast(i18n.t('kb42a381e', { p0: r.dir || dir }));
      } else if (job.status === 'canceled') {
        setLog(i18n.t('k6ea71de7'));
      } else {
        setLog(i18n.t('k9850aa54', { p0: job.error || i18n.t('k974e7484') }));
        onToast(i18n.t('k246e218d', { p0: job.error || i18n.t('k974e7484') }), 'error');
      }
    } catch (e) {
      setLog(i18n.t('k9850aa54', { p0: (e as Error).message }));
      onToast(i18n.t('k246e218d', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  const cancelEagle = async () => {
    if (!eagleJob) return;
    try {
      await api.cancelJob(eagleJob.id);
      onToast(i18n.t('kb467d9fa'));
    } catch (e) {
      onToast(i18n.t('k8ce513f7', { p0: (e as Error).message }), 'error');
    }
  };

  return (
    <Card
      title={i18n.t('k567a89e6')}
      desc={i18n.t('ke6816ece')}
    >
      {loadErr && (
        <div style={{ color: 'var(--err, #e5484d)', fontSize: 12.5, marginBottom: 8 }}>
          {i18n.t('k0540bd7f')}
          {loadErr}
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={load}>
            {i18n.t('k132c5cdc')}
          </button>
        </div>
      )}
      {preview && (
        <div className="maint-grid">
          <div>
            <b>{preview.counts.images}</b>
            <span>{i18n.t('k54d363af')}</span>
          </div>
          <div>
            <b>{preview.counts.folders}</b>
            <span>{i18n.t('k1f4c1042')}</span>
          </div>
          <div>
            <b>{preview.counts.tags}</b>
            <span>{i18n.t('k14d34236')}</span>
          </div>
          <div>
            <b>{preview.counts.ocr}</b>
            <span>{i18n.t('kf52cd0c8')}</span>
          </div>
          <div>
            <b>{preview.counts.actions}</b>
            <span>{i18n.t('kc500cfab')}</span>
          </div>
          <div>
            <b>{formatSize(preview.thumbsBytes)}</b>
            <span>{i18n.t('kbbbce246')}</span>
          </div>
        </div>
      )}
      <div className="hint" style={{ marginTop: 8, wordBreak: 'break-all' }}>
        {i18n.t('k64bf9289')}
        {preview?.library.rootPath || '—'}
        <br />
        {i18n.t('k199a2059')}
        {preview?.library.dbPath || '—'}
      </div>

      <div className="maint-missing" style={{ marginTop: 12 }}>
        <b style={{ fontSize: 13 }}>{i18n.t('k664b37da')}</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          {i18n.t('k8874bf9d')}
          <b>{i18n.t('ka54d24d9')}</b>
          {i18n.t('k0df8d614')}
        </div>
        <label className="hint" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
          <input type="checkbox" checked={includeThumbs} onChange={(e) => setIncludeThumbs(e.target.checked)} />
          {i18n.t('kce2b46ec')}
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn sm" disabled={!!busy}
            title={busy ? i18n.t('kfc1d6cca') : undefined} onClick={backup}>
            {busy === 'backup' ? i18n.t('ka6d4ec4a') : i18n.t('k911f893e')}
          </button>
          <button className="btn sm ghost" onClick={() => downloadFile('/api/transfer/metadata.json')}>
            {i18n.t('k51784521')}
          </button>
          <button className="btn sm ghost" onClick={() => downloadFile('/api/transfer/metadata.csv')}>
            {i18n.t('ka79d1d39')}
          </button>
        </div>
        {lastBackup && (
          <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {i18n.t('kc92b70d8')}
            {lastBackup}
          </div>
        )}
      </div>

      <div className="maint-missing" style={{ marginTop: 12 }}>
        <b style={{ fontSize: 13 }}>{i18n.t('k590e5b46')}</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          {i18n.t('k3673b4a9')}
          <code>{i18n.t('ked599683')}</code>
          {i18n.t('kc6b9b970')}
          {i18n.t('k8d4ed150')}
          <b>{i18n.t('k7cbe907e')}</b>
          {i18n.t('k84ba8a29')}
        </div>
        <label className="hint" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
          <input
            type="checkbox"
            checked={!!autoBackup?.enabled}
            disabled={!autoBackup}
            onChange={(e) => void saveAuto({ enabled: e.target.checked })}
          />
          {i18n.t('k0883b77b')}
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <button
            className="btn sm"
            onClick={async () => {
              const dir = await pickFolder();
              if (dir) void saveAuto({ dir });
            }}
          >
            {autoBackup?.dir ? i18n.t('kc84af357') : i18n.t('k33b9b7b1')}
          </button>
          <span className="hint">{i18n.t('ka7e221ca')}</span>
          <input
            className="input sm"
            style={{ width: 64 }}
            type="number"
            min={1}
            max={90}
            value={autoBackup?.everyDays ?? 7}
            onChange={(e) => void saveAuto({ everyDays: Number(e.target.value) || 7 })}
          />
          <span className="hint">{i18n.t('k26e9c4ce')}</span>
          <input
            className="input sm"
            style={{ width: 64 }}
            type="number"
            min={1}
            max={30}
            value={autoBackup?.keep ?? 3}
            onChange={(e) => void saveAuto({ keep: Number(e.target.value) || 3 })}
          />
          <span className="hint">{i18n.t('k2a5da6a0')}</span>
          <button className="btn sm ghost" disabled={!!busy || !autoBackup?.dir} onClick={() => void runAutoNow()}>
            {busy === 'auto' ? i18n.t('ka6d4ec4a') : i18n.t('k923c3196')}
          </button>
        </div>
        {autoBackup?.dir && (
          <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {i18n.t('k4cc87822')}
            {autoBackup.dir}
            <br />
            {autoBackup.lastAt
              ? i18n.t('k05706d2e', { p0: new Date(autoBackup.lastAt).toLocaleString() })
              : i18n.t('kc08a1692')}
            {autoBackup.lastError ? i18n.t('k63a9a33b', { p0: autoBackup.lastError }) : ''}
          </div>
        )}
      </div>

      <div className="maint-missing">
        <b style={{ fontSize: 13 }}>{i18n.t('k39a21c7b')}</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          {i18n.t('k60dd646e')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn sm" onClick={async () => setRestoreSrc((await pickFolder()) || restoreSrc)}>
            {restoreSrc ? i18n.t('k9f081e88') : i18n.t('kafb2b851')}
          </button>
          <button className="btn sm" onClick={async () => setRestoreRoot((await pickFolder()) || restoreRoot)}>
            {restoreRoot ? i18n.t('k34d08c7f') : i18n.t('kaaa642e9')}
          </button>
          <input
            className="input"
            style={{ width: 160 }}
            placeholder={i18n.t('kbf92a63e')}
            value={restoreName}
            onChange={(e) => setRestoreName(e.target.value)}
          />
          <button className="btn sm primary" disabled={!!busy}
            title={busy ? i18n.t('kfc1d6cca') : undefined} onClick={restore}>
            {busy === 'restore' ? i18n.t('kabc10332') : i18n.t('kb1926650')}
          </button>
        </div>
        {(restoreSrc || restoreRoot) && (
          <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {restoreSrc && <>{i18n.t('k73d4432e')}{restoreSrc}<br /></>}
            {restoreRoot && <>{i18n.t('k3515696d')}{restoreRoot}</>}
          </div>
        )}
      </div>

      <div className="maint-missing">
        <b style={{ fontSize: 13 }}>{i18n.t('kf85d214d')}</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          {i18n.t('k370f33f3')}
          <code>.library</code>
          {i18n.t('k2eaea1ed')}
          <code>images/&lt;id&gt;.info</code>
          {i18n.t('k2ecb75b0')}
          <b>{i18n.t('k8ed98988')}</b>
          {i18n.t('k405daa04')}
          {i18n.t('k1f0c2785')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn sm" onClick={async () => setEagleSrc((await pickFolder()) || eagleSrc)}>
            {eagleSrc ? i18n.t('keb798a60') : i18n.t('k143aa76f')}
          </button>
          <button className="btn sm" onClick={async () => setEagleRoot((await pickFolder()) || eagleRoot)}>
            {eagleRoot ? i18n.t('k1c56b365') : i18n.t('k738fd7c5')}
          </button>
          <button className="btn sm" disabled={!!busy}
            title={busy ? i18n.t('kfc1d6cca') : undefined} onClick={importEagle}>
            {busy === 'eagle'
              ? i18n.t('k709bf5a0')
              : eagleLeft
                ? i18n.t('k44b5ba7b', { p0: eagleLeft })
                : i18n.t('ka9686100')}
          </button>
        </div>
        {eagleSrc && (
          <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {eagleSrc}
          </div>
        )}
      </div>

      <div className="maint-missing">
        <b style={{ fontSize: 13 }}>{i18n.t('kbe32d9a8')}</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          {i18n.t('ka37a9be7')}
          <b>{i18n.t('k8ed98988')}</b>
          {i18n.t('ke521279c')}
          <code>&lt;{i18n.t('kdcd3b704')}&gt;.library</code>
          {i18n.t('k47343c2c')}
          {i18n.t('kfbf8e0f9')}
        </div>
        <div className="hint" style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>
            {eagleSize
              ? i18n.t('k03aa8ee4', { p0: eagleSize.images, p1: formatSize(eagleSize.bytes), p2: eagleSize.folders })
              : i18n.t('k8ffdde73')}
          </span>
          <button className="btn sm ghost" onClick={loadEagleSize} title={i18n.t('kdb956df9')}>
            {i18n.t('k694fc5ef')}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!!busy}
            title={busy ? i18n.t('kfc1d6cca') : i18n.t('k06a3d0fd')}
            onClick={() => void exportEagle()}
          >
            {busy === 'eagle-out' ? i18n.t('k86f99e94') : i18n.t('k187a8a75')}
          </button>
          {eagleRunning && (
            <button className="btn sm ghost" onClick={() => void cancelEagle()}>
              {i18n.t('k834bdca5')}
            </button>
          )}
          {eagleJob && (
            <span className="hint" style={{ display: 'inline-flex', alignItems: 'center' }}>
              {eagleJob.total
                ? i18n.t('k3f7780f3', { p0: eagleJob.done, p1: eagleJob.total, p2: Math.round((eagleJob.done / eagleJob.total) * 100) })
                : i18n.t('k3fceda21')}
            </span>
          )}
        </div>
      </div>

      {log && (
        <div className="hint" style={{ marginTop: 10, lineHeight: 1.8, wordBreak: 'break-all' }}>
          {log}
        </div>
      )}
    </Card>
  );
}
