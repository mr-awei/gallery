import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, quiet } from '../api';
import { confirmDialog } from '../components/Dialogs';
import { ensureHardware, hardwareFeatureForModel } from '../lib/hardware';
import { subscribeEvents } from '../events';
import type {
  AiUpscaleStatus,
  EnhanceCandidates,
  EnhanceConfig,
  EnhanceJobStatus,
  EnhanceModel,
  EnhanceRemoteService,
  EnhanceStandard,
  ImageItem,
} from '../types';
import { IconRefresh, IconWand } from '../components/Icons';
import { IconWarning } from '../components/Icons';
import i18n from '../i18n';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onLibraryChanged: () => void;
}

export default function Enhance({ onToast, onLibraryChanged }: Props) {
  const [standards, setStandards] = useState<EnhanceStandard[]>([]);
  const [config, setConfig] = useState<EnhanceConfig | null>(null);
  const [candidates, setCandidates] = useState<EnhanceCandidates>({ standard: '1080p', count: 0, items: [] });
  const [models, setModels] = useState<{
    builtin: EnhanceModel[];
    remote: EnhanceRemoteService[];
    ai: { id: string; label: string; desc: string; available?: boolean }[];
    aiInstalled: boolean;
  }>({ builtin: [], remote: [], ai: [], aiInstalled: false });
  const [aiStatus, setAiStatus] = useState<AiUpscaleStatus | null>(null);
  const [model, setModel] = useState('');
  const [processing, setProcessing] = useState<Set<number>>(new Set());
  const [job, setJob] = useState<EnhanceJobStatus | null>(null);

  const isAi = model.startsWith('ai-');

  // 用序号防止「晚到的旧响应」覆盖新列表（增强后列表变化很快，必须只认最新一次请求）
  const candReqRef = useRef(0);
  const loadCandidates = useCallback(async () => {
    const reqId = ++candReqRef.current;
    try {
      const c = await api.enhanceCandidates();
      if (reqId === candReqRef.current) setCandidates(c);
    } catch {
      /* ignore */
    }
  }, []);

  const loadAll = useCallback(async () => {
    const [std, md, ai, jb] = await Promise.all([
      api.enhanceStandards(),
      api.enhanceModels(),
      api.aiUpscaleStatus().catch(() => null),
      api.enhanceJob().catch(() => null),
    ]);
    setStandards(std.standards);
    setConfig(std.config);
    setModels(md);
    // 默认优先用 AI 超分模型：内置模型只是插值放大（像素变多但不产生新细节），
    // AI 才会真正合成细节。已装社区模型时优先 NMKD-Siax 200k（真人照片画质最佳）
    const aiUsable = md.ai.filter((m: { available?: boolean }) => m.available);
    const preferred =
      aiUsable.find((m: { id: string }) => m.id === 'esrgan:4x_NMKD-Siax_200k') || aiUsable[0];
    setModel(
      (m) => m || (md.aiInstalled ? preferred?.id || md.ai[0]?.id : '') || std.config.model || md.builtin[0]?.id || ''
    );
    if (ai) setAiStatus(ai);
    if (jb) setJob(jb);
    loadCandidates(); // 走带序号防护的同一入口
  }, [loadCandidates]);

  useEffect(() => {
    loadAll().catch(() => onToast(i18n.t('kcc81ccea')));
  }, [loadAll]);

  // 任务进行中 / 运行库下载中 → 订阅 job 事件（原 1s 轮询，现为服务端变化才推送）
  const jobRef = useRef(job);
  jobRef.current = job;
  const aiStatusRef = useRef(aiStatus);
  aiStatusRef.current = aiStatus;

  useEffect(() => {
    let tick = 0;
    const off = subscribeEvents('job', (d) => {
      try {
        if (d?.enhance && jobRef.current?.running) {
          const st = d.enhance;
          setJob(st);
          // 批量处理中：周期性同步一次列表，已完成的图片及时从「待增强」里消失
          tick += 1;
          if (tick % 5 === 0) loadCandidates();
          if (!st.running) {
            onToast(
              i18n.t('kfc569c0c', { p0: st.done, p1: st.skipped ? i18n.t('k342d9d9c', { p0: st.skipped }) : '', p2: st.failed ? i18n.t('kfb601e6f', { p0: st.failed }) : '' })
            );
            loadCandidates();
            onLibraryChanged();
          }
        }
        if (d?.aiUp && aiStatusRef.current?.downloading) {
          const st = d.aiUp;
          setAiStatus(st);
          if (!st.downloading && st.installed) {
            onToast(i18n.t('k556a8470'));
            api.enhanceModels().then(setModels).catch(quiet);
          }
        }
      } catch {
        /* ignore */
      }
    });
    return () => {
      off();
    };
  }, [loadCandidates, onLibraryChanged, onToast]);

  const refresh = useCallback(() => {
    loadCandidates();
    onLibraryChanged();
  }, [loadCandidates, onLibraryChanged]);

  const doEnhance = async (id: number) => {
    // 模型档（Vulkan 外部程序 / Swin2SR）先过硬件门槛：内插值档不碰模型，不用检查
    if (!(await ensureHardware(hardwareFeatureForModel(model)))) return;
    setProcessing((p) => new Set(p).add(id));
    try {
      const { item, noop } = await api.enhanceImage(id, model, candidates.standard);
      if (noop) {
        // 库记录与磁盘不同步时会出现「列表里有、实际已达标」：底层什么都没做，
        // 不能报「已增强至 W×H」，重新拉一次列表让服务端按真实尺寸重新判定
        onToast(i18n.t('k532bf855', { p0: item.width, p1: item.height }));
        candReqRef.current += 1;
        setCandidates((prev) => ({
          ...prev,
          count: Math.max(0, prev.count - 1),
          items: prev.items.filter((it) => it.id !== id),
        }));
        refresh();
        return;
      }
      onToast(i18n.t('kcfc980d6', { p0: item.width, p1: item.height }));
      // 立即从本页列表移除（该图已达标），不等网络往返，界面马上可见变化
      candReqRef.current += 1; // 作废所有在途请求，避免旧列表把它又加回来
      setCandidates((prev) => ({
        ...prev,
        count: Math.max(0, prev.count - 1),
        items: prev.items.filter((it) => it.id !== id),
      }));
      // 再从服务端拉一次，补上因达到上限而未显示的图片
      refresh();
    } catch (err) {
      onToast(i18n.t('k7af59a2d', { p0: (err as Error).message }), 'error');
    } finally {
      setProcessing((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
    }
  };

  const doAll = async () => {
    if (!candidates.items.length) return;
    if (!(await ensureHardware(hardwareFeatureForModel(model)))) return;
    if (
      isAi &&
      !(await confirmDialog(i18n.t('k9717a0e9', { p0: candidates.count })))
    ) {
      return;
    }
    try {
      const st = await api.enhanceJobStart(
        candidates.items.map((i) => i.id),
        model,
        candidates.standard
      );
      setJob(st);
    } catch (err) {
      onToast(i18n.t('kd96e3f54', { p0: (err as Error).message }), 'error');
    }
  };

  const cancelJob = async () => {
    const st = await api.enhanceJobCancel();
    setJob(st);
    onToast(i18n.t('k7156f40a'));
  };

  const installAi = async () => {
    await api.aiUpscaleInstall();
    const st = await api.aiUpscaleStatus();
    setAiStatus(st);
    onToast(i18n.t('k1ee08f4b'));
  };

  const standardLabel = standards.find((s) => s.key === candidates.standard)?.label || candidates.standard;
  // 内置四档只是插值 + 锐化，必须自己把话说清楚：像素变多但在「细节」上没有增益
  const builtinModel = models.builtin.find((m) => m.id === model);
  const modelDesc =
    builtinModel?.desc ||
    models.ai.find((m) => m.id === model)?.desc ||
    models.remote.find((r) => `remote:${r.id}` === model)?.name ||
    '—';

  // 跳过的（已达标）也算已处理，否则进度条会停在半路
  const jobHandled = job ? job.done + (job.skipped || 0) + job.failed : 0;
  const progressPct = job ? Math.round((jobHandled / Math.max(1, job.total)) * 100) : 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{i18n.t('kfd5e4c21')}</h1>
          <div className="page-sub">
            {i18n.t('k5276785e')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)} disabled={!!job?.running}>
            <optgroup label={i18n.t('kef42ed9d')}>
              {models.builtin.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}（插值）
                </option>
              ))}
            </optgroup>
            <optgroup label={i18n.t('k2444b1fb')}>
              {models.ai.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.available}>
                  {m.label}
                  {m.available ? '' : i18n.t('k6e8eee75')}
                </option>
              ))}
            </optgroup>
            {models.remote.length > 0 && (
              <optgroup label={i18n.t('k9ec2b4af')}>
                {models.remote.map((r) => (
                  <option key={r.id} value={`remote:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn" onClick={refresh} disabled={!!job?.running} title={i18n.t('ka6ddc9a2')}>
            <IconRefresh /> {i18n.t('k694fc5ef')}
          </button>
          {job?.running ? (
            <button className="btn danger" onClick={cancelJob}>
              {i18n.t('k1f8868a5')}
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={!candidates.items.length}
              title={!candidates.items.length ? i18n.t('ka0ef75e8') : i18n.t('k381f9d45')}
              onClick={doAll}
            >
              <IconWand /> 一键增强全部（{candidates.items.length}）
            </button>
          )}
        </div>
      </div>

      {isAi && !models.aiInstalled && (
        <div className="missing-banner" style={{ marginBottom: 14 }}>
          <div className="missing-banner-text">
            <b><IconWarning size={13} /> {i18n.t('kb46a2579')}</b>
            <p>{i18n.t('k4f61dc40')}</p>
          </div>
          <div className="missing-banner-actions">
            <button
              className="btn sm primary"
              disabled={aiStatus?.downloading}
              title={aiStatus?.downloading ? i18n.t('ka5c35bc3') : i18n.t('k1cda8bff')}
              onClick={installAi}
            >
              {aiStatus?.downloading
                ? aiStatus.progress >= 0
                  ? i18n.t('ke8ffc780', { p0: aiStatus.progress })
                  : i18n.t('k0164eeb4')
                : i18n.t('kf2109a17')}
            </button>
          </div>
        </div>
      )}

      {aiStatus?.downloading && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="label">{i18n.t('kcb5a7ced')}</div>
          {/* 进度未知（拿不到 Content-Length）时不画进度条，只留已下载体积的文字说明 */}
          {aiStatus.progress >= 0 && (
            <div className="enh-progress" style={{ marginTop: 8 }}>
              <div style={{ width: `${aiStatus.progress}%` }} />
            </div>
          )}
          <div className="hint" style={{ marginTop: 6 }}>
            {aiStatus.message} · 下载期间可继续浏览其他页面
          </div>
        </div>
      )}

      {job?.running && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="label">
            增强进行中：{jobHandled} / {job.total}（{progressPct}%）
            {job.skipped ? i18n.t('k61a2b59a', { p0: job.skipped }) : ''}
            {job.failed ? i18n.t('k1b84532a', { p0: job.failed }) : ''}
          </div>
          <div className="enh-progress" style={{ marginTop: 8 }}>
            <div style={{ width: `${progressPct}%` }} />
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            正在处理：{job.currentTitle || i18n.t('kaea8b780', { p0: job.currentId })}
            {job.currentIndeterminate
              ? i18n.t('kd058d034')
              : job.currentProgress > 0
                ? i18n.t('k16762c50', { p0: Math.round(job.currentProgress * 100) })
                : ''}
          </div>
        </div>
      )}

      {job && !job.running && job.total > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="label">
            上次任务：成功 {job.done} 张{job.skipped ? i18n.t('k342d9d9c', { p0: job.skipped }) : ''}
            {job.failed ? i18n.t('kfb601e6f', { p0: job.failed }) : ''}
          </div>
          {job.failures.length > 0 && (
            <div className="hint" style={{ marginTop: 6 }}>
              失败原因示例：{job.failures[0].error}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div className="label">{i18n.t('k7d472d65')}</div>
          <div className="value">{standardLabel}</div>
        </div>
        <div>
          <div className="label">{i18n.t('k5204cc35')}</div>
          <div className="value" style={{ color: candidates.count ? 'var(--warn)' : 'var(--ok)' }}>
            {candidates.count} 张
          </div>
        </div>
        {candidates.count > candidates.items.length && (
          <div className="hint" style={{ maxWidth: 200 }}>
            列表最多加载 {candidates.items.length} 张，已显示最小的那些，其余处理完会自动补上
          </div>
        )}
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="label">{i18n.t('ke18ae875')}</div>
          <div className="hint">
            {builtinModel ? `${builtinModel.engineLabel || i18n.t('kc042c84f')} · ${modelDesc}` : modelDesc}
          </div>
          {builtinModel && (
            <div className="hint" style={{ marginTop: 2, color: 'var(--warn)' }}>
              {i18n.t('k80007f67')}
            </div>
          )}
        </div>
        {models.aiInstalled && (
          <div>
            <div className="label">{i18n.t('k6ce742e0')}</div>
            <div className="hint">{aiStatus?.gpu || i18n.t('k0cbe8ecb')}</div>
          </div>
        )}
        <div className="hint" style={{ maxWidth: 320 }}>
          {models.aiInstalled
            ? i18n.t('kb098d6f5')
            : i18n.t('kd0297a3f')}
        </div>
      </div>

      {!candidates.items.length && (
        <div className="empty">
          <div className="big"><IconWand size={42} /></div>
          <h3>{i18n.t('kbbb8517a')}</h3>
          <p>{i18n.t('k981d390c')}</p>
        </div>
      )}

      <div className="enh-grid">
        {candidates.items.map((item: ImageItem) => (
          <div className="enh-card" key={item.id}>
            <img src={item.thumbUrl} alt={item.title} loading="lazy" />
            <div className="enh-meta">
              <span className="tag-pill warn">
                {item.width}×{item.height}
              </span>
              <span className="enh-arrow">→</span>
              <span className="tag-pill ok">{standardLabel.split('（')[0]}</span>
            </div>
            <button
              className="btn sm primary"
              disabled={processing.has(item.id) || !!job?.running || (isAi && !models.aiInstalled)}
              title={
                isAi && !models.aiInstalled
                  ? i18n.t('k4545bdb3')
                  : job?.running
                    ? i18n.t('ka56e02ce')
                    : processing.has(item.id)
                      ? i18n.t('k9f79db2e')
                      : undefined
              }
              onClick={() => doEnhance(item.id)}
            >
              <IconWand /> {processing.has(item.id) ? i18n.t('k15b69940') : i18n.t('k9a5e2729')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
