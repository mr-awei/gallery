import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImageItem, TimelineSummary } from '../types';
import type { JobItem } from '../api';
import { api } from '../api';
import { useLang } from '../lib/i18n';

/**
 * 时间线视图：按拍摄时间倒序，先给「年 → 月」索引，再按月懒加载图片。
 *
 * 为什么不复用 Gallery 的虚拟网格：时间线是「按日期分组的长卷」，分组头要吸顶、
 * 月份要按需拉取；把全部月份塞进一个平铺列表会先序列化几万条 DTO 才出现第一屏。
 * 这里每个月份独立请求（索引可用），滚到哪个月才加载哪个月。
 */

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 打开灯箱（pool 是该月已加载的图，灯箱内可左右切） */
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
}

interface MonthState {
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

function MonthBlock({
  month,
  count,
  state,
  lang,
  onLoad,
  onLoadMore,
  onOpen,
}: {
  month: string;
  count: number;
  state?: MonthState;
  lang: 'zh' | 'en';
  onLoad: () => void;
  onLoadMore: () => void;
  onOpen: (item: ImageItem, pool: ImageItem[]) => void;
}) {
  const { t } = useLang();
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);

  // 进入视口才请求：首屏只加载当前月份，往下滚一屏加载一屏
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
    <section className="tl-month" id={`tl-${month}`} ref={ref}>
      <header className="tl-month-head">
        <h3>{monthLabel(month, lang)}</h3>
        <span className="tl-month-count">
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

export function Timeline({ onToast, onOpen }: Props) {
  const { t, lang } = useLang();
  const [summary, setSummary] = useState<TimelineSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [months, setMonths] = useState<Record<string, MonthState>>({});
  const [job, setJob] = useState<Pick<JobItem, 'id' | 'status' | 'progress' | 'message'> | null>(null);
  const timers = useRef<number[]>([]);

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
    return () => list.forEach((id) => window.clearTimeout(id));
  }, []);

  const loadMonth = useCallback(
    async (month: string, offset = 0) => {
      setMonths((prev) => {
        const cur = prev[month];
        // 已经加载过（或正在加载）就别再请求一次——IntersectionObserver 会重复触发
        if (offset === 0 && cur && (cur.items.length || cur.loading)) return prev;
        return {
          ...prev,
          [month]: { items: offset ? cur?.items || [] : [], total: cur?.total || 0, loading: true },
        };
      });
      try {
        const r = await api.timelineMonth(month, offset, PAGE);
        setMonths((prev) => {
          const cur = prev[month];
          const items = offset > 0 ? [...(cur?.items || []), ...r.items] : r.items;
          return { ...prev, [month]: { items, total: r.total, loading: false } };
        });
      } catch (e) {
        const msg = (e as Error)?.message || t('加载失败', 'Failed to load');
        setMonths((prev) => ({
          ...prev,
          [month]: { items: prev[month]?.items || [], total: prev[month]?.total || 0, loading: false, error: msg },
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

  const jumpTo = (month: string) => {
    const el = document.getElementById(`tl-${month}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const startBackfill = async () => {
    try {
      const r = await api.timelineBackfill();
      if (r.already) onToast(t('重建任务已经在跑', 'Rebuild is already running'));
      else onToast(t('已开始按 EXIF 重建拍摄时间，可以继续浏览', 'Rebuilding capture time from EXIF in the background'));
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

  if (!summary || !summary.months.length) {
    return (
      <div className="tl-empty">
        <h2>{t('还没有可排入时间线的素材', 'Nothing on the timeline yet')}</h2>
        <p>{t('导入照片后，会按拍摄时间（EXIF）自动归档到对应年月。', 'Imported photos are filed by their EXIF capture time.')}</p>
      </div>
    );
  }

  const running = job && (job.status === 'running' || job.status === 'queued');

  return (
    <div className="tl-root">
      <header className="tl-head">
        <div>
          <h2>{t('时间线', 'Timeline')}</h2>
          <p className="tl-sub">
            {t(
              `共 ${summary.placed} 张，分布在 ${summary.months.length} 个月`,
              `${summary.placed} items across ${summary.months.length} months`
            )}
          </p>
        </div>
        <div className="tl-head-actions">
          {summary.pending > 0 && !running && (
            <button type="button" className="btn" onClick={startBackfill}>
              {t(`按 EXIF 重建拍摄时间（${summary.pending} 张待校正）`, `Rebuild capture time from EXIF (${summary.pending} pending)`)}
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
        <nav className="tl-years" aria-label={t('按年跳转', 'Jump by year')}>
          {years.map((y) => (
            <div key={y.year} className="tl-year">
              <button type="button" className="tl-year-btn" onClick={() => jumpTo(y.months[0])}>
                {y.year}
                <span>{y.count}</span>
              </button>
              <div className="tl-year-months">
                {y.months.map((m) => (
                  <button key={m} type="button" className="tl-month-link" onClick={() => jumpTo(m)}>
                    {t(`${Number(m.slice(5))} 月`, monthLabel(m, 'en'))}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="tl-scroll">
          {summary.months.map((m) => (
            <MonthBlock
              key={m.month}
              month={m.month}
              count={m.count}
              state={months[m.month]}
              lang={lang}
              onLoad={() => loadMonth(m.month, 0)}
              onLoadMore={() => loadMonth(m.month, months[m.month]?.items.length || 0)}
              onOpen={onOpen}
            />
          ))}
          {summary.unplaced > 0 && (
            <p className="tl-note">
              {t(
                `另有 ${summary.unplaced} 张没有拍摄时间，未排入时间线。`,
                `${summary.unplaced} items have no capture time and are not on the timeline.`
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
