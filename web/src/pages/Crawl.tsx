import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, SOURCE_OPTIONS, quiet } from '../api';
import { subscribeEvents } from '../events';
import type { CrawlStatus, Keyword, Settings } from '../types';
import { IconPlay, IconStop, IconTrash } from '../components/Icons';

export default function Crawl({ onToast }: { onToast: (msg: string) => void }) {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [pages, setPages] = useState(3);
  const [status, setStatus] = useState<CrawlStatus | null>(null);
  const [newKw, setNewKw] = useState('');
  const [tab, setTab] = useState<'log' | 'fail'>('log');
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.keywords().then((list) => {
      setKeywords(list);
      setPicked(new Set(list.filter((k) => k.enabled).map((k) => k.id)));
    });
    api.settings().then((s: Settings) => {
      setSources(new Set(Object.entries(s.sources).filter(([, v]) => v).map(([k]) => k)));
      setPages(s.pagesPerKeyword || 3);
    });
  }, []);

  const refresh = useCallback(() => {
    api.crawlStatus().then(setStatus).catch(quiet);
  }, []);

  useEffect(() => {
    refresh();
    // 采集进度改为订阅 job 事件（原 1s 轮询）
    const off = subscribeEvents('job', (d) => {
      if (d?.crawl) setStatus(d.crawl as CrawlStatus);
    });
    return () => {
      off();
    };
  }, [refresh]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [status?.logs.length, tab]);

  const start = async () => {
    const list = keywords.filter((k) => picked.has(k.id)).map((k) => k.text);
    const res = await api.crawlStart({ keywords: list, sources: [...sources], pages });
    if (!res.ok) onToast(res.message || '启动失败');
    else {
      onToast(`已启动：${list.length} 个关键词 × ${sources.size} 个来源 × ${pages} 页`);
      setTab('log');
      refresh();
    }
  };

  const stop = async () => {
    await api.crawlStop();
    onToast('正在停止…');
    refresh();
  };

  const addKeyword = async () => {
    const text = newKw.trim();
    if (!text) return;
    const res = await api.addKeyword(text);
    setKeywords(res.keywords);
    setPicked((prev) => new Set([...prev, ...res.keywords.filter((k) => k.text === text).map((k) => k.id)]));
    setNewKw('');
  };

  const removeKeyword = async (id: number) => {
    const res = await api.deleteKeyword(id);
    setKeywords(res.keywords);
    setPicked((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const stats = status?.stats;
  const running = !!status?.running;
  const search = status?.search || { total: 0, done: 0, failed: 0 };
  const download = status?.download || { queued: 0, done: 0, active: 0, saved: 0, failed: 0 };
  const searchPct = search.total ? Math.min(100, (search.done / search.total) * 100) : 0;
  const downloadPct = download.queued ? Math.min(100, (download.done / download.queued) * 100) : 0;
  const phaseText = running
    ? status?.current
      ? `搜索中：${status.current.keyword} · ${status.current.source} 第 ${status.current.page} 页`
      : '准备中…'
    : '空闲';

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">采集</h1>
          <div className="page-sub">必应 / 百度 / 搜狗 / Wallhaven 并发抓取，边搜边下载，自动去重与画质过滤</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {running ? (
            <button className="btn danger" onClick={stop}>
              <IconStop /> 停止采集
            </button>
          ) : (
            <button className="btn primary" onClick={start}>
              <IconPlay /> 开始采集
            </button>
          )}
        </div>
      </div>

      <div className="crawl-layout">
        <div className="card">
          <h4 className="section-title">关键词（{picked.size}/{keywords.length}）</h4>
          <div className="kw-list">
            {keywords.map((k) => (
              <div className="kw-row" key={k.id}>
                <input
                  type="checkbox"
                  checked={picked.has(k.id)}
                  onChange={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(k.id)) next.delete(k.id);
                      else next.add(k.id);
                      return next;
                    })
                  }
                />
                <span>{k.text}</span>
                <button className="del" onClick={() => removeKeyword(k.id)} title="删除">
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="新增关键词…"
              value={newKw}
              onChange={(e) => setNewKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
            />
            <button className="btn" onClick={addKeyword}>
              添加
            </button>
          </div>

          <h4 className="section-title" style={{ marginTop: 20 }}>
            采集源
          </h4>
          {SOURCE_OPTIONS.map((s) => (
            <div className="switch-row" key={s.key} title={s.hint}>
              <span>
                {s.label}
                {s.hint && <span className="src-hint">需配置</span>}
              </span>
              <input
                type="checkbox"
                checked={sources.has(s.key)}
                onChange={() => {
                  const next = new Set(sources);
                  if (next.has(s.key)) next.delete(s.key);
                  else next.add(s.key);
                  setSources(next);
                  // 记住本次选择（副作用不放 setState updater：React 严格模式会
                  // 双调用 updater，同一份设置被写两次；副作用还可能被丢弃）
                  api
                    .saveSettings({
                      sources: Object.fromEntries(SOURCE_OPTIONS.map((x) => [x.key, next.has(x.key)])),
                    })
                    .catch(quiet);
                }}
              />
            </div>
          ))}

          <div className="field" style={{ marginTop: 16 }}>
            <label>每个关键词采集页数</label>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={pages}
              onChange={(e) => {
                const v = Math.max(1, Math.min(20, Number(e.target.value) || 1));
                setPages(v);
              }}
              // 记住页数选择：blur 再落盘，避免每敲一个数字就写一次设置
              onBlur={() => api.saveSettings({ pagesPerKeyword: pages }).catch(quiet)}
            />
            <div className="hint">页数越多耗时越长，建议 3-5 页</div>
          </div>
        </div>

        <div className="card">
          <h4 className="section-title">
            实时进度
            <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>{phaseText}</span>
          </h4>

          {/* 采集（搜索）进度 */}
          <div style={{ fontSize: 12.5, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
            <span>
              ① 搜索候选：{search.done}/{search.total} 次
              {search.failed > 0 && <span style={{ color: 'var(--err)' }}>（失败 {search.failed}）</span>}
            </span>
            <span style={{ color: 'var(--muted)' }}>{Math.round(searchPct)}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${searchPct}%` }} />
          </div>

          {/* 下载进度 */}
          <div style={{ fontSize: 12.5, margin: '12px 0 6px', display: 'flex', justifyContent: 'space-between' }}>
            <span>
              ② 下载入库：{download.done}/{download.queued}
              {download.active > 0 && (
                <span style={{ color: 'var(--warn)' }}>（进行中 {download.active}）</span>
              )}
              {download.failed > 0 && <span style={{ color: 'var(--err)' }}>（失败 {download.failed}）</span>}
            </span>
            <span style={{ color: 'var(--muted)' }}>{Math.round(downloadPct)}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${downloadPct}%` }} />
          </div>

          <div className="counter-grid" style={{ marginTop: 14 }}>
            <div className="counter">
              <div className="k">候选</div>
              <div className="v">{stats?.candidates ?? 0}</div>
            </div>
            <div className="counter">
              <div className="k">待下载</div>
              <div className="v">{download.queued}</div>
            </div>
            <div className="counter">
              <div className="k">已下载</div>
              <div className="v">{download.done}</div>
            </div>
            <div className="counter">
              <div className="k">已保存</div>
              <div className="v" style={{ color: 'var(--ok)' }}>
                {download.saved}
              </div>
            </div>
            <div className="counter">
              <div className="k">重复</div>
              <div className="v" style={{ color: 'var(--warn)' }}>
                {stats?.dropped?.duplicate ?? 0}
              </div>
            </div>
            <div className="counter">
              <div className="k">低质/过滤</div>
              <div className="v" style={{ color: 'var(--warn)' }}>
                {(stats?.dropped?.lowres ?? 0) +
                  (stats?.dropped?.small ?? 0) +
                  (stats?.dropped?.format ?? 0) +
                  (stats?.dropped?.aiFilter ?? 0)}
              </div>
            </div>
            <div className="counter">
              <div className="k">失败</div>
              <div
                className="v"
                style={{ color: status?.failureCount ? 'var(--err)' : undefined, cursor: status?.failureCount ? 'pointer' : undefined }}
                onClick={() => status?.failureCount && setTab('fail')}
                title={status?.failureCount ? '点击查看失败明细' : undefined}
              >
                {status?.failureCount ?? 0}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, margin: '12px 0 8px' }}>
            <button className={`chip${tab === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>
              实时日志
            </button>
            <button
              className={`chip${tab === 'fail' ? ' active' : ''}`}
              onClick={() => setTab('fail')}
            >
              失败明细（{status?.failureCount ?? 0}）
            </button>
          </div>

          {tab === 'log' ? (
            <div className="log-panel" ref={logRef}>
              {status?.logs?.length ? (
                status.logs.map((l) => (
                  <div className={`log-line ${l.level}`} key={l.id}>
                    <span className="time">
                      {new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}
                    </span>
                    <span>{l.message}</span>
                  </div>
                ))
              ) : (
                <div style={{ color: '#6f6f8c' }}>
                  暂无日志。点击「开始采集」后这里会实时输出：搜索进度 → 下载进度 → 成功/失败。
                </div>
              )}
            </div>
          ) : (
            <div className="log-panel">
              {status?.failures?.length ? (
                status.failures
                  .slice()
                  .reverse()
                  .map((f) => (
                    <div className="log-line error" key={f.id}>
                      <span className="time">
                        {new Date(f.t).toLocaleTimeString('zh-CN', { hour12: false })}
                      </span>
                      <span>
                        [{f.reason}] {f.source} · {f.keyword} — {f.message}
                        {f.url && (
                          <>
                            {' '}
                            <span style={{ color: '#6f6f8c' }}>{f.url.slice(0, 60)}</span>
                          </>
                        )}
                      </span>
                    </div>
                  ))
              ) : (
                <div style={{ color: '#6f6f8c' }}>没有失败记录 🎉</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
