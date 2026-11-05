import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Filters } from '../types';
import { BUCKET_LABELS, ORIENTATION_LABELS, SOURCE_LABELS, api, desktop, quiet } from '../api';
import { IconColumns, IconGrid, IconList, IconSearch } from './Icons';
import { THUMB_DEFAULT, THUMB_MAX, THUMB_MIN, THUMB_PRESETS, clampThumbWidth, thumbPresetOf } from '../lib/thumb-size';
import ColorPad from './ColorPad';

interface Props {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  tags: { tag: string; count: number }[];
  viewMode: 'masonry' | 'grid' | 'list';
  onViewMode: (mode: 'masonry' | 'grid' | 'list') => void;
  /** 缩略图尺寸滑块（列宽 px） */
  colWidth?: number;
  onColWidth?: (w: number) => void;
  total: number;
  hideFavorite?: boolean;
  /** 当前在文件夹里：排序下拉才提供「手动排序」（顺序存在 image_folders.sort_order） */
  canManualSort?: boolean;
  onMarkAllSeen?: () => void;
}

/** 「待整理」智能视图（Eagle 式固定入口） */
const PENDING_LABEL: Record<string, string> = {
  noFolder: '待整理·未分类',
  noTags: '待整理·无标签',
  noRating: '待整理·未评分',
};

/** 支持入库的素材类型（Eagle 多格式） */
const KINDS: { key: string; label: string }[] = [
  { key: 'image', label: '图片' },
  { key: 'gif', label: 'GIF' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'font', label: '字体' },
  { key: 'pdf', label: 'PDF' },
  { key: 'office', label: 'Office' },
  { key: 'model', label: '3D 模型' },
];

const BUCKETS = ['sd', 'fhd', '2k', '4k'];
/** 12 个色相区间 + 黑白灰（粗筛快捷键）。
 *  区间 i 对应色相 [i*30, (i+1)*30)：0红 1橙 2黄 3黄绿 4绿 5青绿 6青 7蓝 8靛 9紫 10品红 11玫粉 */
const HUES = [
  { v: '0', c: '#ff4d4d', t: '红' },
  { v: '1', c: '#ff9a4d', t: '橙' },
  { v: '2', c: '#ffe04d', t: '黄' },
  { v: '3', c: '#c8ff4d', t: '黄绿' },
  { v: '4', c: '#4dff6a', t: '绿' },
  { v: '5', c: '#4dffcf', t: '青绿' },
  { v: '6', c: '#4defff', t: '青' },
  { v: '7', c: '#4da6ff', t: '蓝' },
  { v: '8', c: '#5c4dff', t: '靛' },
  { v: '9', c: '#a64dff', t: '紫' },
  { v: '10', c: '#ff4dd2', t: '品红' },
  { v: '11', c: '#ff4d88', t: '玫粉' },
];

/** 下拉筛选（Google Photos / Eagle 的通行做法）：
 *  入口按钮常驻一行、选项收进弹出面板，激活时按钮显示徽标，不再平铺占位。 */
function Drop(props: {
  label: string;
  open: boolean;
  onToggle: () => void;
  active?: boolean;
  badge?: number;
  swatch?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="fdrop">
      <button
        type="button"
        className={`fdrop-btn${props.active ? ' on' : ''}${props.open ? ' open' : ''}`}
        onClick={props.onToggle}
      >
        {props.swatch && <span className="fdrop-swatch" style={{ background: props.swatch }} />}
        {props.label}
        {!!props.badge && <span className="fdrop-badge">{props.badge}</span>}
        <span className="fdrop-caret">▾</span>
      </button>
      {props.open && <div className="fdrop-panel">{props.children}</div>}
    </div>
  );
}

