import { IconClose } from './Icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJobProgress } from '../hooks/useJobProgress';
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
import i18n from '../i18n';

const ADJUST_LABELS: Array<
  [Exclude<keyof AdjustParams, 'curves' | 'hueSat' | 'colorMixer' | 'colorGrade'>, string]
> = [
  ['temperature', i18n.t('kc4985160')],
  ['tint', i18n.t('k7b996e61')],
  ['exposure', i18n.t('k131f6f6b')],
  ['contrast', i18n.t('kadc0d88f')],
  ['highlights', i18n.t('k57b026b7')],
  ['shadows', i18n.t('k803205e3')],
  ['whites', i18n.t('k2fc96b27')],
  ['blacks', i18n.t('k9d2d1f62')],
  ['saturation', i18n.t('kbd05021d')],
  ['vibrance', i18n.t('k2fcb9a85')],
  ['hue', i18n.t('k8b232299')],
  ['clarity', i18n.t('k48f1cd8c')],
  ['sharpen', i18n.t('kab3312d7')],
];

/** 已调项目的摘要，例如「色温 +18 · 高光 -40 · 曲线」 */
function summarize(p: AdjustParams): string {
  const parts = ADJUST_LABELS.filter(([k]) => Math.abs(p[k] as number) >= 0.5).map(
    ([k, label]) => `${label} ${p[k] > 0 ? '+' : ''}${Math.round(p[k] as number)}`
  );
  if (!isHueSatDefault(p.hueSat)) parts.push(p.hueSat.colorize ? i18n.t('kbbed11a8') : i18n.t('k0a2ef31f'));
  if (!isColorMixerDefault(p.colorMixer)) parts.push(i18n.t('kc6ac64d9'));
  if (!isColorGradeDefault(p.colorGrade)) parts.push(i18n.t('k5e41d36a'));
  if (hasAnyCurve(p.curves)) parts.push(i18n.t('k586dc275'));
  return parts.length ? parts.join(' · ') : i18n.t('k25416973');
}

interface Props {
  ids: number[];
  /** 预览用的第一张（调色台与直方图都读它） */
  preview?: { src: string; title: string; meta?: string };
  /** 缩略图条：当前页里被选中的图片，点缩略图只换预览对象，参数仍对整批一致 */
  films?: FilmstripItem[];
  onClose: () => void;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
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
  // 保存方式：默认另存副本（原图不动）；目录留空则副本落在各自原图旁边
  const [save, setSave] = useState<SaveModeState>(SAVE_MODE_DEFAULT);
  const saveMode = save.saveMode;
  const startedRef = useRef(false);
  const errCount = useRef(0);
  const [pollErr, setPollErr] = useState('');

  const running = !!job?.running;

  // 进度走 SSE job 快照；只有在连续 10s 收不到推送时才低频兜底拉接口
  const applyStatus = useCallback(
    (s: EditJobStatus) => {
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
            ? i18n.t('k8c04fc3a', { p0: okCount, p1: failCount })
            : i18n.t('k41e0b4f2', { p0: s.op === 'crop' ? i18n.t('k096cbe88') : i18n.t('k9e368d03'), p1: okCount, p2: failCount ? i18n.t('kfb601e6f', { p0: failCount }) : '' })
        );
      }
    },
    [onDone, onToast]
  );

  const pollOnce = useCallback(async () => {
    try {
      applyStatus(await api.editJob());
    } catch (err) {
      // 连续失败说明服务可能断了，不能一直装成「正在处理」
      errCount.current += 1;
      if (errCount.current >= 3) setPollErr((err as Error).message || i18n.t('ke033d67c'));
    }
  }, [applyStatus]);

  useJobProgress((d) => {
    if (d?.edit) applyStatus(d.edit as EditJobStatus);
  }, pollOnce, running);

  const start = async () => {
    if (starting || running) return;
    if (saveMode === 'overwrite' && isAdjustDefault(adjust)) {
      onToast?.(i18n.t('kd2e2f62d'));
      return;
    }
    // 覆盖原图是一次性写回 N 个文件，误点就是批量不可逆：先确认
    if (saveMode === 'overwrite') {
      const ok = await confirmDialog(i18n.t('kded21324', { p0: ids.length }));
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
      onToast?.((err as Error).message || i18n.t('k04979f21'));
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
      overwriteHint={i18n.t('k0d1331a3', { p0: ids.length })}
    />
  );

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal-card bulk-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>批量调色 · 已选 {ids.length} 张</b>
          <button className="btn sm ghost" onClick={onClose} disabled={running} aria-label={i18n.t('kb15d9127')}>
            <IconClose size={14} />
          </button>
        </div>

        <div className="bulk-edit-body">
          <p className="bulk-edit-desc">{i18n.t('kfcdf6b50')}</p>
          <div className="bulk-color-entry">
            <div className="bulk-color-summary">
              <b>{summarize(adjust)}</b>
              {!isAdjustDefault(adjust) && (
                <button className="btn xs ghost" disabled={running} onClick={() => setAdjust(ADJUST_DEFAULTS)}>
                  {i18n.t('k4b9c3271')}
                </button>
              )}
            </div>
            <button
              className="btn sm primary"
              disabled={running || !pv}
              onClick={() => setRoomOpen(true)}
              title={pv ? i18n.t('kabab8e16') : i18n.t('ke77867ba')}
            >
              <IconSun /> {isAdjustDefault(adjust) ? i18n.t('k4c9b85b0') : i18n.t('k381ee076')}
            </button>
          </div>
          {!pv && <p className="bulk-edit-desc">{i18n.t('ke5e060b5')}</p>}
        </div>

        {/* 保存方式：默认覆盖原图；另存副本时全部输出到同一目录，原图保留 */}
        <div className="bulk-edit-body">{saveModeBlock}</div>

        {job && (job.total > 0) && (
          <div className="job-banner" style={{ margin: '4px 0' }}>
            <span className={job.running ? 'spin' : ''} />
            <span>
              {job.running
                ? i18n.t('k58f94c3d', { p0: job.label, p1: job.currentTitle || '' })
                : job.cancelled
                  ? i18n.t('k58518d0a')
                  : i18n.t('k13313756')}
            </span>
            <span className="job-meta">
              {job.done + job.failed} / {job.total}（{pct}%）{job.failed ? i18n.t('k1b84532a', { p0: job.failed }) : ''}
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
            {running ? i18n.t('k5e59fed7') : i18n.t('kb15d9127')}
          </button>
          {running ? (
            <button className="btn sm danger" onClick={cancel}>
              {i18n.t('k095e938e')}
            </button>
          ) : (
            <button className="btn sm primary" disabled={starting || !ids.length} onClick={start}>
              {starting
                ? i18n.t('kf6196bb1')
                : saveMode === 'copy'
                  ? i18n.t('k36bd39f5', { p0: ids.length })
                  : i18n.t('kaa39c864', { p0: ids.length })}
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
          badge={i18n.t('k1f4021f4', { p0: ids.length })}
          note={i18n.t('kc34b4d34', { p0: ids.length, p1: pv.title })}
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
                  {i18n.t('k4b9c3271')}
                </button>
                <button
                  className="btn sm primary"
                  disabled={starting || running || (saveMode === 'overwrite' && isAdjustDefault(adjust))}
                  onClick={() => {
                    setRoomOpen(false);
                    void start();
                  }}
                >
                  {starting ? i18n.t('kf6196bb1') : saveMode === 'copy' ? i18n.t('kcc1dafb6', { p0: ids.length }) : i18n.t('kd9067042', { p0: ids.length })}
                </button>
              </div>
            </>
          }
        />
      )}
    </div>
  );
}
