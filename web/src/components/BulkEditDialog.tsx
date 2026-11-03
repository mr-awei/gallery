import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AdjustParams, EditJobStatus, EditSaveOptions } from '../types';
import {
  ADJUST_DEFAULTS,
  hasAnyCurve,
  isAdjustDefault,
  isColorGradeDefault,
  isColorMixerDefault,
  isHueSatDefault,
} from '../types';
import { api } from '../api';
import { IconSun } from './Icons';
import ColorRoom, { type FilmstripItem } from './ColorRoom';
import SaveModeBlock, { SAVE_MODE_DEFAULT, type SaveModeState } from './SaveModeBlock';
import type { WbSample } from './AdjustPanel';
import { confirmDialog } from './Dialogs';

const ADJUST_LABELS: Array<
  [Exclude<keyof AdjustParams, 'curves' | 'hueSat' | 'colorMixer' | 'colorGrade'>, string]
> = [
  ['temperature', '色温'],
  ['tint', '色调'],
  ['exposure', '曝光'],
  ['contrast', '对比度'],
  ['highlights', '高光'],
  ['shadows', '阴影'],
  ['whites', '白色'],
  ['blacks', '黑色'],
  ['saturation', '饱和度'],
  ['vibrance', '自然饱和度'],
  ['hue', '色相'],
  ['clarity', '清晰度'],
  ['sharpen', '锐化'],
];

/** 已调项目的摘要，例如「色温 +18 · 高光 -40 · 曲线」 */
function summarize(p: AdjustParams): string {
  const parts = ADJUST_LABELS.filter(([k]) => Math.abs(p[k] as number) >= 0.5).map(
    ([k, label]) => `${label} ${p[k] > 0 ? '+' : ''}${Math.round(p[k] as number)}`
  );
  if (!isHueSatDefault(p.hueSat)) parts.push(p.hueSat.colorize ? '着色' : '色相/饱和度');
  if (!isColorMixerDefault(p.colorMixer)) parts.push('混色器');
  if (!isColorGradeDefault(p.colorGrade)) parts.push('颜色分级');
  if (hasAnyCurve(p.curves)) parts.push('曲线');
  return parts.length ? parts.join(' · ') : '尚未调整参数';
}

interface Props {
  ids: number[];
  /** 预览用的第一张（调色台与直方图都读它） */
  preview?: { src: string; title: string; meta?: string };
  /** 缩略图条：当前页里被选中的图片，点缩略图只换预览对象，参数仍对整批一致 */
  films?: FilmstripItem[];
  onClose: () => void;
  onToast?: (msg: string) => void;
  /** 任务结束回调（刷新列表，让卡片拿到新尺寸/新缩略图） */
  onDone?: () => void;
}

/**
 * 批量调色（Camera Raw）：直接进全屏调色台，调好后一次应用到所有选中图片。
 * 批量「裁切」已独立成 BatchCropStudio（逐张框选），这里只负责统一调色。
 * 处理是服务端异步任务（每张要重编码 + 重算指纹/深度特征），这里轮询 /api/edit/job 显示进度。
 */
