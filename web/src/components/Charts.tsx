import React from 'react';

const COLORS = ['#ff4d8d', '#a855f7', '#38bdf8', '#4ade80', '#fbbf24', '#f472b6', '#818cf8'];

export function Donut({ data, total }: { data: { name: string; count: number }[]; total: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--panel-strong)" strokeWidth="18" />
        {data.map((d, i) => {
          const ratio = total ? d.count / total : 0;
          const len = ratio * c;
          const el = (
            <circle
              key={d.name}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={COLORS[i % COLORS.length]}
              strokeWidth="18"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
              strokeLinecap="butt"
            />
          );
          offset += len;
          return el;
        })}
        {/* 主题感知变量：环形图中心数字曾硬编码暗色主题的近白色，浅色主题下隐形 */}
        <text x="70" y="66" textAnchor="middle" fill="var(--text)" fontSize="21" fontWeight="700">
          {total}
        </text>
        <text x="70" y="84" textAnchor="middle" fill="var(--muted)" fontSize="11">
          张图片
        </text>
      </svg>
      <div className="legend" style={{ flex: 1, minWidth: 130 }}>
        {data.map((d, i) => (
          <div className="legend-row" key={d.name}>
            <span className="legend-dot" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="name">{d.name}</span>
            <span className="val">
              {d.count} · {total ? Math.round((d.count / total) * 100) : 0}%
            </span>
          </div>
        ))}
        {!data.length && <span style={{ color: 'var(--muted)' }}>暂无数据</span>}
      </div>
    </div>
  );
}

export function Bars({ data }: { data: { name: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div>
      {data.map((d) => (
        <div className="bar-row" key={d.name}>
          <span className="name">{d.name}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(d.count / max) * 100}%` }} />
          </span>
          <span className="val">{d.count}</span>
        </div>
      ))}
      {!data.length && <span style={{ color: 'var(--muted)' }}>暂无数据</span>}
    </div>
  );
}

export function TrendLine({ data }: { data: { date: string; count: number }[] }) {
  const w = 320;
  const h = 96;
  const pad = 6;
  if (data.length < 2) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 12, paddingTop: 30 }}>
        {data.length === 1 ? `第一天已采集 ${data[0].count} 张` : '暂无数据'}
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.count));
  const stepX = (w - pad * 2) / (data.length - 1);
  const points = data.map((d, i) => ({
    x: pad + i * stepX,
    y: h - pad - (d.count / max) * (h - pad * 2 - 14),
  }));
  const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,77,141,0.42)" />
            <stop offset="100%" stopColor="rgba(168,85,247,0.02)" />
          </linearGradient>
          <linearGradient id="lineStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ff4d8d" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#areaFill)" />
        <polyline points={line} fill="none" stroke="url(#lineStroke)" strokeWidth="2.2" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.6} fill="#ff4d8d" />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted)', fontSize: 11 }}>
        <span>{data[0].date.slice(5)}</span>
        <span>峰值 {max} 张</span>
        <span>{data[data.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}
