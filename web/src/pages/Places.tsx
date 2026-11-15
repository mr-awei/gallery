import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';

/**
 * 地点视图：按 EXIF 经纬度把素材铺到一张世界地图上。
 *
 * 为什么不用在线地图瓦片：图库是本地优先的，离线时地图不能变成一片灰。
 * 这里画的是等距圆柱投影的简化世界图（有经纬网、有陆地轮廓感），够用来
 * 「看出来照片都拍在哪一带」，点一下就把那一带的素材筛出来。
 *
 * 聚合粒度：0.1°（约 11km）。同一个城市的几百张会落成一个点，而不是糊成一团。
 */

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  /** 选一块区域：直接把 bbox 交给图库筛选（比新开一套列表更省事） */
  onOpenPlace: (bbox: string, label: string) => void;
}

interface GeoPoint {
  lat: number;
  lon: number;
  n: number;
  coverId: number;
}

const W = 960;
const H = 480;
const PAD = 0.22;

/** 经纬度 → SVG 坐标（等距圆柱投影） */
const px = (lon: number) => ((Number(lon) + 180) / 360) * W;
const py = (lat: number) => ((90 - Number(lat)) / 180) * H;

/** 粗略的陆地轮廓（够看，不追求制图精度）：[经度, 纬度] 顶点序列 */
const LANDMASSES: [number, number][][] = [
  // 欧亚大陆
  [[-10, 36], [-9, 43], [-2, 48], [4, 51], [10, 55], [5, 60], [15, 68], [28, 71], [45, 68], [70, 73], [95, 78], [130, 72], [160, 69], [170, 66], [160, 60], [142, 54], [135, 45], [126, 38], [121, 31], [110, 21], [105, 10], [98, 8], [92, 21], [80, 8], [72, 20], [60, 25], [48, 29], [36, 36], [28, 41], [18, 40], [12, 45], [3, 43], [-9, 37]],
  // 非洲
  [[-16, 20], [-17, 33], [-6, 36], [10, 37], [20, 32], [32, 31], [43, 12], [51, 12], [41, -2], [40, -15], [35, -24], [25, -34], [18, -34], [12, -18], [9, -1], [3, 5], [-8, 4], [-13, 12], [-17, 21]],
  // 北美
  [[-168, 66], [-155, 71], [-130, 70], [-95, 72], [-80, 74], [-60, 60], [-56, 50], [-66, 45], [-70, 41], [-76, 35], [-81, 26], [-90, 29], [-97, 26], [-105, 20], [-115, 30], [-125, 40], [-130, 52], [-142, 60], [-160, 62], [-168, 66]],
  // 南美
  [[-81, 8], [-70, 12], [-60, 10], [-50, 0], [-35, -6], [-38, -22], [-48, -27], [-58, -38], [-63, -52], [-70, -55], [-75, -45], [-73, -30], [-70, -18], [-81, -5], [-81, 8]],
  // 澳洲
  [[113, -22], [114, -34], [129, -32], [140, -38], [150, -37], [154, -28], [146, -19], [142, -11], [132, -11], [122, -17], [113, -22]],
  // 南极（一条横带，表示「这里有照片也算地点」）
  [[-180, -72], [-120, -74], [-60, -70], [0, -70], [60, -68], [120, -70], [180, -72], [180, -88], [-180, -88]],
];

function pathOf(poly: [number, number][]) {
  return `${poly.map(([lon, lat], i) => `${i ? 'L' : 'M'}${px(lon).toFixed(1)} ${py(lat).toFixed(1)}`).join(' ')} Z`;
}

/** 0.5° 的框：足够把「这一带拍的」都框进来，又不至于跨到隔壁城市 */
const DELTA = 0.5;

