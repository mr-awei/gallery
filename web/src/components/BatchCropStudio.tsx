import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditJobStatus } from '../types';
import { api } from '../api';
import CropOverlay, { initialRect, type CropRect } from './CropOverlay';
import CropSettings, { cropOutputSize, cropRatioStr, defaultCropControls, ratioWH, type CropControlState } from './CropSettings';
import SaveModeBlock, { SAVE_MODE_DEFAULT, type SaveModeState } from './SaveModeBlock';
import { IconClose, IconExpand } from './Icons';
import { confirmDialog } from './Dialogs';

/** 裁切台要用的最小图片信息（来自当前页选中项） */
export interface CropItem {
  id: number;
  title: string;
  thumb: string;
  url: string;
  width: number;
  height: number;
}

/** 五档预览尺寸；默认「中小」，最小 140、最大 760 之间可无级拖动 */
const CELL_PRESETS = [
  { key: 180, label: '小' },
  { key: 300, label: '中小' },
  { key: 420, label: '中' },
  { key: 560, label: '中大' },
  { key: 720, label: '大' },
];
const CELL_MIN = 140;
const CELL_MAX = 760;
const CELL_STEP = 10;
const CELL_DEFAULT = 300; // 中小

const aspectOf = (it: { width: number; height: number }) => (it.width > 0 && it.height > 0 ? it.width / it.height : 1);

/** 单张缩略图 + 独立裁切框（框铺在图片真实显示区域内，等比 letterbox） */
function CropCell({
  item,
  cell,
  ratio,
  rect,
  index,
  autoFocus,
  onChange,
  onFocus,
}: {
  item: CropItem;
  cell: number;
  ratio: string;
  rect: CropRect;
  index: number;
  autoFocus: boolean;
  onChange: (r: CropRect) => void;
  onFocus: () => void;
}) {
  const aspect = aspectOf(item);
  let iw = cell;
  let ih = cell / aspect;
  if (ih > cell) {
    ih = cell;
    iw = cell * aspect;
  }
  const frame = { left: (cell - iw) / 2, top: (cell - ih) / 2, width: iw, height: ih };
  const outW = Math.round(rect.w * (item.width || 0));
  const outH = Math.round(rect.h * (item.height || 0));
  return (
    <div className="cs-cell" style={{ width: cell }}>
      <div className="cs-box" style={{ width: cell, height: cell }}>
        <img
          className="cs-img"
          src={item.thumb || item.url}
          alt=""
          draggable={false}
          style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
        />
        <CropOverlay frame={frame} imageAspect={aspect} ratio={ratio} value={rect} onChange={onChange} />
      </div>
      <div className="cs-cap">
        <span className="cs-idx">{index + 1}</span>
        <span className="cs-name" title={item.title}>
          {item.title}
        </span>
        <span className="cs-size">
          {outW}×{outH}
        </span>
        <button
          className={`cs-focus-btn${autoFocus ? ' on' : ''}`}
          title="按焦点重新取景这张"
          onClick={onFocus}
          type="button"
        >
          ◎
        </button>
      </div>
    </div>
  );
}

interface Props {
  items: CropItem[];
  onClose: () => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
  /** 任务结束：刷新列表，让卡片拿到新尺寸/新缩略图 */
  onDone?: () => void;
}

/**
 * 批量裁切台（对齐 Eagle 的批量裁剪）：
 * - 网格里每张图各自一个可拖拽/缩放的裁切框，所见即所裁
 * - 比例预设 1:1 / 4:3 / 3:2 / 16:9，竖版（3:4、9:16）由「竖版」按钮翻面，也可自由输入比例与输出长宽
 * - 「自动检测图像焦点」按显著度（轮廓 + 肤色 + 饱和度）把每张的框放到主体上
 * 处理走服务端异步任务（逐张独立 rect），进度轮询 /api/edit/job。
 */
