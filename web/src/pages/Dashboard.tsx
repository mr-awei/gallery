import React, { useEffect, useState } from 'react';
import type { ImageItem, Stats } from '../types';
import { Bars, Donut, TrendLine } from '../components/Charts';
import { BUCKET_LABELS, ORIENTATION_LABELS, SOURCE_LABELS, api, formatSize } from '../api';

/** 使用统计：最常复制 / 导出的素材。没有记录时整块不出现，别占着版面说「暂无」。 */
function UsageBoard() {
  const [data, setData] = useState<{
    items: { id: number; title: string; copyCount: number; exportCount: number; thumbUrl: string }[];
    totals: { copies: number | null; exports: number | null };
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .usageStats()
      .then((r) => alive && setData({ items: r.items, totals: r.totals }))
      // 不能 catch(quiet)：统计读取失败时整块消失，用户只以为「没有使用记录」
      .catch((err) => alive && setError(String(err?.message || err)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="card" style={{ marginTop: 14 }}>
        <h4 className="section-title">使用统计</h4>
        <div className="hint" style={{ color: 'var(--err, #e5484d)' }}>读取失败：{error}</div>
      </div>
    );
  }
  if (!data || !data.items.length) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h4 className="section-title">
        使用统计
        <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
          累计复制 {Number(data.totals.copies) || 0} 次 · 导出 {Number(data.totals.exports) || 0} 次
        </span>
      </h4>
      <div className="usage-grid">
        {data.items.slice(0, 8).map((it) => (
          <div className="usage-item" key={it.id} title={it.title}>
            <img src={it.thumbUrl} alt={it.title} loading="lazy" />
            <div className="usage-meta">
              <span className="usage-title">{it.title}</span>
              <span className="usage-count">
                复制 {it.copyCount} · 导出 {it.exportCount}
              </span>
            </div>
          </div>
        ))}
      </div>
      {data.items.length > 8 && (
        <div className="hint" style={{ marginTop: 8 }}>
          仅显示使用最多的前 8 项（共 {data.items.length} 项有使用记录）
        </div>
      )}
    </div>
  );
}

interface Props {
  stats: Stats | null;
  /** 统计接口失败的原因：有值就说明加载态是假象，得如实告诉用户失败了 */
  error?: string;
  /** pool 传入同一批图片，预览时才可左右切换 / 滚轮翻图 */
  onOpen: (item: ImageItem, pool?: ImageItem[]) => void;
  onNavigate: (view: string) => void;
}

const BUCKET_ORDER = ['sd', 'fhd', '2k', '4k'];

export default function Dashboard({ stats, error, onOpen, onNavigate }: Props) {
  if (!stats) {
    return (
      <div className="empty">
        {error ? (
          <>
            <div className="big">⚠️</div>
            <h3>统计没能加载出来</h3>
            <p>{error}</p>
            <p style={{ color: 'var(--muted)' }}>用顶部错误条上的「重试」再拉一次；持续失败请查看日志。</p>
          </>
        ) : (
          <>
            <span className="spinner" />
            <p style={{ marginTop: 14 }}>加载中…</p>
          </>
        )}
      </div>
    );
  }

  const sourceData = stats.bySource.map((s) => ({
    name: SOURCE_LABELS[s.source] || s.source,
    count: s.count,
  }));

  const bucketData = BUCKET_ORDER.map((b) => ({
    name: BUCKET_LABELS[b],
    count: stats.byBucket.find((x) => x.bucket === b)?.count || 0,
  })).filter((d) => d.count > 0 || stats.total > 0);

  const orientationTotal = stats.byOrientation.reduce((a, b) => a + b.count, 0) || 1;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">仪表盘</h1>
          <div className="page-sub">图库总览 · 实时统计</div>
        </div>
        <button className="btn primary" onClick={() => onNavigate('crawl')}>
          开始采集
        </button>
      </div>

      <div className="stat-grid">
        <div className="card stat-card">
          <div className="label">🖼️ 总图片数</div>
          <div className="value">{stats.total}</div>
          <div className="hint">已通过 pHash 去重</div>
        </div>
        <div className="card stat-card">
          <div className="label">💗 收藏数</div>
          <div className="value">{stats.favorite}</div>
          <div className="hint">
            占比 {stats.total ? Math.round((stats.favorite / stats.total) * 100) : 0}%
          </div>
        </div>
        <div className="card stat-card">
          <div className="label">💾 图库体积</div>
          <div className="value">{formatSize(stats.totalSize)}</div>
          <div className="hint">
            平均 {stats.total ? formatSize(Math.round(stats.totalSize / stats.total)) : '0 B'} / 张
          </div>
        </div>
        <div className="card stat-card">
          <div className="label">📡 采集状态</div>
          <div className="value" style={{ fontSize: 20 }}>
            {stats.crawling ? '采集中…' : '空闲'}
          </div>
          <div className="hint">
            {stats.trend.length ? `最近采集 ${stats.trend[stats.trend.length - 1].date}` : '暂无采集记录'}
          </div>
        </div>
      </div>

      <div className="chart-grid">
        <div className="card chart-card">
          <h4>来源分布</h4>
          <Donut data={sourceData} total={stats.total} />
        </div>
        <div className="card chart-card">
          <h4>分辨率分布</h4>
          <Bars data={bucketData} />
          <div style={{ marginTop: 14, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {stats.byOrientation.map((o) => (
              <div key={o.orientation} style={{ fontSize: 12 }}>
                <span style={{ color: 'var(--muted)' }}>{ORIENTATION_LABELS[o.orientation]} </span>
                <b>{Math.round((o.count / orientationTotal) * 100)}%</b>
              </div>
            ))}
          </div>
        </div>
        <div className="card chart-card">
          <h4>
            采集趋势
            <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>近 14 天</span>
          </h4>
          <TrendLine data={stats.trend} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h4 className="section-title">最近采集</h4>
        {stats.recent.length ? (
          <div className="recent-grid">
            {stats.recent.map((item) => (
              <img
                key={item.id}
                src={item.thumbUrl}
                alt={item.title}
                loading="lazy"
                onClick={() => onOpen(item, stats.recent)}
              />
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            还没有图片，去「采集」页面抓一批高清图吧。
          </div>
        )}
      </div>

      {stats.largest.length > 0 && (
        <div className="card">
          <h4 className="section-title">最高画质</h4>
          <div className="recent-grid">
            {stats.largest.map((item) => (
              <img
                key={item.id}
                src={item.thumbUrl}
                alt={item.title}
                loading="lazy"
                onClick={() => onOpen(item, stats.largest)}
                title={`${item.width}×${item.height}`}
              />
            ))}
          </div>
        </div>
      )}

      <UsageBoard />
    </div>
  );
}
