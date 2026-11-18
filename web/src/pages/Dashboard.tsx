import { IconWarning } from '../components/Icons';
import React, { useEffect, useState } from 'react';
import type { ImageItem, Stats } from '../types';
import { Bars, Donut, TrendLine } from '../components/Charts';
import { BUCKET_LABELS, ORIENTATION_LABELS, SOURCE_LABELS, api, formatSize } from '../api';
import i18n from '../i18n';
import { previewHoverProps } from '../lib/preview-prefetch';

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
        <h4 className="section-title">{i18n.t('kd389aac2')}</h4>
        <div className="hint" style={{ color: 'var(--err, #e5484d)' }}>读取失败：{error}</div>
      </div>
    );
  }
  if (!data || !data.items.length) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h4 className="section-title">
        {i18n.t('kd389aac2')}
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
            <div className="big"><IconWarning size={40} /></div>
            <h3>{i18n.t('kb1051019')}</h3>
            <p>{error}</p>
            <p style={{ color: 'var(--muted)' }}>{i18n.t('k252de463')}</p>
          </>
        ) : (
          <>
            <span className="spinner" />
            <p style={{ marginTop: 14 }}>{i18n.t('kfb4ca1cf')}</p>
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
          <h1 className="page-title">{i18n.t('k3fa8b34a')}</h1>
          <div className="page-sub">{i18n.t('k3e789ed1')}</div>
        </div>
        <button className="btn primary" onClick={() => onNavigate('crawl')}>
          {i18n.t('k4b75b162')}
        </button>
      </div>

      <div className="stat-grid">
        <div className="card stat-card">
          <div className="label">{i18n.t('k19726aee')}</div>
          <div className="value">{stats.total}</div>
          <div className="hint">{i18n.t('k98405dd1')}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{i18n.t('k35337eb4')}</div>
          <div className="value">{stats.favorite}</div>
          <div className="hint">
            占比 {stats.total ? Math.round((stats.favorite / stats.total) * 100) : 0}%
          </div>
        </div>
        <div className="card stat-card">
          <div className="label">{i18n.t('k21691f6d')}</div>
          <div className="value">{formatSize(stats.totalSize)}</div>
          <div className="hint">
            平均 {stats.total ? formatSize(Math.round(stats.totalSize / stats.total)) : '0 B'} / 张
          </div>
        </div>
        <div className="card stat-card">
          <div className="label">{i18n.t('kd9e813ce')}</div>
          <div className="value" style={{ fontSize: 20 }}>
            {stats.crawling ? i18n.t('k595892a3') : i18n.t('k87bb5bbc')}
          </div>
          <div className="hint">
            {stats.trend.length ? i18n.t('k9b676227', { p0: stats.trend[stats.trend.length - 1].date }) : i18n.t('k9cdba42a')}
          </div>
        </div>
      </div>

      <div className="chart-grid">
        <div className="card chart-card">
          <h4>{i18n.t('k26a88820')}</h4>
          <Donut data={sourceData} total={stats.total} />
        </div>
        <div className="card chart-card">
          <h4>{i18n.t('kde338de2')}</h4>
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
            {i18n.t('k29acb917')}
            <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>{i18n.t('k2f48e5d9')}</span>
          </h4>
          <TrendLine data={stats.trend} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h4 className="section-title">{i18n.t('k8f98e6d4')}</h4>
        {stats.recent.length ? (
          <div className="recent-grid">
            {stats.recent.map((item) => (
              <img
                key={item.id}
                src={item.thumbUrl}
                alt={item.title}
                loading="lazy"
                {...previewHoverProps(item)}
                onClick={() => onOpen(item, stats.recent)}
              />
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            {i18n.t('kf08510ca')}
          </div>
        )}
      </div>

      {stats.largest.length > 0 && (
        <div className="card">
          <h4 className="section-title">{i18n.t('k30a18c19')}</h4>
          <div className="recent-grid">
            {stats.largest.map((item) => (
              <img
                key={item.id}
                src={item.thumbUrl}
                alt={item.title}
                loading="lazy"
                {...previewHoverProps(item)}
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
