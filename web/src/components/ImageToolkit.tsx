import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api, copyText, formatDate, formatSize, openFolder, pickFolder, quiet, revealFile } from '../api';
import type { VersionInfo } from '../api';
import type { ImageItem } from '../types';
import { IconClose, IconCopy, IconDownload, IconRefresh, IconTrash, IconWand } from './Icons';
import InpaintTab from './InpaintTab';
import i18n from '../i18n';

/**
 * 素材工具箱：把「检查器 / OCR / 来源 / 版本 / 多区域裁切」收在一个浮层里。
 * 放大图后按需打开，不占常驻界面；每一项都显示真实结果或明确的不可用原因。
 */
export type ToolkitTab = 'info' | 'ocr' | 'source' | 'versions' | 'regions' | 'inpaint';

interface Props {
  item: ImageItem;
  tab?: ToolkitTab;
  onClose: () => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
  /** 换大图 / 恢复版本后回传新数据，父级同步原图与列表 */
  onReplaced?: (item: ImageItem) => void;
}

const TABS: { key: ToolkitTab; label: string; hint: string }[] = [
  { key: 'info', label: i18n.t('k9478f662'), hint: i18n.t('kbb331a9a') },
  { key: 'ocr', label: i18n.t('k08dc029e'), hint: i18n.t('k0da211d8') },
  { key: 'source', label: i18n.t('k26ca20b1'), hint: i18n.t('k54276f58') },
  { key: 'versions', label: i18n.t('k6fdd8590'), hint: i18n.t('k1254ee27') },
  { key: 'regions', label: i18n.t('k3d38e999'), hint: i18n.t('k2dd70064') },
  { key: 'inpaint', label: i18n.t('kd971fed4'), hint: i18n.t('kac62cace') },
];

