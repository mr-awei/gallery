import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api, formatDate, formatSize, pickFolder, quiet } from '../api';
import type { VersionInfo } from '../api';
import type { ImageItem } from '../types';
import { IconClose, IconCopy, IconDownload, IconRefresh, IconTrash, IconWand } from './Icons';

/**
 * 素材工具箱：把「检查器 / OCR / 来源 / 版本 / 多区域裁切」收在一个浮层里。
 * 放大图后按需打开，不占常驻界面；每一项都显示真实结果或明确的不可用原因。
 */
export type ToolkitTab = 'info' | 'ocr' | 'source' | 'versions' | 'regions';

interface Props {
  item: ImageItem;
  tab?: ToolkitTab;
  onClose: () => void;
  onToast?: (msg: string) => void;
  /** 换大图 / 恢复版本后回传新数据，父级同步原图与列表 */
  onReplaced?: (item: ImageItem) => void;
}

const TABS: { key: ToolkitTab; label: string; hint: string }[] = [
  { key: 'info', label: '检查器', hint: '尺寸 / 格式 / EXIF' },
  { key: 'ocr', label: '图内文字', hint: 'OCR 后可被搜索并复制' },
  { key: 'source', label: '来源', hint: '以图搜图 / 换大图' },
  { key: 'versions', label: '版本历史', hint: '回到任意一次编辑之前' },
  { key: 'regions', label: '多区域裁切', hint: '一张图切出多份副本' },
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
          <b>素材工具箱</b>
          <span className="tk-title" title={item.title}>
            {item.title}
          </span>
          <button className="icon-btn" onClick={onClose} title="关闭（Esc）">
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
          {active === 'info' && <InfoTab item={item} />}
          {active === 'ocr' && <OcrTab item={item} onToast={onToast} />}
          {active === 'source' && <SourceTab item={item} onToast={onToast} onReplaced={onReplaced} />}
          {active === 'versions' && <VersionsTab item={item} onToast={onToast} onReplaced={onReplaced} />}
          {active === 'regions' && <RegionsTab item={item} onToast={onToast} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* --------------------------------- 检查器 --------------------------------- */

function InfoTab({ item }: { item: ImageItem }) {
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
    ['相机', String(exif.camera || '')],
    ['镜头', String(exif.lens || '')],
    ['拍摄时间', String(exif.takenAt || '')],
    ['光圈', exif.aperture != null ? `f/${exif.aperture}` : ''],
    ['快门', String(exif.exposure || '')],
    ['ISO', exif.iso != null ? String(exif.iso) : ''],
    ['焦距', exif.focalLength != null ? `${exif.focalLength}mm` : ''],
    ['软件', String(exif.software || '')],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <div className="tk-info">
      <div className="tk-kv">
        <span>尺寸</span>
        <b>
          {data?.width || item.width} × {data?.height || item.height}
        </b>
        <span>格式</span>
        <b>{(data?.format || '未知').toUpperCase()}</b>
        <span>体积</span>
        <b>{formatSize(item.sizeBytes)}</b>
        <span>色彩空间</span>
        <b>{data?.space || '—'}</b>
        <span>DPI</span>
        <b>{data?.density ? String(data.density) : '—'}</b>
        <span>透明通道</span>
        <b>{data?.hasAlpha ? '有' : '无'}</b>
        <span>入库时间</span>
        <b>{formatDate(item.createdAt)}</b>
        <span>原文件</span>
        <b className="tk-path" title={item.path}>
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
        !err && <div className="tk-empty">这张素材没有 EXIF 信息（截图、网络图片和导出图通常不带）。</div>
      )}
      {data?.error && <div className="tk-warn">{data.error}</div>}
    </div>
  );
}

/* ---------------------------------- OCR ---------------------------------- */

