import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImageItem, TimelineSummary } from '../types';
import type { JobItem } from '../api';
import { api } from '../api';
import { useLang } from '../lib/i18n';

/**
 * 时间线视图：按拍摄时间倒序，三级索引「年 → 月 → 日」，图片按天懒加载。
 *
 * 为什么分到日：只给到月的话，一个月的图是一大片平铺，看不出「哪天拍的」，
 * 也定位不到「那天那批」。日期由 /api/timeline/days 聚合给出，图片按天拉，
 * 每天的头（`10 月 5 日 · 周一`）带张数，滚到哪天请求哪天。
 *
 * 为什么不复用 Gallery 的虚拟网格：时间线是「按日期分组的长卷」，分组头要吸顶、
 * 天要按需拉取；把全部素材塞进一个平铺列表会先序列化几万条 DTO 才出现第一屏。
 */

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 打开灯箱（pool 是该月已加载的图，灯箱内可左右切） */
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
}

/** 一个月内的日期索引（每月最多 31 条，一次给完） */
interface MonthState {
  days: { day: string; count: number }[];
  total: number;
  loading: boolean;
  error?: string;
}

/** 某一天已加载的图片（按天单独分页，一天可能拍上千张） */
interface DayState {
  items: ImageItem[];
  total: number;
  loading: boolean;
  error?: string;
}

const PAGE = 120;

