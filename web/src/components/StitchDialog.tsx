import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { api, downloadFile, formatSize } from '../api';
import type { StitchCrop, StitchPlan, StitchTemplate } from '../api';
import type { ImageItem } from '../types';
import { IconClose, IconDownload } from './Icons';
import { applyOrder, normalizeOrder, swapAt } from '../lib/stitchOrder';
import StitchCropEditor from './StitchCropEditor';
import i18n from '../i18n';

interface Props {
  items: ImageItem[];
  onClose: () => void;
  onToast?: (m: string, kind?: 'info' | 'error') => void;
}

const flowFallback = () => [
  { id: 'auto', name: i18n.t('k362ee5ad'), hint: i18n.t('k759c3e1d') },
  { id: 'mosaic', name: i18n.t('k4f8f6438'), hint: i18n.t('k7cd27cfd') },
  { id: 'justified', name: i18n.t('k662e8baa'), hint: i18n.t('k9665ec70') },
  { id: 'grid', name: i18n.t('ka9fa785e'), hint: i18n.t('k2d0a30a0') },
];

const RATIO_OPTIONS = ['auto', '1:1', '4:5', '3:4', '16:9', '9:16'];

/** 标题常用色：白 / 黑 / 米金 / 红，外加取色器自选 */
const TEXT_COLORS = ['#ffffff', '#000000', '#f0d9a8', '#e0362c'];

const centerCrop = (z = 1): StitchCrop => ({ fx: 0.5, fy: 0.5, z });

/**
 * 把服务端返回的格子按 idx 归位成前端数组。
 * plan.boxes 的顺序是几何算法切出来的（满版拼贴是递归二分），
 * 直接按数组下标用会把第 3 张图画到第 5 格上。
 */
function alignPlan(plan: StitchPlan | null, n: number) {
  if (!plan || plan.boxes.length !== n) return null;
  const boxes: number[][] = Array.from({ length: n }, () => [0, 0, 1, 1]);
  const zMin: number[] = Array.from({ length: n }, () => 1);
  for (let i = 0; i < plan.boxes.length; i++) {
    const b = plan.boxes[i];
    if (!(b.idx >= 0 && b.idx < n)) return null;
    boxes[b.idx] = [b.x, b.y, b.w, b.h];
    zMin[b.idx] = plan.zMin[i] ?? 1;
  }
  return { boxes, zMin, ratio: plan.ratio > 0 ? plan.ratio : 1 };
}

/**
 * 拼图 / 版面。
 *
 * 两条路线：
 *  1) 模板（服务端 lib/stitch-templates.js）：构图是人先定好的——主视觉占多少、
 *     留白在哪、片名压哪一条。用户只要挑一个，再逐格调「这张图露哪块」。
 *  2) 算法版式：张数对不上任何模板时兜底（满版 / 整齐行 / 联系表），同样逐格可调。
 *
 * 两种路线的格子都从 /api/export/stitch/plan 取（服务端算几何），左侧大图就是构图台：
 * 静止时铺服务端成品（文字、底色都在上面），一上手就切回实时画面。
 * 预览与下载走同一个接口，看到的就是导出的。
 */