export default function BatchCropStudio({ items, onClose, onToast, onDone }: Props) {
  const [cell, setCell] = useState(CELL_DEFAULT);
  const [ctl, setCtl] = useState<CropControlState>(() => defaultCropControls('4:3'));
  const [rects, setRects] = useState<Record<number, CropRect>>({});
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusDone, setFocusDone] = useState(0);
  const [save, setSave] = useState<SaveModeState>(SAVE_MODE_DEFAULT);
  const [job, setJob] = useState<EditJobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<number | null>(null);
  const startedRef = useRef(false);
  const errCount = useRef(0);
  const [pollErr, setPollErr] = useState('');
  // 同步锁：starting 是 state，确认弹窗 await 期间它还没生效，连点两次会起两个任务
  const startLock = useRef(false);

  const ratio = useMemo(() => ratioWH(ctl), [ctl]);
  const ratioStr = cropRatioStr(ctl);
  const autoFocus = ctl.autoFocus;
  const patchCtl = useCallback((p: Partial<CropControlState>) => setCtl((s) => ({ ...s, ...p })), []);

  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  /** 全部框回到居中最大（比例变化时用） */
  const centerAll = useCallback((r: string) => {
    const next: Record<number, CropRect> = {};
    for (const it of itemsRef.current) next[it.id] = initialRect(r, aspectOf(it));
    setRects(next);
  }, []);

  /* 焦点检测：并发 4 张，逐张回填；序号守卫防止换比例后旧结果覆盖新框 */
  const focusSeq = useRef(0);
  const runFocus = useCallback(async (list: CropItem[], rw: number, rh: number) => {
    if (!list.length) return;
    const my = ++focusSeq.current;
    setFocusBusy(true);
    setFocusDone(0);
    let cursor = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= list.length) return;
        const it = list[i];
        try {
          const r = await api.imageFocus(it.id, `${rw}:${rh}`);
          if (my !== focusSeq.current) return;
          setRects((p) => ({ ...p, [it.id]: r.rect }));
        } catch {
          /* 单张失败：保持居中框，不打断整批 */
        }
        done += 1;
        if (my === focusSeq.current) setFocusDone(done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    if (my === focusSeq.current) setFocusBusy(false);
  }, []);

  // 比例/横竖/图片集合变化：框回到居中；开着自动对焦就重新检测
  const listKey = ids.join(',');
  useEffect(() => {
    centerAll(ratioStr);
    if (autoFocus) void runFocus(itemsRef.current, ratio.w, ratio.h);
    // autoFocus 故意不进依赖：勾选时单独触发一次，避免每次改比例被重复拉起
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioStr, listKey]);

  const running = !!job?.running;

  useEffect(() => {
    if (!running) {
      if (timer.current) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
      return;
    }
    timer.current = window.setInterval(async () => {
      try {
        const s = await api.editJob();
        errCount.current = 0;
        setPollErr('');
        setJob(s);
        if (!s.running && startedRef.current) {
          startedRef.current = false;
          onDone?.();
          onToast?.(
            s.cancelled
              ? `批量裁切已取消（完成 ${s.done} 张，失败 ${s.failed} 张）`
              : `批量裁切完成：成功 ${s.done} 张${s.failed ? `，失败 ${s.failed} 张` : ''}`
          );
        }
      } catch (err) {
        // 连续失败说明服务可能断了：不能一直装成「正在处理」
        errCount.current += 1;
        if (errCount.current >= 3) setPollErr((err as Error).message || '无法连接服务');
      }
    }, 800);
    return () => {
      if (timer.current) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [running, onToast, onDone]);

  // Esc 关闭（任务运行中不关，避免以为停了）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [running, onClose]);

  const start = async () => {
    if (startLock.current || starting || running) return;
    if (!ids.length) return;
    if (save.saveMode === 'copy' && !save.targetDir.trim()) {
      onToast?.('请先选择副本保存位置');
      return;
    }
    const plan: Record<number, CropRect> = {};
    for (const it of itemsRef.current) {
      plan[it.id] = rects[it.id] || initialRect(ratioStr, aspectOf(it));
    }
    const out = cropOutputSize(ctl);
    // 先同步上锁再确认：确认框还开着时第二次点击必须被挡掉，
    // 否则两个任务同时写同一批原文件，互相覆盖中间结果
    startLock.current = true;
    setStarting(true);
    try {
      // 批量覆盖原图：一次点错就是 N 个文件被重写，必须先确认
      if (save.saveMode === 'overwrite') {
        const ok = await confirmDialog(`将覆盖 ${ids.length} 张图片的原文件（可用 Ctrl+Z 逐张撤销）。继续？`);
        if (!ok) return;
      }
      const r = await api.batchEdit(ids, 'crop', {
        ratio: ratioStr,
        rects: plan,
        outWidth: out ? out.w : 0,
        outHeight: out ? out.h : 0,
        saveMode: save.saveMode,
        targetDir: save.saveMode === 'copy' ? save.targetDir.trim() : '',
        addToLibrary: save.addToLibrary,
      });
      setJob(r.job);
      startedRef.current = true;
    } catch (err) {
      onToast?.((err as Error).message || '批量裁切启动失败');
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  };

  const cancel = async () => {
    try {
      setJob(await api.cancelEditJob());
    } catch {
      /* 忽略 */
    }
  };

  const pct = job && job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 0;

  return createPortal(
    <div className="crop-studio">
      <div className="cs-bar">
        <IconExpand />
        <b>批量裁切</b>
        <span className="cs-count">已选 {ids.length} 张</span>
        {focusBusy ? (
          <span className="cs-focus-state">
            <span className="spinner" /> 检测焦点 {focusDone}/{ids.length}
          </span>
        ) : (
          <span className="cs-hint">每张可独立拖动/缩放方框，只保留框内区域</span>
        )}
        <div className="cs-zoom">
          {/* 无级缩放：直接在滑块上拖，五档只是「常用位置」的快捷按钮 */}
          <input
            className="cs-zoom-slider"
            type="range"
            min={CELL_MIN}
            max={CELL_MAX}
            step={CELL_STEP}
            value={cell}
            onChange={(e) => setCell(Number(e.target.value))}
            title={`预览大小 ${cell}px（可无级拖动）`}
            aria-label="预览大小"
          />
          {CELL_PRESETS.map((s) => (
            <button
              key={s.key}
              className={`btn sm${cell === s.key ? ' primary' : ''}`}
              onClick={() => setCell(s.key)}
              title={`预览${s.label}（${s.key}px）`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button className="btn sm ghost cs-close" onClick={onClose} disabled={running} title="关闭（Esc）">
          <IconClose />
        </button>
      </div>

      <div className="cs-main">
        <div className="cs-grid-wrap">
          <div className="cs-grid">
            {items.map((it, i) => (
              <CropCell
                key={it.id}
                item={it}
                cell={cell}
                ratio={ratioStr}
                rect={rects[it.id] || initialRect(ratioStr, aspectOf(it))}
                index={i}
                autoFocus={autoFocus}
                onChange={(r) => setRects((p) => ({ ...p, [it.id]: r }))}
                onFocus={() => void runFocus([it], ratio.w, ratio.h)}
              />
            ))}
            {items.length === 0 && <p className="cs-empty">选中的项目里没有可裁切的图片。</p>}
          </div>
        </div>

        <div className="cs-side">
          <CropSettings
            value={ctl}
            onChange={(p) => {
              patchCtl(p);
              if (p.autoFocus) void runFocus(itemsRef.current, ratio.w, ratio.h);
            }}
            disabled={running}
            busy={focusBusy}
            onCenter={() => centerAll(ratioStr)}
            onFocus={() => void runFocus(itemsRef.current, ratio.w, ratio.h)}
          />

          <div className="cs-sec">
            <div className="cs-sec-title">保存方式</div>
            <SaveModeBlock
              value={save}
              onChange={(p) => setSave((s) => ({ ...s, ...p }))}
              disabled={running}
              count={ids.length}
              overwriteHint={`直接覆盖 ${ids.length} 张原图，裁切掉的部分无法恢复。`}
            />
          </div>

          {job && job.total > 0 && (
            <div className="job-banner cs-job">
              <span className={job.running ? 'spinner' : ''} />
              <span>
                {job.running
                  ? `${job.label} · ${job.currentTitle || ''}`
                  : `${job.label}${job.cancelled ? ' · 已取消' : ' · 已完成'}`}
              </span>
              <span className="job-meta">
                {job.done + job.failed} / {job.total}（{pct}%）{job.failed ? ` · 失败 ${job.failed}` : ''}
              </span>
            </div>
          )}

          {pollErr && running && (
            <div className="cs-job" style={{ color: 'var(--err, #e5484d)', fontSize: 12 }}>
              进度读取失败：{pollErr}（仍在重试）
            </div>
          )}

          <div className="cs-foot">
            <button className="btn sm ghost" onClick={onClose} disabled={running}>
              {running ? '后台执行中…' : '关闭'}
            </button>
            {running ? (
              <button className="btn sm danger" onClick={cancel}>
                停止
              </button>
            ) : (
              <button className="btn sm primary" disabled={starting || !ids.length} onClick={start}>
                {starting
                  ? '启动中…'
                  : save.saveMode === 'copy'
                    ? `另存 ${ids.length} 张副本`
                    : `裁切 ${ids.length} 张`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
