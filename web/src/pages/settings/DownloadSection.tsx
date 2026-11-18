import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Card from './Card';
import { api } from '../../api';
import { subscribeEvents } from '../../events';
import type { ModelItem, ModelsPayload, RuntimeComponent, RuntimeProbe } from '../../types';
import i18n from '../../i18n';

/**
 * 下载中心：全软件所有模型的统一入口（超分 / 抠图 / 人脸 / 语义）。
 *
 * 以前每个功能各自在自己的分区里放一个下载按钮，用户要装齐得在设置里来回翻，
 * 也说不清「一共占了多大盘、哪些可以清理」。这里只做聚合与调度，
 * 真正的下载实现仍在各模块（镜像、断点、哈希校验都是那边的事）。
 */
export default function DownloadSection({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const [data, setData] = useState<ModelsPayload | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  /** 进度只由 SSE 推送更新，避免「每秒重算目录体积」把主线程拖住 */
  const [live, setLive] = useState<Record<string, { progress: number; message: string }>>({});
  const alive = useRef(true);

  // ---- 运行环境（独立于模型检测；非 Windows 平台 supported=false，整个块隐藏） ----
  const [runtime, setRuntime] = useState<RuntimePayload | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState<string>('');
  const runtimeAlive = useRef(true);

  const loadRuntime = useCallback(async () => {
    try {
      const r = await api.listRuntime();
      if (!runtimeAlive.current) return;
      setRuntime(r);
    } catch {
      // runtime 接口挂了不影响模型下载中心主流程；静默失败
    }
  }, []);

  useEffect(() => {
    runtimeAlive.current = true;
    void loadRuntime();
    return () => { runtimeAlive.current = false; };
  }, [loadRuntime]);

  // 有 runtime 组件正在下载 / 安装 → 每 2 秒刷新状态
  const runtimeActive = useMemo(() => {
    if (!runtime) return false;
    return Object.values(runtime.state || {}).some((s: any) => s.status === 'downloading' || s.status === 'installing');
  }, [runtime]);
  useEffect(() => {
    if (!runtimeActive) return;
    const t = setInterval(() => void loadRuntime(), 2000);
    return () => clearInterval(t);
  }, [runtimeActive, loadRuntime]);

  const load = useCallback(async () => {
    try {
      const r = await api.listModels();
      if (!alive.current) return;
      setData(r);
      setError('');
    } catch (err: any) {
      if (alive.current) setError(String(err?.message || err));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // 下载进度走推送：后端任何模块开始下载，这里都能收到「哪一项、到哪了」
  useEffect(() => {
    return subscribeEvents('job', (payload: any) => {
      const models = payload?.models;
      if (!models || !Array.isArray(models.items)) return;
      const next: Record<string, { progress: number; message: string }> = {};
      for (const it of models.items) {
        if (it?.id) next[it.id] = { progress: Number(it.progress) || 0, message: it.message || '' };
      }
      setLive(next);
    });
  }, []);

  const anyDownloading = useMemo(() => {
    if (!data) return false;
    return data.items.some((m) => m.state === 'downloading' || m.state === 'installing') || Object.keys(live).length > 0;
  }, [data, live]);

  /** 还没装、当前也没在下的项：就是「全部下载」要排的队 */
  const pendingItems = useMemo(
    () => (data?.items || []).filter((m) => !m.installed && m.state !== 'downloading' && m.state !== 'installing'),
    [data]
  );
  const pendingBytes = useMemo(() => pendingItems.reduce((sum, m) => sum + Number(m.sizeHint || 0), 0), [pendingItems]);

  // 有下载在跑时才短轮询：等它结束（体积/状态要重新 stat）
  useEffect(() => {
    if (!anyDownloading) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [anyDownloading, load]);

  // 「全部下载」是服务端排队跑的，状态只在它跑的时候问，空闲时一次就够
  const [allRunning, setAllRunning] = useState(false);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.installAllModelsStatus();
        if (!stop) setAllRunning(Boolean(s.running));
      } catch {
        if (!stop) setAllRunning(false);
      }
    };
    void tick();
    if (!allRunning && !anyDownloading) return () => { stop = true; };
    const t = setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [allRunning, anyDownloading]);

  async function startAll() {
    setBusy('install-all');
    try {
      const r = await api.installAllModels();
      if (!r.ok) onToast(r.error || i18n.t('k70af984d'));
      else if (r.already) onToast(i18n.t('kc39b4dfb'));
      else onToast(i18n.t('k6a76abc3', { p0: r.total || 0 }));
      setAllRunning(Boolean(r.ok));
      void load();
    } catch (err: any) {
      onToast(String(err?.message || err));
    } finally {
      setBusy('');
    }
  }

  async function cancelAll() {
    setBusy('install-all');
    try {
      const r = await api.cancelInstallAllModels();
      onToast(r.ok ? i18n.t('ka7ab5c1a') : i18n.t('k482e8539'));
      setAllRunning(false);
    } catch (err: any) {
      onToast(String(err?.message || err));
    } finally {
      setBusy('');
    }
  }

  async function act(kind: 'install' | 'cancel' | 'remove' | 'verify', item: ModelItem) {
    setBusy(`${kind}:${item.id}`);
    try {
      if (kind === 'install') {
        const r = await api.installModel(item.id);
        if (!r.ok) onToast(r.error || i18n.t('k05f9b9a8'));
        else onToast(i18n.t('k1d7887a3', { p0: item.name }));
        void load();
      } else if (kind === 'cancel') {
        const r = await api.cancelModelDownload(item.id);
        if (!r.ok) onToast(r.error || i18n.t('k675a760e'));
        else onToast(i18n.t('ke650001d'));
        void load();
      } else if (kind === 'remove') {
        const warn = item.required ? i18n.t('k99d45ef2', { p0: item.name }) : i18n.t('k01baa048', { p0: item.name });
        if (!window.confirm(warn)) return;
        const r = await api.removeModel(item.id);
        if (!r.ok) onToast(r.error || i18n.t('kacf0664a'));
        else {
          onToast(i18n.t('k34d941d3', { p0: item.name }));
          setData(r);
        }
      } else {
        const r = await api.verifyModel(item.id);
        onToast(r.ok ? r.message || i18n.t('k9a9088c0') : r.error || i18n.t('kdd64a02b'));
      }
    } catch (err: any) {
      onToast(String(err?.message || err));
    } finally {
      setBusy('');
    }
  }

  async function installOneRuntime(id: string) {
    setRuntimeBusy(id);
    try {
      const r = await api.installRuntime(id);
      if (r.error) onToast(r.error);
      else if (r.needsReboot) onToast(i18n.t('k92f18a55')); // 安装完成，建议重启系统
      else onToast(i18n.t('k8e3b4a55')); // 安装完成
      await loadRuntime();
    } catch (err: any) {
      onToast(String(err?.message || err));
    } finally {
      setRuntimeBusy('');
    }
  }

  if (error && !data) {
    return (
      <Card title={i18n.t('k937902e1')} desc={i18n.t('k7ddf83bd')}>
        <div style={{ color: 'var(--danger, #d33)', fontSize: 13 }}>读取失败：{error}</div>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => void load()}>
          {i18n.t('k132c5cdc')}
        </button>
      </Card>
    );
  }

  const summary = data?.summary;
  const groups = data?.groups || [];

  return (
    <Card
      title={i18n.t('k937902e1')}
      desc={i18n.t('k84725777')}
    >
      {runtime?.supported && (
        <RuntimeBlock runtime={runtime} busy={runtimeBusy} onInstall={installOneRuntime} />
      )}

      {/* 总览 */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          alignItems: 'center',
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--bg-soft, #f6f7f9)',
          marginBottom: 14,
        }}
      >
        <Stat label={i18n.t('k9719fec8')} value={summary ? `${summary.installed} / ${summary.total}` : '—'} />
        <Stat label={i18n.t('kad35f58f')} value={summary ? fmtBytes(summary.bytes) : '—'} />
        <Stat label={i18n.t('kd28aeb5f')} value={summary ? fmtBytes(summary.removableBytes) : '—'} />
        {summary && summary.updates > 0 && <Stat label={i18n.t('k840ecc96')} value={i18n.t('kc6ae400b', { p0: summary.updates })} warn />}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {allRunning ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--text-3, #8a8f98)' }}>{i18n.t('k5ea0e030')}</span>
              <button className="btn" disabled={busy === 'install-all'} onClick={() => void cancelAll()}>
                {i18n.t('k080273c8')}
              </button>
            </>
          ) : (
            <button
              className="btn primary"
              disabled={!pendingItems.length || busy === 'install-all'}
              title={pendingItems.length ? i18n.t('k42c58c59') : i18n.t('kb5e47f2e')}
              onClick={() => void startAll()}
            >
              {pendingItems.length ? i18n.t('kbe584330', { p0: pendingItems.length, p1: fmtBytes(pendingBytes) }) : i18n.t('ke20fceb7')}
            </button>
          )}
          <button className="btn" disabled={checking} onClick={() => void load()}>
            {i18n.t('k694fc5ef')}
          </button>
          <button
            className="btn"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              try {
                await load();
                onToast(i18n.t('k7ae8e696'));
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? i18n.t('k68c15533') : i18n.t('k75e1781b')}
          </button>
        </div>
      </div>

      {!data && <div className="settings-desc">{i18n.t('k8b5015f0')}</div>}

      {groups.map((g) => {
        const items = (data?.items || []).filter((m) => m.group === g.id);
        if (!items.length) return null;
        return (
          <div key={g.id} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <h5 style={{ margin: 0, fontSize: 13.5 }}>{g.label}</h5>
              <span style={{ fontSize: 12, color: 'var(--text-3, #8a8f98)' }}>
                {g.installed}/{g.total} · {fmtBytes(g.bytes)}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3, #8a8f98)', marginBottom: 8 }}>{g.hint}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.map((m) => (
                <ModelRow
                  key={m.id}
                  item={m}
                  liveProgress={live[m.id]?.progress}
                  liveMessage={live[m.id]?.message}
                  busy={busy}
                  onAct={act}
                />
              ))}
            </div>
          </div>
        );
      })}

      <div className="settings-desc" style={{ marginTop: 4 }}>
        {i18n.t('k11344dab')}
      </div>
    </Card>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 78 }}>
      <span style={{ fontSize: 11, color: 'var(--text-3, #8a8f98)' }}>{label}</span>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: warn ? 'var(--warn, #c47f17)' : undefined }}>{value}</span>
    </div>
  );
}

