import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { StitchCrop } from '../api';
import type { ImageItem } from '../types';
import { clamp, coverGeom, zoomAt } from '../lib/stitchGeom';
import i18n from '../i18n';

/** '2:3' → [2, 3]；格式不对按 4:3 兜底（与服务端 ratioOf 同规则） */
export function parseRatio(spec?: string): [number, number] {
  const m = String(spec || '').match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return [4, 3];
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : [4, 3];
}

interface Props {
  boxes: number[][]; // 归一化 [x, y, w, h]，来自服务端 /stitch/plan
  ratio: number; // 画布宽/高
  items: ImageItem[];
  crops: StitchCrop[];
  onChange: (next: StitchCrop[]) => void;
  /** 每格的缩放下限（整图刚好装进格子）；缺省按 1 处理 */
  zMin?: number[];
  /** 「复位」回到的倍率：联系表是整图（zMin），其余版式是铺满（1） */
  defaultZ?: number[];
  /** 服务端成品预览：停手时铺在格子上，拖动时让位给实时画面 */
  resultUrl?: string;
  /** 大图模式：铺满左侧预览区 */
  large?: boolean;
  /**
   * 拖动左上角编号换位：给了它就显示编号，用户能把这张图拖到别的格子。
   * 号小、位置在角上，跟「拖画面」区分开；格子里拖仍然是平移构图
   */
  onSlotDrag?: (e: ReactPointerEvent, slot: number) => void;
}

interface DragState {
  idx: number;
  x: number;
  y: number;
  left: number;
  top: number;
  w: number;
  h: number;
  rw: number;
  rh: number;
  minL: number;
  maxL: number;
  minT: number;
  maxT: number;
}

/** 本地在手上的那一格（还没交回父组件） */
interface Live {
  idx: number;
  crop: StitchCrop;
}

/**
 * 逐格构图：直接在版面的格子位置铺用户自己的图，拖动改焦点、滚轮缩放。
 * 拖的是「图」而不是裁剪框，和 Photoshop / Eagle 的裁剪手感一致。
 * 静止时叠服务端成品图（文字、底色、描边都在上面），一上手就切回实时画面。
 */
