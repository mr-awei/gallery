import { useEffect, useRef, useState } from 'react';
import type { StitchCrop } from '../api';
import type { ImageItem } from '../types';

/** '2:3' → [2, 3]；格式不对按 4:3 兜底（与服务端 ratioOf 同规则） */
export function parseRatio(spec?: string): [number, number] {
  const m = String(spec || '').match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return [4, 3];
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : [4, 3];
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 一格的渲染几何：把源图按 cover 放大 z 倍，再平移让焦点落在格子中心。
 * 这是服务端 cropWindow 的逆运算，公式必须一致，否则所见非所得。
 *
 * z 可以小于 1（缩到图比格子还小），这时图不再裁切、整体居中，多出来的是底色；
 * 下限 zMin 由服务端按每格算好传进来，缩到那儿正好是「整张图都在」。
 */
function coverGeom(item: ImageItem, boxW: number, boxH: number, crop: StitchCrop, zMin = 1) {
  const iw = item.width > 0 ? item.width : 4;
  const ih = item.height > 0 ? item.height : 3;
  const z = clamp(Number(crop.z) || 1, Math.min(zMin, 1), 4);
  const k = Math.max(boxW / iw, boxH / ih) * z;
  const rw = iw * k;
  const rh = ih * k;
  // 图比格子大 → 只能推到贴边；图比格子小 → 只能在格子里挪，不能挪出去
  const minL = Math.min(0, boxW - rw);
  const maxL = Math.max(0, boxW - rw);
  const minT = Math.min(0, boxH - rh);
  const maxT = Math.max(0, boxH - rh);
  const fx = clamp(Number.isFinite(crop.fx) ? crop.fx : 0.5, 0, 1);
  const fy = clamp(Number.isFinite(crop.fy) ? crop.fy : 0.5, 0, 1);
  const left = clamp(boxW / 2 - fx * rw, minL, maxL);
  const top = clamp(boxH / 2 - fy * rh, minT, maxT);
  return {
    z,
    zMin,
    rw,
    rh,
    left,
    top,
    minL,
    maxL,
    minT,
    maxT,
    style: {
      width: `${(rw / boxW) * 100}%`,
      height: `${(rh / boxH) * 100}%`,
      left: `${(left / boxW) * 100}%`,
      top: `${(top / boxH) * 100}%`,
    },
  };
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
}: Props) {
  const rw = ratio > 0 ? ratio : 1;
  const rh = 1;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [active, setActive] = useState(-1);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const [resultReady, setResultReady] = useState(false);

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
  const latest = useRef({ boxes, items, crops, onChange, zMin, rw, rh });
  latest.current = { boxes, items, crops, onChange, zMin, rw, rh };

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const node = (e.target as HTMLElement | null)?.closest?.('[data-cell]') as HTMLElement | null;
      if (!node) return;
      const idx = Number(node.dataset.cell);
      const st = latest.current;
      const cur = st.crops[idx];
      const item = st.items[idx];
      const slot = st.boxes[idx];
      if (!cur || !item || !slot) return;
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // 缩放锚在光标：光标下那一点保持不动，才像「往这里推近」
      const px = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const py = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      const g = coverGeom(item, slot[2] * st.rw, slot[3] * st.rh, cur, st.zMin?.[idx]);
      const z2 = clamp(g.z * (e.deltaY > 0 ? 0.88 : 1.14), g.zMin, 4);
      if (Math.abs(z2 - g.z) < 1e-4) return; // 已经到头了，别再抖动
      const ratio2 = z2 / g.z;
      const nw = g.rw / ratio2;
      const nh = g.rh / ratio2;
      st.onChange(
        st.crops.map((c, i) =>
          i === idx
            ? {
                fx: clamp((slot[2] * st.rw / 2 - g.left + (px - 0.5) * (g.rw - nw)) / nw, 0, 1),
                fy: clamp((slot[3] * st.rh / 2 - g.top + (py - 0.5) * (g.rh - nh)) / nh, 0, 1),
                z: z2,
              }
            : c
        )
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const patch = (idx: number, next: Partial<StitchCrop>) => {
    onChange(latest.current.crops.map((c, i) => (i === idx ? { ...c, ...next } : c)));
  };

  /** 复位这一格：居中 + 回到该版式的默认倍率 */
  const resetCell = (idx: number) => patch(idx, { fx: 0.5, fy: 0.5, z: defaultZ?.[idx] ?? 1 });

  const showResult = Boolean(resultUrl) && resultReady && active < 0;

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
          const left = clamp(d.left - (e.clientX - d.x), d.minL, d.maxL);
          const top = clamp(d.top - (e.clientY - d.y), d.minT, d.maxT);
          // 一次写回：fx/fy 都是「格子中心相对图左上角」反算出来的，与 cropWindow 同一套坐标
          onChange(
            latest.current.crops.map((c, i) =>
              i === d.idx
                ? { ...c, fx: (d.w / 2 - left) / d.rw, fy: (d.h / 2 - top) / d.rh }
                : c
            )
          );
        }}
        onPointerUp={() => {
          dragRef.current = null;
          setActive(-1);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
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
          const crop = crops[i] || { fx: 0.5, fy: 0.5, z: 1 };
          const g = coverGeom(item, s[2] * rw, s[3] * rh, crop, zMin?.[i]);
          const atMin = g.z <= g.zMin + 0.005;
          return (
            <div
              key={i}
              data-cell={i}
              className={`st-edit-cell${active === i ? ' on' : ''}`}
              style={{
                left: `${s[0] * 100}%`,
                top: `${s[1] * 100}%`,
                width: `${s[2] * 100}%`,
                height: `${s[3] * 100}%`,
              }}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('.st-edit-badge')) return;
                const rect = e.currentTarget.getBoundingClientRect();
                dragRef.current = {
                  idx: i,
                  x: e.clientX,
                  y: e.clientY,
                  left: g.left,
                  top: g.top,
                  w: rect.width,
                  h: rect.height,
                  rw: g.rw,
                  rh: g.rh,
                  minL: g.minL,
                  maxL: g.maxL,
                  minT: g.minT,
                  maxT: g.maxT,
                };
                setActive(i);
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onDoubleClick={() => resetCell(i)}
            >
              <img src={item.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} style={g.style} />
              <span
                className={`st-edit-badge${atMin ? ' min' : ''}`}
                title={atMin ? '已缩到整图，再缩就只是更小更糊' : '点击复位这一格'}
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
          {'拖动移动画面 · 滚轮缩放 · 双击复位 · 角标显示放大倍数（变橙＝已缩到整图，到底了）'}
        </div>
      )}
    </div>
  );
}
