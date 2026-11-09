import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, isDesktop } from '../../api';
import Card from './Card';

/**
 * API Playground：把 OpenAPI 里的接口列出来，当场填参数、发请求、看返回。
 *
 * 为什么做：项目有 /api/v1 + OpenAPI + MCP，但「第一次接你的人」要读文档、开终端、
 * 拼 token，五分钟就没了。这里的目标很窄：选一个接口 → 点发送 → 看到 JSON → 复制 curl。
 *
 * 安全：写操作（POST/PUT/DELETE/PATCH）必须二次确认；令牌由 api 层自动带上，不在这里显示。
 */

interface Endpoint {
  method: string;
  path: string;
  summary: string;
  tag: string;
}

interface Spec {
  paths?: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
}

export default function ApiPlaygroundCard({ onToast }: { onToast: (msg: string, kind?: 'info' | 'error') => void }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [pick, setPick] = useState('');
  const [body, setBody] = useState('{}');
  const [result, setResult] = useState<{ status: string; ms: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/v1/openapi.json')
      .then((r) => r.json())
      .then((spec: Spec) => {
        const list: Endpoint[] = [];
        for (const [path, ops] of Object.entries(spec.paths || {})) {
          for (const [method, op] of Object.entries(ops || {})) {
            if (!/^(get|post|put|patch|delete)$/i.test(method)) continue;
            list.push({
              method: method.toUpperCase(),
              path,
              summary: op?.summary || '',
              tag: (op?.tags && op.tags[0]) || '默认',
            });
          }
        }
        list.sort((a, b) => a.path.localeCompare(b.path));
        setEndpoints(list);
        if (list.length) setPick(`${list[0].method} ${list[0].path}`);
      })
      .catch(() => setEndpoints([]));
  }, []);

  const current = useMemo(
    () => endpoints.find((e) => `${e.method} ${e.path}` === pick) || null,
    [endpoints, pick]
  );
  const isWrite = current && current.method !== 'GET';

  /** 路径里的 {id} 之类先用 1 顶替，让「点了就能跑」而不是先报 404 */
  const resolvedPath = useMemo(() => {
    if (!current) return '';
    return current.path.replace(/\{[^}]+\}/g, '1');
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

  if (!endpoints.length) return null;

  const groups = [...new Set(endpoints.map((e) => e.tag))];

  return (
    <Card
      title="API Playground"
      desc="直接对着本地接口调一次：选接口 → 填 body → 发送 → 看返回。写操作会二次确认。"
      badge={
        isDesktop ? (
          <span className="hint">桌面端</span>
        ) : (
          <span className="hint">浏览器调试</span>
        )
      }
    >
      <div className="field">
        <label>接口</label>
        <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {endpoints
                .filter((e) => e.tag === g)
                .map((e) => (
                  <option key={`${e.method} ${e.path}`} value={`${e.method} ${e.path}`}>
                    {e.method} {e.path} {e.summary ? `· ${e.summary}` : ''}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
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
        <button className="btn primary sm" disabled={busy || !current} onClick={() => void send()}>
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
        <span className="hint">
          路径里的 {'{id}'} 先用 1 顶替；要测别的 id 直接在结果里对照返回调整
        </span>
      </div>

      {result && (
        <div style={{ marginTop: 12 }}>
          <div className="hint" style={{ marginBottom: 6 }}>
            状态 {result.status} · 耗时 {result.ms}ms
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
    </Card>
  );
}
