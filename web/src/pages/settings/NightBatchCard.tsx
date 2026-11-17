import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  onToast: (msg: string, type?: 'info' | 'error') => void;
}

const TASKS: { key: 'semantic' | 'face'; label: string; hint: string }[] = [
  { key: 'semantic', label: i18n.t('kdcec5f42'), hint: i18n.t('ke0d26045') },
  { key: 'face', label: i18n.t('k6945ac81'), hint: i18n.t('ke42b82fa') },
];

/**
 * AI 夜间批处理：把「白天来不及跑完的索引」挪到夜里。
 *
 * 放在 AI 区而不是任务中心，是因为它是一份「长期策略」（时段 + 任务勾选），
 * 不是一次性动作；任务中心那边只在真正跑起来时出现一条可取消的记录。
 */
export default function NightBatchCard({ onToast }: Props) {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.nightBatch>> | null>(null);
  const [busy, setBusy] = useState('');
  const timer = useRef<number | null>(null);

  const load = useCallback(
    (silent = false) => {
      api
        .nightBatch()
        .then(setState)
        .catch((err) => {
          if (!silent) onToast(i18n.t('kd96f4827', { p0: (err as Error).message }), 'error');
        });
    },
    [onToast]
  );

  useEffect(() => load(), [load]);

  // 跑着的时候看进度，闲着的时候慢一点轮询（不为了一个空闲开关持续打接口）
  useEffect(() => {
    const iv = window.setInterval(() => load(true), state?.running ? 1200 : 8000);
    timer.current = iv;
    return () => window.clearInterval(iv);
  }, [load, state?.running]);

  const save = async (patch: { enabled?: boolean; start?: string; end?: string; tasks?: string[] }) => {
    try {
      setState(await api.saveNightBatch(patch));
    } catch (err) {
      onToast(i18n.t('k837dd027', { p0: (err as Error).message }), 'error');
    }
  };

  const toggleTask = (key: string, on: boolean) => {
    const cur = state?.tasks || [];
    const next = on ? [...new Set([...cur, key])] : cur.filter((t) => t !== key);
    if (!next.length) {
      onToast(i18n.t('k0af8b85e'), 'info');
      return;
    }
    void save({ tasks: next });
  };

  const runNow = async () => {
    setBusy('run');
    try {
      const r = await api.runNightBatch();
      if (r.status) setState(r.status);
      onToast(r.summary ? i18n.t('k26278f8f', { p0: r.summary }) : i18n.t('k236a141a'));
    } catch (err) {
      onToast(i18n.t('kd96e3f54', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      const r = await api.stopNightBatch();
      if (r.status) setState(r.status);
      onToast(r.message || i18n.t('k82977854'), 'info');
    } catch (err) {
      onToast(i18n.t('k8ce513f7', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  const pct = state && state.total > 0 ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  const pending = state?.pending || { semantic: 0, face: 0, total: 0 };
  const taskLabel = state?.task === 'semantic' ? i18n.t('kdcec5f42') : state?.task === 'face' ? i18n.t('k6945ac81') : '';

  return (
    <Card
      title={i18n.t('k41284d5b')}
      desc={i18n.t('k712d01d7')}
      badge={state?.running ? <span className="badge">{taskLabel || i18n.t('kd679aea3')} {pct}%</span> : undefined}
    >
      <label className="hint" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={!!state?.enabled}
          disabled={!state}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        {i18n.t('k6e782fb9')}
      </label>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
        <span className="hint">{i18n.t('k6de97eb2')}</span>
        <input
          className="input sm"
          type="time"
          style={{ width: 110 }}
          value={state?.startText || '02:00'}
          disabled={!state?.enabled}
          onChange={(e) => void save({ start: e.target.value })}
        />
        <span className="hint">{i18n.t('kd716f1e8')}</span>
        <input
          className="input sm"
          type="time"
          style={{ width: 110 }}
          value={state?.endText || '06:00'}
          disabled={!state?.enabled}
          onChange={(e) => void save({ end: e.target.value })}
        />
        <span className="hint">{i18n.t('kbcfb2ae9')}</span>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
        {TASKS.map((t) => {
          const num = t.key === 'semantic' ? pending.semantic : pending.face;
          return (
            <label key={t.key} className="hint" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                style={{ marginTop: 3 }}
                checked={(state?.tasks || []).includes(t.key)}
                disabled={!state?.enabled}
                onChange={(e) => toggleTask(t.key, e.target.checked)}
              />
              <span>
                {t.label}
                <br />
                <span className="tiny muted">
                  {t.hint} · 待补 {num} 张
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {state?.running && (
        <div style={{ marginTop: 10 }}>
          <div className="hint">
            {taskLabel || i18n.t('kf76540a9')} {state.done} / {state.total} 张
            {state.total > 0 ? `（${pct}%）` : ''}
          </div>
          <div style={{ height: 6, background: 'var(--bg-3)', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .3s' }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button
          className="btn sm"
          disabled={!!busy || state?.running || !pending.total}
          onClick={() => void runNow()}
        >
          {busy === 'run' ? i18n.t('kf6196bb1') : i18n.t('k719e6484')}
        </button>
        {state?.running && (
          <button className="btn sm ghost" disabled={busy === 'stop' || state.stopRequested} onClick={() => void stop()}>
            {state.stopRequested ? i18n.t('k06e7df32') : i18n.t('k095e938e')}
          </button>
        )}
      </div>

      <div className="hint" style={{ marginTop: 8, lineHeight: 1.8 }}>
        {pending.total === 0 ? i18n.t('k1a1be048') : i18n.t('kb6133c4b', { p0: pending.semantic, p1: pending.face })}
        {state?.enabled && !state.running && state.skipped ? i18n.t('k51fa284f', { p0: state.skipped }) : ''}
        {state?.lastAt ? (
          <>
            <br />
            {i18n.t('kf6b34e52', { p0: new Date(state.lastAt).toLocaleString(), p1: state.lastSummary ? ` · ${state.lastSummary}` : '' })}
          </>
        ) : (
          <>
            <br />
            {i18n.t('k0b0ee40a')}
          </>
        )}
        {state?.lastError ? (
          <>
            <br />
            <span className="err">{i18n.t('k7ea5a870', { p0: state.lastError })}</span>
          </>
        ) : null}
      </div>
    </Card>
  );
}
