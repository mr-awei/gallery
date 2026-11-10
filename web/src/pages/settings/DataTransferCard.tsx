import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, formatSize, pickFolder } from '../../api';
import { confirmDialog } from '../../components/Dialogs';
import Card from './Card';

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
        onToast(`备份概览读取失败：${(err as Error).message}`, 'error');
      });
  }, [onToast]);

  useEffect(load, [load]);

  const backup = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    setBusy('backup');
    setLog('');
    try {
      const r = await api.transferBackup(dir, includeThumbs);
      setLastBackup(r.dir);
      setLog(`已备份 ${r.counts.images} 张的元数据${r.thumbsBytes ? `与 ${formatSize(r.thumbsBytes)} 缩略图` : ''} 到 ${r.dir}`);
      onToast('备份完成');
    } catch (e) {
      // 备份失败只落在小字 log 里太容易被忽略（尤其卡片下半屏），同时弹提示
      setLog(`备份失败：${(e as Error).message}`);
      onToast(`备份失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const restore = async () => {
    if (!restoreSrc) return setLog('先选择备份文件夹');
    if (!restoreRoot) return setLog('先选择新库的素材文件夹');
    if (!(await confirmDialog('将从备份恢复成一个「新资源库」，当前库不受影响。继续？'))) return;
    setBusy('restore');
    setLog('');
    try {
      const r = await api.transferRestore(restoreSrc, restoreName || undefined, restoreRoot);
      setLog(
        `已创建资源库「${r.name}」：${r.dbPath}${r.remapped ? `；重映射 ${r.remapped} 条路径` : ''}${
          r.missing ? `；其中 ${r.missing} 张在新目录里找不到` : ''
        }`
      );
      onToast('恢复完成，可在左上角切换到新库');
      onLibraryChanged();
    } catch (e) {
      setLog(`恢复失败：${(e as Error).message}`);
      onToast(`恢复失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const importEagle = async () => {
    if (!eagleSrc) return setLog('先选择 Eagle 的 .library 文件夹');
    setBusy('eagle');
    setLog('');
    try {
      const r = await api.transferImportEagle(eagleSrc, undefined, eagleRoot || undefined);
      setEagleLeft(r.remaining || 0);
      setLog(
        `Eagle 迁移：库里共 ${r.total} 个素材（含回收站），本轮处理 ${r.processed} 个 → 新增 ${r.imported} 张、` +
          `已存在跳过 ${r.existing} 张` +
          `${r.skipped ? `、无原图或已删除 ${r.skipped} 个` : ''}` +
          `${r.folders ? `、新建文件夹 ${r.folders} 个` : ''}` +
          `${r.failed ? `、失败 ${r.failed} 张（${r.errors.slice(0, 3).join('；')}）` : ''}` +
          `${r.remaining ? `。还剩 ${r.remaining} 个，点「继续迁移」接着来` : '。全部完成'}`
      );
      onToast(r.remaining ? `本轮导入 ${r.imported} 张，还剩 ${r.remaining} 个` : `已从 Eagle 导入 ${r.imported} 张`);
      onLibraryChanged();
    } catch (e) {
      setLog(`Eagle 迁移失败：${(e as Error).message}`);
      onToast(`Eagle 迁移失败：${(e as Error).message}`, 'error');
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
        setLog('导出任务的记录丢了，请到「任务历史」里查看结果');
      } else if (job.status === 'done') {
        const r = (job.result || {}) as { dir?: string; exported?: number; folders?: number; missing?: number; errors?: string[] };
        const errs = Array.isArray(r.errors) ? r.errors : [];
        setLog(
          `已导出 ${r.exported ?? 0} 个素材、${r.folders ?? 0} 个文件夹 → ${r.dir || dir}` +
            `${r.missing ? `；${r.missing} 个原文件读不到已跳过` : ''}` +
            `${errs.length ? `（${errs.slice(0, 3).join('；')}）` : ''}`
        );
        onToast(`Eagle 库已生成：${r.dir || dir}`);
      } else if (job.status === 'canceled') {
        setLog('已取消导出；没写完的 .library 已删除，可以重新导出到同一个位置');
      } else {
        setLog(`导出 Eagle 库失败：${job.error || '未知错误'}`);
        onToast(`导出失败：${job.error || '未知错误'}`, 'error');
      }
    } catch (e) {
      setLog(`导出 Eagle 库失败：${(e as Error).message}`);
      onToast(`导出失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const cancelEagle = async () => {
    if (!eagleJob) return;
    try {
      await api.cancelJob(eagleJob.id);
      onToast('已请求停止导出，正在清理未完成的文件');
    } catch (e) {
      onToast(`停止失败：${(e as Error).message}`, 'error');
    }
  };

  return (
    <Card
      title="数据出口"
      desc="备份、恢复、导出清单、从 Eagle 4 迁移。数据始终在你自己手里，随时能带走。"
    >
      {loadErr && (
        <div style={{ color: 'var(--err, #e5484d)', fontSize: 12.5, marginBottom: 8 }}>
          备份信息读取失败：{loadErr}
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={load}>
            重试
          </button>
        </div>
      )}
      {preview && (
        <div className="maint-grid">
          <div>
            <b>{preview.counts.images}</b>
            <span>素材</span>
          </div>
          <div>
            <b>{preview.counts.folders}</b>
            <span>文件夹</span>
          </div>
          <div>
            <b>{preview.counts.tags}</b>
            <span>标签</span>
          </div>
          <div>
            <b>{preview.counts.ocr}</b>
            <span>OCR 记录</span>
          </div>
          <div>
            <b>{preview.counts.actions}</b>
            <span>动作</span>
          </div>
          <div>
            <b>{formatSize(preview.thumbsBytes)}</b>
            <span>缩略图占用</span>
          </div>
        </div>
      )}
      <div className="hint" style={{ marginTop: 8, wordBreak: 'break-all' }}>
        素材文件夹：{preview?.library.rootPath || '—'}
        <br />
        数据库：{preview?.library.dbPath || '—'}
      </div>

      <div className="maint-missing" style={{ marginTop: 12 }}>
        <b style={{ fontSize: 13 }}>备份</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          备份包含 gallery.db（文件夹 / 标签 / 备注 / 评分 / OCR / 动作）、可读的 library.json 与缩略图；
          <b> 原图不在备份里</b>——它们一直在你的素材文件夹中，不需要重复拷贝。
        </div>
        <label className="hint" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
          <input type="checkbox" checked={includeThumbs} onChange={(e) => setIncludeThumbs(e.target.checked)} />
          同时复制缩略图（体积更大，但恢复后无需重建）
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn sm" disabled={!!busy}
            title={busy ? '上一个操作还在进行，完成后再试' : undefined} onClick={backup}>
            {busy === 'backup' ? '备份中…' : '备份到…'}
          </button>
          <button className="btn sm ghost" onClick={() => downloadFile('/api/transfer/metadata.json')}>
            导出元数据 JSON
          </button>
          <button className="btn sm ghost" onClick={() => downloadFile('/api/transfer/metadata.csv')}>
            导出清单 CSV（Excel 可开）
          </button>
        </div>
        {lastBackup && (
          <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            最近一次备份：{lastBackup}
          </div>
        )}
      </div>

      <div className="maint-missing">
        <b style={{ fontSize: 13 }}>从备份恢复</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          恢复为「新资源库」，不会覆盖当前库；换机器 / 换盘符时按备份里记录的旧根目录自动重映射绝对路径。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn sm" onClick={async () => setRestoreSrc((await pickFolder()) || restoreSrc)}>
            {restoreSrc ? '换备份文件夹…' : '选择备份文件夹…'}
          </button>
          <button className="btn sm" onClick={async () => setRestoreRoot((await pickFolder()) || restoreRoot)}>
            {restoreRoot ? '换素材文件夹…' : '选择新库素材文件夹…'}
          </button>
          <input
            className="input"
            style={{ width: 160 }}
            placeholder="新库名称（可选）"
            value={restoreName}
            onChange={(e) => setRestoreName(e.target.value)}
          />
          <button className="btn sm primary" disabled={!!busy}
            title={busy ? '上一个操作还在进行，完成后再试' : undefined} onClick={restore}>
            {busy === 'restore' ? '恢复中…' : '恢复为新库'}
          </button>
        </div>
        {(restoreSrc || restoreRoot) && (
          <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {restoreSrc && <>备份：{restoreSrc}<br /></>}
            {restoreRoot && <>新库：{restoreRoot}</>}
          </div>
        )}
      </div>

      <div className="maint-missing">
        <b style={{ fontSize: 13 }}>从 Eagle 4 迁移</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          选择 Eagle 的 <code>.library</code> 目录：把每个 <code>images/&lt;id&gt;.info</code> 里体积最大的原图复制进
          <b>当前库</b>，并完整还原「文件夹层级 / 标签 / 星级 / 备注 / 来源地址 / 拍摄时间」；回收站里已删的素材不迁。
          为了不让一次请求卡太久，单轮最多迁 1000 个，迁完会显示还剩多少，再点一次继续即可（已迁过的会自动跳过，不会重复）。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn sm" onClick={async () => setEagleSrc((await pickFolder()) || eagleSrc)}>
            {eagleSrc ? '换 .library 目录…' : '选择 .library 目录…'}
          </button>
          <button className="btn sm" onClick={async () => setEagleRoot((await pickFolder()) || eagleRoot)}>
            {eagleRoot ? '换目标文件夹…' : '选择目标文件夹…（默认用素材文件夹）'}
          </button>
          <button className="btn sm" disabled={!!busy}
            title={busy ? '上一个操作还在进行，完成后再试' : undefined} onClick={importEagle}>
            {busy === 'eagle' ? '迁移中…' : eagleLeft ? `继续迁移（还剩 ${eagleLeft}）` : '开始迁移'}
          </button>
        </div>
        {eagleSrc && (
          <div className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {eagleSrc}
          </div>
        )}
      </div>

      <div className="maint-missing">
        <b style={{ fontSize: 13 }}>导出为 Eagle 库（反向互通）</b>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          把<b>当前库</b>写成一个标准的 <code>&lt;库名&gt;.library</code>：原图、文件夹层级、标签、星级、备注、来源地址都带过去，
          在 Eagle 里「文件 → 打开资源库」选它就能用。缩略图不复制，由 Eagle 首次打开时自行生成。
          导出目标必须是空目录（不会覆盖已有资源库）。
        </div>
        <div className="hint" style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>
            {eagleSize
              ? `当前库：${eagleSize.images} 张原图 · ${formatSize(eagleSize.bytes)} · ${eagleSize.folders} 个文件夹`
              : '正在统计导出规模…'}
          </span>
          <button className="btn sm ghost" onClick={loadEagleSize} title="重新统计当前库的素材与体积">
            刷新
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!!busy}
            title={busy ? '上一个操作还在进行，完成后再试' : '选一个空文件夹，会在里面生成 <库名>.library'}
            onClick={() => void exportEagle()}
          >
            {busy === 'eagle-out' ? '导出中…' : '导出为 .library…'}
          </button>
          {eagleRunning && (
            <button className="btn sm ghost" onClick={() => void cancelEagle()}>
              停止导出
            </button>
          )}
          {eagleJob && (
            <span className="hint" style={{ display: 'inline-flex', alignItems: 'center' }}>
              {eagleJob.total ? `已处理 ${eagleJob.done}/${eagleJob.total}（${Math.round((eagleJob.done / eagleJob.total) * 100)}%）` : '正在准备…'}
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
