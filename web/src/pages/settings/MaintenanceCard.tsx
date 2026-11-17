import React, { useCallback, useEffect, useState } from 'react';
import { api, desktop, formatSize, quiet } from '../../api';
import { confirmDialog } from '../../components/Dialogs';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  onLibraryChanged: () => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

type Status = Awaited<ReturnType<typeof api.maintenanceStatus>>;

// 体积格式化统一走 api.formatSize（以前每个页面一份，同一个数显示得不一样）
const fmtBytes = formatSize;

/**
 * 关联表孤儿行：库里没有外键，异常退出（进程被杀 / 磁盘满）会留下指向已删图片的
 * 标签、向量、回收站记录。它们不报错，但统计会虚高、回收站点开是空白。
 *
 * 维护按钮与库健康面板共用这一份流程（先扫描预览 → 确认 → 真删 → 复查），
 * 避免两处各写一套、口径越走越远。返回清理行数，0 表示没孤儿或用户取消。
 * 文案要跟语言走，所以 t 由调用点传入（模块级不能调 t）。
 */
async function cleanRowOrphansFlow(
  onToast: (msg: string, kind?: 'info' | 'error') => void,
  ): Promise<number> {
  const dry = await api.maintenanceOrphans();
  if (!dry.total) {
    onToast(i18n.t('k5661d125'));
    return 0;
  }
  const detail = dry.byTable
    .filter((x) => x.count)
    .slice(0, 6)
    .map((x) => i18n.t('k2e496850', { p0: x.note, p1: x.table, p2: x.column, p3: x.count }))
    .join('\n');
  const ok = await confirmDialog(i18n.t('ke934e924', { p0: dry.total }), {
    detail: i18n.t('kd81f7cc0', { p0: detail }),
  });
  if (!ok) return 0;
  const r = await api.maintenanceCleanOrphans(false);
  // after 是清理后重新扫描的结果，拿它兜底：只报「已清理 N 行」而不复查，等于自说自话
  const left = r.after?.total ?? 0;
  onToast(
    left
      ? i18n.t('k290fd6d5', { p0: r.removed, p1: left })
      : i18n.t('k3cc4c42c', { p0: r.removed }),
    left ? 'error' : 'info'
  );
  return r.removed;
}

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
      // 以前只跑 300 张就结束，用户以为「修好了」，其实还剩几千张没补。
      // 服务端按 nextBeforeId 分页，这里一直翻到底（上限 80 轮 = 2.4 万张，防意外死循环）。
      let rebuilt = 0;
      let skipped = 0;
      let failed = 0;
      let beforeId = 0;
      for (let round = 0; round < 80; round++) {
        const r = await api.maintenanceRebuildThumbs(300, beforeId);
        rebuilt += r.rebuilt;
        skipped += r.skipped;
        failed += r.failed;
        if (!r.nextBeforeId) break;
        beforeId = r.nextBeforeId;
      }
      // 失败的不是「已重建」：文件已不在，或根本没内嵌预览（RAW 变体/设计稿）
      const failedPart = failed
        ? i18n.t('k2d298b46', { p0: failed })
        : '';
      onToast(
        i18n.t('k2092990a', { p0: rebuilt, p1: skipped, p2: failedPart }),
        failed ? 'error' : 'info',
      );
      onLibraryChanged();
    });

  /**
   * 修正 EXIF 方向：竖拍照片在库里躺倒 90°、卡片按横图裁切。
   * RAW/设计稿的缩略图由后端在同一个请求里 force 重画（不再转后台补图：
   * 旧文件在 Windows 上偶尔删不掉，后台会把它当缓存复用，图仍然是躺倒的）。
   */
  const fixOrientation = () =>
    run('orient', async () => {
      let rotated = 0;
      let dims = 0;
      let cleared = 0;
      let failed = 0;
      let beforeId = 0;
      for (let round = 0; round < 80; round++) {
        const r = await api.maintenanceFixOrientation(300, beforeId);
        rotated += r.rotated;
        dims += r.dims;
        cleared += r.cleared;
        failed += r.failed;
        if (!r.nextBeforeId) break;
        beforeId = r.nextBeforeId;
      }
      const failPart = failed
        ? i18n.t('k2d298b46', { p0: failed })
        : '';
      onToast(
        rotated
          ? i18n.t('k4e866137', { p0: rotated, p1: dims, p2: cleared ? i18n.t('k343821e2', { p0: cleared }) : '', p3: failPart })
          : i18n.t('kb3e183ea'),
        failed ? 'error' : 'info'
      );
      onLibraryChanged();
    });

  const cleanOrphans = () =>
    run('orphan', async () => {
      const dry = await api.maintenanceOrphanThumbs(true);
      if (!dry.found) return onToast(i18n.t('kc26d8d2b'));
      const names = dry.sample.map((p) => p.split(/[\\/]/).pop() || p);
      const more = dry.found > names.length
        ? i18n.t('ke2ce7d83', { p0: dry.found })
        : '';
      const ok = await confirmDialog(i18n.t('kde0ec61d', { p0: dry.found }), {
        detail: i18n.t('k20503945', { p0: names.join('\n'), p1: more }),
      });
      if (!ok) return;
      const r = await api.maintenanceOrphanThumbs(false);
      onToast(i18n.t('kbb0ce5a5', { p0: r.removed }));
    });

  const cleanRowOrphans = () =>
    run('rows', async () => {
      if (await cleanRowOrphansFlow(onToast, )) onLibraryChanged();
    });

  /** 幽灵文件夹：磁盘已删 / 历史跨库残留，侧栏会显示成「另一个库的文件夹」且张数 0 */
  const cleanGhostFolders = () =>
    run('ghost', async () => {
      const dry = await api.maintenanceGhostFolders(true);
      if (!dry.candidates.length) return onToast(i18n.t('ka6daa88b'));
      const names = dry.candidates.slice(0, 5).map((c) => c.name).join('、');
      const more = dry.candidates.length > 5 ? i18n.t('k238fd3a8', { p0: dry.candidates.length }) : '';
      const ok = await confirmDialog(
        i18n.t('k6146b081', { p0: dry.candidates.length, p1: names, p2: more })
      );
      if (!ok) return;
      const r = await api.maintenanceGhostFolders(false);
      onToast(i18n.t('ka920a1b9', { p0: r.deleted }));
      onLibraryChanged();
    });

  const vacuum = () =>
    run('vacuum', async () => {
      const r = await api.maintenanceVacuum();
      onToast(i18n.t('k3d96f872', { p0: r.integrity, p1: fmtBytes(r.saved) }));
    });

  const rescan = () =>
    run('rescan', async () => {
      const r = await api.maintenanceRescan();
      if (r.ok === false) return onToast(r.message || i18n.t('k4a5815f8'));
      onToast(i18n.t('k662f8437', { p0: r.saved ?? 0 }));
      onLibraryChanged();
    });

  /* 视频/音频的时长与分辨率：入库时已尽量探测，存量记录在这里按需补算 */
  const probeMedia = () =>
    run('probe', async () => {
      const r = await api.maintenanceProbeMedia(300);
      onToast(
        i18n.t('k61834835', { p0: r.probed, p1: r.skipped, p2: r.remain }),
      );
      onLibraryChanged();
    });

  /* CLIP 特征：相似度分析的前提，缺特征时「深度相似」会漏结果 */
  const clipBackfill = () =>
    run('clip', async () => {
      const r = await api.clipBackfill();
      onToast(r.message || i18n.t('k273e19cc', { p0: r.total ?? 0 }));
    });

  const relocate = () =>
    run('relocate', async () => {
      const r = await api.relocateMissing();
      const unreadable = r.unreadable || 0;
      onToast(
        i18n.t('k1dbaca63', { p0: r.relocated, p1: r.remaining, p2: unreadable ? i18n.t('k432f62d4', { p0: unreadable }) : '' })
      );
      onLibraryChanged();
    });

  /**
   * 本地零样本打标：用 CLIP 给「还没打标签」的素材打上大类标签。
   * 先预演看会打成什么，确认后再写库 —— 自动标签最怕的是「悄悄打错还改不了」。
   */
  const localTagging = () =>
    run('localtag', async () => {
      const dry = await api.localTagPreview({ limit: 40, top: 3 });
      if (!dry.done) {
        return onToast(
          dry.remain === 0
            ? i18n.t('k94bea02f')
            : i18n.t('kb259dfe2'),
        );
      }
      const sample = (dry.samples || [])
        .slice(0, 6)
        .map((s) => `#${s.id} → ${s.tags.join('、')}`)
        .join('\n');
      const ok = await confirmDialog(i18n.t('k22ec27b5', { p0: dry.done }), {
        detail: i18n.t('kb2cc5fe4', { p0: sample }),
      });
      if (!ok) return;
      const r = await api.localTagBatch({ limit: 40, top: 3 });
      onToast(
        i18n.t('k66224dd7', { p0: r.added, p1: r.remain ? i18n.t('k8832f578', { p0: r.remain }) : '' }),
      );
      if (r.added) onLibraryChanged();
    });

  /**
   * 从 XMP sidecar 拉回元数据：在外面用 Lightroom / digiKam 改完标签，
   * 拷回素材目录后点这里合并进库（标签并集，评分/备注只在库里为空时补）。
   */
  const xmpImport = () =>
    run('xmp', async () => {
      const r = await api.maintenanceXmpImport(500);
      onToast(
        r.updated
          ? i18n.t('k3550443b', { p0: r.updated, p1: r.nextBeforeId ? i18n.t('kaab6dd21') : '' })
          : i18n.t('k55e88c18'),
        'info'
      );
      if (r.updated) onLibraryChanged();
    });

  const purge = async () => {
    const n = missing?.count || 0;
    if (!n) return onToast(i18n.t('kbc98fd14'));
    const ok = await confirmDialog(
      i18n.t('ka5b40616', { p0: n })
    );
    if (!ok) return;
    await run('purge', async () => {
      const r = await api.purgeMissing();
      onToast(i18n.t('kb34b718c', { p0: r.removed }));
      onLibraryChanged();
    });
  };

  const busyTitle = busy ? i18n.t('k2cbab215') : undefined;

  return (
    <Card
      title={i18n.t('k3bf2da95')}
      desc={i18n.t('kd6d3f5e1')}
    >
      {status ? (
        <div className="maint-grid">
          <div>
            <b>{status.total}</b>
            <span>{i18n.t('k54aa1e97')}</span>
          </div>
          <div className={status.missing ? 'warn' : ''}>
            <b>{status.missing}</b>
            <span>{i18n.t('kefd177a4')}</span>
          </div>
          <div>
            <b>{status.withThumb}</b>
            <span>{i18n.t('k7b2c6fbc')}</span>
          </div>
          <div>
            <b>{fmtBytes(status.thumbBytes)}</b>
            <span>{i18n.t('k5c6c3b47', { p0: status.thumbFiles })}</span>
          </div>
          <div>
            <b>{fmtBytes(status.dbBytes)}</b>
            <span>{i18n.t('k68051bf4')}</span>
          </div>
          <div>
            <b>{status.undoCount}</b>
            <span>{i18n.t('kc09dd069')}</span>
          </div>
        </div>
      ) : (
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>{i18n.t('k8b5015f0')}</span>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn sm" disabled={!!busy}
          title={busyTitle} onClick={rebuildThumbs}>
          {busy === 'thumb' ? i18n.t('k3d99e2cf') : i18n.t('k2723a66d')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={
            busy
              ? busyTitle
              : i18n.t('k5bbe3d00')
          }
          onClick={fixOrientation}>
          {busy === 'orient' ? i18n.t('k6d79fe1b') : i18n.t('k5ddd27f4')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={
            busy
              ? busyTitle
              : i18n.t('k16163264')
          }
          onClick={() => void localTagging()}>
          {busy === 'localtag' ? i18n.t('k5f906b8b') : i18n.t('k51e0ac97')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={
            busy
              ? busyTitle
              : i18n.t('kaebab358')
          }
          onClick={() => void xmpImport()}>
          {busy === 'xmp' ? i18n.t('k306926b8') : i18n.t('kb99f6d4e')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={busyTitle} onClick={cleanOrphans}>
          {busy === 'orphan' ? i18n.t('ke8ddca9d') : i18n.t('k223ca637')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={busyTitle} onClick={vacuum}>
          {busy === 'vacuum' ? i18n.t('kb7ec852a') : i18n.t('k574b1deb')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={busyTitle} onClick={rescan}>
          {busy === 'rescan' ? i18n.t('k68c15533') : i18n.t('k72295762')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={busyTitle} onClick={probeMedia}>
          {busy === 'probe' ? i18n.t('k396c315c') : i18n.t('kd0d1eba6')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={i18n.t('k4c9b1134')} onClick={cleanGhostFolders}>
          {busy === 'ghost' ? i18n.t('ke8ddca9d') : i18n.t('k2271c454')}
        </button>
        <button className="btn sm" disabled={!!busy}
          title={i18n.t('k8a70d806')}
          onClick={cleanRowOrphans}>
          {busy === 'rows' ? i18n.t('ka90a56f3') : i18n.t('k6276bdcd')}
        </button>
      </div>

      <div className="maint-missing">
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.9 }}>
          <b style={{ color: 'var(--text)' }}>{i18n.t('k3ec0ccfc')}</b>
          {i18n.t('kf676d710')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!!busy || !missing?.count}
            title={
              busy
                ? i18n.t('k1d2a6b5a')
                : !missing?.count
                  ? i18n.t('k0e79fc6c')
                  : undefined
            }
            onClick={relocate}
          >
            {busy === 'relocate'
              ? i18n.t('k976dac88')
              : i18n.t('k49fb5ab1', { p0: missing?.count ? `（${missing.count}）` : '' })}
          </button>
          <button
            className="btn sm danger"
            disabled={!!busy || !missing?.count}
            title={
              busy
                ? i18n.t('k1d2a6b5a')
                : !missing?.count
                  ? i18n.t('ke9524242')
                  : i18n.t('k05668e80')
            }
            onClick={purge}
          >
            {i18n.t('kbafeb286')}
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
          <b style={{ color: 'var(--text)' }}>{i18n.t('k098efd9b')}</b>
          {i18n.t('k78261bf4')}
          {clip?.loadError
            ? i18n.t('k65d06a43', { p0: clip.loadError })
            : clip
              ? i18n.t('k963d9bb7', { p0: clip.model || i18n.t('k2ea70917'), p1: clip.indexed, p2: clip.total > clip.done ? i18n.t('k3141ba9e', { p0: clip.total - clip.done }) : '' })
              : i18n.t('k8b5015f0')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!!busy || !!clip?.loadError || clip?.running}
            title={
              clip?.loadError
                ? i18n.t('k249bc4ea', { p0: clip.loadError })
                : clip?.running
                  ? i18n.t('k50609cf3')
                  : busy
                    ? i18n.t('k1d2a6b5a')
                    : undefined
            }
            onClick={clipBackfill}
          >
            {clip?.running ? i18n.t('k2b1eb887', { p0: clip.done, p1: clip.total }) : i18n.t('k9e023bdb')}
          </button>
        </div>
      </div>

      <div className="maint-missing" style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.9 }}>
          <b style={{ color: 'var(--text)' }}>{i18n.t('k6bfeb6b6')}</b>
          {i18n.t('k21f2bc37')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!desktop?.openCrashDir}
            title={desktop?.openCrashDir ? i18n.t('k1761a4c6') : i18n.t('k3b5bd0ff')}
            onClick={async () => {
              try {
                const err = await desktop?.openCrashDir?.();
                if (err) onToast(i18n.t('k494daab8', { p0: err }), 'error');
              } catch (e) {
                onToast(i18n.t('k494daab8', { p0: (e as Error).message }), 'error');
              }
            }}
          >
            {i18n.t('k1761a4c6')}
          </button>
          <button
            className="btn sm"
            disabled={!desktop?.openLogDir}
            title={desktop?.openLogDir ? i18n.t('k780d4b0e') : i18n.t('k3b5bd0ff')}
            onClick={async () => {
              try {
                const err = await desktop?.openLogDir?.();
                if (err) onToast(i18n.t('k494daab8', { p0: err }), 'error');
              } catch (e) {
                onToast(i18n.t('k494daab8', { p0: (e as Error).message }), 'error');
              }
            }}
          >
            {i18n.t('k780d4b0e')}
          </button>
          <button
            className="btn sm primary"
            disabled={!desktop?.exportDiagnostics}
            title={desktop?.exportDiagnostics ? i18n.t('k220cfaf2') : i18n.t('k3b5bd0ff')}
            onClick={async () => {
              try {
                const r = await desktop?.exportDiagnostics?.();
                if (r?.canceled) return;
                if (!r?.ok) return onToast(i18n.t('k246e218d', { p0: r?.error || i18n.t('kf91d273b') }), 'error');
                onToast(i18n.t('kfc076ea6', { p0: r.path }));
              } catch (e) {
                onToast(i18n.t('k246e218d', { p0: (e as Error).message }), 'error');
              }
            }}
          >
            {i18n.t('keca99856')}
          </button>
        </div>
      </div>
      <ImportJobPanel onToast={onToast} />
      <ThumbQueuePanel onToast={onToast} />
      <HealthPanel onToast={onToast} />
    </Card>
  );
}

/**
 * 上次导入干了什么：中断 / 失败 / 完成都有记录。
 * 「接着导」靠的是增量扫描：已登记且指纹未变的文件直接跳过，所以重跑即续传。
 */
function ImportJobPanel({ onToast }: { onToast: (msg: string, kind?: 'info' | 'error') => void }) {
  const [job, setJob] = useState<Awaited<ReturnType<typeof api.importJob>> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.importJob().then(setJob).catch(quiet);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const j = job?.job;
  if (!j) return null;
  const label: Record<string, string> = {
    running: i18n.t('k828da2e2'),
    interrupted: i18n.t('k91ee3dee'),
    done: i18n.t('k795f9586'),
    cancelled: i18n.t('k38d1bdc8'),
    failed: i18n.t('k1af8304b'),
  };
  const canResume = j.status === 'interrupted' || j.status === 'failed';

  const resume = async () => {
    setBusy(true);
    try {
      const r = await api.resumeImport();
      onToast(i18n.t('k1fee167a', { p0: r.saved ?? 0 }));
      load();
    } catch (e) {
      onToast(i18n.t('k8a6fca52', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>{label[j.status] || i18n.t('k93568869')}</b>
        <span className="hint" style={{ flex: 1, minWidth: 200 }}>
          {i18n.t('kdc7fe9c6', { p0: j.saved ?? 0, p1: j.duplicate ?? 0, p2: j.errors ?? 0 })}
          {j.syncConflicts ? i18n.t('k0e4abb56', { p0: j.syncConflicts }) : ''}
          {j.startedAt ? ` · ${new Date(j.startedAt).toLocaleString()}` : ''}
        </span>
        {canResume && (
          <button className="btn sm" disabled={busy} onClick={() => void resume()}>
            {busy ? i18n.t('k343630ee') : i18n.t('kb2d28603')}
          </button>
        )}
      </div>
      {j.error && <div className="danger small" style={{ marginTop: 6 }}>{j.error}</div>}
    </div>
  );
}

/**
 * 缩略图队列：看得见「还在跑几张、哪些失败了、为什么」。
 * 之前失败只进日志，用户看到的就是一直转圈 —— 典型的「把失败伪装成空」。
 */
function HealthPanel({ onToast }: { onToast: (msg: string, kind?: 'info' | 'error') => void }) {
  const [h, setH] = useState<Awaited<ReturnType<typeof api.libraryHealth>> | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.libraryHealth().then(setH).catch(quiet);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const rebuild = async () => {
    setBusy('index');
    try {
      const r = await api.rebuildPathIndex();
      onToast(
        r.ok
          ? i18n.t('kfd0808bd')
          : i18n.t('k7932d3cd', { p0: r.duplicates }),
      );
      load();
    } catch (e) {
      onToast(i18n.t('k938b209c', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  const clean = async () => {
    setBusy('orphans');
    try {
      await cleanRowOrphansFlow(onToast, );
      load();
    } catch (e) {
      onToast(i18n.t('k9b27d3e4', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  if (!h) return null;
  const orphans = h.orphans;
  const orphanTotal = orphans.total;
  // 明细按规则表来（与后端 lib/integrity.js 同一份），只列真的有孤儿行的项
  const orphanDetail = orphans.byTable.filter((x) => x.count > 0).sort((a, b) => b.count - a.count);

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>{i18n.t('kc8b94a01')}</b>
        <span className="hint" style={{ flex: 1 }}>
          {h.pathIndex.ok
            ? i18n.t('kff628334')
            : i18n.t('k6a835f02', { p0: h.pathIndex.duplicates })}
        </span>
        {!h.pathIndex.ok && (
          <button className="btn sm" disabled={!!busy} onClick={() => void rebuild()}>
            {busy === 'index' ? i18n.t('k3d99e2cf') : i18n.t('kbe0ade04')}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          className="hint"
          style={{ flex: 1 }}
          title={orphanDetail.map((x) => i18n.t('k2e496850', { p0: x.note, p1: x.table, p2: x.column, p3: x.count })).join('\n')}
        >
          {i18n.t('k35daa5ea')}
          {i18n.t('k33ef699f', { p0: orphanTotal })}
          {orphanTotal === 0
            ? i18n.t('k055fd284')
            : i18n.t('kc07627ae', { p0: orphanDetail
                  .slice(0, 4)
                  .map((x) => `${x.note} ${x.count}`)
                  .join(' · '), p1: orphanDetail.length > 4 ? i18n.t('kc3729bdc', { p0: orphanDetail.length }) : '' })}
        </span>
        {orphanTotal > 0 && (
          <button className="btn sm" disabled={!!busy} onClick={() => void clean()}>
            {busy === 'orphans' ? i18n.t('ke8ddca9d') : i18n.t('k86e02f35')}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
        <span
          className="hint"
          style={{ flex: 1 }}
          title={[
            h.foreignKeys.builtAt ? i18n.t('k5ed7ce69', { p0: new Date(h.foreignKeys.builtAt).toLocaleString() }) : '',
            h.foreignKeys.failures.length
              ? i18n.t('kbe7c24f4', { p0: h.foreignKeys.failures.map((x) => `${x.table}（${x.error}）`).join('、') })
              : '',
          ]
            .filter(Boolean)
            .join('\n')}
        >
          {i18n.t('kec710023')}
          {h.foreignKeys.enabled ? i18n.t('k53ace430') : i18n.t('kcbb289f0')}
          {h.foreignKeys.enabled && h.foreignKeys.violations > 0
            ? i18n.t('k6d6faec4', { p0: h.foreignKeys.violations })
            : ''}
          {h.foreignKeys.failures.length
            ? i18n.t('k3c874e89', { p0: h.foreignKeys.failures.length })
            : ''}
        </span>
      </div>
      {!!h.warnings?.length && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--warn)', fontSize: 12.5 }}>
          {h.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThumbQueuePanel({ onToast }: { onToast: (msg: string, kind?: 'info' | 'error') => void }) {
  const [st, setSt] = useState<{
    pending: number;
    running: number;
    failed: number;
    missing: number;
    lastError: string;
    failures: { id: number; reason: string; at: string }[];
  } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api
      .thumbQueueStatus()
      .then(setSt)
      .catch(quiet);
  }, []);

  useEffect(() => {
    load();
    // 队列是后台在推进的，5 秒刷一次即可；页面不可见时不刷
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const retry = async () => {
    setBusy('retry');
    try {
      const r = await api.retryThumbs();
      onToast(r.queued ? i18n.t('k60fba5c9', { p0: r.queued }) : i18n.t('k2c81ab59'));
      load();
    } catch (e) {
      onToast(i18n.t('k3420484b', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  // 单张重试：200 条里只有一条是文件被临时占用时，不该逼用户整批重跑
  const retryOne = async (id: number) => {
    setBusy(`one-${id}`);
    try {
      const r = await api.retryThumbs(id);
      onToast(
        r.queued
          ? i18n.t('k00649744', { p0: id })
          : i18n.t('kf5cee9a4', { p0: id }),
      );
      load();
    } catch (e) {
      onToast(i18n.t('k3420484b', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  // 失败明细是「排查用」的，批量重试也救不回的（文件已删之类）会一直留着；
  // 提供清空入口，避免列表越堆越长、还让用户误以为还有东西没处理。
  const clearFailures = async () => {
    setBusy('clear');
    try {
      await api.clearThumbFailures();
      onToast(i18n.t('kafe7f8b5'));
      load();
    } catch (e) {
      onToast(i18n.t('k329014c1', { p0: (e as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  if (!st) return null;
  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>{i18n.t('kc97e3b5a')}</b>
        <span className="hint" style={{ flex: 1 }}>
          {i18n.t('k2f92f5db', { p0: st.pending, p1: st.running, p2: st.failed, p3: st.missing })}
        </span>
        <button className="btn sm" disabled={!!busy || !st.failures.length} onClick={() => void retry()}>
          {busy === 'retry' ? i18n.t('k9b2526c3') : i18n.t('k80f1ca7c')}
        </button>
        <button
          className="btn sm ghost"
          disabled={!!busy || !st.failures.length}
          onClick={() => void clearFailures()}
          title={i18n.t('k22d67561')}
        >
          {busy === 'clear' ? i18n.t('k613cc012') : i18n.t('kaec44086')}
        </button>
      </div>
      {st.failures.length === 0 ? (
        <div className="hint">{i18n.t('k32dfe306', { p0: st.missing })}</div>
      ) : (
        <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 12.2 }}>
          {st.failures.slice(0, 20).map((f) => (
            <div key={f.id} style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'center' }}>
              <span style={{ color: 'var(--muted)', minWidth: 54 }}>#{f.id}</span>
              <span style={{ flex: 1 }}>{f.reason}</span>
              <button
                className="btn sm ghost"
                disabled={!!busy}
                title={i18n.t('k2d2d491c')}
                onClick={() => void retryOne(f.id)}
              >
                {busy === `one-${f.id}` ? i18n.t('k9b2526c3') : i18n.t('k132c5cdc')}
              </button>
            </div>
          ))}
          {st.failures.length > 20 && <div className="hint">{i18n.t('k4e18a969', { p0: st.failures.length - 20 })}</div>}
        </div>
      )}
    </div>
  );
}
