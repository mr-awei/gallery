import React, { useCallback, useEffect, useState } from 'react';
import { api, desktop, formatSize, quiet } from '../../api';
import { confirmDialog } from '../../components/Dialogs';
import Card from './Card';

interface Props {
  onLibraryChanged: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

type Status = Awaited<ReturnType<typeof api.maintenanceStatus>>;

// 体积格式化统一走 api.formatSize（以前每个页面一份，同一个数显示得不一样）
const fmtBytes = formatSize;

/**
 * 「维护工具」卡片：
 * 缩略图坏了、库里堆了孤儿文件、DB 涨到几个 G —— 以前只能删库重来，
 * 现在都能在界面上自助处理。
 */
export default function MaintenanceCard({ onLibraryChanged, onToast }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState('');
  const [missing, setMissing] = useState<{ count: number; ids: number[] } | null>(null);
  const [clip, setClip] = useState<{
    running: boolean;
    done: number;
    total: number;
    error: string;
    indexed: number;
    model: string;
    loadError: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.maintenanceStatus());
    } catch (err) {
      onToast((err as Error).message, 'error');
    }
    api.missingFiles().then(setMissing).catch(quiet);
    api.clipStatus().then(setClip).catch(quiet);
  }, [onToast]);

  useEffect(() => {
    load();
  }, [load]);

  /** 统一包一层忙碌态，避免同一动作被连点两次 */
  const run = async (tag: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(tag);
    try {
      await fn();
      await load();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const rebuildThumbs = () =>
    run('thumb', async () => {
      const r = await api.maintenanceRebuildThumbs(300);
      const failedPart = r.failed ? `，失败 ${r.failed}` : '';
      onToast(`重建 ${r.rebuilt} 张（已存在 ${r.skipped}${failedPart}）`, r.failed ? 'error' : 'info');
      onLibraryChanged();
    });

  const cleanOrphans = () =>
    run('orphan', async () => {
      const dry = await api.maintenanceOrphanThumbs(true);
      if (!dry.found) return onToast('没有孤立缩略图');
      const ok = await confirmDialog(
        `发现 ${dry.found} 个孤立缩略图文件，删除它们？（只删 thumbs 目录里没有对应记录的图片，不影响原图）`
      );
      if (!ok) return;
      const r = await api.maintenanceOrphanThumbs(false);
      onToast(`已清理 ${r.removed} 个孤立缩略图`);
    });

  const vacuum = () =>
    run('vacuum', async () => {
      const r = await api.maintenanceVacuum();
      onToast(`完整性：${r.integrity}；压缩节省 ${fmtBytes(r.saved)}`);
    });

  const rescan = () =>
    run('rescan', async () => {
      const r = await api.maintenanceRescan();
      if (r.ok === false) return onToast(r.message || '任务正在运行');
      onToast(`扫描完成，新增 ${r.saved ?? 0} 张`);
      onLibraryChanged();
    });

  /* 视频/音频的时长与分辨率：入库时已尽量探测，存量记录在这里按需补算 */
  const probeMedia = () =>
    run('probe', async () => {
      const r = await api.maintenanceProbeMedia(300);
      onToast(`已补算 ${r.probed} 个（跳过 ${r.skipped}，剩余 ${r.remain}）`);
      onLibraryChanged();
    });

  /* CLIP 特征：相似度分析的前提，缺特征时「深度相似」会漏结果 */
  const clipBackfill = () =>
    run('clip', async () => {
      const r = await api.clipBackfill();
      onToast(r.message || `已开始补算（待处理 ${r.total ?? 0} 张）`);
    });

  const relocate = () =>
    run('relocate', async () => {
      const r = await api.relocateMissing();
      onToast(`找回 ${r.relocated} 张，仍有 ${r.remaining} 张缺失`);
      onLibraryChanged();
    });

  const purge = async () => {
    const n = missing?.count || 0;
    if (!n) return onToast('没有缺失文件');
    const ok = await confirmDialog(
      `从库中移除 ${n} 条「文件已不在磁盘」的记录？只删数据库记录，不影响磁盘文件；移除后无法再「尝试找回」。`
    );
    if (!ok) return;
    await run('purge', async () => {
      const r = await api.purgeMissing();
      onToast(`已移除 ${r.removed} 条失配记录`);
      onLibraryChanged();
    });
  };

  return (
    <Card title="维护工具" desc="库体检、修复失配、重建缩略图、压缩数据库。">
      {status ? (
        <div className="maint-grid">
          <div>
            <b>{status.total}</b>
            <span>张图片</span>
          </div>
          <div className={status.missing ? 'warn' : ''}>
            <b>{status.missing}</b>
            <span>文件缺失</span>
          </div>
          <div>
            <b>{status.withThumb}</b>
            <span>有缩略图</span>
          </div>
          <div>
            <b>{fmtBytes(status.thumbBytes)}</b>
            <span>缩略图 {status.thumbFiles} 个</span>
          </div>
          <div>
            <b>{fmtBytes(status.dbBytes)}</b>
            <span>数据库</span>
          </div>
          <div>
            <b>{status.undoCount}</b>
            <span>可撤销编辑</span>
          </div>
        </div>
      ) : (
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>读取中…</span>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn sm" disabled={!!busy}
          title={busy ? '有维护任务正在进行，等它结束再点' : undefined} onClick={rebuildThumbs}>
          {busy === 'thumb' ? '重建中…' : '重建缺失缩略图'}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={busy ? '有维护任务正在进行，等它结束再点' : undefined} onClick={cleanOrphans}>
          {busy === 'orphan' ? '清理中…' : '清理孤立缩略图'}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={busy ? '有维护任务正在进行，等它结束再点' : undefined} onClick={vacuum}>
          {busy === 'vacuum' ? '压缩中…' : '压缩数据库'}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={busy ? '有维护任务正在进行，等它结束再点' : undefined} onClick={rescan}>
          {busy === 'rescan' ? '扫描中…' : '重新扫描目录'}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={busy ? '有维护任务正在进行，等它结束再点' : undefined} onClick={probeMedia}>
          {busy === 'probe' ? '探测中…' : '补算音视频时长'}
        </button>
      </div>

      <div className="maint-missing">
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.9 }}>
          <b style={{ color: 'var(--text)' }}>库-盘失配</b>：在应用外改名/移动过的文件会显示为缺失。
          先「尝试找回」（按文件名在保存目录里重新定位），确认实在找不回来再「移除记录」。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!!busy || !missing?.count}
            title={
              busy ? '有维护任务正在进行' : !missing?.count ? '当前没有失配文件，无需找回' : undefined
            }
            onClick={relocate}
          >
            {busy === 'relocate' ? '找回中…' : `尝试找回${missing?.count ? `（${missing.count}）` : ''}`}
          </button>
          <button
            className="btn sm danger"
            disabled={!!busy || !missing?.count}
            title={
              busy
                ? '有维护任务正在进行'
                : !missing?.count
                  ? '当前没有失配文件，没有记录可移除'
                  : '只删除数据库记录，磁盘上找不回的文件会彻底失去关联'
            }
            onClick={purge}
          >
            移除失配记录
          </button>
        </div>
        {!!status?.sampleMissing?.length && (
          <div className="hint" style={{ marginTop: 8 }}>
            {status.sampleMissing.slice(0, 3).map((m) => (
              <div key={m.id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                #{m.id} {m.path}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="maint-missing">
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.9 }}>
          <b style={{ color: 'var(--text)' }}>CLIP 视觉特征</b>：相似度/智能归类的前提。
          {clip?.loadError
            ? `模型不可用：${clip.loadError}（离线环境需先联网下载一次）`
            : clip
              ? `${clip.model || '模型已就绪'} · 已建模 ${clip.indexed} 张${clip.total > clip.done ? ` · 待补算 ${clip.total - clip.done}` : ''}`
              : '读取中…'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!!busy || !!clip?.loadError || clip?.running}
            title={
              clip?.loadError
                ? `模型不可用：${clip.loadError}`
                : clip?.running
                  ? '正在补算特征'
                  : busy
                    ? '有维护任务正在进行'
                    : undefined
            }
            onClick={clipBackfill}
          >
            {clip?.running ? `补算中 ${clip.done}/${clip.total}` : '补算缺失特征'}
          </button>
        </div>
      </div>

      <div className="maint-missing" style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.9 }}>
          <b style={{ color: 'var(--text)' }}>崩溃与日志</b>：崩溃转储只留在本机，启动时自动清理 7 天前的文件。
          遇到闪退、白屏，可以把这两个目录里的文件发给开发者定位。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!desktop?.openCrashDir}
            title={desktop?.openCrashDir ? '打开崩溃转储目录' : '仅桌面端可用'}
            onClick={async () => {
              try {
                const err = await desktop?.openCrashDir?.();
                if (err) onToast(`打不开目录：${err}`, 'error');
              } catch (e) {
                onToast(`打不开目录：${(e as Error).message}`, 'error');
              }
            }}
          >
            打开崩溃转储目录
          </button>
          <button
            className="btn sm"
            disabled={!desktop?.openLogDir}
            title={desktop?.openLogDir ? '打开运行日志目录' : '仅桌面端可用'}
            onClick={async () => {
              try {
                const err = await desktop?.openLogDir?.();
                if (err) onToast(`打不开目录：${err}`, 'error');
              } catch (e) {
                onToast(`打不开目录：${(e as Error).message}`, 'error');
              }
            }}
          >
            打开运行日志目录
          </button>
        </div>
      </div>
    </Card>
  );
}
