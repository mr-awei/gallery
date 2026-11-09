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
      const failedPart = failed ? `，失败 ${failed} 张（文件不在或没有内嵌预览）` : '';
      onToast(`重建 ${rebuilt} 张（已存在 ${skipped}${failedPart}）`, failed ? 'error' : 'info');
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
      const failPart = failed ? `，失败 ${failed} 张（文件不在或没有内嵌预览）` : '';
      onToast(
        rotated
          ? `已修正 ${rotated} 张竖拍照片（改宽高 ${dims} 张${cleared ? `，重出缩略图 ${cleared} 张` : ''}${failPart}）`
          : '没有需要修正方向的照片',
        failed ? 'error' : 'info'
      );
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

  /** 幽灵文件夹：磁盘已删 / 历史跨库残留，侧栏会显示成「另一个库的文件夹」且张数 0 */
  const cleanGhostFolders = () =>
    run('ghost', async () => {
      const dry = await api.maintenanceGhostFolders(true);
      if (!dry.candidates.length) return onToast('没有幽灵文件夹');
      const names = dry.candidates.slice(0, 5).map((c) => c.name).join('、');
      const more = dry.candidates.length > 5 ? ` 等 ${dry.candidates.length} 个` : '';
      const ok = await confirmDialog(
        `发现 ${dry.candidates.length} 个幽灵文件夹（${names}${more}）：磁盘上已不存在，且里面一张图都没有。删除它们？（只删文件夹节点，不动任何素材）`
      );
      if (!ok) return;
      const r = await api.maintenanceGhostFolders(false);
      onToast(`已删除 ${r.deleted} 个幽灵文件夹`);
      onLibraryChanged();
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
      const unreadable = r.unreadable || 0;
      onToast(
        `找回 ${r.relocated} 张，仍有 ${r.remaining} 张缺失${unreadable ? `；${unreadable} 个文件读不到大小，未参与重关联` : ''}`
      );
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
          title={
            busy
              ? '有维护任务正在进行，等它结束再点'
              : '相机竖拍的照片会带 EXIF 方向标记：修好宽高与缩略图，避免卡片把竖图当横图裁掉、RAW 躺倒 90°'
          }
          onClick={fixOrientation}>
          {busy === 'orient' ? '修正中…' : '修正竖拍方向'}
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
        <button className="btn sm" disabled={!!busy}
          title="侧栏里张数为 0、磁盘上已不存在的文件夹（切换资源库后残留的那种）" onClick={cleanGhostFolders}>
          {busy === 'ghost' ? '清理中…' : '清理幽灵文件夹'}
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
    running: '正在导入',
    interrupted: '上次导入被中断',
    done: '上次导入已完成',
    cancelled: '上次导入已取消',
    failed: '上次导入失败',
  };
  const canResume = j.status === 'interrupted' || j.status === 'failed';

  const resume = async () => {
    setBusy(true);
    try {
      const r = await api.resumeImport();
      onToast(`继续导入完成：本次新增 ${r.saved ?? 0} 张`);
      load();
    } catch (e) {
      onToast(`继续导入失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>{label[j.status] || '导入记录'}</b>
        <span className="hint" style={{ flex: 1, minWidth: 200 }}>
          已保存 {j.saved ?? 0} 张 · 跳过重复 {j.duplicate ?? 0} · 失败 {j.errors ?? 0}
          {j.syncConflicts ? ` · 同步冲突副本 ${j.syncConflicts}` : ''}
          {j.startedAt ? ` · ${new Date(j.startedAt).toLocaleString()}` : ''}
        </span>
        {canResume && (
          <button className="btn sm" disabled={busy} onClick={() => void resume()}>
            {busy ? '继续中…' : '继续导入（只补没进来的）'}
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
      onToast(r.ok ? '路径唯一索引已建立' : `仍有 ${r.duplicates} 组重复路径，先去「整理 → 重复」清理`);
      load();
    } catch (e) {
      onToast(`重建失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const clean = async () => {
    setBusy('orphans');
    try {
      const r = await api.cleanOrphans();
      onToast(r.removed ? `已清理 ${r.removed} 条孤儿关联` : '没有需要清理的孤儿关联');
      load();
    } catch (e) {
      onToast(`清理失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  if (!h) return null;
  const orphans = h.orphans;
  const orphanTotal = [orphans.folders, orphans.comments, orphans.clipVec].reduce((s, n) => s + Math.max(0, n), 0);

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>库健康</b>
        <span className="hint" style={{ flex: 1 }}>
          {h.pathIndex.ok
            ? '素材路径唯一索引：已建立'
            : `素材路径唯一索引：缺失（${h.pathIndex.duplicates} 组重复路径），并发导入可能写入重复记录`}
        </span>
        {!h.pathIndex.ok && (
          <button className="btn sm" disabled={!!busy} onClick={() => void rebuild()}>
            {busy === 'index' ? '重建中…' : '重建索引'}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="hint" style={{ flex: 1 }}>
          孤儿关联：文件夹 {orphans.folders} · 评论 {orphans.comments} · 向量 {orphans.clipVec}
          {orphanTotal === 0 ? '（正常）' : '（会让人物 / 文件夹计数虚高，建议清理）'}
        </span>
        {orphanTotal > 0 && (
          <button className="btn sm" disabled={!!busy} onClick={() => void clean()}>
            {busy === 'orphans' ? '清理中…' : '清理孤儿关联'}
          </button>
        )}
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
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const retry = async () => {
    setBusy('retry');
    try {
      const r = await api.retryThumbs();
      onToast(r.queued ? `已重新排队 ${r.queued} 张` : '没有可重试的失败项');
      load();
    } catch (e) {
      onToast(`重试失败：${(e as Error).message}`, 'error');
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
      onToast('已清空失败明细');
      load();
    } catch (e) {
      onToast(`清空失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  if (!st) return null;
  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>缩略图队列</b>
        <span className="hint" style={{ flex: 1 }}>
          待生成 {st.pending} · 生成中 {st.running} · 累计失败 {st.failed} · 库里缺图 {st.missing}
        </span>
        <button className="btn sm" disabled={!!busy || !st.failures.length} onClick={() => void retry()}>
          {busy === 'retry' ? '排队中…' : '重试失败项'}
        </button>
        <button
          className="btn sm ghost"
          disabled={!!busy || !st.failures.length}
          onClick={() => void clearFailures()}
          title="清空失败明细（重试仍失败的条目）"
        >
          {busy === 'clear' ? '清空中…' : '清空明细'}
        </button>
      </div>
      {st.failures.length === 0 ? (
        <div className="hint">没有失败记录。缺图 {st.missing} 张会在后台按顺序补，不需要手动干预。</div>
      ) : (
        <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 12.2 }}>
          {st.failures.slice(0, 20).map((f) => (
            <div key={f.id} style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
              <span style={{ color: 'var(--muted)', minWidth: 54 }}>#{f.id}</span>
              <span style={{ flex: 1 }}>{f.reason}</span>
            </div>
          ))}
          {st.failures.length > 20 && <div className="hint">还有 {st.failures.length - 20} 条…</div>}
        </div>
      )}
    </div>
  );
}