/** '2026-11' → '2026年11月' / 'Nov 2026' */
function monthLabel(month: string, lang: 'zh' | 'en') {
  const [y, m] = month.split('-');
  if (lang === 'en') {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${names[Number(m) - 1] || m} ${y}`;
  }
  return `${y} 年 ${Number(m)} 月`;
}

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * '2026-10-05' → '10 月 5 日 · 周一' / 'Mon, Oct 5'
 *
 * 为什么带星期：具体到日期之后，人回忆素材靠的是「那个周一拍的」，只给数字仍然对不上号。
 * 年份不重复写（正上方就是年月标题），免得每天一行都拖一长串。
 */
function dayLabel(day: string, lang: 'zh' | 'en') {
  const [, m, d] = day.split('-').map(Number);
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (lang === 'en') return `${WEEK_EN[wd]}, ${MONTH_EN[m - 1]} ${d}`;
  return `${m} 月 ${d} 日 · ${WEEK_ZH[wd]}`;
}

function DayBlock({
  day,
  count,
  state,
  lang,
  onLoad,
  onLoadMore,
  onOpen,
}: {
  day: string;
  count: number;
  state?: DayState;
  lang: 'zh' | 'en';
  onLoad: () => void;
  onLoadMore: () => void;
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
}) {
  const { t } = useLang();
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);

  // 每一天也懒加载：一个月 3000 张、30 天，滚到哪天拉哪天
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          onLoad();
          io.disconnect();
        }
      },
      { rootMargin: '600px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, onLoad]);

  const items = state?.items || [];
  const total = state?.total ?? count;

  return (
    <section className="tl-day" id={`tl-${day}`} data-day={day} ref={ref}>
      <header className="tl-day-head">
        <h4>{dayLabel(day, lang)}</h4>
        <span className="tl-day-count">
          {total} {t('张', 'items')}
        </span>
        {state?.loading && !items.length && <span className="tl-month-loading">{t('加载中…', 'Loading…')}</span>}
        {state?.error && <span className="tl-month-error">{state.error}</span>}
      </header>
      {items.length > 0 && (
        <div className="tl-grid">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              className="tl-cell"
              title={it.title}
              onClick={() => onOpen(it, items)}
            >
              <img src={it.thumbUrl} alt={it.title} loading="lazy" decoding="async" />
              {(it.editOps || 0) > 0 && <span className="tl-nondestructive" title={t('非破坏编辑未写入原图', 'Non-destructive edits')}>◐</span>}
            </button>
          ))}
        </div>
      )}
      {items.length > 0 && items.length < total && (
        <button type="button" className="tl-more" disabled={state?.loading} onClick={onLoadMore}>
          {state?.loading ? t('加载中…', 'Loading…') : t(`加载更多（还有 ${total - items.length} 张）`, `Load more (${total - items.length} left)`)}
        </button>
      )}
    </section>
  );
}

function MonthBlock({
  month,
  count,
  state,
  dayStates,
  lang,
  onLoadDays,
  onLoadDay,
  onMoreDay,
  onOpen,
}: {
  month: string;
  count: number;
  state?: MonthState;
  dayStates: Record<string, DayState>;
  lang: 'zh' | 'en';
  onLoadDays: () => void;
  onLoadDay: (day: string) => void;
  onMoreDay: (day: string, offset: number) => void;
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
}) {
  const { t } = useLang();
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);

  // 进入视口才请求：首屏只加载当前月份的日期索引，往下滚一屏加载一屏
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          onLoadDays();
          io.disconnect();
        }
      },
      { rootMargin: '600px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, onLoadDays]);

  const days = state?.days || [];
  const total = state?.total ?? count;

  return (
    <section className="tl-month" id={`tl-${month}`} ref={ref}>
      <header className="tl-month-head">
        <h3>{monthLabel(month, lang)}</h3>
        <span className="tl-month-count">
          {total} {t('张', 'items')}
          {days.length > 0 && ` · ${days.length} ${t('天', 'days')}`}
        </span>
        {state?.loading && !days.length && <span className="tl-month-loading">{t('加载中…', 'Loading…')}</span>}
        {state?.error && <span className="tl-month-error">{state.error}</span>}
      </header>
      {days.map((b) => (
        <DayBlock
          key={b.day}
          day={b.day}
          count={b.count}
          state={dayStates[b.day]}
          lang={lang}
          onLoad={() => onLoadDay(b.day)}
          onLoadMore={() => onMoreDay(b.day, dayStates[b.day]?.items.length || 0)}
          onOpen={onOpen}
        />
      ))}
    </section>
  );
}

export function Timeline({ onToast, onOpen }: Props) {
  const { t, lang } = useLang();
  const [summary, setSummary] = useState<TimelineSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [months, setMonths] = useState<Record<string, MonthState>>({});
  const [days, setDays] = useState<Record<string, DayState>>({});
  const [job, setJob] = useState<Pick<JobItem, 'id' | 'status' | 'progress' | 'message'> | null>(null);
  const timers = useRef<number[]>([]);
  /** 跳月份后的反复对齐定时器（见 alignTo 的注释） */
  const jumpTimer = useRef<number | null>(null);
  /** 滚动节流的 rAF 句柄 */
  const scrollRaf = useRef(0);
  /** 左栏当前展开的月份（手风琴，只开一个：全部铺开会有上百行日期，翻不动） */
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  /** 滚动位置所在的日期，用于左栏高亮 */
  const [activeDay, setActiveDay] = useState('');

  const loadSummary = useCallback(async () => {
    try {
      const s = await api.timelineSummary();
      setSummary(s);
      setError('');
      return s;
    } catch (e) {
      setError((e as Error)?.message || t('加载失败', 'Failed to load'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    const list = timers.current;
    return () => {
      list.forEach((id) => window.clearTimeout(id));
      if (jumpTimer.current) window.clearTimeout(jumpTimer.current);
    };
  }, []);

  /** 拉某个月的日期索引（只回每天有几张，不回图片） */
  const loadDays = useCallback(
    async (month: string) => {
      setMonths((prev) => {
        const cur = prev[month];
        // 已经加载过（或正在加载）就别再请求一次——IntersectionObserver 会重复触发
        if (cur && (cur.days.length || cur.loading)) return prev;
        return { ...prev, [month]: { days: [], total: 0, loading: true } };
      });
      try {
        const r = await api.timelineDays(month);
        setMonths((prev) => ({ ...prev, [month]: { days: r.days, total: r.total, loading: false } }));
      } catch (e) {
        const msg = (e as Error)?.message || t('加载失败', 'Failed to load');
        setMonths((prev) => ({
          ...prev,
          [month]: { days: prev[month]?.days || [], total: prev[month]?.total || 0, loading: false, error: msg },
        }));
      }
    },
    [t]
  );

  /** 拉某一天的图片；一天可能上千张，仍按 PAGE 分页 */
  const loadDay = useCallback(
    async (day: string, offset = 0) => {
      setDays((prev) => {
        const cur = prev[day];
        if (offset === 0 && cur && (cur.items.length || cur.loading)) return prev;
        return {
          ...prev,
          [day]: { items: offset ? cur?.items || [] : [], total: cur?.total || 0, loading: true },
        };
      });
      try {
        const r = await api.timelineDay(day, offset, PAGE);
        setDays((prev) => {
          const cur = prev[day];
          const items = offset > 0 ? [...(cur?.items || []), ...r.items] : r.items;
          return { ...prev, [day]: { items, total: r.total, loading: false } };
        });
      } catch (e) {
        const msg = (e as Error)?.message || t('加载失败', 'Failed to load');
        setDays((prev) => ({
          ...prev,
          [day]: { items: prev[day]?.items || [], total: prev[day]?.total || 0, loading: false, error: msg },
        }));
      }
    },
    [t]
  );

  /** 年份索引（月份已按倒序返回，只需顺序分组） */
  const years = useMemo(() => {
    const out: { year: string; count: number; months: string[] }[] = [];
    for (const m of summary?.months || []) {
      const year = m.month.slice(0, 4);
      const last = out[out.length - 1];
      if (last && last.year === year) {
        last.count += Number(m.count || 0);
        last.months.push(m.month);
      } else {
        out.push({ year, count: Number(m.count || 0), months: [m.month] });
      }
    }
    return out;
  }, [summary]);

  /** 每个月多少张（左栏月份行右侧的小字），summary 只给一次，顺手摊平 */
  const monthTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of summary?.months || []) out[m.month] = Number(m.count || 0);
    return out;
  }, [summary]);

  /** 当前滚动位置所在月份，左栏据此高亮并展开 */
  const activeMonth = activeDay.slice(0, 7);

  // 进页面先展开最新一个月：不然左栏只有年月，用户还得先点一下才看得到日期
  useEffect(() => {
    if (openMonth || !summary?.months.length) return;
    setOpenMonth(summary.months[0].month);
  }, [openMonth, summary]);

  // 主视图滚到别的月份时，左栏跟着换展开月份，并补拉那个月的日期索引
  useEffect(() => {
    if (!activeMonth) return;
    setOpenMonth(activeMonth);
    loadDays(activeMonth);
  }, [activeMonth, loadDays]);

  // 还没滚动过时先高亮最新一天：否则首屏左栏一片「没有选中」，
  // 要等用户滚一下才有反馈
  useEffect(() => {
    if (activeDay) return;
    const m = summary?.months?.[0]?.month;
    const d = m ? months[m]?.days?.[0]?.day : '';
    if (d) setActiveDay(d);
  }, [summary, months, activeDay]);

  /**
   * 跳到某个元素 + 反复对齐（月份与日期共用）。
   *
   * 为什么不能只 scrollIntoView 一次：目标之前那些月份在途经时会陆续加载日期索引和图片，
   * 它们的高度是滚上去之后才长出来的 —— 内容一长上面就膨胀，目标被顶得往下跑。
   * 实测点「2022 年 4 月」会落在 5 月里，差了 1.5 万像素。这里在 1.2 秒内反复对位，
   * 直到连续两次不再偏移就停手；偏差用「元素顶边 − 滚动容器顶边」判断，不依赖绝对视口位置。
   *
   * margin 必须与 timeline.css 的 scroll-margin-top 一致：月 6px、日 38px（让过吸顶的月头）。
   */
  const alignTo = useCallback((id: string, margin: number) => {
    if (jumpTimer.current) window.clearTimeout(jumpTimer.current);
    let stable = 0;
    const align = (left: number) => {
      const el = document.getElementById(id);
      const scroller = el?.closest('.tl-scroll');
      if (!el || !scroller || left <= 0) return;
      const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (Math.abs(offset - margin) > 3) {
        stable = 0;
        el.scrollIntoView({ behavior: left > 9 ? 'smooth' : 'auto', block: 'start' });
      } else if (++stable >= 2) {
        return;
      }
      jumpTimer.current = window.setTimeout(() => align(left - 1), 100);
    };
    align(12);
  }, []);

  const jumpTo = useCallback((month: string) => alignTo(`tl-${month}`, 6), [alignTo]);

  /**
   * 跳到某一天：先确保该月的日期索引已在手（否则页面上还没有这一天的节点），
   * 再等节点出现、对齐，并顺手把这一天拉出来 —— 直接跳过去时 IntersectionObserver
   * 可能还没来得及触发，别让用户看到一整天空白。
   */
  const jumpToDay = useCallback(
    (day: string) => {
      const month = day.slice(0, 7);
      setOpenMonth(month);
      setActiveDay(day);
      loadDays(month).then(() => {
        const waitEl = (left: number) => {
          if (document.getElementById(`tl-${day}`)) {
            alignTo(`tl-${day}`, 38);
            return;
          }
          if (left > 0) jumpTimer.current = window.setTimeout(() => waitEl(left - 1), 60);
        };
        waitEl(10);
      });
      loadDay(day, 0);
    },
    [alignTo, loadDay, loadDays]
  );

  /**
   * 滚动时算「现在滚到哪一天」，用来高亮左栏的日期、并让它所属的月份自动展开。
   * 判定线放在月头下沿（44px = 38 月头 + 6 余量）：那一天的头刚贴上来就算进来了。
   */
  const onTimelineScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (scrollRaf.current) return;
    const scroller = e.currentTarget;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const line = scroller.getBoundingClientRect().top + 44;
      let cur = '';
      for (const el of scroller.querySelectorAll<HTMLElement>('.tl-day')) {
        if (el.getBoundingClientRect().top <= line) cur = el.dataset.day || cur;
        else break;
      }
      setActiveDay(cur);
    });
  };

  const startBackfill = async () => {
    try {
      const r = await api.timelineBackfill();
      if (r.already) onToast(t('重建任务已经在跑', 'Rebuild is already running'));
      else onToast(t('已开始重建拍摄时间（EXIF → 文件时间），可以继续浏览', 'Rebuilding capture time in the background'));
      pollJob();
    } catch (e) {
      onToast((e as Error)?.message || t('启动失败', 'Failed to start'), 'error');
    }
  };

  const pollJob = useCallback(() => {
    let tries = 0;
    const tick = async () => {
      try {
        const list = await api.jobs('timeline-backfill', 1);
        const last = list[0];
        if (last) setJob(last);
        if (last && (last.status === 'running' || last.status === 'queued')) {
          if (tries++ < 600) timers.current.push(window.setTimeout(tick, 800));
          return;
        }
        if (last && last.status === 'done') {
          setMonths({});
          setDays({});
          await loadSummary();
          onToast(t('拍摄时间已重建，时间线已刷新', 'Capture times rebuilt — timeline refreshed'));
        } else if (last && last.status === 'failed') {
          onToast(last.error || t('重建失败', 'Rebuild failed'), 'error');
        }
      } catch {
        /* 轮询失败不打扰用户，任务中心里有记录 */
      }
    };
    tick();
  }, [loadSummary, onToast, t]);

  // 进来时如果后台已经在跑（比如从别的页面启动），继续显示进度
  useEffect(() => {
    if (summary?.lastBackfill && summary.lastBackfill.status === 'running') {
      setJob({ ...summary.lastBackfill, status: summary.lastBackfill.status as JobItem['status'] });
      pollJob();
    }
  }, [summary?.lastBackfill, pollJob]);

  /**
   * 整页空但库里有素材：老版本把「收录时间」当拍摄时间，v1.2.8 起这些行被清成空，
   * 于是一库照片全排不进时间线（用户实报「全部有拍摄时间却提示没有」）。
   * 页面本来就没内容可看，这里自动重建一次最省事；同一会话只自动试一次，失败退回手动按钮。
   *
   * 注意：这个 effect 必须写在下面的早退 return 之前 —— 放在早退之后，
   * 首屏（loading）比加载完少调用两个 hook，React 会直接抛「Rendered more hooks than during the previous render」把整页打崩。
   */
  const startRef = useRef(startBackfill);
  startRef.current = startBackfill;
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !summary) return;
    if (summary.months.length) return;
    if (!(summary.total > 0 && summary.placed === 0)) return;
    if (!(summary.pending > 0 || summary.unplaced > 0)) return;
    const last = summary.lastBackfill;
    if (last && (last.status === 'running' || last.status === 'queued')) return;
    autoTried.current = true;
    startRef.current();
  }, [summary]);

  if (loading && !summary) {
    return <div className="tl-empty">{t('正在读取拍摄时间…', 'Reading capture times…')}</div>;
  }

  if (error && !summary) {
    return (
      <div className="tl-empty">
        {error}
        <button type="button" className="btn" onClick={() => { setLoading(true); loadSummary(); }}>
          {t('重试', 'Retry')}
        </button>
      </div>
    );
  }

  const running = job && (job.status === 'running' || job.status === 'queued');

  if (!summary || !summary.months.length) {
    const total = Number(summary?.total || 0);
    const unplaced = Number(summary?.unplaced || 0);
    // 待校正口径（还是入库时间兜底）与「排不进任何月份」都可能单独出现，两个都要给按钮
    const rebuildable = Number(summary?.pending || 0) || unplaced;
    return (
      <div className="tl-empty">
        <h2>{t('还没有可排入时间线的素材', 'Nothing on the timeline yet')}</h2>
        <p>
          {total > 0
            ? t(
                `库里 ${total.toLocaleString('zh-CN')} 张素材目前都没算出拍摄时间（多半是旧版本导入时把「收录时间」当成了拍摄时间，v1.2.8 起这个口径已废弃并被清空）。` +
                  '照片本身的时间还在 EXIF 和文件属性里，点下面的按钮重建一次就会按年归位。',
                `All ${total} items currently have no capture time (older versions filed them by import time, which was dropped in v1.2.8).` +
                  ' The times still exist in EXIF / file attributes — rebuild once and they will be filed by year.'
              )
            : t(
                '导入照片后，会按拍摄时间自动归档到对应年月：优先 EXIF 拍摄时间，没有 EXIF 时用文件的修改 / 创建时间（不会用收录进来的时间）。',
                'Imported photos are filed by capture time: EXIF first, otherwise the file’s modified / created time — never the time it was imported.'
              )}
        </p>
        {total > 0 && (
          <div className="tl-empty-acts">
            {!running && rebuildable > 0 && (
              <button type="button" className="btn primary" onClick={startBackfill}>
                {t(`重建拍摄时间（${rebuildable} 张待校正）`, `Rebuild capture time (${rebuildable} pending)`)}
              </button>
            )}
            {running && job && (
              <span className="tl-job">
                {job.message || t('重建中…', 'Rebuilding…')}
                <span className="tl-job-bar">
                  <i style={{ width: `${Math.max(2, Math.min(100, job.progress || 0))}%` }} />
                </span>
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="tl-root">
      <header className="tl-head">
        <div>
          <h2>{t('时间线', 'Timeline')}</h2>
          <p className="tl-sub">
            {t(
              `共 ${summary.placed} 张，分布在 ${summary.months.length} 个月 · 按拍摄日期分组（EXIF → 文件修改 / 创建时间）`,
              `${summary.placed} items across ${summary.months.length} months · grouped by capture date (EXIF → file time)`
            )}
          </p>
        </div>
        <div className="tl-head-actions">
          {summary.pending > 0 && !running && (
            <button type="button" className="btn" onClick={startBackfill}>
              {t(`重建拍摄时间（${summary.pending} 张待校正）`, `Rebuild capture time (${summary.pending} pending)`)}
            </button>
          )}
          {running && job && (
            <span className="tl-job">
              {job.message || t('重建中…', 'Rebuilding…')}
              <span className="tl-job-bar">
                <i style={{ width: `${Math.max(2, Math.min(100, job.progress || 0))}%` }} />
              </span>
            </span>
          )}
        </div>
      </header>

      <div className="tl-body">
        <nav className="tl-years" aria-label={t('按年月日跳转', 'Jump by year, month, day')}>
          {years.map((y) => (
            <div key={y.year} className="tl-year">
              <button type="button" className="tl-year-btn" onClick={() => jumpTo(y.months[0])}>
                {y.year}
                <span>{y.count}</span>
              </button>
              <div className="tl-year-months">
                {y.months.map((m) => {
                  const open = openMonth === m;
                  const state = months[m];
                  return (
                    <div key={m} className="tl-month-group">
                      <button
                        type="button"
                        className={`tl-month-link${activeMonth === m ? ' active' : ''}`}
                        aria-expanded={open}
                        onClick={() => {
                          setOpenMonth(open ? null : m);
                          jumpTo(m);
                        }}
                      >
                        {t(`${Number(m.slice(5))} 月`, monthLabel(m, 'en'))}
                        <span className="tl-month-link-count">{monthTotals[m]}</span>
                      </button>
                      {open && (
                        <div className="tl-days">
                          {!state?.days.length && (
                            <span className="tl-days-hint">
                              {state?.loading ? t('读取日期…', 'Loading…') : state?.error || t('没有日期', 'No days')}
                            </span>
                          )}
                          {state?.days.map((d) => (
                            <button
                              key={d.day}
                              type="button"
                              className={`tl-day-link${activeDay === d.day ? ' active' : ''}`}
                              onClick={() => jumpToDay(d.day)}
                            >
                              <span>{t(`${Number(d.day.slice(8))} 日`, `${Number(d.day.slice(8))}`)}</span>
                              <span className="tl-day-link-count">{d.count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="tl-scroll" onScroll={onTimelineScroll}>
          {summary.months.map((m) => (
            <MonthBlock
              key={m.month}
              month={m.month}
              count={m.count}
              state={months[m.month]}
              dayStates={days}
              lang={lang}
              onLoadDays={() => loadDays(m.month)}
              onLoadDay={(day) => loadDay(day, 0)}
              onMoreDay={(day, offset) => loadDay(day, offset)}
              onOpen={onOpen}
            />
          ))}
          {summary.unplaced > 0 && (
            <p className="tl-note">
              {t(
                `另有 ${summary.unplaced} 张既没有 EXIF 拍摄时间、也读不到文件时间，未排入时间线。点上方「重建拍摄时间」会重新读一次文件。`,
                `${summary.unplaced} items have neither EXIF capture time nor readable file time, so they are not on the timeline. Use “Rebuild capture time” to re-read the files.`
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
