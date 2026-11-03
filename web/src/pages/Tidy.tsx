import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatSize, quiet } from '../api';
import type { DupeGroup, Filters, ImageItem, SimilarGroup } from '../types';
import { IconRefresh, IconTrash, IconWand } from '../components/Icons';
import DuelView from '../components/DuelView';
import CompareView from '../components/CompareView';

interface Props {
  onToast: (msg: string) => void;
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
        onToast('还没有选中任何素材，已按全库扫描');
        return undefined;
      }
      return selectedIds;
    }
    if (scope === 'filter') {
      try {
        const r = await api.imageIds(filters as Filters, { folderId: folderId ?? null });
        if (!r.ids.length) {
          onToast('当前筛选条件下没有素材，已按全库扫描');
          return undefined;
        }
        setScopeNote(r.truncated ? '筛选结果过多，只扫描了前一部分' : '');
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
          onToast(res.failures?.[0]?.error || '移入回收站失败');
          return false;
        }
        setGroups((prev) =>
          prev.map((g) => (g.key === duel?.key ? { ...g, items: g.items.filter((it) => it.id !== loseId) } : g))
        );
        onLibraryChanged();
        return true;
      } catch (err) {
        onToast((err as Error).message);
        return false;
      }
    },
    [duel, onToast, onLibraryChanged]
  );
  const [mode, setMode] = useState<'phash' | 'format' | 'clip' | 'md5'>('phash'); // 当前列表来源：pHash / 同名格式 / CLIP / MD5 完全重复

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
      setScanLabel('正在扫描相似图片（按感知哈希逐张比对）…');
      try {
        const ids = await resolveScopeIds();
        const res = await api.similar(th, ids);
        setMode('phash');
        setGroups(res.groups);
        const next: Record<string, number> = {};
        for (const g of res.groups) next[g.key] = g.recommendId;
        setPicked(next);
        const range = ids?.length ? `（范围 ${ids.length} 张）` : '';
        onToast(res.count ? `发现 ${res.count} 组相似图片${range}` : `没有发现相似图片${range}`);
      } catch (err) {
        onToast((err as Error).message);
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
    setScanLabel('正在扫描同名 JPG/PNG 重复…');
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
      const extra = scanned.saved ? `（本次新登记 ${scanned.saved} 张）` : '';
      onToast(res.count ? `发现 ${res.count} 组同名格式重复（推荐保留 PNG）${extra}` : `没有同名 JPG/PNG 重复${extra}`);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setScanning(false);
      setScanLabel('');
    }
  }, [onToast, resolveScopeIds]);

  // CLIP 深度特征相似：余弦 ≥ 0.92 视为同类，能抓住 pHash 漏掉的裁剪/旋转/滤镜变体
  const scanClip = useCallback(async () => {
    setScanning(true);
    setScanLabel('正在进行 CLIP 深度相似分析（AI 视觉特征比对）…');
    try {
      const ids = await resolveScopeIds();
      const res = await api.similarClip(0.92, ids);
      setMode('clip');
      setGroups(res.groups);
      const next: Record<string, number> = {};
      for (const g of res.groups) next[g.key] = g.recommendId;
      setPicked(next);
      if (!res.count) return onToast('没有发现深度相似的图片');
      const exact = res.groups.filter((g) => g.tier === 'exact').length;
      onToast(
        `发现 ${res.count} 组：${exact} 组完全重复（可一键清理），${res.count - exact} 组系列照（只折叠，不自动删）`
      );
    } catch (err) {
      onToast((err as Error).message);
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
    setScanLabel('正在补算 MD5 指纹（按字节完全一致才算重复）…');
    try {
      let remaining = 1;
      let done = 0;
      for (let i = 0; i < 400 && remaining > 0; i++) {
        const b = await api.md5Backfill(500);
        done += b.done;
        remaining = b.remaining;
        if (b.done > 0) setJobProgress(`已补算 ${done} 张，剩余 ${remaining} 张`);
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
      onToast(res.groups.length ? `发现 ${res.groups.length} 组完全重复，可回收 ${formatSize(res.reclaim || 0)}` : '没有字节完全相同的重复文件');
    } catch (err) {
      onToast((err as Error).message);
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
    if (!window.confirm(`保留 1 张，把另外 ${ids.length} 张移入回收站？（可在「设置 → 数据与维护」恢复）`)) return;
    setBusy(g.md5);
    try {
      const r = await api.resolveDupes(keep, ids);
      const failed = r.failed || [];
      if (failed.length) {
        // 部分失败必须如实说：之前无论删没删成都提示「已解决」，重复项还在列表里消失
        onToast(`已移入回收站 ${r.removed} 张，${failed.length} 张失败：${failed[0].error}`);
      } else {
        onToast(`已移入回收站 ${r.removed} 张`);
      }
      // 有失败就保留这组，方便用户重试
      if (!failed.length) setMd5Groups((prev) => prev.filter((x) => x.md5 !== g.md5));
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** 一键清理所有 MD5 重复组（每组保留第一张） */
  const resolveAllMd5 = async () => {
    if (!md5Groups.length) return;
    const total = md5Groups.reduce((s, g) => s + g.items.length - 1, 0);
    if (!window.confirm(`将处理 ${md5Groups.length} 组，共移入回收站 ${total} 张（每组保留一张）？`)) return;
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
          ? `已移入回收站 ${removed} 张，${failed} 张失败（这些组已保留，可重试）`
          : `已移入回收站 ${removed} 张`
      );
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  // 已被「不处理」的组不显示（刷新/重扫后依旧隐藏，因为 recommendId 已持久化）
  const visibleGroups = useMemo(
    () => groups.filter((g) => !skipped.has(g.recommendId)),
    [groups, skipped]
  );

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
      onToast('这组只有一张图，无需处理');
      return true;
    }
    if (!window.confirm(`保留 1 张，把另外 ${removeIds.length} 张移入应用内回收站？（可在「设置 → 数据与维护」恢复）`)) return false;
    setBusy(g.key);
    try {
      const res = await api.resolveSimilar(keep, removeIds);
      onToast(res.removed ? `已移入回收站 ${res.removed} 张` : '没有删除任何图片');
      setGroups((prev) => prev.filter((x) => x.key !== g.key));
      loadStats();
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message);
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
      onToast(seriesCount ? `${seriesCount} 组都是系列照，已跳过（请逐组人工确认）` : '没有可处理的组');
      return;
    }
    const total = list.reduce((s, g) => s + g.items.length - 1, 0);
    const tip = seriesCount ? `另有 ${seriesCount} 组系列照已跳过` : '';
    if (!window.confirm(`将处理 ${list.length} 组，共移入回收站 ${total} 张（每组保留推荐的那张）。${tip}确定吗？`)) return;
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
      onToast(`已移入回收站 ${removed} 张${seriesCount ? `，${seriesCount} 组系列照保留待人工确认` : ''}`);
      setGroups((prev) => prev.filter((g) => !doneKeys.has(g.key)));
      loadStats();
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** 补算主色（分批循环到算完） */
  const runDominant = async () => {
    if (!stats?.noDominant) return onToast('所有图片都已有主色');
    setBusy('dominant');
    let done = 0;
    try {
      for (;;) {
        const res = await api.backfillDominant(300);
        done += res.done;
        setJobProgress(`已处理 ${done} 张，剩余 ${res.remain} 张`);
        if (!res.remain || !res.done) break;
      }
      onToast(`主色补算完成，共 ${done} 张`);
      loadStats();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
      setJobProgress('');
    }
  };

  /** 补算主体哈希（白底抠图归一化 pHash，相似分组更准）：分批循环到算完 */
  const runSubject = async () => {
    if (!stats?.noObjHash) return onToast('所有图片都已有主体哈希');
    setBusy('subject');
    let done = 0;
    let skipped = 0;
    try {
      for (;;) {
        const res = await api.backfillSubject(200);
        done += res.done;
        skipped += res.skipped ?? 0;
        setJobProgress(`已处理 ${done + skipped} 张，剩余 ${res.remain} 张`);
        if (!res.remain || (!res.done && !res.skipped)) break;
      }
      onToast(skipped ? `主体哈希完成：${done} 张算出，${skipped} 张非白底已跳过` : `主体哈希补算完成，共 ${done} 张`);
      loadStats();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy('');
      setJobProgress('');
    }
  };

  /** AI 打标（分批循环，供自然语言搜索） */
  const runAiTag = async () => {
    if (!stats?.noAiDesc) return onToast('所有图片都已有 AI 描述');
    setBusy('ai');
    let done = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await api.aiTagBatch(4);
        done += res.done;
        setJobProgress(`AI 已分析 ${done} 张，剩余 ${res.remain} 张`);
        if (!res.remain) break;
        if (!res.done) {
          const err = res.results.find((r) => !r.ok)?.error;
          onToast(err ? `AI 分析中断：${err}` : 'AI 分析没有进展');
          break;
        }
      }
      onToast(`AI 打标完成，共 ${done} 张`);
      loadStats();
    } catch (err) {
      onToast((err as Error).message);
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
          <h1 className="page-title">整理</h1>
          <div className="page-sub">
            {mode === 'format'
              ? '同名格式去重：同目录下同名 JPG/PNG 视为同一张，推荐保留更清晰的 PNG'
              : mode === 'clip'
                ? 'CLIP 深度相似：按 AI 视觉特征分组，裁剪 / 旋转 / 加滤镜的变体也能归到一组'
                : mode === 'md5'
                  ? '完全重复（MD5）：按字节逐位比对，只有一模一样的文件才会出现；与上面的 pHash 相似合并互补'
                  : '相似图审查合并 · 主色补算 · AI 描述打标（让搜索能听懂自然语言）'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={scanClip} disabled={scanning}>
            <IconWand /> CLIP 深度相似
          </button>
          <button className="btn" onClick={scanFormat} disabled={scanning}>
            <IconWand /> 同名 JPG/PNG 去重
          </button>
          <button
            className="btn"
            onClick={scanMd5}
            disabled={scanning}
            title="按字节完全一致分组（MD5），与 pHash 相似检测互补"
          >
            <IconWand /> 完全重复（MD5）
          </button>
          <button className="btn" onClick={() => scan()} disabled={scanning}>
            <IconRefresh /> {scanning ? '扫描中…' : '重新扫描相似图'}
          </button>
          {mode === 'md5' ? (
            <button
              className="btn primary"
              onClick={resolveAllMd5}
              disabled={!!busy || !md5Groups.length}
            >
              <IconTrash /> 一键清理重复
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={resolveAll}
              disabled={!!busy || !visibleGroups.length}
            >
              <IconTrash /> 一键保留最佳
            </button>
          )}
          {skipped.size > 0 && (
            <button
              className="btn"
              onClick={async () => {
                try {
                  await api.tidySkipReset();
                  setSkipped(new Set());
                  onToast('已重置全部「不处理」，被跳过的组会重新出现');
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
                ? '正在补算主色（解码逐张取主色）…'
                : busy === 'subject'
                  ? '正在补算主体哈希（抠出商品主体后重新计算指纹）…'
                  : 'AI 正在分析图片（生成搜索用描述）…'}
          </span>
          <span className="job-meta">{jobProgress || `已耗时 ${elapsed}s`}</span>
        </div>
      )}

      {mode === 'md5' ? (
        <div className="toolbar">
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>按 MD5 + 字节大小精确分组</span>
          <span className="hint" style={{ marginLeft: 4 }}>
            完全相同的文件才会归为一组（与 pHash 相似合并互补）
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
              {md5Groups.length} 组 · 可回收 {formatSize(md5Reclaim)}
              {md5Missing > 0 ? ` · ${md5Missing} 张待补算指纹` : ''}
            </span>
            <button className="btn sm" onClick={scanMd5} disabled={scanning}>
              <IconRefresh /> 重新检测
            </button>
          </span>
        </div>
      ) : (
        <div className="toolbar">
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>扫描范围</span>
          <select
            className="input"
            style={{ padding: '4px 8px', fontSize: 12.5 }}
            value={scope}
            onChange={(e) => setScope(e.target.value as 'all' | 'filter' | 'selected')}
            title="只比较这一批素材，避免全库扫描把无关的组带出来"
          >
            <option value="all">全库</option>
            <option value="filter">当前筛选结果</option>
            <option value="selected" disabled={!selectedIds?.length}>
              已选中 {selectedIds?.length || 0} 张
            </option>
          </select>
          <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 6 }}>相似度阈值</span>
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
              <div className="big">🧬</div>
              <h3>没有字节完全相同的重复文件</h3>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                同一张图被重复导入、或从不同渠道存成两份时才会出现在这里；相似但不同的图请在 pHash 那栏处理
              </p>
            </div>
          )
        ) : (
          md5Groups.map((g) => {
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
                    MD5 一致 · 可放心清理
                  </span>
                  <span className="hint">
                    {formatSize(g.size)} / 个 · MD5 {g.md5.slice(0, 12)}…
                  </span>
                  <div style={{ marginLeft: 'auto' }}>
                    <button className="btn sm danger" onClick={() => resolveMd5(g)} disabled={!!busy}>
                      {busy === g.md5 ? '处理中…' : `保留选中的，删其余 ${g.items.length - 1} 个`}
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
          <div className="big">🧹</div>
          <h3>没有需要合并的相似图片</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            同一张照片的不同裁剪 / 不同来源版本会自动出现在这里，可整组对比后保留最清晰的那张
          </p>
        </div>
      )}

      {visibleGroups.map((g) => {
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
                  完全重复 · 可放心清理
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
                  title="同一场拍摄的多帧，不算重复。已按画质排好序，想要留哪张自己勾选"
                >
                  系列照 · 建议保留，不自动清理
                </span>
              ) : null}
              <span className="hint">
                选一张保留，其余移入回收站（推荐项已按「清晰度 × 分辨率」自动选中）
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => setDuel(g)}
                  disabled={g.items.length < 2}
                  title="两个一组逐对比较：败者立即移入回收站，直到只剩一张"
                >
                  两两对比
                </button>
                <button
                  className="btn sm"
                  onClick={() => setCmpGroup(g)}
                  disabled={g.items.length < 2}
                  title="并排 / 分割（拖分界线）/ 重叠（调不透明度）三种方式细看差异"
                >
                  三种对比
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
                  这组不处理
                </button>
                <button className="btn sm danger" onClick={() => resolve(g)} disabled={!!busy}>
                  {busy === g.key ? '处理中…' : `保留选中的，删其余 ${g.items.length - 1} 张`}
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
                      {typeof it.quality === 'number' ? `画质 ${it.quality}` : `评分 ${it.score}`}
                      {it.rating > 0 ? ` · ${'★'.repeat(it.rating)}` : ''}
                      {it.id === g.recommendId ? ' · 推荐' : ''}
                    </span>
                    <span className="hint">{it.source}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>
        );
      })}

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
            onToast('整组处理完成，只保留了画质最佳的一张');
            setGroups((prev) => prev.filter((g) => g.key !== duel.key));
            loadStats();
            setDuel(null);
          }}
          onClose={() => setDuel(null)}
        />
      )}

      <div className="card">
        <h4 className="section-title">素材维护</h4>
        <div className="hint" style={{ marginBottom: 10, lineHeight: 1.9 }}>
          · 库内共 {stats?.total ?? '…'} 张，已评分 {stats?.rated ?? 0} 张
          <br />          · 缺主色：{stats?.noDominant ?? '…'} 张（主色用于「找同色」与颜色筛选）
          <br />· 缺主体哈希：{stats?.noObjHash ?? '…'} 张（白底抠图后重算指纹，让相似分组不再被白背景干扰）
          <br />· 缺 AI 描述：{stats?.noAiDesc ?? '…'} 张（AI 描述会进入搜索索引，可搜「红裙 舞台」这类自然语言）
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={runDominant} disabled={!!busy}>
            <IconWand /> {busy === 'dominant' ? '补算主色中…' : '补算主色'}
          </button>
          <button className="btn" onClick={runSubject} disabled={!!busy}>
            <IconWand /> {busy === 'subject' ? '补算主体哈希中…' : '补算主体哈希'}
          </button>
          <button className="btn" onClick={runAiTag} disabled={!!busy}>
            <IconWand /> {busy === 'ai' ? 'AI 分析中…' : '批量 AI 打标'}
          </button>
          <button className="btn" onClick={loadStats} disabled={!!busy}>
            刷新统计
          </button>
          {jobProgress && <span className="hint" style={{ alignSelf: 'center' }}>{jobProgress}</span>}
        </div>
      </div>
    </div>
  );
}
