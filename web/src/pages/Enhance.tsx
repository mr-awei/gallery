import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, quiet } from '../api';
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

interface Props {
  onToast: (msg: string) => void;
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
    loadAll().catch(() => onToast('加载增强数据失败'));
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
              `增强完成：成功 ${st.done} 张${st.skipped ? `，跳过 ${st.skipped} 张（已达标）` : ''}${
                st.failed ? `，失败 ${st.failed} 张` : ''
              }`
            );
            loadCandidates();
            onLibraryChanged();
          }
        }
        if (d?.aiUp && aiStatusRef.current?.downloading) {
          const st = d.aiUp;
          setAiStatus(st);
          if (!st.downloading && st.installed) {
            onToast('AI 超分运行库安装完成');
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
    setProcessing((p) => new Set(p).add(id));
    try {
      const { item, noop } = await api.enhanceImage(id, model, candidates.standard);
      if (noop) {
        // 库记录与磁盘不同步时会出现「列表里有、实际已达标」：底层什么都没做，
        // 不能报「已增强至 W×H」，重新拉一次列表让服务端按真实尺寸重新判定
        onToast(`该图已是 ${item.width}×${item.height}，无需增强`);
        candReqRef.current += 1;
        setCandidates((prev) => ({
          ...prev,
          count: Math.max(0, prev.count - 1),
          items: prev.items.filter((it) => it.id !== id),
        }));
        refresh();
        return;
      }
      onToast(`已增强至 ${item.width}×${item.height}`);
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
      onToast(`增强失败：${(err as Error).message}`);
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
    if (isAi && !window.confirm(`AI 超分较慢（每张约数秒到数十秒），将处理 ${candidates.count} 张，可能耗时较长。继续？`)) {
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
      onToast(`启动失败：${(err as Error).message}`);
    }
  };

  const cancelJob = async () => {
    const st = await api.enhanceJobCancel();
    setJob(st);
    onToast('已请求停止，当前这张完成即停');
  };

  const installAi = async () => {
    await api.aiUpscaleInstall();
    const st = await api.aiUpscaleStatus();
    setAiStatus(st);
    onToast('已开始下载 AI 超分运行库（约 43MB），请留意进度');
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
          <h1 className="page-title">画质增强</h1>
          <div className="page-sub">
            低于标准的图片会自动收录于此，一键放大至标准以上，结果覆盖原文件（其他软件打开即为增强后效果）
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)} disabled={!!job?.running}>
            <optgroup label="内置插值放大（离线·快速，不生成新细节）">
              {models.builtin.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}（插值）
                </option>
              ))}
            </optgroup>
            <optgroup label="AI 超分模型（Real-ESRGAN）">
              {models.ai.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.available}>
                  {m.label}
                  {m.available ? '' : '（未安装）'}
                </option>
              ))}
            </optgroup>
            {models.remote.length > 0 && (
              <optgroup label="线上服务">
                {models.remote.map((r) => (
                  <option key={r.id} value={`remote:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn" onClick={refresh} disabled={!!job?.running} title="重新读取待增强列表">
            <IconRefresh /> 刷新
          </button>
          {job?.running ? (
            <button className="btn danger" onClick={cancelJob}>
              停止增强
            </button>
          ) : (
            <button className="btn primary" disabled={!candidates.items.length} onClick={doAll}>
              <IconWand /> 一键增强全部（{candidates.items.length}）
            </button>
          )}
        </div>
      </div>

      {isAi && !models.aiInstalled && (
        <div className="missing-banner" style={{ marginBottom: 14 }}>
          <div className="missing-banner-text">
            <b>⚠ AI 超分运行库尚未安装</b>
            <p>AI 模型需要先下载 Real-ESRGAN 运行库（约 43MB，免 Python / 免 CUDA），下载后即可离线使用。</p>
          </div>
          <div className="missing-banner-actions">
            <button className="btn sm primary" disabled={aiStatus?.downloading} onClick={installAi}>
              {aiStatus?.downloading ? `下载中 ${aiStatus.progress}%` : '立即下载安装'}
            </button>
          </div>
        </div>
      )}

      {aiStatus?.downloading && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="label">正在下载 AI 超分运行库</div>
          <div className="enh-progress" style={{ marginTop: 8 }}>
            <div style={{ width: `${aiStatus.progress}%` }} />
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {aiStatus.message} · 下载期间可继续浏览其他页面
          </div>
        </div>
      )}

      {job?.running && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="label">
            增强进行中：{jobHandled} / {job.total}（{progressPct}%）
            {job.skipped ? ` · 跳过 ${job.skipped}` : ''}
            {job.failed ? ` · 失败 ${job.failed}` : ''}
          </div>
          <div className="enh-progress" style={{ marginTop: 8 }}>
            <div style={{ width: `${progressPct}%` }} />
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            正在处理：{job.currentTitle || `图片 ${job.currentId}`}
            {job.currentIndeterminate
              ? ' · 模型推理中（这一档拿不到中间进度）'
              : job.currentProgress > 0
                ? ` · 当前 ${Math.round(job.currentProgress * 100)}%`
                : ''}
          </div>
        </div>
      )}

      {job && !job.running && job.total > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="label">
            上次任务：成功 {job.done} 张{job.skipped ? `，跳过 ${job.skipped} 张（已达标）` : ''}
            {job.failed ? `，失败 ${job.failed} 张` : ''}
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
          <div className="label">当前目标标准</div>
          <div className="value">{standardLabel}</div>
        </div>
        <div>
          <div className="label">待增强图片</div>
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
          <div className="label">当前模型</div>
          <div className="hint">
            {builtinModel ? `${builtinModel.engineLabel || '插值放大（非 AI 超分）'} · ${modelDesc}` : modelDesc}
          </div>
          {builtinModel && (
            <div className="hint" style={{ marginTop: 2, color: 'var(--warn)' }}>
              插值只是把像素撑大、再锐化，不会补出原本没有的细节；想真正补细节请选「AI 超分模型」
            </div>
          )}
        </div>
        {models.aiInstalled && (
          <div>
            <div className="label">AI 加速设备</div>
            <div className="hint">{aiStatus?.gpu || '正在自检…'}</div>
          </div>
        )}
        <div className="hint" style={{ maxWidth: 320 }}>
          {models.aiInstalled
            ? '建议选 AI 超分模型：内置模型只是插值放大（像素数真实增加，但不会产生新细节）；AI 会合成细节，画质提升明显'
            : '标准与默认模型可在「设置 → 画质增强」里自定义；安装 AI 运行库可获得真正的画质提升'}
        </div>
      </div>

      {!candidates.items.length && (
        <div className="empty">
          <div className="big">✨</div>
          <h3>没有低于标准的图片</h3>
          <p>当前标准下所有图片都已达标。可在「设置 → 画质增强」提高目标标准试试。</p>
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
              onClick={() => doEnhance(item.id)}
            >
              <IconWand /> {processing.has(item.id) ? '增强中…' : '增强'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
