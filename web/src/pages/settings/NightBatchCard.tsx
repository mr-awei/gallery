import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import Card from './Card';

interface Props {
  onToast: (msg: string, type?: 'info' | 'error') => void;
}

const TASKS: { key: 'semantic' | 'face'; label: string; hint: string }[] = [
  { key: 'semantic', label: '语义索引', hint: '让「以图搜图 / 语义搜索」能命中晚上导入的图' },
  { key: 'face', label: '人脸索引', hint: '人物页的分组与命名' },
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
          if (!silent) onToast(`夜间批处理状态读取失败：${(err as Error).message}`, 'error');
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
      onToast(`保存失败：${(err as Error).message}`, 'error');
    }
  };

  const toggleTask = (key: string, on: boolean) => {
    const cur = state?.tasks || [];
    const next = on ? [...new Set([...cur, key])] : cur.filter((t) => t !== key);
    if (!next.length) {
      onToast('至少要留一项，否则夜里没事可做', 'info');
      return;
    }
    void save({ tasks: next });
  };

  const runNow = async () => {
    setBusy('run');
    try {
      const r = await api.runNightBatch();
      if (r.status) setState(r.status);
      onToast(r.summary ? `本轮完成：${r.summary}` : '已开始处理');
    } catch (err) {
      onToast(`启动失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      const r = await api.stopNightBatch();
      if (r.status) setState(r.status);
      onToast(r.message || '已停止', 'info');
    } catch (err) {
      onToast(`停止失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const pct = state && state.total > 0 ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  const pending = state?.pending || { semantic: 0, face: 0, total: 0 };
  const taskLabel = state?.task === 'semantic' ? '语义索引' : state?.task === 'face' ? '人脸索引' : '';

  return (
    <Card
      title="AI 夜间批处理"
      desc="导入后没来得及建的语义 / 人脸索引，留到你设定的时段再补：串行执行、不抢界面。只补缺失的那些，中途关机或切库都能接着来。"
      badge={state?.running ? <span className="badge">{taskLabel || '运行中'} {pct}%</span> : undefined}
    >
      <label className="hint" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={!!state?.enabled}
          disabled={!state}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        开启夜间批处理
      </label>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
        <span className="hint">时段</span>
        <input
          className="input sm"
          type="time"
          style={{ width: 110 }}
          value={state?.startText || '02:00'}
          disabled={!state?.enabled}
          onChange={(e) => void save({ start: e.target.value })}
        />
        <span className="hint">到</span>
        <input
          className="input sm"
          type="time"
          style={{ width: 110 }}
          value={state?.endText || '06:00'}
          disabled={!state?.enabled}
          onChange={(e) => void save({ end: e.target.value })}
        />
        <span className="hint">（跨午夜可以设成 22:00 到 06:00）</span>
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
            {taskLabel || '准备中'} {state.done} / {state.total} 张
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
          {busy === 'run' ? '启动中…' : '现在跑一轮'}
        </button>
        {state?.running && (
          <button className="btn sm ghost" disabled={busy === 'stop' || state.stopRequested} onClick={() => void stop()}>
            {state.stopRequested ? '正在收尾…' : '停止'}
          </button>
        )}
      </div>

      <div className="hint" style={{ marginTop: 8, lineHeight: 1.8 }}>
        {pending.total === 0 ? '当前没有需要补算的图片。' : `待处理：语义 ${pending.semantic} 张 · 人脸 ${pending.face} 张。`}
        {state?.enabled && !state.running && state.skipped ? `现在没跑：${state.skipped}。` : ''}
        {state?.lastAt ? (
          <>
            <br />
            {`上次运行：${new Date(state.lastAt).toLocaleString()}${state.lastSummary ? ` · ${state.lastSummary}` : ''}`}
          </>
        ) : (
          <>
            <br />
            还没跑过。
          </>
        )}
        {state?.lastError ? (
          <>
            <br />
            <span className="err">{`上次出错：${state.lastError}`}</span>
          </>
        ) : null}
      </div>
    </Card>
  );
}