function ModelRow({
  item,
  liveProgress,
  liveMessage,
  busy,
  onAct,
}: {
  item: ModelItem;
  liveProgress?: number;
  liveMessage?: string;
  busy: string;
  onAct: (kind: 'install' | 'cancel' | 'remove' | 'verify', item: ModelItem) => void;
}) {
  const downloading = item.state === 'downloading' || item.state === 'installing';
  const progress = downloading ? (liveProgress ?? item.progress) : 0;
  const msg = downloading ? liveMessage || item.message : item.error || item.message;
  const rowBusy = busy.endsWith(`:${item.id}`);

  return (
    <div
      style={{
        border: '1px solid var(--border, #e6e8eb)',
        borderRadius: 8,
        padding: '10px 12px',
        background: item.installed ? 'var(--bg-panel, #fff)' : 'var(--bg-soft, #fafbfc)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</span>
        {item.required && <Badge tone="neutral">{i18n.t('k976a3e8e')}</Badge>}
        {item.installed && !item.error ? (
          <Badge tone="ok">{i18n.t('k9719fec8')}</Badge>
        ) : (
          <Badge tone="muted">{i18n.t('k33618963')}</Badge>
        )}
        {item.updateAvailable && <Badge tone="warn">{i18n.t('kb48cca48')}</Badge>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3, #8a8f98)' }}>
          {item.installed ? fmtBytes(item.size) : i18n.t('k326af30e', { p0: fmtBytes(item.sizeHint) })}
        </span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-2, #555b63)', marginTop: 4, lineHeight: 1.6 }}>{item.desc}</div>

      <div style={{ fontSize: 11.5, color: 'var(--text-3, #8a8f98)', marginTop: 3 }}>
        {item.source} · {item.license}
        {item.installed && item.verified ? i18n.t('kd8285fbc') : item.installed ? '' : ''}
      </div>
      {item.note && (
        <div style={{ fontSize: 11.5, color: 'var(--text-3, #8a8f98)', marginTop: 2, fontStyle: 'italic' }}>
          {item.note}
        </div>
      )}

      {downloading && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--border, #e6e8eb)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: progress >= 0 ? `${progress}%` : '30%',
                background: 'var(--accent, #2563eb)',
                transition: 'width .2s',
              }}
            />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3, #8a8f98)', marginTop: 4 }}>{msg || i18n.t('k0164eeb4')}</div>
        </div>
      )}

      {!downloading && item.error && (
        <div style={{ fontSize: 11.5, color: 'var(--danger, #d33)', marginTop: 6 }}>{item.error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {downloading ? (
          <button className="btn" disabled={rowBusy} onClick={() => onAct('cancel', item)}>
            {i18n.t('k625fb26b')}
          </button>
        ) : item.installed ? (
          <>
            <button className="btn" disabled={rowBusy} onClick={() => onAct('verify', item)}>
              {i18n.t('kb7579706')}
            </button>
            <button className="btn" disabled={rowBusy} onClick={() => onAct('install', item)}>
              {i18n.t('k754569be')}
            </button>
            <button className="btn btn-danger" disabled={rowBusy} onClick={() => onAct('remove', item)}>
              {i18n.t('k2f4aaddd')}
            </button>
          </>
        ) : (
          <button className="btn btn-primary" disabled={rowBusy} onClick={() => onAct('install', item)}>
            {rowBusy ? i18n.t('kf6196bb1') : i18n.t('kf26ef914')}
          </button>
        )}
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'muted' | 'neutral'; children: ReactNode }) {
  const map = {
    ok: { bg: 'rgba(34,160,90,.12)', fg: '#1f8a4c' },
    warn: { bg: 'rgba(196,127,23,.14)', fg: '#a4690f' },
    muted: { bg: 'rgba(0,0,0,.06)', fg: '#6b7280' },
    neutral: { bg: 'rgba(37,99,235,.1)', fg: '#2563eb' },
  }[tone];
  return (
    <span
      style={{
        fontSize: 10.5,
        padding: '1px 6px',
        borderRadius: 4,
        background: map.bg,
        color: map.fg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function fmtBytes(n: number) {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 运行环境 payload（和 resources.ts 的 listRuntime 返回对齐） */
interface RuntimePayload {
  supported: boolean;
  platform: string;
  components: RuntimeComponent[];
  probes: RuntimeProbe[];
  summary: { total: number; installed: number; missing: number; criticalMissing: number };
  state: Record<string, { status: string; progress: number; message: string; error: string; needsReboot: boolean }>;
}

/** 运行环境分组：检测到缺系统组件时，展示「XX 未安装 · 一键下载安装」 */
function RuntimeBlock({
  runtime,
  busy,
  onInstall,
}: {
  runtime: RuntimePayload;
  busy: string;
  onInstall: (id: string) => void;
}) {
  const missingComp = runtime.components.filter((c) => !c.installed);
  const failingProbes = runtime.probes.filter((p) => !p.ok);

  if (!missingComp.length && !failingProbes.length) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>
          {i18n.t('k17c39a01')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3, #8a8f98)', marginBottom: 8 }}>
          {i18n.t('k8d2a6f11')}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {runtime.probes.map((p) => (
            <Badge key={p.id} tone="ok">
              {p.label}{p.version ? ` ${p.version}` : ''}
            </Badge>
          ))}
          {runtime.components.filter((c) => c.installed).map((c) => (
            <Badge key={c.id} tone="ok">{c.label}</Badge>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{i18n.t('k17c39a01')}</span>
        {runtime.summary.criticalMissing > 0 && (
          <Badge tone="warn">{i18n.t('k2f4d4a55', { p0: runtime.summary.criticalMissing })}</Badge>
        )}
        {failingProbes.length > 0 && (
          <Badge tone="warn">{i18n.t('kf4b5c881', { p0: failingProbes.length })}</Badge>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3, #8a8f98)', marginBottom: 8 }}>
        {i18n.t('k8d2a6f11')}
      </div>

      {/* 原生模块探针状态（总览性，告诉用户 onnxruntime / sharp 能不能用） */}
      {failingProbes.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {runtime.probes.map((p) => (
            <Badge key={p.id} tone={p.ok ? 'ok' : 'warn'}>
              {p.label} {p.ok ? i18n.t('k9719fec8') : i18n.t('k33618963')}
              {!p.ok && p.error ? `（${p.error.slice(0, 40)}）` : ''}
            </Badge>
          ))}
        </div>
      )}

      {/* 可安装组件：缺哪个列哪个，每个有「下载安装」按钮 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {missingComp.map((c) => {
          const st = runtime.state[c.id];
          const rowBusy = busy === c.id;
          const downloading = st?.status === 'downloading';
          const installing = st?.status === 'installing';
          const done = st?.status === 'done';
          const err = st?.status === 'error';
          return (
            <div
              key={c.id}
              style={{
                border: '1px solid var(--border, #e6e8eb)',
                borderRadius: 8,
                padding: '10px 12px',
                background: 'var(--bg-soft, #fafbfc)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</span>
                {c.critical && <Badge tone="warn">{i18n.t('k976a3e8e')}</Badge>}
                <Badge tone="muted">{i18n.t('k33618963')}</Badge>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3, #8a8f98)' }}>
                  {fmtBytes(c.sizeHint)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2, #555b63)', marginTop: 4, lineHeight: 1.6 }}>
                {c.desc}
              </div>
              {(downloading || installing) && (
                <>
                  <div style={{ marginTop: 8 }}>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--border, #e6e8eb)', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${st.progress ?? 0}%`,
                          background: installing ? 'var(--warn, #c47f17)' : 'var(--accent, #2563eb)',
                          transition: 'width .2s',
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3, #8a8f98)', marginTop: 4 }}>
                      {st.message}
                    </div>
                  </div>
                </>
              )}
              {err && (
                <div style={{ fontSize: 11.5, color: 'var(--danger, #d33)', marginTop: 6 }}>
                  {st.error}
                </div>
              )}
              {done && (
                <div style={{ fontSize: 11.5, color: 'var(--accent, #2563eb)', marginTop: 6 }}>
                  {st.message}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="btn btn-primary"
                  disabled={rowBusy || downloading || installing}
                  onClick={() => void onInstall(c.id)}
                >
                  {installing
                    ? i18n.t('kf6196bb1')
                    : downloading
                    ? i18n.t('k0164eeb4')
                    : rowBusy
                    ? i18n.t('kf6196bb1')
                    : i18n.t('kf26ef914')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
