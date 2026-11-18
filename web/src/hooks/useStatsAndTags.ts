import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api, quiet } from '../api';
import type { Stats, TagNode } from '../types';
import i18n from '../i18n';

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
  // 服务端是当前库全局连接，响应本身不带库 id；必须在发起时记下库，并在落地前复核。
  // ref 在 render 时更新，activeLibId 一切换，旧库的慢响应立刻失效（不必等 effect）。
  const activeLibRef = useRef(activeLibId);
  activeLibRef.current = activeLibId;
  const statsReqRef = useRef(0);
  const tagsReqRef = useRef(0);
  const pendingReqRef = useRef(0);
  const missingReqRef = useRef(0);

  useEffect(() => {
    // A→B→A 快切时只靠 libId 仍会误收第一次 A 的响应，因此每次换库同时作废旧代次
    statsReqRef.current++;
    tagsReqRef.current++;
    pendingReqRef.current++;
    missingReqRef.current++;
    libTotalRef.current = -1;
    tagsFetchedAtRef.current = 0;
  }, [activeLibId, libTotalRef]);

  const refreshStats = useCallback(() => {
    const libId = activeLibId;
    const statsReq = ++statsReqRef.current;
    api
      .stats()
      .then((s) => {
        if (activeLibRef.current !== libId || statsReq !== statsReqRef.current) return;
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
            showToast(i18n.t('kf828260b'));
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
      const tagsReq = ++tagsReqRef.current;
      api
        .tags({ limit: 500 })
        .then((r) => {
          if (activeLibRef.current !== libId || tagsReq !== tagsReqRef.current) return;
          setTags(r.tags);
          setTagGroups(r.groups);
          setTagTotal(r.total ?? r.tags.length);
        })
        .catch(quiet);
    }
    const pendingReq = ++pendingReqRef.current;
    api.pending().then((r) => {
      if (activeLibRef.current === libId && pendingReq === pendingReqRef.current) setPendingCounts(r);
    }).catch(quiet);
    const missingReq = ++missingReqRef.current;
    api.missingFiles().then((m) => {
      if (activeLibRef.current === libId && missingReq === missingReqRef.current) setMissingCount(m.count);
    }).catch(quiet);
  }, [load, pageRef, newAtTopRef, setTotal, isImporting, showToast, activeLibId]);

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

  /**
   * 「后端自己入库了」（目录监听自动导入 / 采集协程）推送 → 直接重载当前列表。
   *
   * 以前只靠 refreshStats 的「库变大就对账」：但 /api/stats 是 120s 快照，
   * 目录监听入库不走 HTTP，没人让快照过期 → total 恒为旧值 → 列表永不重载，
   * 用户必须手动点一下刷新（v1.2.14 报的问题，根因在服务端缓存）。
   * 服务端现在会在入库时让快照过期；但推送里已经明说了这是入库，这里直接重载
   * 一次最省事，也让「拷进去几秒后自己冒出来」成立。
   */
  const ingestThrottleRef = useRef(0);
  const reloadOnIngest = useCallback(() => {
    // 目录监听会一批一批推（拷贝几百张时 600ms 一条），节流成 1.2s 一次重载
    if (ingestThrottleRef.current) return;
    ingestThrottleRef.current = window.setTimeout(() => {
      ingestThrottleRef.current = 0;
      if (pageRef.current <= 1) {
        pageRef.current = 1;
        void load(1, true);
      } else if (!newAtTopRef.current) {
        newAtTopRef.current = true;
        showToast(i18n.t('kf828260b'));
      }
      refreshStats();
    }, 1200);
  }, [load, pageRef, newAtTopRef, showToast, refreshStats]);

  useEffect(
    () => () => {
      if (ingestThrottleRef.current) window.clearTimeout(ingestThrottleRef.current);
    },
    []
  );

  /** 只重取标签/分组：智能文件夹页改名、合并、删除后要让侧栏同步，不必重拉统计 */
  const reloadTags = useCallback(() => {
    const libId = activeLibId;
    const tagsReq = ++tagsReqRef.current;
    api
      .tags({ limit: 500 })
      .then((r) => {
        if (activeLibRef.current !== libId || tagsReq !== tagsReqRef.current) return;
        setTags(r.tags);
        setTagGroups(r.groups);
        setTagTotal(r.total ?? r.tags.length);
      })
      .catch(quiet);
  }, [activeLibId]);

  /** 侧栏标签按需加载更多页（标签很多时初始只拉前 500，避免一次拉完） */
  const loadMoreTags = useCallback(() => {
    const libId = activeLibId;
    const tagsReq = ++tagsReqRef.current;
    api
      .tags({ limit: 500, offset: tags.length })
      .then((r) => {
        if (activeLibRef.current !== libId || tagsReq !== tagsReqRef.current) return;
        setTags((prev) => [...prev, ...r.tags]);
        setTagTotal((prevTotal) => r.total ?? prevTotal + r.tags.length);
      })
      .catch(quiet);
  }, [tags.length, activeLibId]);

  /* 卡片角标与「待整理」数字：换库 / 手动刷新时重取（标注 & MD5 重复都是低频变更） */
  useEffect(() => {
    let alive = true;
    api
      .annotationCounts()
      .then((r) => {
        if (alive) setAnnotationCounts(r.counts || {});
      })
      .catch(quiet);
    return () => {
      alive = false;
    };
  }, [refreshSeq, activeLibId]);

  useEffect(() => {
    let alive = true;
    api
      .md5Dupes()
      .then((r) => {
        if (!alive) return;
        const map: Record<string, number> = {};
        for (const g of r.groups) for (const it of g.items) map[String(it.id)] = g.items.length;
        setDupeCounts(map);
      })
      .catch(quiet);
    return () => {
      alive = false;
    };
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
      const g = t.group || i18n.t('k6bf48c97');
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
    reloadOnIngest,
    statsThrottleRef,
    reloadTags,
    loadMoreTags,
    tagTree,
  };
}