export default function FilterBar({
  filters,
  onChange,
  tags,
  viewMode,
  onViewMode,
  colWidth,
  onColWidth,
  total,
  hideFavorite,
  canManualSort,
  onMarkAllSeen,
}: Props) {
  /** 当前列宽（收进合法区间，老 localStorage 里的小值也不会让滑块越界） */
  const curW = clampThumbWidth(colWidth ?? THUMB_DEFAULT);
  const toggleIn = (key: 'source' | 'bucket', value: string) => {
    const list = filters[key];
    onChange({ [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] } as Partial<Filters>);
  };

  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggleDrop = (key: string) => setOpenKey((cur) => (cur === key ? null : key));
  const rootRef = useRef<HTMLDivElement>(null);

  // 来源筛选项来自后端（含「本地导入」），前端不再硬编码一份可能与后端脱节的列表
  const [sources, setSources] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    api
      .crawlConfig()
      .then((c) => {
        if (!alive) return;
        setSources(c.sources.map((s) => s.key));
        setLabels(Object.fromEntries(c.sources.map((s) => [s.key, s.label])));
      })
      .catch(quiet);
    return () => {
      alive = false;
    };
  }, []);

  // 点击面板外 / Esc 关闭
  useEffect(() => {
    if (!openKey) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenKey(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenKey(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openKey]);

  const selectedHues = filters.hue ? filters.hue.split(',').filter(Boolean) : [];

  /** 色系快筛：多选即取并集（后端 hue 用逗号串存，'gray' 表示无彩度图） */
  const toggleHue = (v: string) => {
    const next = selectedHues.includes(v) ? selectedHues.filter((x) => x !== v) : [...selectedHues, v];
    onChange({ hue: next.join(',') });
  };

  /* 颜色草稿：色盘拖动/选色高频变化，静止 150ms 后才提交筛选（与「停下即搜」一致）。
   * 用 useEffect 去抖（与智能检索页同款），比“事件内 setTimeout”更稳，不会被卸载清理误清。 */
  const [draft, setDraft] = useState({ hex: filters.colorHex || '#ff4d6d', tol: filters.colorTol ?? 48 });
  const interactedRef = useRef(false);
  // 色号输入框的文本（允许中间态如 "ff4"，凑满 6 位合法十六进制才提交筛选）
  const [hexText, setHexText] = useState((filters.colorHex || '#ff4d6d').replace('#', ''));
  // 屏幕吸管（桌面端）：截图覆盖层实现「左键取色 / 右键取消」；浏览器端退回 EyeDropper API
  const eyeDropperOk = typeof (window as { EyeDropper?: unknown }).EyeDropper === 'function';
  const [picking, setPicking] = useState(false);
  // 截图取色：url 为已裁剪好的窗口区域截图（主进程返回），铺满窗口即 1:1 对齐
  const [cap, setCap] = useState<{ url: string } | null>(null);
  const capPixels = useRef<{ w: number; h: number; data: Uint8ClampedArray } | null>(null); // 截图像素缓存
  const [liveHex, setLiveHex] = useState('');
  const [pickPos, setPickPos] = useState({ x: 0, y: 0 });
  const eyeRef = useRef<{ open: () => Promise<{ sRGBHex: string }> } | null>(null);

  // 打开颜色下拉时预构建吸管实例，消除首次点击的 ~1-2s 启动延迟（仅 EyeDropper 备用路径用）
  useEffect(() => {
    if (openKey !== 'color' || !eyeDropperOk || eyeRef.current) return;
    // @ts-expect-error EyeDropper 是较新的标准 API
    eyeRef.current = new window.EyeDropper();
  }, [openKey, eyeDropperOk]);

  const applyPicked = (hex: string) => {
    interactedRef.current = true;
    setHexText(hex.replace('#', '').toLowerCase());
    setDraft((d) => ({ ...d, hex: hex.toLowerCase() }));
  };
  // 从截图像素缓存取某屏幕坐标的颜色
  const sampleFromCache = (clientX: number, clientY: number): string => {
    const img = document.querySelector<HTMLImageElement>('.screen-picker img');
    if (!img || !capPixels.current) return '';
    const rect = img.getBoundingClientRect();
    const px = Math.floor(((clientX - rect.left) / rect.width) * capPixels.current.w);
    const py = Math.floor(((clientY - rect.top) / rect.height) * capPixels.current.h);
    if (px < 0 || py < 0 || px >= capPixels.current.w || py >= capPixels.current.h) return '';
    const i = (py * capPixels.current.w + px) * 4;
    const d = capPixels.current.data;
    return `#${[d[i], d[i + 1], d[i + 2]].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  };
  const startPick = async () => {
    setPicking(true);
    try {
      // 先收起颜色下拉：否则截图里是整个色盘面板，挡住后面的照片没法取色
      setOpenKey(null);
      await new Promise((r) => setTimeout(r, 150)); // 等下拉收起动画结束并重新绘制
      const r = await desktop?.screenCapture?.();
      if (!r?.dataUrl) {
        // 桌面端截图不可用时退回 EyeDropper（浏览器模式）
        if (eyeDropperOk) {
          // @ts-expect-error EyeDropper 是较新的标准 API
          const { sRGBHex } = await new window.EyeDropper().open();
          applyPicked(sRGBHex);
        }
        return;
      }
      capPixels.current = null;
      setCap({ url: r.dataUrl });
    } finally {
      setPicking(false);
    }
  };

  // 取色覆盖层：Esc 取消
  useEffect(() => {
    if (!cap) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCap(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cap]);
  // 搜索词草稿 + 250ms 防抖：逐键提交会每键打一次全量列表查询（FTS + COUNT），
  // 停顿后再查；外部重置（清除筛选 / chips）时同步回输入框
  const [qDraft, setQDraft] = useState(filters.q);
  useEffect(() => {
    setQDraft(filters.q);
  }, [filters.q]);
  useEffect(() => {
    if (qDraft === filters.q) return;
    const t = setTimeout(() => onChange({ q: qDraft }), 250);
    return () => clearTimeout(t);
  }, [qDraft]);

  // 外部筛选变化（清空 / 来自大图“找同色系”等）时同步草稿，并清掉“已交互”标记
  useEffect(() => {
    setDraft({ hex: filters.colorHex || '#ff4d6d', tol: filters.colorTol ?? 48 });
    setHexText((filters.colorHex || '#ff4d6d').replace('#', '').toLowerCase());
    if (!filters.colorHex) interactedRef.current = false;
  }, [filters.colorHex, filters.colorTol]);
  // 拖动/选色后静止 150ms 提交
  useEffect(() => {
    if (!interactedRef.current) return;
    const t = setTimeout(() => onChange({ colorHex: draft.hex, colorTol: draft.tol, hue: '' }), 150);
    return () => clearTimeout(t);
  }, [draft.hex, draft.tol]);

  /* 已生效筛选 → 可移除 chips（有筛选时才出现，不占常驻空间） */
  const chips: { label: string; swatch?: string; clear: () => void }[] = [];
  if (filters.favorite !== 'all')
    chips.push({ label: filters.favorite === 'yes' ? '已收藏' : '未收藏', clear: () => onChange({ favorite: 'all' }) });
  filters.source.forEach((s) =>
    chips.push({ label: `来源·${SOURCE_LABELS[s] || s}`, clear: () => onChange({ source: filters.source.filter((x) => x !== s) }) })
  );
  if (filters.orientation !== 'all')
    chips.push({ label: `画幅·${ORIENTATION_LABELS[filters.orientation]}`, clear: () => onChange({ orientation: 'all' }) });
  if ((filters.seen || 'all') !== 'all')
    chips.push({ label: filters.seen === 'unseen' ? '未看过' : '已看过', clear: () => onChange({ seen: 'all' }) });
  if (filters.minRating)
    chips.push({ label: `${'★'.repeat(filters.minRating)}+`, clear: () => onChange({ minRating: 0 }) });
  filters.bucket.forEach((b) =>
    chips.push({ label: BUCKET_LABELS[b] || b, clear: () => onChange({ bucket: filters.bucket.filter((x) => x !== b) }) })
  );
  if (filters.colorHex)
    chips.push({ label: filters.colorHex.toUpperCase(), swatch: filters.colorHex, clear: () => onChange({ colorHex: '' }) });
  if (selectedHues.length) {
    const h = HUES.find((x) => x.v === selectedHues[0]);
    const label =
      selectedHues.length > 1 ? `色系·${selectedHues.length} 项` : h ? `色系·${h.t}` : '黑白灰';
    chips.push({ label, clear: () => onChange({ hue: '' }) });
  }
  if (filters.kind && filters.kind !== 'all') {
    const k = KINDS.find((x) => x.key === filters.kind);
    chips.push({ label: `类型·${k?.label || filters.kind}`, clear: () => onChange({ kind: 'all' }) });
  }
  if (filters.pending) {
    chips.push({ label: PENDING_LABEL[filters.pending] || '待整理', clear: () => onChange({ pending: '' }) });
  }

  const resetAll = () =>
    onChange({
      favorite: 'all',
      source: [],
      bucket: [],
      orientation: 'all',
      seen: 'all',
      minRating: 0,
      hue: '',
      colorHex: '',
      kind: 'all',
      pending: '',
    });

  return (
    <div data-tour="filterbar">
      <div className="toolbar">
        <div className="search-box">
          <span className="icon">
            <IconSearch />
          </span>
          <input
            className="input"
            placeholder="搜索文件名 / 标签…（支持 tag: color: rating: folder:）"
            title={
              '搜索语法（可与关键词混用）：\n' +
              'tag:风景            按标签（别名也算）\n' +
              'color:红 / color:#ff0000   按色系或精确色号\n' +
              'rating:>=4          按星级（>= / <= / > / < / =）\n' +
              'folder:参考         按文件夹（含子夹）\n' +
              'kind:video          按类型\n' +
              'is:favorite / is:unseen    收藏 / 未看过'
            }
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
          />
        </div>

        <select
          className="select"
          value={filters.sort}
          onChange={(e) => onChange({ sort: e.target.value })}
        >
          <option value="newest">最新采集</option>
          <option value="name">名称 A → Z</option>
          <option value="nameDesc">名称 Z → A</option>
          <option value="recommend">推荐（个人偏好 + 评分）</option>
          <option value="rating">我的星级优先</option>
          <option value="smart">评分排序（知识库打分优先）</option>
          <option value="worst">低分优先（待清理）</option>
          <option value="oldest">最早采集</option>
          <option value="resolution">分辨率最高</option>
          <option value="largest">文件最大</option>
          <option value="random">随机</option>
          {(canManualSort || filters.sort === 'manual') && (
            <option value="manual" disabled={!canManualSort}>
              手动排序（拖拽定序）
            </option>
          )}
        </select>

        <select className="select" value={filters.tag} onChange={(e) => onChange({ tag: e.target.value })}>
          <option value="">全部标签</option>
          {tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag}（{t.count}）
            </option>
          ))}
        </select>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {desktop?.captureScreenshot && (
            <button
              className="btn sm"
              title="截图入库：框选屏幕区域存进图库（全局快捷键 Ctrl+Shift+S）"
              onClick={() => {
                // 统一入口：桌面端由主进程抓底图，浏览器端给提示
                if (desktop?.grabScreen) window.dispatchEvent(new Event('tuku:screenshot'));
                else void desktop?.captureScreenshot?.();
              }}
            >
              📷
            </button>
          )}
          {/* Eagle 式缩略图尺寸：五档预设 + 无极滑块，只在两种缩略视图下可用 */}
          {onColWidth && viewMode !== 'list' && (
            <div className="thumb-size-group">
              <div className="thumb-presets" role="group" aria-label="缩略图预设尺寸">
                {THUMB_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={`thumb-preset${thumbPresetOf(curW)?.key === p.key ? ' on' : ''}`}
                    onClick={() => onColWidth(p.width)}
                    title={`${p.label}：列宽约 ${p.width}px`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                className="thumb-size"
                type="range"
                min={THUMB_MIN}
                max={THUMB_MAX}
                step={1}
                value={curW}
                onChange={(e) => onColWidth(Number(e.target.value))}
                title={`缩略图大小：${curW}px（可无极拖动）`}
                aria-label="缩略图大小"
              />
            </div>
          )}
          <button
            className={`btn sm${viewMode === 'masonry' ? ' primary' : ''}`}
            onClick={() => onViewMode('masonry')}
            title="瀑布流"
          >
            <IconColumns />
          </button>
          <button
            className={`btn sm${viewMode === 'grid' ? ' primary' : ''}`}
            onClick={() => onViewMode('grid')}
            title="网格视图"
          >
            <IconGrid />
          </button>
          <button
            className={`btn sm${viewMode === 'list' ? ' primary' : ''}`}
            onClick={() => onViewMode('list')}
            title="列表视图"
          >
            <IconList />
          </button>
        </div>

        <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>共 {total} 张</span>
      </div>

      <div className="toolbar" style={{ marginTop: -4 }} ref={rootRef}>
        {!hideFavorite && (
          <Drop label="收藏" active={filters.favorite !== 'all'} open={openKey === 'fav'} onToggle={() => toggleDrop('fav')}>
            {(['all', 'yes', 'no'] as const).map((v) => (
              <button
                key={v}
                className={`chip${filters.favorite === v ? ' active' : ''}`}
                onClick={() => onChange({ favorite: v })}
              >
                {v === 'all' ? '全部' : v === 'yes' ? '已收藏' : '未收藏'}
              </button>
            ))}
          </Drop>
        )}

        <Drop
          label="来源"
          active={!!filters.source.length}
          badge={filters.source.length || undefined}
          open={openKey === 'source'}
          onToggle={() => toggleDrop('source')}
        >
          {sources.map((s) => (
            <button
              key={s}
              className={`chip${filters.source.includes(s) ? ' active' : ''}`}
              onClick={() => toggleIn('source', s)}
            >
              {labels[s] || SOURCE_LABELS[s] || s}
            </button>
          ))}
        </Drop>

        <Drop
          label="画幅"
          active={filters.orientation !== 'all'}
          open={openKey === 'orient'}
          onToggle={() => toggleDrop('orient')}
        >
          {(['portrait', 'landscape', 'square'] as const).map((o) => (
            <button
              key={o}
              className={`chip${filters.orientation === o ? ' active' : ''}`}
              onClick={() => onChange({ orientation: filters.orientation === o ? 'all' : o })}
            >
              {ORIENTATION_LABELS[o]}
            </button>
          ))}
        </Drop>

        <Drop
          label="浏览"
          active={(filters.seen || 'all') !== 'all'}
          open={openKey === 'seen'}
          onToggle={() => toggleDrop('seen')}
        >
          {(['all', 'unseen', 'seen'] as const).map((v) => (
            <button
              key={v}
              className={`chip${(filters.seen || 'all') === v ? ' active' : ''}`}
              onClick={() => onChange({ seen: v })}
              title={v === 'unseen' ? '还没在大图预览里看过的图片' : undefined}
            >
              {v === 'all' ? '全部' : v === 'unseen' ? '未看过' : '已看过'}
            </button>
          ))}
          {onMarkAllSeen && filters.seen === 'unseen' && (
            <button className="chip ghost-chip" onClick={onMarkAllSeen} title="把当前筛选结果全部标记为已看">
              全部标记为已看
            </button>
          )}
        </Drop>

        <Drop
          label="星级"
          active={!!filters.minRating}
          open={openKey === 'rating'}
          onToggle={() => toggleDrop('rating')}
        >
          {[0, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`chip${(filters.minRating || 0) === n ? ' active' : ''}`}
              onClick={() => onChange({ minRating: n })}
              title={n === 0 ? '不限星级' : `只看 ${n} 星及以上`}
            >
              {n === 0 ? '不限' : `${'★'.repeat(n)}+`}
            </button>
          ))}
        </Drop>

        <Drop
          label="分辨率"
          active={!!filters.bucket.length}
          badge={filters.bucket.length || undefined}
          open={openKey === 'bucket'}
          onToggle={() => toggleDrop('bucket')}
        >
          {BUCKETS.map((b) => (
            <button
              key={b}
              className={`chip${filters.bucket.includes(b) ? ' active' : ''}`}
              onClick={() => toggleIn('bucket', b)}
            >
              {BUCKET_LABELS[b]}
            </button>
          ))}
        </Drop>

        <Drop
          label="类型"
          active={!!filters.kind && filters.kind !== 'all'}
          open={openKey === 'kind'}
          onToggle={() => toggleDrop('kind')}
        >
          {[{ key: 'all', label: '全部' }, ...KINDS].map((k) => (
            <button
              key={k.key}
              className={`chip${(filters.kind || 'all') === k.key ? ' active' : ''}`}
              onClick={() => onChange({ kind: k.key })}
            >
              {k.label}
            </button>
          ))}
        </Drop>

        <Drop
          label="颜色"
          active={!!filters.colorHex || !!selectedHues.length}
          badge={selectedHues.length || (filters.colorHex ? 1 : undefined)}
          swatch={filters.colorHex || undefined}
          open={openKey === 'color'}
          onToggle={() => toggleDrop('color')}
        >
          <div className="sec-label">色系快筛 · 可多选（黑白灰单独一项）</div>
          <div className="hue-row">
            {HUES.map((h) => (
              <button
                key={h.v}
                type="button"
                className={`hue-chip${selectedHues.includes(h.v) ? ' on' : ''}`}
                style={{ background: h.c }}
                title={`只看${h.t}色系`}
                aria-label={`只看${h.t}色系`}
                onClick={() => toggleHue(h.v)}
              />
            ))}
            <button
              type="button"
              className={`chip hue-gray${selectedHues.includes('gray') ? ' active' : ''}`}
              title="只看黑白灰（无彩度）图片"
              onClick={() => toggleHue('gray')}
            >
              黑白灰
            </button>
          </div>
          <div className="sec-label" style={{ marginTop: 14 }}>
            精确颜色 · 拖动色盘 / 输入色号 / 吸管取色
          </div>
          <div className="cpad-sm">
            <ColorPad
              value={draft.hex}
              onChange={(hex) => {
                interactedRef.current = true;
                setHexText(hex.replace('#', '').toLowerCase());
                setDraft((d) => ({ ...d, hex }));
              }}
            />
          </div>
          {/* 色号输入 + 屏幕吸管（Eagle / 设计工具同款交互；吸管用 Chrome EyeDropper API） */}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <span
              style={{
                padding: '5px 8px',
                border: '1px solid var(--border, rgba(0,0,0,.15))',
                borderRadius: 7,
                fontSize: 12,
                color: 'var(--muted)',
              }}
            >
              #
            </span>
            <input
              className="input"
              value={hexText}
              placeholder="RRGGBB"
              maxLength={6}
              spellCheck={false}
              style={{ width: 86, fontFamily: 'monospace', textTransform: 'uppercase', padding: '5px 8px' }}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
                setHexText(v.toLowerCase());
                if (/^[0-9a-fA-F]{6}$/.test(v)) {
                  interactedRef.current = true;
                  setDraft((d) => ({ ...d, hex: `#${v.toLowerCase()}` }));
                }
              }}
            />
            <button
              className="btn sm"
              disabled={picking || (!desktop && !eyeDropperOk)}
              title="从屏幕任意位置取色：左键取色 · 右键取消"
              onClick={startPick}
            >
              {picking ? '截图中…' : '💧 吸管'}
            </button>
          </div>
          {cap && (
            <div className="hint" style={{ marginTop: 6 }}>
              取色中：<b>左键</b>点击取色 · <b>右键</b>单击或 Esc 取消
            </div>
          )}
          <label className="tol" style={{ marginTop: 10 }}>
            准确度
            <input
              type="range"
              min={0}
              max={160}
              value={160 - draft.tol}
              onChange={(e) => {
                interactedRef.current = true;
                const tol = 160 - Number(e.target.value);
                setDraft((d) => ({ ...d, tol }));
              }}
            />
            <b>{160 - draft.tol}</b>
          </label>
          {(!!filters.colorHex || !!selectedHues.length) && (
            <button className="chip ghost-chip" style={{ marginTop: 10 }} onClick={() => onChange({ colorHex: '', hue: '' })}>
              清除颜色筛选
            </button>
          )}
        </Drop>

        {chips.length > 0 && (
          <button className="chip ghost-chip" style={{ marginLeft: 'auto' }} onClick={resetAll}>
            清空全部筛选
          </button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="active-chips">
          {chips.map((c, i) => (
            <button key={i} className="chip chip-active" onClick={c.clear} title="点击移除该筛选">
              {c.swatch && <span className="chip-swatch" style={{ background: c.swatch }} />}
              {c.label}
              <span className="x">×</span>
            </button>
          ))}
        </div>
      )}

      {/* 截图取色覆盖层：挂到 body，避免祖先的 filter/backdrop-filter 给 fixed 造参照系 */}
      {cap &&
        createPortal(
          <div
            className="screen-picker"
            onClick={(e) => {
              const hex = sampleFromCache(e.clientX, e.clientY);
              if (hex) applyPicked(hex);
              setCap(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCap(null);
            }}
            onMouseMove={(e) => {
              setPickPos({ x: e.clientX, y: e.clientY });
              setLiveHex(sampleFromCache(e.clientX, e.clientY));
            }}
          >
            <img
              src={cap.url}
              alt=""
              draggable={false}
              ref={(el) => {
                if (!el) return;
                const build = () => {
                  if (capPixels.current || !el.naturalWidth) return;
                  const cv = document.createElement('canvas');
                  cv.width = el.naturalWidth;
                  cv.height = el.naturalHeight;
                  const ctx = cv.getContext('2d');
                  if (!ctx) return;
                  ctx.drawImage(el, 0, 0);
                  capPixels.current = {
                    w: el.naturalWidth,
                    h: el.naturalHeight,
                    data: ctx.getImageData(0, 0, el.naturalWidth, el.naturalHeight).data,
                  };
                };
                if (el.complete) build();
                else el.onload = build;
              }}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', userSelect: 'none' }}
            />
            {liveHex && (
              <>
                {/* 放大镜：以鼠标为中心放大 8 倍，带十字准星（设计工具同款） */}
                <div
                  className="pick-loupe"
                  style={{
                    left: pickPos.x + 18,
                    top: pickPos.y + 18,
                    backgroundImage: `url(${cap.url})`,
                    backgroundSize: `${window.innerWidth * 8}px ${window.innerHeight * 8}px`,
                    backgroundPosition: `${-(pickPos.x * 8 - 72)}px ${-(pickPos.y * 8 - 72)}px`,
                  }}
                >
                  <span className="pick-crosshair" />
                  <span className="pick-pixel" style={{ background: liveHex }} />
                </div>
                <div className="pick-chip" style={{ left: pickPos.x + 18, top: pickPos.y + 18 + 150 }}>
                  <span className="pick-swatch" style={{ background: liveHex }} />
                  {liveHex.toUpperCase()}
                  <small>左键取色</small>
                </div>
              </>
            )}
            <div className="pick-tip">左键点击取色 · 右键单击取消 · Esc 取消</div>
          </div>,
          document.body
        )}
    </div>
  );
}