export default function ImageToolkit({ item, tab = 'info', onClose, onToast, onReplaced }: Props) {
  const [active, setActive] = useState<ToolkitTab>(tab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 传送到 body：这个浮层可能开在大图预览里，而 .lightbox 会把 --text/--muted 拨成
  // 深色浮层用的浅色值——留在里面就会出现「白卡片 + 白字」（亮色主题下几乎看不见）
  return createPortal(
    <div className="modal-backdrop tk-backdrop" onClick={onClose}>
      <div className="modal-card tk-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{i18n.t('k616c5a20')}</b>
          <span className="tk-title" title={item.title}>
            {item.title}
          </span>
          <button className="icon-btn" onClick={onClose} title={i18n.t('k01aadfea')}>
            <IconClose />
          </button>
        </div>
        <div className="tk-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tk-tab${active === t.key ? ' on' : ''}`}
              title={t.hint}
              onClick={() => setActive(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="modal-body tk-body">
          {active === 'info' && <InfoTab item={item} onToast={onToast} />}
          {active === 'ocr' && <OcrTab item={item} onToast={onToast} />}
          {active === 'source' && <SourceTab item={item} onToast={onToast} onReplaced={onReplaced} />}
          {active === 'versions' && <VersionsTab item={item} onToast={onToast} onReplaced={onReplaced} />}
          {active === 'regions' && <RegionsTab item={item} onToast={onToast} />}
          {active === 'inpaint' && <InpaintTab item={item} onToast={onToast} onReplaced={onReplaced} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* --------------------------------- 检查器 --------------------------------- */

function InfoTab({ item, onToast }: { item: ImageItem; onToast?: (msg: string, kind?: 'info' | 'error') => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.exif>> | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .exif(item.id)
      .then((r) => alive && setData(r))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [item.id]);

  const exif = data?.exif || {};
  const rows: [string, string][] = [
    [i18n.t('k5c980c4f'), String(exif.camera || '')],
    [i18n.t('k45cf25c9'), String(exif.lens || '')],
    [i18n.t('ke7d65b46'), String(exif.takenAt || '')],
    [i18n.t('kb7104277'), exif.aperture != null ? `f/${exif.aperture}` : ''],
    [i18n.t('kc57dfe98'), String(exif.exposure || '')],
    ['ISO', exif.iso != null ? String(exif.iso) : ''],
    [i18n.t('k2391c262'), exif.focalLength != null ? `${exif.focalLength}mm` : ''],
    [i18n.t('kf0dfc65b'), String(exif.software || '')],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <div className="tk-info">
      <div className="tk-kv">
        <span>{i18n.t('kc8339fd2')}</span>
        <b>
          {data?.width || item.width} × {data?.height || item.height}
        </b>
        <span>{i18n.t('ke3127cc1')}</span>
        <b>{(data?.format || i18n.t('k1622dc9b')).toUpperCase()}</b>
        <span>{i18n.t('k972d5f82')}</span>
        <b>{formatSize(item.sizeBytes)}</b>
        <span>{i18n.t('k8f5d2fd3')}</span>
        <b>{data?.space || '—'}</b>
        <span>DPI</span>
        <b>{data?.density ? String(data.density) : '—'}</b>
        <span>{i18n.t('kd0bc689f')}</span>
        <b>{data?.hasAlpha ? i18n.t('kcc4ad2fd') : i18n.t('kd81bb206')}</b>
        <span>{i18n.t('k5e2aaf4f')}</span>
        <b>{formatDate(item.createdAt)}</b>
        <span>{i18n.t('kdbc87e61')}</span>
        {/* 检查器里显示的本来就是磁盘路径，点它定位比再去右键菜单找一遍省事 */}
        <b
          className="tk-path is-clickable"
          title={i18n.t('k6d89daf9', { p0: item.path })}
          onClick={() =>
            revealFile(item.path).catch((err: Error) => onToast?.(i18n.t('k22c7225f', { p0: err.message }), 'error'))
          }
        >
          {item.path}
        </b>
      </div>
      {err && <div className="tk-warn">{err}</div>}
      {rows.length ? (
        <table className="tk-exif">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        !err && <div className="tk-empty">{i18n.t('k53cc79f5')}</div>
      )}
      {data?.error && <div className="tk-warn">{data.error}</div>}
    </div>
  );
}

/* ---------------------------------- OCR ---------------------------------- */

function OcrTab({ item, onToast }: { item: ImageItem; onToast?: (m: string, kind?: 'info' | 'error') => void }) {
  const [status, setStatus] = useState<{ available: boolean; note: string } | null>(null);
  const [text, setText] = useState('');
  const [meta, setMeta] = useState<{ engine?: string; createdAt?: string; chars?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    api.ocrStatus().then((s) => alive && setStatus(s)).catch(quiet);
    api
      .ocrGet(item.id)
      .then((r) => {
        if (!alive) return;
        setText(r.text);
        setMeta({ engine: r.engine, createdAt: r.createdAt, chars: r.text.length });
      })
      .catch(quiet);
    return () => {
      alive = false;
    };
  }, [item.id]);

  const run = async (force: boolean) => {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.ocrRun(item.id, force);
      setText(r.text);
      setMeta({ engine: r.engine, createdAt: new Date().toISOString(), chars: r.text.length });
      setMsg(r.text.trim() ? i18n.t('k1601f484', { p0: r.text.length }) : i18n.t('k3fda9e80'));
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (status && !status.available) return <div className="tk-empty">{status.note}</div>;

  return (
    <div className="tk-ocr">
      <div className="tk-row">
        <button className="btn sm primary" disabled={busy} onClick={() => run(!!text)}>
          <IconWand /> {busy ? i18n.t('k5f021cab') : text ? i18n.t('k2a3dd292') : i18n.t('kb4a9ace8')}
        </button>
        {text && (
          <>
            <button
              className="btn sm"
              onClick={async () => {
                const ok = await copyText(text);
                onToast?.(ok ? i18n.t('k34368424') : i18n.t('k3987c43b'), ok ? 'info' : 'error');
              }}
            >
              <IconCopy /> {i18n.t('kd640f875')}
            </button>
            <button
              className="btn sm ghost danger"
              onClick={async () => {
                try {
                  await api.ocrClear(item.id);
                  setText('');
                  setMeta(null);
                  setMsg(i18n.t('k2fd45925'));
                } catch (err) {
                  setMsg((err as Error).message);
                }
              }}
            >
              <IconTrash /> {i18n.t('k4403fca0')}
            </button>
          </>
        )}
      </div>
      {msg && <div className="tk-hint">{msg}</div>}
      {text ? (
        <textarea className="tk-textarea" value={text} readOnly spellCheck={false} />
      ) : (
        <div className="tk-empty">
          {i18n.t('ka54b7df2')}
        </div>
      )}
      {meta?.createdAt && (
        <div className="tk-hint">
          识别于 {formatDate(meta.createdAt)}
          {meta.engine ? i18n.t('kcf66b62a', { p0: meta.engine }) : ''}
          {meta.chars ? i18n.t('k1649dbd1', { p0: meta.chars }) : ''}
        </div>
      )}
    </div>
  );
}

/* --------------------------------- 来源 --------------------------------- */

function SourceTab({
  item,
  onToast,
  onReplaced,
}: {
  item: ImageItem;
  onToast?: (m: string, kind?: 'info' | 'error') => void;
  onReplaced?: (it: ImageItem) => void;
}) {
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof api.searchProviders>> | null>(null);
  const [busy, setBusy] = useState('');
  const [results, setResults] = useState<
    { similarity: number; title: string; detail: string; thumb: string; link: string }[]
  >([]);
  const [note, setNote] = useState('');
  const [up, setUp] = useState<Awaited<ReturnType<typeof api.upgradePreview>> | null>(null);
  const [upErr, setUpErr] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .searchProviders(item.id)
      .then((r) => alive && setProviders(r))
      .catch((e) => alive && setNote((e as Error).message));
    return () => {
      alive = false;
    };
  }, [item.id]);

  const run = async (engine: string) => {
    setBusy(engine);
    setResults([]);
    setNote('');
    try {
      const r = await api.reverseSearch(item.id, engine);
      if (r.url) {
        window.open(r.url, '_blank', 'noopener');
        setNote(r.note || i18n.t('k1a50fee7'));
      } else {
        setResults(r.results || []);
        setNote(r.note || '');
      }
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const checkUpgrade = async () => {
    setUpErr('');
    setBusy('upgrade');
    try {
      setUp(await api.upgradePreview(item.id));
    } catch (err) {
      setUpErr((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const doUpgrade = async () => {
    if (!up?.found) return;
    setBusy('replace');
    try {
      const r = await api.upgradeSource(item.id);
      onReplaced?.(r.item);
      onToast?.(i18n.t('kdf78ff5f', { p0: r.after.width, p1: r.after.height, p2: r.before.width, p3: r.before.height }));
      setUp(null);
    } catch (err) {
      setUpErr((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="tk-source">
      <h4 className="section-title">{i18n.t('kc30d6c94')}</h4>
      <div className="tk-providers">
        {(providers?.providers || []).map((p) => (
          <div className={`tk-provider${p.ready ? '' : ' off'}`} key={p.id}>
            <div>
              <b>{p.name}</b>
              <div className="tk-hint">{p.ready ? p.desc : p.reason}</div>
            </div>
            <button className="btn sm" disabled={!p.ready || !!busy} onClick={() => run(p.id)}>
              {busy === p.id ? i18n.t('kcf978c02') : p.kind === 'upload' ? i18n.t('k01fcc2de') : i18n.t('kd7098f50')}
            </button>
          </div>
        ))}
        {!providers && !note && <div className="tk-hint">{i18n.t('kcebe7f81')}</div>}
      </div>
      {note && <div className="tk-hint">{note}</div>}
      {results.length > 0 && (
        <div className="tk-results">
          {results.map((r, i) => (
            <a
              key={`${r.link}-${i}`}
              className="tk-result"
              href={r.link || undefined}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => {
                if (!r.link) e.preventDefault();
              }}
            >
              {r.thumb ? <img src={r.thumb} alt="" loading="lazy" /> : <span className="tk-noimg">{i18n.t('k09483fca')}</span>}
              <div>
                <b>{r.title}</b>
                <div className="tk-hint">
                  相似度 {r.similarity.toFixed(1)}%{r.detail ? ` · ${r.detail}` : ''}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}

      <h4 className="section-title" style={{ marginTop: 18 }}>
        {i18n.t('k88655e7e')}
      </h4>
      <div className="tk-hint" style={{ marginBottom: 8 }}>
        {i18n.t('k3d1287d7')}
      </div>
      <div className="tk-row">
        <button className="btn sm" disabled={!!busy} onClick={checkUpgrade}>
          <IconRefresh /> {busy === 'upgrade' ? i18n.t('k396c315c') : i18n.t('ka57934f4')}
        </button>
        {up?.found && (
          <button className="btn sm primary" disabled={!!busy} onClick={doUpgrade}>
            {busy === 'replace' ? i18n.t('k1b5e17ec') : i18n.t('k95b6a7df')}
          </button>
        )}
      </div>
      {up && (
        <div className="tk-hint">
          {up.found
            ? i18n.t('k2c1c049e', { p0: up.before.width, p1: up.before.height, p2: up.after?.width, p3: up.after?.height })
            : i18n.t('k4dfb3bed', { p0: up.before.width, p1: up.before.height })}
          {!up.found && up.tried.length > 0 && i18n.t('ka609d215', { p0: up.tried.length })}
        </div>
      )}
      {upErr && <div className="tk-warn">{upErr}</div>}
    </div>
  );
}

/* -------------------------------- 版本历史 -------------------------------- */

function VersionsTab({
  item,
  onToast,
  onReplaced,
}: {
  item: ImageItem;
  onToast?: (m: string, kind?: 'info' | 'error') => void;
  onReplaced?: (it: ImageItem) => void;
}) {
  const [data, setData] = useState<{
    current: VersionInfo;
    versions: (VersionInfo & { id: number; label: string })[];
  } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(0);

  const load = useCallback(() => {
    api
      .versions(item.id)
      .then((r) => setData({ current: r.current, versions: r.versions }))
      .catch((e) => setErr((e as Error).message));
  }, [item.id]);

  useEffect(load, [load]);

  const restore = async (vid: number) => {
    setBusy(vid);
    try {
      const r = await api.restoreVersion(item.id, vid);
      onReplaced?.(r.item);
      onToast?.(i18n.t('k7bf996c8'));
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(0);
    }
  };

  if (err && !data) return <div className="tk-warn">{err}</div>;

  return (
    <div className="tk-versions">
      <div className="tk-hint" style={{ marginBottom: 10 }}>
        {i18n.t('k02b63cb4')}
      </div>
      {data && (
        <>
          <div className="tk-vcurrent">
            <img src={item.thumbUrl} alt="" />
            <div>
              <b>{i18n.t('k9b601b8e')}</b>
              <div className="tk-hint">
                {data.current.width}×{data.current.height} · {data.current.sizeLabel}
              </div>
            </div>
            <span className="tk-badge">{i18n.t('k60136ec9')}</span>
          </div>
          {data.versions.length === 0 && <div className="tk-empty">{i18n.t('k956aae64')}</div>}
          <div className="tk-vlist">
            {data.versions.map((v) => (
              <div className="tk-vitem" key={v.id}>
                <img src={`/api/images/${item.id}/versions/${v.id}/preview`} alt="" loading="lazy" />
                <div className="tk-vmeta">
                  <b>{v.label}</b>
                  <div className="tk-hint">
                    {v.width}×{v.height} · {v.sizeLabel}
                    {v.createdAt ? ` · ${formatDate(v.createdAt)}` : ''}
                  </div>
                </div>
                {v.missing ? (
                  <span className="tk-warn">{i18n.t('kc6cdf4d8')}</span>
                ) : (
                  <button
                    className="btn sm"
                    disabled={busy > 0}
                    onClick={() => restore(v.id)}
                    title={i18n.t('k38a1d65e')}
                  >
                    {busy === v.id ? i18n.t('kabc10332') : i18n.t('ka4927087')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {err && <div className="tk-warn">{err}</div>}
    </div>
  );
}

/* ------------------------------- 多区域裁切 ------------------------------- */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function RegionsTab({ item, onToast }: { item: ImageItem; onToast?: (m: string, kind?: 'info' | 'error') => void }) {
  const [rects, setRects] = useState<Rect[]>([]);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [dir, setDir] = useState('');
  const [addToLib, setAddToLib] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  /** 画布按图片真实比例撑开，否则框会画在留白上，切出来的区域和看到的对不上 */
  const [ratio, setRatio] = useState(item.width && item.height ? item.width / item.height : 0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const point = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = point(e);
    startRef.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = startRef.current;
    if (!s) return;
    const p = point(e);
    setDraft({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  };
  const onUp = () => {
    const d = draft;
    startRef.current = null;
    setDraft(null);
    if (d && d.w > 0.02 && d.h > 0.02) setRects((prev) => [...prev, d].slice(0, 24));
    else if (d) setMsg(i18n.t('kfe467db5'));
  };

  const pick = async () => {
    const p = await pickFolder();
    if (p) setDir(p);
  };

  const save = async () => {
    if (!rects.length) return;
    if (!dir) {
      setMsg(i18n.t('kf3394ecf'));
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await api.cropRegions(item.id, rects, { targetDir: dir, addToLibrary: addToLib });
      const ok = r.results.filter((x) => x.ok).length;
      setMsg(i18n.t('k573d0ee2', { p0: ok, p1: r.count }));
      onToast?.(i18n.t('k0cf25e41', { p0: ok }));
      if (ok) setRects([]);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const boxes = useMemo(
    () =>
      rects.map((r) => ({
        ...r,
        style: { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` },
      })),
    [rects]
  );

  return (
    <div className="tk-regions">
      <div className="tk-regions-canvas">
        <div className="tk-cropbox" style={{ ['--r' as string]: String(ratio || 1) } as CSSProperties}>
          {/* 框画在「和图片一样大」的内层上：外层只是舞台，直接按外层算坐标
              会把留白也算进图片，切出来的区域和看到的框对不上 */}
          <div
            className="tk-cropframe"
            ref={boxRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
          {/* 画布用预览图：原图动辄 20MB，等它解码完才能拖框，体验像卡死 */}
          <img
            src={item.previewUrl || item.url}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const im = e.currentTarget;
              if (im.naturalWidth && im.naturalHeight) setRatio(im.naturalWidth / im.naturalHeight);
            }}
          />
            {boxes.map((r, i) => (
              <div className="tk-rect" key={i} style={r.style}>
                <span>{i + 1}</span>
              </div>
            ))}
            {draft && (
              <div
                className="tk-rect draft"
                style={{
                  left: `${draft.x * 100}%`,
                  top: `${draft.y * 100}%`,
                  width: `${draft.w * 100}%`,
                  height: `${draft.h * 100}%`,
                }}
              />
            )}
          </div>
        </div>
      </div>
      <div className="tk-regions-side">
        <div className="tk-hint">{i18n.t('k434975d9')}</div>
        <div className="tk-hint">已框 {rects.length} 个</div>
        <button className="btn sm" onClick={pick}>
          {dir ? i18n.t('kb08d287e') : i18n.t('kb08bb8a4')}
        </button>
        <label className="tk-check">
          <input type="checkbox" checked={addToLib} onChange={(e) => setAddToLib(e.target.checked)} />
          {i18n.t('k1bf32aea')}
        </label>
        <div className="tk-regions-actions">
          <button className="btn sm ghost" disabled={!rects.length} onClick={() => setRects([])}>
            {i18n.t('k288f0c40')}
          </button>
          <button className="btn sm primary" disabled={busy || !rects.length} onClick={save}>
            <IconDownload /> {busy ? i18n.t('k9b5d32d1') : i18n.t('kaac9e35b')}
          </button>
        </div>
        {dir && (
          <button
            type="button"
            className="tk-hint tk-path tk-path-btn"
            title={i18n.t('k93e7a536', { p0: dir })}
            onClick={() =>
              openFolder(dir).catch((e: Error) => onToast?.(i18n.t('k811885fb', { p0: e.message }), 'error'))
            }
          >
            {dir}
          </button>
        )}
        {msg && <div className="tk-hint">{msg}</div>}
      </div>
    </div>
  );
}