export default function Places({ onToast, onOpenPlace }: Props) {
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.geoPoints(1);
      setPoints(r.points || []);
      setTotal(r.total || 0);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 补算历史素材的 GPS：老库导入时没有落经纬度，地图上会是空的 */
  const backfill = async () => {
    setBusy(true);
    try {
      const r = await api.maintenanceGpsBackfill(200);
      const tail = r.remain ? `（还剩 ${r.remain} 张待扫描）` : '';
      onToast(
        r.scanned
          ? `已扫描 ${r.scanned} 张，其中 ${r.found} 张有 GPS${tail}`
          : '没有待扫描的素材'
      );
      await load();
    } catch (err) {
      onToast(`补算地点失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const maxN = useMemo(() => points.reduce((m, p) => Math.max(m, p.n), 1), [points]);
  const top = useMemo(() => points.slice(0, 12), [points]);
  const radius = (n: number) => 4 + Math.sqrt(n / maxN) * 16;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{'地点'}</h3>
        <span className="hint" style={{ flex: 1 }}>
          {total
            ? `${total} 张带 GPS 的素材，聚成 ${points.length} 个地点`
            : '还没有带经纬度的素材：地图是空的'}
        </span>
        <button className="btn sm" disabled={busy} onClick={() => void load()}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        <button
          className="btn sm ghost"
          disabled={busy}
          title={'读历史素材的 EXIF，把经纬度补进库（按批进行，可多次点）'}
          onClick={() => void backfill()}
        >
          {busy ? '补算中…' : '补算历史素材的位置'}
        </button>
      </div>

      {error && <div className="danger small" style={{ marginBottom: 10 }}>{'读取地点失败：'}{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 10 }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
            aria-label={'素材拍摄地点分布图'}>
            <rect x={0} y={0} width={W} height={H} fill="var(--panel-strong, #141821)" rx={8} />
            {/* 经纬网：每 30° 一条，够定位又不会糊住图 */}
            {[-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lon) => (
              <line key={`v${lon}`} x1={px(lon)} y1={0} x2={px(lon)} y2={H} stroke="rgba(255,255,255,.07)" strokeWidth={1} />
            ))}
            {[-60, -30, 0, 30, 60].map((lat) => (
              <line key={`h${lat}`} x1={0} y1={py(lat)} x2={W} y2={py(lat)} stroke="rgba(255,255,255,.07)" strokeWidth={1} />
            ))}
            {LANDMASSES.map((poly, i) => (
              <path key={i} d={pathOf(poly)} fill="rgba(255,255,255,.055)" stroke="rgba(255,255,255,.14)" strokeWidth={1} />
            ))}
            {points.map((p) => (
              <g key={`${p.lat},${p.lon}`} style={{ cursor: 'pointer' }}
                onClick={() => {
                  const label = `${p.lat.toFixed(1)}°, ${p.lon.toFixed(1)}°`;
                  onOpenPlace(
                    `${p.lat - DELTA},${p.lon - DELTA},${p.lat + DELTA},${p.lon + DELTA}`,
                    label
                  );
                }}>
                <circle cx={px(p.lon)} cy={py(p.lat)} r={radius(p.n)} fill="rgba(96,165,250,.35)" stroke="rgba(147,197,253,.9)" strokeWidth={1.5} />
                <text x={px(p.lon)} y={py(p.lat) + 4} textAnchor="middle" fontSize={11} fill="#e5e7eb" pointerEvents="none">
                  {p.n}
                </text>
              </g>
            ))}
          </svg>
          <div className="hint" style={{ marginTop: 8 }}>
            {'圆点大小 = 该处的素材张数；点一下就在图库里筛出这一带的照片。地图为离线简图，不含街道级细节。'}
          </div>
        </div>

        <div className="card" style={{ padding: 12 }}>
          <b style={{ fontSize: 13 }}>{'地点排行'}</b>
          {loading && !points.length && <div className="hint" style={{ marginTop: 8 }}>{'读取中…'}</div>}
          {!loading && !points.length && (
            <div className="hint" style={{ marginTop: 8, lineHeight: 1.8 }}>
              {'没有带 GPS 的素材。相机拍的照片通常带经纬度，截图 / 网图一般没有。老库可以点上方「补算历史素材的位置」。'}
            </div>
          )}
          {top.map((p) => (
            <button
              key={`${p.lat},${p.lon}`}
              className="btn sm ghost"
              style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginTop: 6, gap: 8 }}
              title={'筛选这一带的素材'}
              onClick={() =>
                onOpenPlace(
                  `${p.lat - DELTA},${p.lon - DELTA},${p.lat + DELTA},${p.lon + DELTA}`,
                  `${p.lat.toFixed(1)}°, ${p.lon.toFixed(1)}°`
                )
              }
            >
              <span>{p.lat.toFixed(1)}°, {p.lon.toFixed(1)}°</span>
              <span style={{ color: 'var(--muted)' }}>{p.n}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
