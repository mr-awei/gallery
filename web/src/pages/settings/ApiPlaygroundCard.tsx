import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, isDesktop } from '../../api';
import Card from './Card';

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

  useEffect(() => {
    api
      .apiDocs()
      .then((r) => {
        setRoutes(r.routes);
        setGroups(r.groups);
        setTotal(r.total);
        if (r.routes.length) setPick(`${r.routes[0].method} ${r.routes[0].path}`);
      })
      .catch((e: Error) => setFailed(e.message || '接口清单加载失败'));
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
    if (isWrite && !window.confirm(`这是写操作（${current.method} ${current.path}），确定要发送吗？`)) return;
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

  const asCurl = useMemo(() => {
    if (!current) return '';
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3001';
    const parts = [`curl -X ${current.method} "${origin}${resolvedPath}"`, '-H "Authorization: Bearer <token>"'];
    if (current.method !== 'GET') parts.push(`-H "Content-Type: application/json" -d '${body.replace(/\n/g, ' ')}'`);
    return parts.join(' \\\n  ');
  }, [current, resolvedPath, body]);

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
      onToast('已下载 tuku-api.md');
    } catch (e) {
      onToast((e as Error).message || '下载失败', 'error');
    }
  }, [onToast]);

  return (
    <Card
      title="API 参考与调试"
      desc={`服务端自省出的完整接口清单（共 ${total || '…'} 个），可搜索、当场试调、导出 Markdown。`}
      badge={isDesktop ? <span className="hint">桌面端</span> : <span className="hint">浏览器调试</span>}
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
              placeholder="搜索路径或方法，如 /api/images 或 post"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="搜索接口"
            />
            <select
              className="input"
              style={{ flex: '0 0 auto', minWidth: 160 }}
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              aria-label="按分组筛选"
            >
              <option value="">全部分组</option>
              {groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {`${g.label}（${g.count}）`}
                </option>
              ))}
            </select>
            <button className="btn sm" onClick={() => void downloadMarkdown()}>
              下载 Markdown
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
                没有匹配的接口
              </div>
            ) : (
              shown.map((r) => {
                const key = `${r.method} ${r.path}`;
                const active = key === pick;
                return (
                  <button
                    key={key}
                    onClick={() => setPick(key)}
                    title={`${r.label} · 鉴权：${r.auth}`}
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
            {`显示 ${shown.length} / ${routes.length} 个接口`}
            {groupNote ? ` · ${groupNote}` : ''}
          </div>

          {current && (
            <>
              <div className="field">
                <label>{`${current.method} ${current.path}`}</label>
                <div className="hint">
                  {`鉴权：${current.auth} · 实际请求：${resolvedPath}（路径参数用 1 顶替）`}
                </div>
              </div>

              {isWrite && (
                <div className="field">
                  <label>请求体（JSON）</label>
                  <textarea
                    className="input"
                    style={{ minHeight: 90, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12.5 }}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn primary sm" disabled={busy} onClick={() => void send()}>
                  {busy ? '发送中…' : '发送请求'}
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(asCurl).then(
                      () => onToast('已复制 curl'),
                      () => onToast('复制失败，请手动选中', 'error')
                    );
                  }}
                >
                  复制 curl
                </button>
              </div>
            </>
          )}

          {result && (
            <div style={{ marginTop: 12 }}>
              <div className="hint" style={{ marginBottom: 6 }}>
                {`状态 ${result.status} · 耗时 ${result.ms}ms`}
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