function OcrTab({ item, onToast }: { item: ImageItem; onToast?: (m: string) => void }) {
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
      setMsg(r.text.trim() ? `识别到 ${r.text.length} 字，已进入搜索索引` : '这张图里没有识别到文字');
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
          <IconWand /> {busy ? '识别中…' : text ? '重新识别' : '识别文字'}
        </button>
        {text && (
          <>
            <button
              className="btn sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  onToast?.('文字已复制到剪贴板');
                } catch {
                  onToast?.('复制失败，请手动选中复制');
                }
              }}
            >
              <IconCopy /> 复制文字
            </button>
            <button
              className="btn sm ghost danger"
              onClick={async () => {
                try {
                  await api.ocrClear(item.id);
                  setText('');
                  setMeta(null);
                  setMsg('已删除识别结果（搜索将不再命中这张图）');
                } catch (err) {
                  setMsg((err as Error).message);
                }
              }}
            >
              <IconTrash /> 清除
            </button>
          </>
        )}
      </div>
      {msg && <div className="tk-hint">{msg}</div>}
      {text ? (
        <textarea className="tk-textarea" value={text} readOnly spellCheck={false} />
      ) : (
        <div className="tk-empty">
          识别结果会存进图库，关键词搜索能直接搜到图里的文字；识别在本机离线完成，不上传图片。
        </div>
      )}
      {meta?.createdAt && (
        <div className="tk-hint">
          识别于 {formatDate(meta.createdAt)}
          {meta.engine ? ` · 引擎 ${meta.engine}` : ''}
          {meta.chars ? ` · ${meta.chars} 字` : ''}
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
  onToast?: (m: string) => void;
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
        setNote(r.note || '已在浏览器打开搜图结果');
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
      onToast?.(`已换成 ${r.after.width}×${r.after.height} 的大图（原 ${r.before.width}×${r.before.height}）`);
      setUp(null);
    } catch (err) {
      setUpErr((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="tk-source">
      <h4 className="section-title">以图搜图</h4>
      <div className="tk-providers">
        {(providers?.providers || []).map((p) => (
          <div className={`tk-provider${p.ready ? '' : ' off'}`} key={p.id}>
            <div>
              <b>{p.name}</b>
              <div className="tk-hint">{p.ready ? p.desc : p.reason}</div>
            </div>
            <button className="btn sm" disabled={!p.ready || !!busy} onClick={() => run(p.id)}>
              {busy === p.id ? '处理中…' : p.kind === 'upload' ? '上传检索' : '打开'}
            </button>
          </div>
        ))}
        {!providers && !note && <div className="tk-hint">正在读取可用渠道…</div>}
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
              {r.thumb ? <img src={r.thumb} alt="" loading="lazy" /> : <span className="tk-noimg">无缩略图</span>}
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
        一键换大图
      </h4>
      <div className="tk-hint" style={{ marginBottom: 8 }}>
        用采到的原始地址重新下载一张更大的存回原文件（会先留撤销备份，可还原）。
      </div>
      <div className="tk-row">
        <button className="btn sm" disabled={!!busy} onClick={checkUpgrade}>
          <IconRefresh /> {busy === 'upgrade' ? '探测中…' : '检测有没有更大版本'}
        </button>
        {up?.found && (
          <button className="btn sm primary" disabled={!!busy} onClick={doUpgrade}>
            {busy === 'replace' ? '替换中…' : '替换为大图'}
          </button>
        )}
      </div>
      {up && (
        <div className="tk-hint">
          {up.found
            ? `可替换：${up.before.width}×${up.before.height} → ${up.after?.width}×${up.after?.height}`
            : `没有找到更大的版本（原图 ${up.before.width}×${up.before.height}）`}
          {!up.found && up.tried.length > 0 && ` · 试过 ${up.tried.length} 个地址`}
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
  onToast?: (m: string) => void;
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
      onToast?.('已恢复到该版本（当前版本也已备份，可再撤销）');
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
        每做一次编辑（裁切 / 旋转 / 调色 / 增强 / 换大图）都会先备份原图，这里可以把任意一版换回来。
      </div>
      {data && (
        <>
          <div className="tk-vcurrent">
            <img src={item.thumbUrl} alt="" />
            <div>
              <b>当前版本</b>
              <div className="tk-hint">
                {data.current.width}×{data.current.height} · {data.current.sizeLabel}
              </div>
            </div>
            <span className="tk-badge">在用</span>
          </div>
          {data.versions.length === 0 && <div className="tk-empty">这张素材还没有编辑历史。</div>}
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
                  <span className="tk-warn">备份文件已丢失</span>
                ) : (
                  <button
                    className="btn sm"
                    disabled={busy > 0}
                    onClick={() => restore(v.id)}
                    title="把原图换回这一版；当前版本同样会被备份"
                  >
                    {busy === v.id ? '恢复中…' : '恢复此版本'}
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

function RegionsTab({ item, onToast }: { item: ImageItem; onToast?: (m: string) => void }) {
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
    else if (d) setMsg('框太小了，拖大一点再放开');
  };

  const pick = async () => {
    const p = await pickFolder();
    if (p) setDir(p);
  };

  const save = async () => {
    if (!rects.length) return;
    if (!dir) {
      setMsg('请先选择保存位置');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await api.cropRegions(item.id, rects, { targetDir: dir, addToLibrary: addToLib });
      const ok = r.results.filter((x) => x.ok).length;
      setMsg(`已保存 ${ok} / ${r.count} 个区域`);
      onToast?.(`已从这张图切出 ${ok} 份`);
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
        <div className="tk-hint">在图上拖出多个框，一次全部另存为副本（原图不动）。</div>
        <div className="tk-hint">已框 {rects.length} 个</div>
        <button className="btn sm" onClick={pick}>
          {dir ? '更换保存位置' : '选择保存位置'}
        </button>
        <label className="tk-check">
          <input type="checkbox" checked={addToLib} onChange={(e) => setAddToLib(e.target.checked)} />
          同时入库
        </label>
        <div className="tk-regions-actions">
          <button className="btn sm ghost" disabled={!rects.length} onClick={() => setRects([])}>
            清空
          </button>
          <button className="btn sm primary" disabled={busy || !rects.length} onClick={save}>
            <IconDownload /> {busy ? '保存中…' : '保存全部'}
          </button>
        </div>
        {dir && (
          <div className="tk-hint tk-path" title={dir}>
            {dir}
          </div>
        )}
        {msg && <div className="tk-hint">{msg}</div>}
      </div>
    </div>
  );
}