export default function StitchDialog({ items, onClose, onToast }: Props) {
  const [tplList, setTplList] = useState<StitchTemplate[] | null>(null);
  const [flowList, setFlowList] = useState(() => flowFallback());
  const [tplErr, setTplErr] = useState('');
  const [tplTry, setTplTry] = useState(0);
  const [tplId, setTplId] = useState('');
  const [crops, setCrops] = useState<StitchCrop[]>(() => items.map(() => centerCrop()));
  const [autoBusy, setAutoBusy] = useState(false);

  const [layout, setLayout] = useState('auto');
  const [ratio, setRatio] = useState('auto');
  const [outWidth, setOutWidth] = useState(2400);
  const [columns, setColumns] = useState(Math.min(3, Math.max(1, items.length)));
  const [gap, setGap] = useState(0); // 0 = 自动（模板按画布短边、算法版式 12px）
  const [cell, setCell] = useState(0);
  const [format, setFormat] = useState('jpeg');
  // 成品默认最高画质：拼图是发出去的东西，为省几百 KB 让它发虚不值
  const [quality, setQuality] = useState(100);

  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [billing, setBilling] = useState('');
  const [fileName, setFileName] = useState('');
  // 海报文字样式：本机字体 key（sys:家族名）/ 标题字号倍率 / 标题颜色
  const [font, setFont] = useState('');
  const [titleScale, setTitleScale] = useState(1);
  const [titleColor, setTitleColor] = useState('');
  const [fonts, setFonts] = useState<{ key: string; name: string; group: string }[]>([]);
  const [fontErr, setFontErr] = useState('');

  // 版面坐标（每格归一化位置 + 缩放下限），模板与算法版式都走它
  const [plan, setPlan] = useState<StitchPlan | null>(null);
  const [planErr, setPlanErr] = useState('');
  // 上一次重排构图用的「模板|版式|张数」，一样就不再动用户调好的每格
  const resetKey = useRef('');
  // 下载按钮的重入保护：连点两下会建两个下载项，叠出两个「另存为」框
  const saveRef = useRef(0);

  // 装饰项留空 = 跟模板默认值；用户动过才覆盖，切模板时清回去
  const [radiusOv, setRadiusOv] = useState<number | null>(null);
  const [shadowOv, setShadowOv] = useState<number | null>(null);
  const [borderOv, setBorderOv] = useState<boolean | null>(null);
  const [backdropOv, setBackdropOv] = useState<boolean | null>(null);
  const [bgOv, setBgOv] = useState('');
  const [seamlessOv, setSeamlessOv] = useState<boolean | null>(null);

  const [size, setSize] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);

  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const idsKey = ids.join(',');
  // 「哪张图放哪一格」：order[槽位] = 选图下标。以前顺序是写死的（第 i 张进第 i 格），
  // 想让竖构图占左大图只能重选素材；现在随时能换位，换布局也不丢
  const [order, setOrder] = useState<number[]>(() => items.map((_, i) => i));
  // 重新选了一批素材（ids 变了）就回到顺序摆放，别把上一批的对应关系带过来
  useEffect(() => {
    setOrder((prev) => {
      const next = normalizeOrder([], items.length);
      return prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next;
    });
  }, [idsKey, items.length]);
  /** 按当前顺序拍好的素材：槽位 i 就是 orderedItems[i] */
  const orderedItems = useMemo(() => applyOrder(items, order), [items, order]);
  const orderedIds = useMemo(() => orderedItems.map((i) => i.id), [orderedItems]);
  const tpl = useMemo(() => tplList?.find((t) => t.id === tplId) || null, [tplList, tplId]);
  const availTemplates = useMemo(
    () => (tplList || []).filter((t) => items.length >= t.min && items.length <= t.max),
    [tplList, items.length]
  );

  const radius = radiusOv ?? tpl?.radius ?? 0;
  const shadow = shadowOv ?? tpl?.shadow ?? 0;
  const border = borderOv ?? Boolean(tpl?.border);
  const backdrop = backdropOv ?? Boolean(tpl?.backdrop);
  const bg = bgOv || tpl?.bg || (tpl?.band ? '#000000' : '#ffffff');
  // 无缝是可选项：开了就压掉一切装饰，模板自带无缝的（长图/三联画）默认开
  const seamless = seamlessOv ?? (tpl ? Boolean(tpl.seamless) : layout === 'seamless' || layout === 'stack');
  const gapParam = seamless ? 0 : gap > 0 ? gap : undefined;

  const cropsParam = useMemo(
    () => crops.map((c) => `${c.fx.toFixed(3)},${c.fy.toFixed(3)},${c.z.toFixed(2)}`).join(';'),
    [crops]
  );

  // 版面坐标：格子在哪、最小能缩到多少，全由服务端算（这里只算几何不读图，很轻）。
  // 参数一变就重取，拖间距/列数也不会卡
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api
        .stitchPlan(orderedIds, {
          template: tplId || undefined,
          layout: tplId ? undefined : layout,
          ratio: tplId ? undefined : ratio,
          outWidth,
          columns: !tplId && layout === 'grid' ? columns : undefined,
          cell: !tplId && layout === 'grid' ? cell || undefined : undefined,
          gap: gapParam,
          seamless: seamless || undefined,
        })
        .then((r) => {
          if (!alive) return;
          setPlan(r);
          setPlanErr('');
          // 换模板 / 换版式才重排构图；只改间距、列数不动用户已经调好的每格
          const rk = `${tplId}|${layout}|${items.length}`;
          const aligned = alignPlan(r, items.length);
          if (aligned && resetKey.current !== rk) {
            resetKey.current = rk;
            // 联系表的格子是等大的，z=1 会把图裁掉一截；默认给「整图刚好装进格子」（zMin），
            // 想铺满往里推就是了
            const contain = !tplId && layout === 'grid';
            setCrops(aligned.boxes.map((_, i) => centerCrop(contain ? aligned.zMin[i] : 1)));
          }
        })
        .catch((e: any) => {
          if (!alive) return;
          // 拿不到坐标就退回整图预览（不挡住出图），但要说明白为什么不能逐格调
          setPlan(null);
          setPlanErr(e?.message || i18n.t('k9902e055'));
        });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [orderedIds, tplId, layout, ratio, outWidth, columns, cell, gapParam, seamless, items.length]);

  /** 构图台的格子：按 idx 归位后的坐标 + 缩放下限（缺一格就不画，免得框和图错位） */
  const cells = useMemo(() => alignPlan(plan, items.length), [plan, items.length]);

  // 本机字体清单：走水印那套扫描（服务端有 60 秒缓存），失败就只保留默认字体
  useEffect(() => {
    let alive = true;
    api
      .stitchFonts()
      .then((r) => {
        if (alive) setFonts(r.fonts || []);
      })
      .catch((e: any) => {
        if (alive) setFontErr(e?.message || i18n.t('kbfd59028'));
      });
    return () => {
      alive = false;
    };
  }, []);

  const url = useMemo(
    () =>
      api.stitchUrl(orderedIds, {
        template: tplId || undefined,
        // 两种版式都带上 crops：算法版式也要能逐格调（不带就是服务端的默认铺法）
        crops: cropsParam,
        layout: tplId ? undefined : layout,
        ratio: tplId ? undefined : ratio,
        outWidth,
        columns: !tplId && layout === 'grid' ? columns : undefined,
        gap: gapParam,
        bg,
        cell: !tplId && layout === 'grid' ? cell || undefined : undefined,
        radius: tplId ? radius : undefined,
        shadow: tplId ? shadow : undefined,
        border: tplId ? border : undefined,
        backdrop: tplId ? backdrop : undefined,
        seamless: seamless || undefined,
        format,
        quality: format === 'png' ? undefined : quality,
        title: title.trim() || undefined,
        subtitle: subtitle.trim() || undefined,
        billing: billing.trim() || undefined,
        font: font || undefined,
        titleScale,
        titleColor: titleColor || undefined,
        file: fileName.trim() || undefined,
      }),
    [
      orderedIds, tplId, cropsParam, layout, ratio, outWidth, columns, gapParam, bg, cell,
      radius, shadow, border, backdrop, seamless, format, quality, title, subtitle, billing,
      font, titleScale, titleColor, fileName,
    ]
  );

  useEffect(() => {
    let alive = true;
    setTplErr('');
    api
      .stitchTemplates()
      .then((r) => {
        if (!alive) return;
        setTplList(r.templates);
        if (r.layouts?.length) setFlowList(r.layouts);
      })
      .catch((e: any) => {
        if (!alive) return;
        const msg = e?.message || i18n.t('k094d97a7');
        // 服务端是新进程才有这个接口；旧进程/旧版本会 404，给一句能自己解决的话
        setTplErr(/404|不存在|Not Found/i.test(msg) ? i18n.t('kc3e1e10b') : msg);
      });
    return () => {
      alive = false;
    };
  }, [tplTry]);

  // 张数定了就替用户挑一个模板：大多数人不该先读一遍模板名
  useEffect(() => {
    if (!tplList) return;
    const ok = tplList.filter((t) => items.length >= t.min && items.length <= t.max);
    setTplId((cur) => (ok.some((t) => t.id === cur) ? cur : ok[0]?.id || ''));
  }, [tplList, items.length]);

  useEffect(() => {
    setCrops((prev) => (prev.length === items.length ? prev : items.map(() => centerCrop())));
  }, [items.length]);

  // 预览防抖：拖动构图时每一帧都请求会让服务端一直忙，停手 180ms 再出图
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      setPreviewUrl(url);
      return;
    }
    const t = setTimeout(() => setPreviewUrl(url), 180);
    return () => clearTimeout(t);
  }, [url]);

  useEffect(() => {
    setLoading(true);
    setErr('');
    // 图被缓存（同一 URL 重新挂载）时不会再触发 onLoad，必须自己查一次，
    // 否则预览永远停在 35% 透明 + 转圈，看起来像没生成
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth) {
      setSize(`${el.naturalWidth}×${el.naturalHeight}`);
      setLoading(false);
    }
  }, [previewUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* 成品图回调：普通预览图与构图台的隐藏探针共用 */
  const onImgLoad = (el: HTMLImageElement) => {
    setSize(`${el.naturalWidth}×${el.naturalHeight}`);
    setLoading(false);
  };
  const onImgError = () => {
    setErr(i18n.t('k96969d9e'));
    setLoading(false);
  };

  const pickTemplate = useCallback(
    (id: string) => {
      if (id !== tplId) {
        setRadiusOv(null);
        setShadowOv(null);
        setBorderOv(null);
        setBackdropOv(null);
        setBgOv('');
        setSeamlessOv(null);
      }
      setTplId(id);
    },
    [tplId]
  );

  const runAuto = async () => {
    if (!tpl) return;
    setAutoBusy(true);
    try {
      const r = await api.stitchAutoCrops(orderedIds, tpl.id);
      setCrops(orderedItems.map((_, i) => r.crops[i] || centerCrop()));
      onToast?.(i18n.t('k6257418f'));
    } catch (e: any) {
      onToast?.(e?.message || i18n.t('k245e9177'), 'error');
    } finally {
      setAutoBusy(false);
    }
  };

  /**
   * 互换两格的图：只换映射，不动素材本身。
   * 构图（crops）跟着图走 —— 用户调好的「这张图露哪块」不该留在原来的格子里。
   */
  const swapSlots = useCallback((a: number, b: number) => {
    setOrder((prev) => swapAt(prev, a, b));
    setCrops((prev) => swapAt(prev, a, b));
  }, []);

  // 换位的拖拽：从缩略图条或格子左上角的编号拖到另一格，松手即互换。
  // 用 pointer 事件而不是 HTML5 drag：桌面端（Electron）一样能用，还能用真实鼠标序列做回归测试
  const dragFrom = useRef<{ slot: number; x: number; y: number; moved: boolean; thumb: string } | null>(null);
  const [dragThumb, setDragThumb] = useState('');
  const ghostRef = useRef<HTMLDivElement | null>(null);
  // 刚拖完的那一下会顺手生成一个 click：拖到对话框外面松手不该顺带把窗口关掉
  const dragEndRef = useRef(0);

  const beginSlotDrag = useCallback(
    (e: ReactPointerEvent, slot: number) => {
      if (e.button !== 0) return;
      const it = orderedItems[slot];
      if (!it) return;
      e.preventDefault(); // 别让浏览器顺手开始选字 / 拖原生图片
      dragFrom.current = { slot, x: e.clientX, y: e.clientY, moved: false, thumb: it.thumbUrl };
    },
    [orderedItems]
  );

  useEffect(() => {
    const place = (x: number, y: number) => {
      const el = ghostRef.current;
      // 用 fixed + translate 直接改样式：每帧只动一个合成层，不带着整个对话框重渲染
      if (el) el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    };
    const onMove = (e: PointerEvent) => {
      const d = dragFrom.current;
      if (!d) return;
      if (!d.moved) {
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 6) return;
        d.moved = true;
        setDragThumb(d.thumb);
        requestAnimationFrame(() => place(e.clientX, e.clientY));
        return;
      }
      place(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      const d = dragFrom.current;
      dragFrom.current = null;
      setDragThumb('');
      if (!d || !d.moved) return;
      dragEndRef.current = Date.now();
      // 落点命中格子（data-cell）或缩略图（data-slot）就互换；落在别处等于取消
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const holder = el?.closest<HTMLElement>('[data-cell], [data-slot]');
      const to = Number(holder?.dataset.cell ?? holder?.dataset.slot);
      if (Number.isInteger(to) && to !== d.slot) swapSlots(d.slot, to);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [swapSlots]);

  const totalBytes = items.reduce((n, i) => n + (i.sizeBytes || 0), 0);
  const hasText = Boolean(tpl && (tpl.title || tpl.masthead || tpl.sub || tpl.billing));
  const flowHint = flowList.find((l) => l.id === layout)?.hint || '';
  const swatches = ['#ffffff', '#000000', '#f2f2f7', '#1c1c22'];
  const colOptions = useMemo(() => {
    const max = Math.max(1, Math.min(12, items.length));
    return Array.from({ length: max }, (_, i) => i + 1);
  }, [items.length]);

  return (
    <div
      className="modal-backdrop tk-backdrop"
      onClick={() => {
        if (Date.now() - dragEndRef.current < 300) return; // 拖拽换位的落点在外面＝取消，别关窗
        onClose();
      }}
    >
      <div className={`modal-card st-card${dragThumb ? ' st-dragging' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{i18n.t('kcdbb0115')}</b>
          <span className="tk-title">
            {i18n.t('ked8ded0a', { p0: items.length, p1: formatSize(totalBytes) })}
            {size ? i18n.t('k7295eb8d', { p0: size }) : ''}
          </span>
          <button className="icon-btn" onClick={onClose} title={i18n.t('k01aadfea')}>
            <IconClose />
          </button>
        </div>

        <div className="modal-body st-modal-body">
          <div className="st-body">
            <div className="st-stage">
              <div className={`st-preview${cells ? ' st-preview-edit' : ''}`}>
                {err ? (
                  <div className="tk-warn">{err}</div>
                ) : cells ? (
                  /* 左侧大图就是构图台（模板与算法版式通用）：拖/滚/双击直接改每格构图，
                     静止时盖着服务端成品，文字、底色、描边都在上面 */
                  <StitchCropEditor
                    large
                    boxes={cells.boxes}
                    ratio={cells.ratio}
                    items={orderedItems}
                    crops={crops}
                    onChange={setCrops}
                    zMin={cells.zMin}
                    defaultZ={!tplId && layout === 'grid' ? cells.zMin : undefined}
                    resultUrl={previewUrl || undefined}
                    onSlotDrag={beginSlotDrag}
                  />
                ) : (
                  <img
                    ref={imgRef}
                    className="st-img"
                    src={previewUrl || url}
                    alt={i18n.t('k63d7ac22')}
                    style={{ opacity: loading ? 0.35 : 1 }}
                    onLoad={(e) => onImgLoad(e.currentTarget)}
                    onError={onImgError}
                  />
                )}
                {/* 构图台的成品图被盖在格子里，尺寸还得是真实值：藏一张探针图专门读宽高 */}
                {cells && !err && (
                  <img
                    ref={imgRef}
                    className="st-size-probe"
                    src={previewUrl || url}
                    alt=""
                    onLoad={(e) => onImgLoad(e.currentTarget)}
                    onError={onImgError}
                  />
                )}
                {!cells && loading && !err && <span className="spinner st-spin" />}
              </div>
              <div className="st-meta">
                <span>{i18n.t('k1bff293f', { p0: items.length })}</span>
                <span>{i18n.t('k51913b72', { p0: formatSize(totalBytes) })}</span>
                {size && <span className="st-meta-out">{i18n.t('kcbe08da5', { p0: size })}</span>}
                <span className="st-meta-tip">
                  {cells ? i18n.t('k1c52a175') : i18n.t('k48970816')}
                </span>
              </div>
              {planErr && (
                <div className="st-warnline">{i18n.t('kd2acc93d', { p0: planErr })}</div>
              )}
              <div className="st-order">
                <span className="st-order-label" title={i18n.t('k5e79a16f')}>
                  {i18n.t('k6367e715')}
                </span>
                <div className="st-picked">
                  {orderedItems.slice(0, 24).map((it, i) => (
                    <span
                      className="st-pick"
                      key={it.id}
                      data-slot={i}
                      title={i18n.t('k467ca31f', { p0: i + 1, p1: it.title ? ` · ${it.title}` : '' })}
                      onPointerDown={(e) => beginSlotDrag(e, i)}
                    >
                      <img src={it.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} />
                      <i>{i + 1}</i>
                    </span>
                  ))}
                  {orderedItems.length > 24 && (
                    <span className="tk-hint">{i18n.t('kf402dda0', { p0: orderedItems.length - 24 })}</span>
                  )}
                </div>
              </div>
            </div>

            <div className="st-side">
              <div className="st-group">
                <h5>
                  {i18n.t('k131a0f4c')}
                  <em>{tpl ? i18n.t('k95aa4459', { p0: tpl.ratio }) : i18n.t('kd4941798')}</em>
                </h5>
                {tplErr ? (
                  <div className="st-hintline st-errline">
                    <span>{tplErr}</span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setTplList(null);
                        setTplTry((n) => n + 1);
                      }}
                    >
                      {i18n.t('k132c5cdc')}
                    </button>
                  </div>
                ) : null}
                {!tplList && !tplErr ? <div className="st-hintline">{i18n.t('k649d6b56')}</div> : null}
                {availTemplates.length > 0 && (
                  <div className="st-tpl-grid">
                    {availTemplates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`st-tpl${t.id === tplId ? ' on' : ''}`}
                        title={t.hint}
                        onClick={() => pickTemplate(t.id)}
                      >
                        <span className="st-tpl-canvas" style={{ aspectRatio: t.ratio.replace(':', ' / ') }}>
                          {t.slots.map((s, i) => (
                            <span
                              key={i}
                              className="st-tpl-box"
                              style={{
                                left: `${s[0] * 100}%`,
                                top: `${s[1] * 100}%`,
                                width: `${s[2] * 100}%`,
                                height: `${s[3] * 100}%`,
                              }}
                            >
                              {orderedItems[i] ? (
                                <img src={orderedItems[i].thumbUrl} alt="" loading="lazy" decoding="async" />
                              ) : null}
                            </span>
                          ))}
                        </span>
                        <span className="st-tpl-name">{t.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {tplList && availTemplates.length === 0 && (
                  <div className="st-hintline">
                    {i18n.t('kaa01e886', { p0: items.length })}
                  </div>
                )}
                {tpl && <div className="st-hintline">{tpl.hint}</div>}
                <div className="st-row">
                  <span className="st-row-label">{i18n.t('k103701c5')}</span>
                  <div className="st-seg">
                    {flowList.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        className={!tplId && layout === l.id ? 'on' : ''}
                        title={l.hint}
                        onClick={() => {
                          // 切到算法版式：模板专属的参数不再生效，先摘掉模板
                          setTplId('');
                          setSeamlessOv(null);
                          setLayout(l.id);
                        }}
                      >
                        {l.name}
                      </button>
                    ))}
                  </div>
                </div>
                {!tplId && flowHint && <div className="st-hintline">{flowHint}</div>}
              </div>

              {hasText && (
                <div className="st-group">
                  <h5>
                    {i18n.t('keaf0bf88')}
                    <em>{i18n.t('kd9dbc619')}</em>
                  </h5>
                  {(tpl?.title || tpl?.masthead) && (
                    <input
                      className="input"
                      value={title}
                      maxLength={40}
                      placeholder={tpl?.masthead ? i18n.t('kfbc34bbf') : i18n.t('k6171ab37')}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  )}
                  {tpl?.sub && (
                    <input
                      className="input"
                      value={subtitle}
                      maxLength={60}
                      placeholder={i18n.t('k9755aa64')}
                      onChange={(e) => setSubtitle(e.target.value)}
                    />
                  )}
                  {tpl?.billing && (
                    <input
                      className="input"
                      value={billing}
                      maxLength={120}
                      placeholder={i18n.t('k222ae845')}
                      onChange={(e) => setBilling(e.target.value)}
                    />
                  )}
                  <div className="st-row">
                    <span className="st-row-label">{i18n.t('k8456bc40')}</span>
                    <select
                      className="input"
                      value={font}
                      onChange={(e) => setFont(e.target.value)}
                      title={fontErr || i18n.t('kcff173d0')}
                    >
                      <option value="">{i18n.t('k83e983cf')}</option>
                      {fonts.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="st-field">
                    <span>
                      {i18n.t('k8f3b6cdd')}
                      <b>{` ${Math.round(titleScale * 100)}%`}</b>
                    </span>
                    <input
                      className="st-range"
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={titleScale}
                      onChange={(e) => setTitleScale(Number(e.target.value))}
                    />
                  </label>
                  <div className="st-row">
                    <span className="st-row-label">{i18n.t('k94e391ba')}</span>
                    <div className="st-swatches">
                      {TEXT_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`st-swatch${titleColor === c ? ' on' : ''}`}
                          style={{ background: c }}
                          title={c}
                          aria-label={c}
                          onClick={() => setTitleColor(titleColor === c ? '' : c)}
                        />
                      ))}
                      <label className="st-swatch st-swatch-custom" title={i18n.t('k255f442c')}>
                        <input
                          type="color"
                          value={titleColor || '#ffffff'}
                          onChange={(e) => setTitleColor(e.target.value)}
                        />
                      </label>
                      {titleColor ? (
                        <button type="button" className="st-swatch-reset" onClick={() => setTitleColor('')}>
                          {i18n.t('kc134f58f')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="st-hintline">
                    {fontErr
                      ? fontErr
                      : i18n.t('k57a89005')}
                  </div>
                </div>
              )}

              {cells && (
                <div className="st-group">
                  <h5>
                    {i18n.t('kdde96054')}
                    <em>{i18n.t('k9df9aace')}</em>
                  </h5>
                  <div className="st-hintline">
                    {i18n.t('ka923e757')}
                  </div>
                  <div className="st-row">
                    {/* 自动构图要靠模板槽位算主体落点，算法版式没有槽位就不给这个按钮 */}
                    {tpl && (
                      <button type="button" className="btn" onClick={runAuto} disabled={autoBusy}>
                        {autoBusy ? i18n.t('ka61a89e3') : i18n.t('k9c57f9dc')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        // 联系表复位回「整图」，其余版式回到「铺满」
                        setCrops(items.map((_, i) => centerCrop(!tplId && layout === 'grid' ? cells.zMin[i] : 1)))
                      }
                    >
                      {i18n.t('k42330f9b')}
                    </button>
                  </div>
                </div>
              )}

              <div className="st-group">
                <h5>
                  {i18n.t('kafcde261')}
                  {seamless ? <em>{i18n.t('kcc555f4b')}</em> : null}
                </h5>
                <label className="st-check">
                  <input
                    type="checkbox"
                    checked={seamless}
                    onChange={(e) => setSeamlessOv(e.target.checked)}
                  />
                  <span>{i18n.t('kc0784830')}</span>
                </label>
                {tpl && !seamless && (
                  <>
                    <label className="st-field">
                      <span>
                        {i18n.t('k0103eb2d')} <b>{(radius * 100).toFixed(1)}%</b>
                      </span>
                      <input
                        className="st-range"
                        type="range"
                        min={0}
                        max={8}
                        step={0.2}
                        value={Number((radius * 100).toFixed(1))}
                        onChange={(e) => setRadiusOv(Number(e.target.value) / 100)}
                      />
                    </label>
                    <label className="st-field">
                      <span>
                        {i18n.t('k16ad4ad5')} <b>{Math.round(shadow * 100)}%</b>
                      </span>
                      <input
                        className="st-range"
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={Math.round(shadow * 100)}
                        onChange={(e) => setShadowOv(Number(e.target.value) / 100)}
                      />
                    </label>
                    <label className="st-check">
                      <input type="checkbox" checked={border} onChange={(e) => setBorderOv(e.target.checked)} />
                      <span>{i18n.t('ka2ee8985')}</span>
                    </label>
                    <label className="st-check">
                      <input type="checkbox" checked={backdrop} onChange={(e) => setBackdropOv(e.target.checked)} />
                      <span>{i18n.t('kd84a6069')}</span>
                    </label>
                    <div className="st-row">
                      <span className="st-row-label">{i18n.t('kb53d6d1a')}</span>
                      <div className="st-swatches">
                        {swatches.map((c) => (
                          <button
                            key={c}
                            type="button"
                            className={`st-swatch${c.toLowerCase() === bg.toLowerCase() ? ' on' : ''}`}
                            style={{ background: c }}
                            title={c}
                            onClick={() => setBgOv(c)}
                          />
                        ))}
                        <label className="st-swatch st-swatch-custom" title={i18n.t('k255f442c')}>
                          <input type="color" value={bg} onChange={(e) => setBgOv(e.target.value)} />
                        </label>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="st-group">
                <h5>{i18n.t('k8ba7c3a7')}</h5>
                <input
                  className="input"
                  value={fileName}
                  maxLength={60}
                  placeholder={i18n.t('kb4d9aab0', { p0: title.trim() || i18n.t('kea4483d9') })}
                  onChange={(e) => setFileName(e.target.value)}
                />
                <div className="st-row">
                  <span className="st-row-label">{i18n.t('kc2847901')}</span>
                  <div className="st-seg">
                    {[1600, 2400, 3200, 4000].map((w) => (
                      <button
                        key={w}
                        type="button"
                        className={outWidth === w ? 'on' : ''}
                        onClick={() => setOutWidth(w)}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>
                {tpl ? (
                  <div className="st-row">
                    <span className="st-row-label">{i18n.t('k8c79a1eb')}</span>
                    <span className="st-ro">{i18n.t('k09fbee01', { p0: tpl.ratio })}</span>
                  </div>
                ) : (
                  <div className="st-row">
                    <span className="st-row-label">{i18n.t('k15007537')}</span>
                    <div className="st-seg">
                      {RATIO_OPTIONS.map((v) => (
                        <button key={v} type="button" className={ratio === v ? 'on' : ''} onClick={() => setRatio(v)}>
                          {v === 'auto' ? i18n.t('k3aed2c11') : v}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {!tplId && layout === 'grid' && (
                  <>
                    <div className="st-row">
                      <span className="st-row-label">{i18n.t('keb22d47f')}</span>
                      <div className="st-seg">
                        {colOptions.map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={n === columns ? 'on' : ''}
                            onClick={() => setColumns(n)}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="st-field">
                      <span>
                        {i18n.t('ke1ab7d13')} <b>{cell ? `${cell}px` : i18n.t('kf7f3989b')}</b>
                      </span>
                      <input
                        className="st-range"
                        type="range"
                        min={0}
                        max={1200}
                        step={40}
                        value={cell}
                        onChange={(e) => setCell(Number(e.target.value))}
                      />
                    </label>
                  </>
                )}
                <label className="st-field">
                  <span>
                    {i18n.t('k60bac4c0')} <b>{seamless ? i18n.t('kcc555f4b') : gap ? `${gap}px` : i18n.t('k3aed2c11')}</b>
                  </span>
                  <input
                    className="st-range"
                    type="range"
                    min={0}
                    max={64}
                    value={seamless ? 0 : gap}
                    disabled={seamless}
                    onChange={(e) => setGap(Number(e.target.value))}
                  />
                </label>
                <div className="st-row">
                  <span className="st-row-label">{i18n.t('ke3127cc1')}</span>
                  <div className="st-seg">
                    {(
                      [
                        ['jpeg', 'JPEG'],
                        ['png', 'PNG'],
                        ['webp', 'WebP'],
                      ] as const
                    ).map(([v, label]) => (
                      <button key={v} type="button" className={format === v ? 'on' : ''} onClick={() => setFormat(v)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {format !== 'png' && (
                  <div className="st-row">
                    <span className="st-row-label">{i18n.t('k3a7170b9')}</span>
                    <div className="st-seg">
                      {[100, 95, 90, 82].map((q) => (
                        <button
                          key={q}
                          type="button"
                          className={quality === q ? 'on' : ''}
                          onClick={() => setQuality(q)}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="st-foot">
          <span className="tk-hint">
            {i18n.t('k8c90f32b')}
          </span>
          <button
            className="btn primary"
            disabled={!ids.length}
            onClick={() => {
              const now = Date.now();
              // 保存框是异步弹的，连点会在它出现前又触发一次，于是叠出两个框
              if (now - saveRef.current < 1200) return;
              saveRef.current = now;
              void downloadFile(url);
              onToast?.(i18n.t('kc785a04e'));
            }}
          >
            <IconDownload /> {i18n.t('k1dcc1f2e')}
          </button>
        </div>
        {/* 拖动换位时跟着光标的缩略图：位置用 transform 直接改，不参与 React 重渲染 */}
        {dragThumb && (
          <div ref={ghostRef} className="st-drag-ghost" aria-hidden>
            <img src={dragThumb} alt="" draggable={false} />
          </div>
        )}
      </div>
    </div>
  );
}