export default function BulkEditDialog({ ids, preview, films, onClose, onToast, onDone }: Props) {
  const [adjust, setAdjust] = useState<AdjustParams>(ADJUST_DEFAULTS);
  const [sample, setSample] = useState<WbSample | null>(null);
  const [roomOpen, setRoomOpen] = useState(!!preview);
  // 调色台的缩略图条：切换只换预览对象（直方图/吸管跟着换），参数仍对整批一致
  const [filmId, setFilmId] = useState<number | null>(null);
  const filmList = useMemo(() => (films || []).filter((f) => f.src), [films]);
  const activeFilm = filmList.find((f) => f.id === filmId) || filmList[0];
  const pv = activeFilm
    ? { src: activeFilm.src, title: activeFilm.title, meta: activeFilm.meta }
    : preview;
  const [job, setJob] = useState<EditJobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  // 保存方式：默认覆盖原图；'copy' 时全部副本输出到同一目录，原图不动
  const [save, setSave] = useState<SaveModeState>(SAVE_MODE_DEFAULT);
  const saveMode = save.saveMode;
  const timer = useRef<number | null>(null);
  const startedRef = useRef(false);
  const errCount = useRef(0);
  const [pollErr, setPollErr] = useState('');

  const running = !!job?.running;

  // 任务运行中轮询进度；结束时提示一次并停表
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
          const okCount = s.done;
          const failCount = s.failed;
          onToast?.(
            s.cancelled
              ? `批量编辑已取消（完成 ${okCount} 张，失败 ${failCount} 张）`
              : `批量${s.op === 'crop' ? '裁切' : '调色'}完成：成功 ${okCount} 张${failCount ? `，失败 ${failCount} 张` : ''}`
          );
        }
      } catch (err) {
        // 单次失败继续重试（进度接口偶发抖动），但连续失败说明服务可能没了，
        // 一直转圈会让人以为还在处理 —— 至少把原因摆出来
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
  }, [running, onToast]);

  const start = async () => {
    if (starting || running) return;
    if (saveMode === 'overwrite' && isAdjustDefault(adjust)) {
      onToast?.('调色参数全为 0，无需处理');
      return;
    }
    if (saveMode === 'copy' && !save.targetDir.trim()) {
      onToast?.('请先选择副本保存位置');
      return;
    }
    // 覆盖原图是一次性写回 N 个文件，误点就是批量不可逆：先确认
    if (saveMode === 'overwrite') {
      const ok = await confirmDialog(`将覆盖 ${ids.length} 张图片的原文件（可用 Ctrl+Z 逐张撤销）。继续？`);
      if (!ok) return;
    }
    const saveOpts: EditSaveOptions =
      saveMode === 'copy'
        ? { saveMode: 'copy', targetDir: save.targetDir.trim(), addToLibrary: save.addToLibrary }
        : { saveMode: 'overwrite' };
    setStarting(true);
    try {
      const r = await api.batchEdit(ids, 'adjust', { ...adjust, ...saveOpts });
      setJob(r.job);
      startedRef.current = true;
    } catch (err) {
      onToast?.((err as Error).message || '批量调色启动失败');
    } finally {
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

  const pct = job && job.total ? Math.round((job.done + job.failed) / job.total * 100) : 0;

  // 保存方式：与批量裁切台共用同一段
  const saveModeBlock = (
    <SaveModeBlock
      value={save}
      onChange={(p) => setSave((s) => ({ ...s, ...p }))}
      disabled={running}
      count={ids.length}
      overwriteHint={`直接覆盖 ${ids.length} 张原图，调色后无法恢复。`}
    />
  );

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal-card bulk-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>批量调色 · 已选 {ids.length} 张</b>
          <button className="btn sm ghost" onClick={onClose} disabled={running}>
            ✕
          </button>
        </div>

        <div className="bulk-edit-body">
          <p className="bulk-edit-desc">同一组参数应用到所有选中图片，用于统一白平衡与色调。</p>
          <div className="bulk-color-entry">
            <div className="bulk-color-summary">
              <b>{summarize(adjust)}</b>
              {!isAdjustDefault(adjust) && (
                <button className="btn xs ghost" disabled={running} onClick={() => setAdjust(ADJUST_DEFAULTS)}>
                  重置
                </button>
              )}
            </div>
            <button
              className="btn sm primary"
              disabled={running || !pv}
              onClick={() => setRoomOpen(true)}
              title={pv ? '在调色台里调整参数与曲线' : '当前选中项不在本页，无法预览'}
            >
              <IconSun /> {isAdjustDefault(adjust) ? '打开调色台' : '继续调整'}
            </button>
          </div>
          {!pv && <p className="bulk-edit-desc">选中项不在当前页，取不到预览图；参数仍会应用到全部选中图片。</p>}
        </div>

        {/* 保存方式：默认覆盖原图；另存副本时全部输出到同一目录，原图保留 */}
        <div className="bulk-edit-body">{saveModeBlock}</div>

        {job && (job.total > 0) && (
          <div className="job-banner" style={{ margin: '4px 0' }}>
            <span className={job.running ? 'spin' : ''} />
            <span>
              {job.running
                ? `${job.label} · 正在处理 ${job.currentTitle || ''}`
                : job.cancelled
                  ? '任务已取消'
                  : '任务已结束'}
            </span>
            <span className="job-meta">
              {job.done + job.failed} / {job.total}（{pct}%）{job.failed ? ` · 失败 ${job.failed}` : ''}
            </span>
          </div>
        )}

        {pollErr && running && (
          <p className="bulk-edit-desc" style={{ color: 'var(--err, #e5484d)' }}>
            任务进度读取失败：{pollErr}（仍在重试，可关闭窗口后到图库确认结果）
          </p>
        )}

        <div className="modal-foot">
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
                : saveMode === 'copy'
                  ? `另存 ${ids.length} 张副本`
                  : `调色 ${ids.length} 张`}
            </button>
          )}
        </div>
      </div>

      {/* 批量调色：与单张同一个全屏调色台，预览/直方图用第一张，参数应用到全部 */}
      {roomOpen && pv && (
        <ColorRoom
          src={pv.src}
          title={pv.title}
          meta={pv.meta}
          badge={`批量 · 已选 ${ids.length} 张`}
          note={`参数会统一应用到 ${ids.length} 张图片；预览与直方图取自「${pv.title}」，点底部缩略图可切换预览对象`}
          value={adjust}
          onChange={setAdjust}
          sample={sample}
          onSampleChange={setSample}
          filmstrip={filmList}
          activeFilmId={activeFilm?.id}
          onSelectFilm={(id) => {
            setFilmId(id);
            setSample(null);
          }}
          busy={starting || running}
          onClose={() => setRoomOpen(false)}
          saveBar={
            <>
              <div className="cr-save-mode">{saveModeBlock}</div>
              <div className="lb-edit-actions">
                <button
                  className="btn sm ghost"
                  disabled={starting || running}
                  onClick={() => {
                    setAdjust(ADJUST_DEFAULTS);
                    setSample(null);
                  }}
                >
                  重置
                </button>
                <button
                  className="btn sm primary"
                  disabled={starting || running || (saveMode === 'overwrite' && isAdjustDefault(adjust))}
                  onClick={() => {
                    setRoomOpen(false);
                    void start();
                  }}
                >
                  {starting ? '启动中…' : saveMode === 'copy' ? `另存 ${ids.length} 张` : `应用到 ${ids.length} 张`}
                </button>
              </div>
            </>
          }
        />
      )}
    </div>
  );
}
