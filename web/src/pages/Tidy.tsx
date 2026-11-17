import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatSize, quiet } from '../api';
import { confirmDialog } from '../components/Dialogs';
import type { DupeGroup, Filters, ImageItem, SimilarGroup } from '../types';
import { IconRefresh, IconTrash, IconWand } from '../components/Icons';
import { IconSliders } from '../components/Icons';
import DuelView from '../components/DuelView';
import CompareView from '../components/CompareView';
import i18n from '../i18n';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onLibraryChanged: () => void;
  /** 当前筛选条件（用于「只查当前筛选结果」） */
  filters?: Filters;
  folderId?: number | null;
  /** 图库里已选中的 id（用于「只查选中的」） */
  selectedIds?: number[];
}

/** 整理页：相似图审查合并 + 补算主色 + AI 自动打标 */
export default function Tidy({ onToast, onLibraryChanged, filters, folderId, selectedIds }: Props) {
  /**
   * 扫描范围：全库最稳，但十万张库里只想在两三百张里查重时全库既慢又吵。
   * 这里让用户明确选范围，并把 ids 传给后端白名单（后端不会再扫全库）。
   */
  const [scope, setScope] = useState<'all' | 'filter' | 'selected'>('all');
  const [scopeNote, setScopeNote] = useState('');

  const resolveScopeIds = useCallback(async (): Promise<number[] | undefined> => {
    if (scope === 'selected') {
      if (!selectedIds?.length) {
        onToast(i18n.t('k067f99c5'));
        return undefined;
      }
      return selectedIds;
    }
    if (scope === 'filter') {
      try {
        const r = await api.imageIds(filters as Filters, { folderId: folderId ?? null });
        if (!r.ids.length) {
          onToast(i18n.t('k7c8bfecd'));
          return undefined;
        }
        setScopeNote(r.truncated ? i18n.t('kb9763ab9') : '');
        return r.ids;
      } catch (e) {
        onToast((e as Error).message);
        return undefined;
      }
    }
    return undefined;
  }, [scope, selectedIds, filters, folderId, onToast]);

  const [threshold, setThreshold] = useState(10);
  const [groups, setGroups] = useState<SimilarGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<Record<string, number>>({}); // 每组选中的保留项
  const [skipped, setSkipped] = useState<Set<number>>(new Set()); // 已「不处理」的组（按 recommendId 持久化）
  const [busy, setBusy] = useState('');
  const [duel, setDuel] = useState<SimilarGroup | null>(null);
  /** 三模式对比（并排 / 分割 / 重叠）：比两两对决更适合看「差在哪」而不是「选哪张」 */
  const [cmpGroup, setCmpGroup] = useState<SimilarGroup | null>(null);

  /** 两两对决淘汰一张：立刻移入回收站；同步把该图从当前组数据里移除 */
  const eliminateOne = useCallback(
    async (keepId: number, loseId: number): Promise<boolean> => {
      try {
        const res = await api.resolveSimilar(keepId, [loseId]);
        if (!res.removed) {
          onToast(res.failures?.[0]?.error || i18n.t('k806045f4'));
          return false;
        }
        setGroups((prev) =>
          prev.map((g) => (g.key === duel?.key ? { ...g, items: g.items.filter((it) => it.id !== loseId) } : g))
        );
        onLibraryChanged();
        return true;
      } catch (err) {
        onToast((err as Error).message, 'error');
        return false;
      }
    },
    [duel, onToast, onLibraryChanged]
  );
  const [mode, setMode] = useState<'phash' | 'format' | 'clip' | 'md5'>('phash'); // 当前列表来源：pHash / 同名格式 / CLIP / MD5 完全重复

  /**
   * 分组卡片的增量渲染数量。
   *
   * 这里没用 VirtualGrid：卡片高度不固定（标题行 + 可换行的缩略图排），固定行高
   * 的窗口算不出来。改成「先渲染 30 组，滚到底部哨兵再追加 30 组」，
   * 首屏 DOM 从「全部重复组」降到 30 张卡片，滚动由用户驱动，不会一次铺几万个节点。
   */
  const [groupLimit, setGroupLimit] = useState(30);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  /* ------------------------- 完全重复（MD5） ------------------------- */
  const [md5Groups, setMd5Groups] = useState<DupeGroup[]>([]);
  const [md5Reclaim, setMd5Reclaim] = useState(0);
  const [md5Keep, setMd5Keep] = useState<Record<string, number>>({}); // 每组保留项
  const [md5Missing, setMd5Missing] = useState(0);
  const [stats, setStats] = useState<{ total: number; noDominant: number; noAiDesc: number; rated: number; noObjHash: number } | null>(
    null
  );
  const [jobProgress, setJobProgress] = useState('');
  /** 长任务横幅：扫描/补算动辄几分钟，只变按钮文字形同假死（P3 反馈） */
  const [scanLabel, setScanLabel] = useState('');
  const [elapsed, setElapsed] = useState(0);

  // 扫描已耗时：横幅上的滚动数字让用户确认任务还活着
  useEffect(() => {
    if (!scanning) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [scanning]);

  const loadStats = useCallback(() => {
    api.tidyStats().then(setStats).catch(quiet);
  }, []);

  const loadSkips = useCallback(() => {
    api.tidySkipList().then((r) => setSkipped(new Set(r.ids))).catch(quiet);
  }, []);

  const scan = useCallback(
    async (th = threshold) => {
      setScanning(true);
      setScanLabel(i18n.t('k730b62b6'));
      try {
        const ids = await resolveScopeIds();
        const res = await api.similar(th, ids);
        setMode('phash');
        setGroups(res.groups);
        const next: Record<string, number> = {};
        for (const g of res.groups) next[g.key] = g.recommendId;
        setPicked(next);
        const range = ids?.length ? i18n.t('k77b258c5', { p0: ids.length }) : '';
        onToast(res.count ? i18n.t('k7913a54d', { p0: res.count, p1: range }) : i18n.t('k135cf395', { p0: range }));
      } catch (err) {
        onToast((err as Error).message, 'error');
      } finally {
        setScanning(false);
        setScanLabel('');
      }
    },
    [threshold, onToast, resolveScopeIds]
  );

  // 同名跨格式去重：同目录同名（如 5.jpg 与 5.png）视为同一张，推荐保留 PNG
  const scanFormat = useCallback(async () => {
    setScanning(true);
    setScanLabel(i18n.t('k3ca023cc'));
    try {
      // 先登记磁盘上新增/手动拷入的文件，否则只有 png 在库里、jpg 配不成对
      const scanned = await api.scanFolder();
      const ids = await resolveScopeIds();
      const res = await api.formatDupes(ids);
      setMode('format');
      setGroups(res.groups);
      const next: Record<string, number> = {};
      for (const g of res.groups) next[g.key] = g.recommendId;
      setPicked(next);
      const extra = scanned.saved ? i18n.t('k240aa08b', { p0: scanned.saved }) : '';
      onToast(res.count ? i18n.t('kd3796db1', { p0: res.count, p1: extra }) : i18n.t('ke94a7eb7', { p0: extra }));
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setScanning(false);
      setScanLabel('');
    }
  }, [onToast, resolveScopeIds]);

  // CLIP 深度特征相似：余弦 ≥ 0.92 视为同类，能抓住 pHash 漏掉的裁剪/旋转/滤镜变体
  const scanClip = useCallback(async () => {
    setScanning(true);
    setScanLabel(i18n.t('k6460338e'));
    try {
      const ids = await resolveScopeIds();
      const res = await api.similarClip(0.92, ids);
      setMode('clip');
      setGroups(res.groups);
      const next: Record<string, number> = {};
      for (const g of res.groups) next[g.key] = g.recommendId;
      setPicked(next);
      if (!res.count) return onToast(i18n.t('k7698ad8e'));
      const exact = res.groups.filter((g) => g.tier === 'exact').length;
      onToast(
        i18n.t('k0a4bd4f7', { p0: res.count, p1: exact, p2: res.count - exact })
      );
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setScanning(false);
      setScanLabel('');
    }
  }, [onToast, resolveScopeIds]);

  /**
   * 完全重复（MD5）：按字节比，比 pHash 更硬。
   * 老库没有 md5，先分批补算（每批 500，循环到补完），再按 md5+size 分组。
   */
  const scanMd5 = useCallback(async () => {
    setScanning(true);
    setScanLabel(i18n.t('k7110bf1f'));
    try {
      let remaining = 1;
      let done = 0;
      for (let i = 0; i < 400 && remaining > 0; i++) {
        const b = await api.md5Backfill(500);
        done += b.done;
        remaining = b.remaining;
        if (b.done > 0) setJobProgress(i18n.t('k996dd2d1', { p0: done, p1: remaining }));
        if (!b.done) break;
      }
      const res = await api.md5Dupes();
      setMode('md5');
      setGroups([]);
      setMd5Groups(res.groups);
      setMd5Reclaim(res.reclaim || 0);
      setMd5Missing(res.missing || 0);
      const next: Record<string, number> = {};
      for (const g of res.groups) next[g.md5] = g.items[0]?.id;
      setMd5Keep(next);
      onToast(res.groups.length ? i18n.t('k661d684a', { p0: res.groups.length, p1: formatSize(res.reclaim || 0) }) : i18n.t('k4c4224de'));
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setScanning(false);
      setScanLabel('');
      setJobProgress('');
    }
  }, [onToast]);

  /** 处理单组：保留选中项，其余移入回收站 */
  const resolveMd5 = async (g: DupeGroup) => {
    const keep = md5Keep[g.md5] || g.items[0]?.id;
    const ids = g.items.filter((it) => it.id !== keep).map((it) => it.id);
    if (!ids.length) return;
    if (!(await confirmDialog(i18n.t('kb3d0ff9b', { p0: ids.length }))))
      return;
    setBusy(g.md5);
    try {
      const r = await api.resolveDupes(keep, ids);
      const failed = r.failed || [];
      if (failed.length) {
        // 部分失败必须如实说：之前无论删没删成都提示「已解决」，重复项还在列表里消失
        onToast(i18n.t('k5eafc6fa', { p0: r.removed, p1: failed.length, p2: failed[0].error }), 'error');
      } else {
        onToast(i18n.t('k4e6ca751', { p0: r.removed }));
      }
      // 有失败就保留这组，方便用户重试
      if (!failed.length) setMd5Groups((prev) => prev.filter((x) => x.md5 !== g.md5));
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  /** 一键清理所有 MD5 重复组（每组保留第一张） */
  const resolveAllMd5 = async () => {
    if (!md5Groups.length) return;
    const total = md5Groups.reduce((s, g) => s + g.items.length - 1, 0);
    if (!(await confirmDialog(i18n.t('k584b720e', { p0: md5Groups.length, p1: total })))) return;
    setBusy('__md5all__');
    let removed = 0;
    let failed = 0;
    const done: string[] = [];
    try {
      for (const g of md5Groups) {
        const keep = md5Keep[g.md5] || g.items[0]?.id;
        try {
          const r = await api.resolveDupes(keep, g.items.filter((it) => it.id !== keep).map((it) => it.id));
          removed += r.removed;
          failed += (r.failed || []).length;
          // 单组失败不掐断整批：只有全部成功才从列表移除，失败组留着可重试
          if (!(r.failed || []).length) done.push(g.md5);
        } catch {
          failed += g.items.length - 1;
        }
      }
      setMd5Groups((prev) => prev.filter((g) => !done.includes(g.md5)));
      onToast(
        failed
          ? i18n.t('k3644067d', { p0: removed, p1: failed })
          : i18n.t('k4e6ca751', { p0: removed })
      );
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  // 已被「不处理」的组不显示（刷新/重扫后依旧隐藏，因为 recommendId 已持久化）
  const visibleGroups = useMemo(
    () => groups.filter((g) => !skipped.has(g.recommendId)),
    [groups, skipped]
  );

  /** 切到别的分组来源时回到第一批，否则会带着上一模式的增量继续铺 */
  useEffect(() => {
    setGroupLimit(30);
  }, [mode]);

  /** 滚到卡片末尾的哨兵就再追加一批，滚动本身驱动，不预生成看不见的卡片 */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setGroupLimit((n) => n + 30);
      },
      { rootMargin: '600px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mode, groupLimit, visibleGroups.length, md5Groups.length]);

  useEffect(() => {
    loadStats();
    loadSkips();
    scan(10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 保留指定项（keepOverride 缺省用当前选中），其余移入回收站；返回是否成功执行 */
  const resolve = async (g: SimilarGroup, keepOverride?: number): Promise<boolean> => {
    const keep = keepOverride ?? (picked[g.key] || g.recommendId);
    const removeIds = g.items.filter((it) => it.id !== keep).map((it) => it.id);
    if (!removeIds.length) {
      onToast(i18n.t('ke92ca59e'));
      return true;
    }
    if (
      !(await confirmDialog(
        i18n.t('k43c2a53e', { p0: removeIds.length })
      ))
    )
      return false;
    setBusy(g.key);
    try {
      const res = await api.resolveSimilar(keep, removeIds);
      onToast(res.removed ? i18n.t('k4e6ca751', { p0: res.removed }) : i18n.t('kc8b30d2b'));
      setGroups((prev) => prev.filter((x) => x.key !== g.key));
      loadStats();
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
    return true;
  };

  /** 一键处理所有组：完全重复组保留推荐项，其余移入回收站；系列照组跳过（需人工逐组确认） */
  const resolveAll = async () => {
    const list = visibleGroups.filter((g) => g.tier !== 'series');
    const seriesCount = visibleGroups.length - list.length;
    if (!list.length) {
      onToast(seriesCount ? i18n.t('kc13ca786', { p0: seriesCount }) : i18n.t('k092cf89d'));
      return;
    }
    const total = list.reduce((s, g) => s + g.items.length - 1, 0);
    const tip = seriesCount ? i18n.t('k908c2742', { p0: seriesCount }) : '';
    if (
      !(await confirmDialog(i18n.t('kef322d33', { p0: list.length, p1: total, p2: tip })))
    )
      return;
    setBusy('__all__');
    let removed = 0;
    const doneKeys = new Set<string>();
    try {
      for (const g of list) {
        const keep = picked[g.key] || g.recommendId;
        const res = await api.resolveSimilar(
          keep,
          g.items.filter((it) => it.id !== keep).map((it) => it.id)
        );
        removed += res.removed;
        doneKeys.add(g.key);
      }
      onToast(i18n.t('k97df5de1', { p0: removed, p1: seriesCount ? i18n.t('kefed2f7c', { p0: seriesCount }) : '' }));
      setGroups((prev) => prev.filter((g) => !doneKeys.has(g.key)));
      loadStats();
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  /** 补算主色（分批循环到算完） */
  const runDominant = async () => {
    if (!stats?.noDominant) return onToast(i18n.t('k5f4cc923'));
    setBusy('dominant');
    let done = 0;
    try {
      for (;;) {
        const res = await api.backfillDominant(300);
        done += res.done;
        setJobProgress(i18n.t('k3d230127', { p0: done, p1: res.remain }));
        if (!res.remain || !res.done) break;
      }
      onToast(i18n.t('kd36ea20c', { p0: done }));
      loadStats();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
      setJobProgress('');
    }
  };

  /** 补算主体哈希（白底抠图归一化 pHash，相似分组更准）：分批循环到算完 */
  const runSubject = async () => {
    if (!stats?.noObjHash) return onToast(i18n.t('kb5c85d23'));
    setBusy('subject');
    let done = 0;
    let skipped = 0;
    try {
      for (;;) {
        const res = await api.backfillSubject(200);
        done += res.done;
        skipped += res.skipped ?? 0;
        setJobProgress(i18n.t('k3d230127', { p0: done + skipped, p1: res.remain }));
        if (!res.remain || (!res.done && !res.skipped)) break;
      }
      onToast(skipped ? i18n.t('kc65cf801', { p0: done, p1: skipped }) : i18n.t('kc8003208', { p0: done }));
      loadStats();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
      setJobProgress('');
    }
  };

  /** AI 打标（分批循环，供自然语言搜索） */
  const runAiTag = async () => {
    if (!stats?.noAiDesc) return onToast(i18n.t('k25c20c72'));
    setBusy('ai');
    let done = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await api.aiTagBatch(4);
        done += res.done;
        setJobProgress(i18n.t('k53adf23d', { p0: done, p1: res.remain }));
        if (!res.remain) break;
        if (!res.done) {
          const err = res.results.find((r) => !r.ok)?.error;
          onToast(err ? i18n.t('k045ab030', { p0: err }) : i18n.t('k99cab8a1'));
          break;
        }
      }
      onToast(i18n.t('k5fb8416a', { p0: done }));
      loadStats();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
      setJobProgress('');
    }
  };

  const label = (it: ImageItem) => `${it.width}×${it.height} · ${formatSize(it.sizeBytes)}`;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{i18n.t('k1b6c7716')}</h1>
          <div className="page-sub">
            {mode === 'format'
              ? i18n.t('kfc9a2b18')
              : mode === 'clip'
                ? i18n.t('kbd4f058a')
                : mode === 'md5'
                  ? i18n.t('kace52fff')
                  : i18n.t('k4b9b6782')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={scanClip} disabled={scanning}>
            <IconWand /> {i18n.t('k071a1dc4')}
          </button>
          <button className="btn" onClick={scanFormat} disabled={scanning}>
            <IconWand /> {i18n.t('k3115634d')}
          </button>
          <button
            className="btn"
            onClick={scanMd5}
            disabled={scanning}
            title={i18n.t('k7d423ed0')}
          >
            <IconWand /> {i18n.t('k37499f1b')}
          </button>
          <button className="btn" onClick={() => scan()} disabled={scanning}>
            <IconRefresh /> {scanning ? i18n.t('k68c15533') : i18n.t('k74e9f7de')}
          </button>
          {mode === 'md5' ? (
            <button
              className="btn primary"
              onClick={resolveAllMd5}
              disabled={!!busy || !md5Groups.length}
            >
              <IconTrash /> {i18n.t('kbd033310')}
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={resolveAll}
              disabled={!!busy || !visibleGroups.length}
            >
              <IconTrash /> {i18n.t('k4e7a08b3')}
            </button>
          )}
          {skipped.size > 0 && (
            <button
              className="btn"
              onClick={async () => {
                try {
                  await api.tidySkipReset();
                  setSkipped(new Set());
                  onToast(i18n.t('kcb6f6cfa'));
                } catch (e) {
                  onToast((e as Error).message);
                }
              }}
              disabled={!!busy}
            >
              重置全部跳过 ({skipped.size})
            </button>
          )}
        </div>
      </div>

      {/* 长任务横幅：sticky 吸顶，滚动后依然可见；jobProgress 有真实进度时优先展示 */}
      {(scanning || busy === 'dominant' || busy === 'ai' || busy === 'subject') && (
        <div className="job-banner">
          <span className="spin" />
          <span>
            {scanning
              ? scanLabel
              : busy === 'dominant'
                ? i18n.t('k0c907b6b')
                : busy === 'subject'
                  ? i18n.t('kd33947d3')
                  : i18n.t('k88f8ff3a')}
          </span>
          <span className="job-meta">{jobProgress || i18n.t('ka2aa36fd', { p0: elapsed })}</span>
        </div>
      )}

      {mode === 'md5' ? (
        <div className="toolbar">
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{i18n.t('k70ab30cb')}</span>
          <span className="hint" style={{ marginLeft: 4 }}>
            {i18n.t('kbe37efc3')}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
              {md5Groups.length} 组 · 可回收 {formatSize(md5Reclaim)}
              {md5Missing > 0 ? i18n.t('k313d0a76', { p0: md5Missing }) : ''}
            </span>
            <button className="btn sm" onClick={scanMd5} disabled={scanning}>
              <IconRefresh /> {i18n.t('kf515f8fb')}
            </button>
          </span>
        </div>
      ) : (
        <div className="toolbar">
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{i18n.t('k6bb5fc14')}</span>
          <select
            className="input"
            style={{ padding: '4px 8px', fontSize: 12.5 }}
            value={scope}
            onChange={(e) => setScope(e.target.value as 'all' | 'filter' | 'selected')}
            title={i18n.t('kd9c52931')}
          >
            <option value="all">{i18n.t('kd5190d5f')}</option>
            <option value="filter">{i18n.t('k35134b52')}</option>
            <option value="selected" disabled={!selectedIds?.length}>
              已选中 {selectedIds?.length || 0} 张
            </option>
          </select>
          <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 6 }}>{i18n.t('k2980caa0')}</span>
          <input
            type="range"
            min={2}
            max={18}
            value={threshold}
            style={{ width: 160 }}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          <span style={{ fontSize: 12.5 }}>{threshold}</span>
          <span className="hint" style={{ marginLeft: 4 }}>
            越小越严格{scopeNote ? ` · ${scopeNote}` : ''}
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12.5 }}>
            {visibleGroups.length} 组 · 共 {visibleGroups.reduce((s, g) => s + g.count, 0)} 张
          </span>
        </div>
      )}

      {/* MD5 完全重复：按字节一致分组，保留任意一张即可 */}
      {mode === 'md5' &&
        (md5Groups.length === 0 ? (
          !scanning && (
            <div className="empty">
              <div className="big"><IconSliders size={42} /></div>
              <h3>{i18n.t('k4c4224de')}</h3>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                {i18n.t('k0b5d21d8')}
              </p>
            </div>
          )
        ) : (
          md5Groups.slice(0, groupLimit).map((g) => {
            const keep = md5Keep[g.md5] || g.items[0]?.id;
            return (
              <div className="card" key={g.md5} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13.5 }}>{g.items.length} 个完全相同的文件</b>
                  <span
                    style={{
                      fontSize: 11.5,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: 'rgba(220,80,80,.15)',
                      color: 'var(--err, #e5484d)',
                    }}
                  >
                    {i18n.t('k288aa511')}
                  </span>
                  <span className="hint">
                    {formatSize(g.size)} / 个 · MD5 {g.md5.slice(0, 12)}…
                  </span>
                  <div style={{ marginLeft: 'auto' }}>
                    <button className="btn sm danger" onClick={() => resolveMd5(g)} disabled={!!busy}>
                      {busy === g.md5 ? i18n.t('kcf978c02') : i18n.t('ka14dcaa5', { p0: g.items.length - 1 })}
                    </button>
                  </div>
                </div>
                <div className="similar-row">
                  {g.items.map((it) => (
                    <label className={`similar-item${keep === it.id ? ' on' : ''}`} key={it.id}>
                      <input
                        type="radio"
                        name={`md5-${g.md5}`}
                        checked={keep === it.id}
                        onChange={() => setMd5Keep((prev) => ({ ...prev, [g.md5]: it.id }))}
                      />
                      <img src={it.thumbUrl} alt={it.title} loading="lazy" />
                      <div className="similar-meta">
                        <span>{formatSize(g.size)}</span>
                        <span>{it.title}</span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            );
          })
        ))}

      {mode !== 'md5' && visibleGroups.length === 0 && !scanning && (
        <div className="empty">
          <div className="big"><IconTrash size={42} /></div>
          <h3>{i18n.t('kc7a18e30')}</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            {i18n.t('kbf785cc3')}
          </p>
        </div>
      )}

      {visibleGroups.slice(0, groupLimit).map((g) => {
        const keep = picked[g.key] || g.recommendId;
        return (
          <div className="card" key={g.key} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13.5 }}>{g.count} 张相似</b>
              {g.tier === 'exact' ? (
                <span
                  style={{
                    fontSize: 11.5,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'rgba(220,80,80,.15)',
                    color: 'var(--err, #e5484d)',
                  }}
                >
                  {i18n.t('k2722a8b0')}
                </span>
              ) : g.tier === 'series' ? (
                <span
                  style={{
                    fontSize: 11.5,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'rgba(240,170,40,.15)',
                    color: '#e8a33d',
                  }}
                  title={i18n.t('k4370187c')}
                >
                  {i18n.t('k7bd8bdd0')}
                </span>
              ) : null}
              <span className="hint">
                {i18n.t('ke397516e')}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => setDuel(g)}
                  disabled={g.items.length < 2}
                  title={i18n.t('kf1899581')}
                >
                  {i18n.t('k2d4bdcd5')}
                </button>
                <button
                  className="btn sm"
                  onClick={() => setCmpGroup(g)}
                  disabled={g.items.length < 2}
                  title={i18n.t('k17e5a96d')}
                >
                  {i18n.t('kfb27722a')}
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await api.tidySkipAdd(g.recommendId);
                      setSkipped((prev) => new Set(prev).add(g.recommendId));
                    } catch (e) {
                      onToast((e as Error).message);
                    }
                  }}
                  disabled={!!busy}
                >
                  {i18n.t('k552f8d52')}
                </button>
                <button className="btn sm danger" onClick={() => resolve(g)} disabled={!!busy}>
                  {busy === g.key ? i18n.t('kcf978c02') : i18n.t('k27cc6608', { p0: g.items.length - 1 })}
                </button>
              </div>
            </div>
            <div className="similar-row">
              {g.items.map((it) => (
                <label className={`similar-item${keep === it.id ? ' on' : ''}`} key={it.id}>
                  <input
                    type="radio"
                    name={g.key}
                    checked={keep === it.id}
                    onChange={() => setPicked((prev) => ({ ...prev, [g.key]: it.id }))}
                  />
                  <img src={it.thumbUrl} alt={it.title} loading="lazy" />
                  <div className="similar-meta">
                    <span>{label(it)}</span>
                    <span>
                      {typeof it.quality === 'number' ? i18n.t('k723ad1eb', { p0: it.quality }) : i18n.t('k13808e97', { p0: it.score })}
                      {it.rating > 0 ? ` · ${'★'.repeat(it.rating)}` : ''}
                      {it.id === g.recommendId ? i18n.t('kfc4e063a') : ''}
                    </span>
                    <span className="hint">{it.source}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>
        );
      })}

      {/* 增量渲染哨兵：进入视口就再放 30 组出来 */}
      {(visibleGroups.length > groupLimit || md5Groups.length > groupLimit) && (
        <div ref={sentinelRef} className="hint" style={{ padding: '14px 0', textAlign: 'center' }}>
          {i18n.t('k9a635b5f', { p0: Math.min(groupLimit, mode === 'md5' ? md5Groups.length : visibleGroups.length) })}
        </div>
      )}

      {cmpGroup && (
        <CompareView
          items={cmpGroup.items}
          leftId={picked[cmpGroup.key] || cmpGroup.recommendId}
          rightId={
            (cmpGroup.items.find((it) => it.id !== (picked[cmpGroup.key] || cmpGroup.recommendId)) || cmpGroup.items[0]).id
          }
          onKeep={async (id) => {
            await resolve(cmpGroup, id);
            setCmpGroup(null);
          }}
          onClose={() => setCmpGroup(null)}
        />
      )}

      {duel && (
        <DuelView
          group={duel}
          onEliminate={eliminateOne}
          onFinished={() => {
            onToast(i18n.t('k664e0604'));
            setGroups((prev) => prev.filter((g) => g.key !== duel.key));
            loadStats();
            setDuel(null);
          }}
          onClose={() => setDuel(null)}
        />
      )}

      <div className="card">
        <h4 className="section-title">{i18n.t('k468aabaa')}</h4>
        <div className="hint" style={{ marginBottom: 10, lineHeight: 1.9 }}>
          · 库内共 {stats?.total ?? '…'} 张，已评分 {stats?.rated ?? 0} 张
          <br />          · 缺主色：{stats?.noDominant ?? '…'} 张（主色用于「找同色」与颜色筛选）
          <br />· 缺主体哈希：{stats?.noObjHash ?? '…'} 张（白底抠图后重算指纹，让相似分组不再被白背景干扰）
          <br />· 缺 AI 描述：{stats?.noAiDesc ?? '…'} 张（AI 描述会进入搜索索引，可搜「红裙 舞台」这类自然语言）
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={runDominant} disabled={!!busy}>
            <IconWand /> {busy === 'dominant' ? i18n.t('kc19afbe1') : i18n.t('kbffcc1ff')}
          </button>
          <button className="btn" onClick={runSubject} disabled={!!busy}>
            <IconWand /> {busy === 'subject' ? i18n.t('k21dc4846') : i18n.t('k4c41f223')}
          </button>
          <button className="btn" onClick={runAiTag} disabled={!!busy}>
            <IconWand /> {busy === 'ai' ? i18n.t('kb1ee39eb') : i18n.t('kfef40924')}
          </button>
          <button className="btn" onClick={loadStats} disabled={!!busy}>
            {i18n.t('kba542a85')}
          </button>
          {jobProgress && <span className="hint" style={{ alignSelf: 'center' }}>{jobProgress}</span>}
        </div>
      </div>
    </div>
  );
}