export default function StitchCropEditor({
  boxes,
  ratio,
  items,
  crops,
  onChange,
  zMin,
  defaultZ,
  resultUrl,
  large = false,
  onSlotDrag,
}: Props) {
  const rw = ratio > 0 ? ratio : 1;
  const rh = 1;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [active, setActive] = useState(-1);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const [resultReady, setResultReady] = useState(false);

  // 手上正在拖/缩的那一格只存在本地。以前每个 pointermove 都 setState 到父组件，
  // 整张对话框（模板格 + 几十张缩略图）跟着重渲染；指针事件比帧率密得多，
  // 主线程被 VDOM diff 占满 → 手感「拖不动、不跟手」。
  // 现在本地按帧渲染，抬手（或滚轮停手 200ms）才把结果交回父组件一次。
  const [live, setLive] = useState<Live | null>(null);
  const liveRef = useRef<Live | null>(null);
  const frameRef = useRef(0);
  const idleTimer = useRef(0);
  // 父组件那份 crops 的最新值（自己刚交回去的也算），连发操作不会互相覆盖
  const cropsRef = useRef(crops);
  if (cropsRef.current !== crops) cropsRef.current = crops;

  // 换了预览地址就等新图 onLoad 再亮出来，别把上一张当成品
  useEffect(() => {
    setResultReady(false);
  }, [resultUrl]);

  // 大图模式按容器实际空间等比铺开（竖版 2:3 也要撑满预览区）。
  // 光靠 CSS 的 aspect-ratio + max-height 在 flex 里算不准，直接量一遍。
  useEffect(() => {
    if (!large) return;
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const k = Math.min(r.width / rw, r.height / rh);
      setFit({ w: Math.max(80, Math.floor(rw * k)), h: Math.max(60, Math.floor(rh * k)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [large, rw, rh]);

  // React 的 onWheel 是 passive，preventDefault 无效（滚轮会顺带滚走右侧栏），
  // 所以用原生监听；最新状态走 ref，避免把监听器绑成一次性的旧闭包
  const latest = useRef({ boxes, items, onChange, zMin, rw, rh });
  latest.current = { boxes, items, onChange, zMin, rw, rh };

  const frameLive = useCallback(() => {
    if (frameRef.current) return; // 一帧只渲染一次，pointermove 再密也不怕
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setLive(liveRef.current);
    });
  }, []);

  const pushLive = useCallback(
    (idx: number, crop: StitchCrop) => {
      liveRef.current = { idx, crop };
      frameLive();
    },
    [frameLive]
  );

  /** 把还在手上的这一格交回父组件；数值没变就一声不响地扔掉 */
  const flushLive = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = 0;
    }
    const cur = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (!cur) return;
    const prev = cropsRef.current[cur.idx];
    const same =
      prev &&
      Math.abs(prev.fx - cur.crop.fx) < 1e-4 &&
      Math.abs(prev.fy - cur.crop.fy) < 1e-4 &&
      Math.abs(prev.z - cur.crop.z) < 1e-4;
    if (same) return; // 手感上没动过，别惊动父组件（否则会白丢一次成品图）
    const next = cropsRef.current.map((c, i) => (i === cur.idx ? cur.crop : c));
    cropsRef.current = next;
    // 旧成品先撤掉，等新成品 onLoad 再铺回来；不然松手瞬间会闪回改动前的画面
    setResultReady(false);
    latest.current.onChange(next);
  }, []);

  /** 滚轮是连发的：停手 200ms 再提交，中间的每一格只走本地渲染 */
  const scheduleFlush = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(flushLive, 200);
  }, [flushLive]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    []
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const node = (e.target as HTMLElement | null)?.closest?.('[data-cell]') as HTMLElement | null;
      if (!node) return;
      const idx = Number(node.dataset.cell);
      const st = latest.current;
      const item = st.items[idx];
      const slot = st.boxes[idx];
      // 上一笔可能还在手上（本地），要接着它缩，否则每一下都从旧值重来 → 一顿一顿
      const cur = liveRef.current?.idx === idx ? liveRef.current.crop : cropsRef.current[idx];
      if (!cur || !item || !slot) return;
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // 缩放锚在光标：光标下那一点保持不动，才像「往这里推近」
      const px = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const py = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      // 换算交给 zoomAt（纯函数、有单测），别在这里手写 —— 单位一混焦点就漂
      const next = zoomAt(item, rect.width, rect.height, cur, st.zMin?.[idx] ?? 1, e.deltaY > 0 ? 0.88 : 1.14, px, py);
      if (!next) return; // 已经到头了，别再抖动
      pushLive(idx, next);
      scheduleFlush();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pushLive, scheduleFlush]);

  const patch = (idx: number, next: Partial<StitchCrop>) => {
    flushLive();
    const out = cropsRef.current.map((c, i) => (i === idx ? { ...c, ...next } : c));
    cropsRef.current = out;
    setResultReady(false);
    latest.current.onChange(out);
  };

  /** 复位这一格：居中 + 回到该版式的默认倍率 */
  const resetCell = (idx: number) => patch(idx, { fx: 0.5, fy: 0.5, z: defaultZ?.[idx] ?? 1 });

  // 一上手（按住拖动 / 正在滚轮缩放）就必须撤掉成品层，露出一格一格的实时画面
  const showResult = Boolean(resultUrl) && resultReady && active < 0 && !live;

  return (
    <div className={large ? 'st-edit st-edit-lg' : 'st-edit'} ref={wrapRef}>
      <div
        ref={stageRef}
        className={`${large ? 'st-edit-canvas lg' : 'st-edit-canvas'}${showResult ? ' has-result' : ''}`}
        style={
          large
            ? {
                // 量到尺寸前先不给死宽高，避免第一次渲染闪一条细缝
                width: fit ? `${fit.w}px` : undefined,
                height: fit ? `${fit.h}px` : undefined,
                aspectRatio: `${rw} / ${rh}`,
              }
            : {
                aspectRatio: `${rw} / ${rh}`,
                // 高度定在 ~320px 反推宽度：竖版 2:3 的格子不能把侧栏撑成一条长图
                width: `min(100%, calc(320px * ${(rw / rh).toFixed(4)}))`,
              }
        }
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          // 位移与 d.left/d.rw 全是像素：不会再出现「1px 手抖 = 半屏」。
          // 加号＝图跟手走（往上拖图往上走、露出下方），与注释里说的 PS/Eagle 裁剪手感一致
          const left = clamp(d.left + (e.clientX - d.x), d.minL, d.maxL);
          const top = clamp(d.top + (e.clientY - d.y), d.minT, d.maxT);
          // 只写本地：fx/fy 是「格子中心相对图左上角」反算出来的，与 cropWindow 同一套坐标。
          // 倍率取手上那一格（按下时可能刚推近过一档），别让 cropsRef 的旧 z 把它抹掉
          const cur =
            liveRef.current?.idx === d.idx
              ? liveRef.current.crop
              : cropsRef.current[d.idx] || { fx: 0.5, fy: 0.5, z: 1 };
          pushLive(d.idx, { ...cur, fx: (d.w / 2 - left) / d.rw, fy: (d.h / 2 - top) / d.rh });
        }}
        onPointerUp={() => {
          dragRef.current = null;
          flushLive();
          setActive(-1);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          flushLive();
          setActive(-1);
        }}
      >
        {resultUrl ? (
          <img
            className="st-edit-result"
            src={resultUrl}
            alt=""
            draggable={false}
            onLoad={() => setResultReady(true)}
            onError={() => setResultReady(false)}
          />
        ) : null}
        {boxes.slice(0, items.length).map((s, i) => {
          const item = items[i];
          const crop = live?.idx === i ? live.crop : cropsRef.current[i] || { fx: 0.5, fy: 0.5, z: 1 };
          const g = coverGeom(item, s[2] * rw, s[3] * rh, crop, zMin?.[i]);
          const atMin = g.z <= g.zMin + 0.005;
          return (
            <div
              key={i}
              data-cell={i}
              className={`st-edit-cell${active === i ? ' on' : ''}${g.dry ? ' dry' : ''}`}
              style={{
                left: `${s[0] * 100}%`,
                top: `${s[1] * 100}%`,
                width: `${s[2] * 100}%`,
                height: `${s[3] * 100}%`,
              }}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('.st-edit-badge')) return;
                // 先把滚轮那笔落地的改动交回去，再量尺寸，起点才和画面对得上
                flushLive();
                const rect = e.currentTarget.getBoundingClientRect();
                if (!rect.width || !rect.height) return;
                const start = cropsRef.current[i] || { fx: 0.5, fy: 0.5, z: 1 };
                // 像素口径！拖动位移是像素，几何必须同口径；
                // 这里若传归一化比例（s[2]*rw），1px 手抖等于几百像素，一拖就撞 clamp 边界
                let seed = start;
                let g0 = coverGeom(item, rect.width, rect.height, seed, zMin?.[i]);
                if (g0.dry || (g0.maxL - g0.minL < 1 && g0.maxT - g0.minT < 1)) {
                  // 图正好铺满/装进格子 → 两向余量 <1px，硬拖必然纹丝不动。
                  // 按下先推近一档再进拖动，用户不必先滚轮也能直接拉
                  seed = { ...start, z: Math.min(4, Math.max(1.25, (Number(start.z) || 1) * 1.25)) };
                  g0 = coverGeom(item, rect.width, rect.height, seed, zMin?.[i]);
                  pushLive(i, seed);
                }
                dragRef.current = {
                  idx: i,
                  x: e.clientX,
                  y: e.clientY,
                  left: g0.left,
                  top: g0.top,
                  w: rect.width,
                  h: rect.height,
                  rw: g0.rw,
                  rh: g0.rh,
                  minL: g0.minL,
                  maxL: g0.maxL,
                  minT: g0.minT,
                  maxT: g0.maxT,
                };
                setActive(i);
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onDoubleClick={() => resetCell(i)}
            >
              <img src={item.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} style={g.style} />
              {onSlotDrag && (
                <span
                  className="st-edit-no"
                  title={i18n.t('k2838e2bf', { p0: i + 1 })}
                  onPointerDown={(e) => {
                    // 别让格子接管这一下，否则会变成平移构图而不是换位
                    e.stopPropagation();
                    e.preventDefault();
                    onSlotDrag(e, i);
                  }}
                >
                  {i + 1}
                </span>
              )}
              <span
                className={`st-edit-badge${atMin ? ' min' : ''}`}
                title={atMin ? i18n.t('k6c98bf50') : i18n.t('k98aad67e')}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => resetCell(i)}
              >
                {g.z <= 1.005 ? (g.z < 0.995 ? `${g.z.toFixed(2)}×` : '1×') : `${g.z.toFixed(g.z < 1.15 ? 2 : 1)}×`}
              </span>
            </div>
          );
        })}
      </div>
      {!large && (
        <div className="st-edit-tip">
          {i18n.t('kcdfbd8e2')}
        </div>
      )}
    </div>
  );
}
