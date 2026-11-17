import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, isDesktop } from '../../api';
import Card from './Card';
import i18n from '../../i18n';

/**
 * API 参考 + Playground。
 *
 * 之前只有 /api/v1 的 11 个接口有 OpenAPI，其余 380+ 个内部接口没有任何清单，
 * 想写脚本 / 接扩展只能去 grep 源码 —— 这就是「没有 API 参考」。
 * 现在清单来自服务端自省（server/lib/api-docs.js 遍历 Express 路由表）：
 * 左边可搜可筛，右边选一个接口当场发请求、看返回、复制 curl、下载 Markdown 全文。
 *
 * 安全：写操作（POST/PUT/DELETE/PATCH）必须二次确认；令牌由 api 层自动带上，不在界面上显示。
 */

interface DocRoute {
  method: string;
  path: string;
  group: string;
  label: string;
  auth: string;
}

interface DocGroup {
  key: string;
  label: string;
  note: string;
  count: number;
}

const METHOD_COLOR: Record<string, string> = {
  GET: '#2563eb',
  POST: '#16a34a',
  PUT: '#d97706',
  PATCH: '#7c3aed',
  DELETE: '#dc2626',
};

export default function ApiPlaygroundCard({ onToast }: { onToast: (msg: string, kind?: 'info' | 'error') => void }) {
  const [routes, setRoutes] = useState<DocRoute[]>([]);
  const [groups, setGroups] = useState<DocGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState('');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [pick, setPick] = useState('');
  const [body, setBody] = useState('{}');
  const [result, setResult] = useState<{ status: string; ms: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [exampleTab, setExampleTab] = useState<'curl' | 'js' | 'py'>('curl');

  useEffect(() => {
    api
      .apiDocs()
      .then((r) => {
        setRoutes(r.routes);
        setGroups(r.groups);
        setTotal(r.total);
        if (r.routes.length) setPick(`${r.routes[0].method} ${r.routes[0].path}`);
      })
      .catch((e: Error) => setFailed(e.message || i18n.t('k6c4849a1')));
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return routes.filter(
      (r) =>
        (!group || r.group === group) &&
        (!needle || r.path.toLowerCase().includes(needle) || r.method.toLowerCase().includes(needle))
    );
  }, [routes, q, group]);

  const current = useMemo(() => routes.find((e) => `${e.method} ${e.path}` === pick) || null, [routes, pick]);
  const isWrite = current && current.method !== 'GET';
  const groupNote = useMemo(() => groups.find((g) => g.key === (group || current?.group))?.note || '', [groups, group, current]);

  /** 路径里的 :id / {id} 之类先用 1 顶替，让「点了就能跑」而不是先报 404 */
  const resolvedPath = useMemo(() => {
    if (!current) return '';
    return current.path.replace(/\{[^}]+\}/g, '1').replace(/:[A-Za-z_][\w]*/g, '1');
  }, [current]);

  const send = useCallback(async () => {
    if (!current) return;
    if (isWrite && !window.confirm(i18n.t('kd79f1ca0', { p0: current.method, p1: current.path }))) return;
    setBusy(true);
    const t0 = performance.now();
    try {
      const payload = current.method === 'GET' ? undefined : body;
      const r = await api.playground(current.method, resolvedPath, payload);
      setResult({ status: String(r.status), ms: Math.round(performance.now() - t0), text: r.text });
    } catch (e) {
      setResult({ status: 'ERR', ms: Math.round(performance.now() - t0), text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [current, isWrite, body, resolvedPath]);

  /**
   * 三份示例：curl / JavaScript / Python。
   * 之前只有 curl 一份，写脚本的人还得自己翻译；口径与 /api/docs.md 里的一致
   * （路径参数已换成 1，鉴权用 <token> 占位，不猜业务字段）。
   */
  const sampleCode = useMemo(() => {
    if (!current) return { curl: '', js: '', py: '' };
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3001';
    const url = `${origin}${resolvedPath}`;
    const isWrite = current.method !== 'GET';
    const needAuth = current.auth !== i18n.t('kd81bb206');
    const authValue = current.auth === i18n.t('k66a8fce5') ? 'Bearer <lan-token>' : 'Bearer <token>';
    const hint = i18n.t('k6ceacd21');

    const curl = [
      `curl -X ${current.method} "${url}"`,
      ...(needAuth ? [`-H "Authorization: ${authValue}"`] : []),
      ...(isWrite ? ['-H "Content-Type: application/json"', `-d '${body.replace(/\n/g, ' ')}'`] : []),
    ].join(' \\\n  ');

    const js = [
      i18n.t('k278e4bc9'),
      `const res = await fetch('${url}', {`,
      `  method: '${current.method}',`,
      ...(needAuth
        ? [`  headers: { Authorization: \`Bearer \${token}\`${isWrite ? ", 'Content-Type': 'application/json'" : ''} },`]
        : []),
      ...(isWrite ? [`  body: JSON.stringify(${body.replace(/\s+/g, ' ') || hint}),`] : []),
      '});',
      'console.log(res.status, await res.json());',
    ].join('\n');

    const py = [
      'import os, requests',
      '',
      'token = os.environ.get("TUKU_TOKEN", "")',
      `res = requests.${current.method.toLowerCase()}(`,
      `    "${url}",`,
      ...(needAuth ? ['    headers={"Authorization": f"Bearer {token}"},'] : []),
      ...(isWrite ? [`    json=${body.replace(/\s+/g, ' ') || hint},`] : []),
      '    timeout=30,',
      ')',
      'print(res.status_code, res.text[:200])',
    ].join('\n');

    return { curl, js, py };
  }, [current, resolvedPath, body]);

  const asCurl = sampleCode.curl;

  /** Markdown 全文带令牌下载：直接 <a href> 拿不到 Authorization 头，所以走 api 层再落盘 */
  const downloadMarkdown = useCallback(async () => {
    try {
      const r = await api.playground('GET', '/api/docs.md');
      const blob = new Blob([r.text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tuku-api.md';
      a.click();
      URL.revokeObjectURL(url);
      onToast(i18n.t('k749115b3'));
    } catch (e) {
      onToast((e as Error).message || i18n.t('k65e200d3'), 'error');
    }
  }, [onToast]);

  return (
    <Card
      title={i18n.t('k9937b379')}
      desc={i18n.t('k06ab8a95', { p0: total || '…' })}
      badge={isDesktop ? <span className="hint">{i18n.t('k5953127d')}</span> : <span className="hint">{i18n.t('k4536243a')}</span>}
    >
      {failed ? (
        <div className="hint" style={{ color: 'var(--danger, #dc2626)' }}>
          {failed}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <input
              className="input"
              style={{ flex: '1 1 200px', minWidth: 160 }}
              placeholder={i18n.t('k5501fb16')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label={i18n.t('ke92c2a0e')}
            />
            <select
              className="input"
              style={{ flex: '0 0 auto', minWidth: 160 }}
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              aria-label={i18n.t('k7bd12fd7')}
            >
              <option value="">{i18n.t('k13900bfc')}</option>
              {groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {`${g.label}（${g.count}）`}
                </option>
              ))}
            </select>
            <button className="btn sm" onClick={() => void downloadMarkdown()}>
              {i18n.t('k3a58d41e')}
            </button>
          </div>

          <div
            style={{
              maxHeight: 280,
              overflow: 'auto',
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'var(--card)',
            }}
          >
            {shown.length === 0 ? (
              <div className="hint" style={{ padding: 12 }}>
                {i18n.t('k29a5c1de')}
              </div>
            ) : (
              shown.map((r) => {
                const key = `${r.method} ${r.path}`;
                const active = key === pick;
                return (
                  <button
                    key={key}
                    onClick={() => setPick(key)}
                    title={i18n.t('kfc07e5bd', { p0: r.label, p1: r.auth })}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 10px',
                      border: 0,
                      borderBottom: '1px solid var(--line)',
                      background: active ? 'rgba(255, 77, 141, 0.12)' : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 12.5,
                    }}
                  >
                    <span
                      style={{
                        flex: 'none',
                        width: 52,
                        fontWeight: 700,
                        fontSize: 11,
                        color: METHOD_COLOR[r.method] || 'var(--muted)',
                      }}
                    >
                      {r.method}
                    </span>
                    <span style={{ flex: 1, fontFamily: 'Cascadia Code, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.path}
                    </span>
                    <span className="hint" style={{ flex: 'none' }}>
                      {r.label}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="hint" style={{ margin: '8px 0 12px' }}>
            {i18n.t('k46655200', { p0: shown.length, p1: routes.length })}
            {groupNote ? ` · ${groupNote}` : ''}
          </div>

          {current && (
            <>
              <div className="field">
                <label>{`${current.method} ${current.path}`}</label>
                <div className="hint">
                  {i18n.t('k808a28d5', { p0: current.auth, p1: resolvedPath })}
                </div>
              </div>

              {isWrite && (
                <div className="field">
                  <label>{i18n.t('k317414ba')}</label>
                  <textarea
                    className="input"
                    style={{ minHeight: 90, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12.5 }}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                <button className="btn primary sm" disabled={busy} onClick={() => void send()}>
                  {busy ? i18n.t('k08815707') : i18n.t('k4f02d2ef')}
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(sampleCode[exampleTab]).then(
                      () => onToast(i18n.t('k65d2c076', { p0: exampleTab === 'curl' ? 'curl' : exampleTab === 'js' ? 'JavaScript' : 'Python' })),
                      () => onToast(i18n.t('k63e6737e'), 'error')
                    );
                  }}
                >
                  {i18n.t('kad180ece', { p0: exampleTab === 'curl' ? 'curl' : exampleTab === 'js' ? 'JavaScript' : 'Python' })}
                </button>
              </div>

              {/* 示例代码：写脚本的人直接从这里拿走，不用回去翻源码猜调用方式 */}
              <div className="field">
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }} role="tablist" aria-label={i18n.t('kc81b1363')}>
                  {(['curl', 'js', 'py'] as const).map((k) => (
                    <button
                      key={k}
                      role="tab"
                      aria-selected={exampleTab === k}
                      className={exampleTab === k ? 'btn primary sm' : 'btn sm'}
                      onClick={() => setExampleTab(k)}
                    >
                      {k === 'curl' ? 'curl' : k === 'js' ? 'JavaScript' : 'Python'}
                    </button>
                  ))}
                </div>
                <pre
                  style={{
                    maxHeight: 220,
                    overflow: 'auto',
                    background: '#0f172a',
                    color: '#d6e2f5',
                    borderRadius: 10,
                    padding: '10px 12px',
                    fontSize: 12,
                    lineHeight: 1.6,
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {sampleCode[exampleTab]}
                </pre>
              </div>
            </>
          )}

          {result && (
            <div style={{ marginTop: 12 }}>
              <div className="hint" style={{ marginBottom: 6 }}>
                {i18n.t('kc35fd2ea', { p0: result.status, p1: result.ms })}
              </div>
              <pre
                style={{
                  maxHeight: 320,
                  overflow: 'auto',
                  background: '#0f172a',
                  color: '#d6e2f5',
                  borderRadius: 10,
                  padding: '10px 12px',
                  fontSize: 12,
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {result.text}
              </pre>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
