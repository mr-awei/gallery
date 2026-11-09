import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api, quiet } from '../api';
import type { Stats, TagNode } from '../types';

type Toast = (msg: string, kind?: 'info' | 'error') => void;

export type PendingCounts = { total: number; noFolder: number; noTags: number; noRating: number };

/**
 * 统计 / 标签 / 待整理数字 / 卡片角标。
 *
 * 这里最关键是 refreshStats 里的「库增长对账」：导入的 CPU 密集段会阻塞 SSE 心跳，
 * EventSource 断连重连期间的 library 事件全部丢失，列表就停在断连前的张数不再前进
 * （P0：导入 642 张前端只跟到 10 张）。现在 library 事件、job 快照、60s 兜底定时器
 * 三路都会调用它，任何一路活着列表就能跟上导入进度。
 */
export function useStatsAndTags({
  showToast,
  load,
  pageRef,
  newAtTopRef,
  setTotal,
  isImporting,
  refreshSeq,
  activeLibId,
}: {
  showToast: Toast;
  load: (page: number, reset: boolean) => Promise<void>;
  pageRef: MutableRefObject<number>;
  newAtTopRef: MutableRefObject<boolean>;
  setTotal: Dispatch<SetStateAction<number>>;
  /** 导入进行中的取值器（ref 语义，避免回调依赖频繁变化） */
  isImporting: () => boolean;
  refreshSeq: number;
  activeLibId: number | null;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tags, setTags] = useState<TagNode[]>([]);
  const [tagGroups, setTagGroups] = useState<string[]>([]);
  /** 标签总数（分页）：远端实际标签数可能大于本地已加载的 tags */
  const [tagTotal, setTagTotal] = useState(0);
  /** 「待整理」三个入口的数量（Eagle 侧栏数字） */
  const [pendingCounts, setPendingCounts] = useState<PendingCounts | null>(null);
  /** 卡片角标：标注数量 / 完全重复同组张数 */
  const [annotationCounts, setAnnotationCounts] = useState<Record<string, number>>({});
  const [dupeCounts, setDupeCounts] = useState<Record<string, number>>({});
  const [missingCount, setMissingCount] = useState(0);

  // 上一次统计到的全库张数：library 推送后若库变大（导入/采集），自动重载列表
  const libTotalRef = useRef(-1);
  // 标签是全量扫 images.tags 算出来的，比 stats 贵得多；而导入进度推送期间
  // 标签集合不会变（入库不带标签）。2s 内重复拉只是白扫一遍全表。
  const tagsFetchedAtRef = useRef(0);

  const refreshStats = useCallback(() => {
    api
      .stats()
      .then((s) => {
        setStats(s);
        const prev = libTotalRef.current;
        libTotalRef.current = s.total;
        if (prev >= 0 && s.total > prev) {
          // 用户已经翻到第 2 页以后就别再打回第 1 页：那会 abort 在途分页、列表跳回顶部，
          // 正在看的内容被抽走（导入期 1.2s 一次，根本没法翻）。新图在回到首屏时自然出现。
          if (pageRef.current <= 1) {
            pageRef.current = 1;
            load(1, true);
          } else if (!newAtTopRef.current) {
            newAtTopRef.current = true;
            showToast('有新图片入库，回到顶部即可看到');
          }
        }
        // 导入进行中：新入库图片必然出现在默认「最新采集」列表里，
        // 让筛选栏「共 X 张」随导入实时跳动，而不是等下一次 load 才更新
        if (isImporting()) setTotal((cur) => Math.max(cur, s.total));
      })
      .catch(quiet);
    const now = Date.now();
    if (now - tagsFetchedAtRef.current >= 2000) {
      tagsFetchedAtRef.current = now;
      api
        .tags({ limit: 500 })
        .then((r) => {
          setTags(r.tags);
          setTagGroups(r.groups);
          setTagTotal(r.total ?? r.tags.length);
        })
        .catch(quiet);
    }
    api.pending().then(setPendingCounts).catch(quiet);
    api.missingFiles().then((m) => setMissingCount(m.count)).catch(quiet);
  }, [load, pageRef, newAtTopRef, setTotal, isImporting, showToast]);

  /**
   * 统计刷新节流（800ms）。
   * library 与 job 两条推送都走这里：导入期任务快照每秒好几条，以前每条都打
   * stats/tags/pending/missingFiles 四个接口，叠加 1.2s 轮询直接变成请求风暴。
   * 用「定时器在就不重置」的节流而不是尾随去抖：持续导入时也保持稳定刷新节奏，
   * 不会因为事件不断而永远刷不到。
   */
  const statsThrottleRef = useRef(0);
  const scheduleStatsRefresh = useCallback(() => {
    if (statsThrottleRef.current) return;
    statsThrottleRef.current = window.setTimeout(() => {
      statsThrottleRef.current = 0;
      refreshStats();
    }, 800);
  }, [refreshStats]);

  /** 只重取标签/分组：智能文件夹页改名、合并、删除后要让侧栏同步，不必重拉统计 */
  const reloadTags = useCallback(() => {
    api
      .tags({ limit: 500 })
      .then((r) => {
        setTags(r.tags);
        setTagGroups(r.groups);
        setTagTotal(r.total ?? r.tags.length);
      })
      .catch(quiet);
  }, []);

  /** 侧栏标签按需加载更多页（标签很多时初始只拉前 500，避免一次拉完） */
  const loadMoreTags = useCallback(() => {
    api
      .tags({ limit: 500, offset: tags.length })
      .then((r) => {
        setTags((prev) => [...prev, ...r.tags]);
        setTagTotal((prevTotal) => r.total ?? prevTotal + r.tags.length);
      })
      .catch(quiet);
  }, [tags.length]);

  /* 卡片角标与「待整理」数字：换库 / 手动刷新时重取（标注 & MD5 重复都是低频变更） */
  useEffect(() => {
    api
      .annotationCounts()
      .then((r) => setAnnotationCounts(r.counts || {}))
      .catch(quiet);
  }, [refreshSeq, activeLibId]);

  useEffect(() => {
    api
      .md5Dupes()
      .then((r) => {
        const map: Record<string, number> = {};
        for (const g of r.groups) for (const it of g.items) map[String(it.id)] = g.items.length;
        setDupeCounts(map);
      })
      .catch(quiet);
  }, [refreshSeq, activeLibId]);

  /**
   * 标签面板（Eagle 式）：按 group 分组、parent 做父子层级。
   * 标签本体仍是逗号串，这里只负责展示与筛选，不额外维护倒排。
   */
  const tagTree = useMemo(() => {
    const names = new Set(tags.map((t) => t.tag));
    const childrenOf = new Map<string, TagNode[]>();
    const cmp = (a: TagNode, b: TagNode) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN');
    for (const t of tags) {
      const p = t.parent && names.has(t.parent) ? t.parent : '';
      if (!p) continue;
      const arr = childrenOf.get(p);
      if (arr) arr.push(t);
      else childrenOf.set(p, [t]);
    }
    for (const arr of childrenOf.values()) arr.sort(cmp);
    const groups = new Map<string, TagNode[]>();
    for (const t of tags) {
      // 子标签不单列，跟父标签一起出现
      if (t.parent && names.has(t.parent)) continue;
      const g = t.group || '未分组';
      const arr = groups.get(g);
      if (arr) arr.push(t);
      else groups.set(g, [t]);
    }
    return {
      groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN')),
      childrenOf,
    };
  }, [tags]);

  return {
    stats,
    setStats,
    tags,
    setTags,
    tagGroups,
    setTagGroups,
    tagTotal,
    setTagTotal,
    pendingCounts,
    annotationCounts,
    setAnnotationCounts,
    dupeCounts,
    missingCount,
    setMissingCount,
    libTotalRef,
    refreshStats,
    scheduleStatsRefresh,
    statsThrottleRef,
    reloadTags,
    loadMoreTags,
    tagTree,
  };
}
