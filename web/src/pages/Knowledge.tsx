import React, { useCallback, useEffect, useState } from 'react';
import { api, quiet } from '../api';
import type { AiPreset, AiStatus, FeedbackItem, KbRule, KbStats } from '../types';
import { IconGear, IconTrash } from '../components/Icons';
import { formatDate } from '../api';
import { reasonLabel } from '../components/DeleteReasonDialog';

const RULE_TYPE_LABELS: Record<string, string> = {
  source: '来源',
  keyword: '关键词',
  resolution: '分辨率',
  aspect: '宽高比',
  tag: '标签',
  phash: '相似画面',
  ai_term: 'AI 描述词',
};

/** 规则列表每页条数：几千条规则时不把整表响应体一次灌进前端 */
const RULE_PAGE = 50;

export default function Knowledge({
  onToast,
  onLibraryChanged,
}: {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onLibraryChanged: () => void;
}) {
  const [rules, setRules] = useState<KbRule[]>([]);
  const [ruleTotal, setRuleTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [stats, setStats] = useState<KbStats | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [presets, setPresets] = useState<Record<string, AiPreset>>({});
  const [suggestion, setSuggestion] = useState('');
  const [busy, setBusy] = useState('');
  /** 「AI 描述词」规则靠 ai_desc 匹配，库里没有 AI 看图数据时永远是死规则，默认折叠 */
  const [showDormant, setShowDormant] = useState(false);

  const refreshRules = useCallback(async () => {
    const page = await api.kbRulesPaged({ limit: RULE_PAGE, offset: 0 });
    setRules(page.items);
    setRuleTotal(page.total);
  }, []);

  const loadMore = async () => {
    if (loadingMore || rules.length >= ruleTotal) return;
    setLoadingMore(true);
    try {
      const page = await api.kbRulesPaged({ limit: RULE_PAGE, offset: rules.length });
      setRuleTotal(page.total);
      setRules((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.items.filter((r) => !seen.has(r.id))];
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const refresh = useCallback(() => {
    refreshRules().catch(quiet);
    api.kbFeedback().then(setFeedback).catch(quiet);
    api.kbStats().then(setStats).catch(quiet);
    api.aiStatus().then(setAiStatus).catch(quiet);
    api.aiPresets().then(setPresets).catch(quiet);
  }, [refreshRules]);

  useEffect(refresh, [refresh]);

  const summarize = async () => {
    setBusy('summarize');
    try {
      const res = await api.aiSummarize();
      onToast(
        typeof res.before === 'number'
          ? `AI 归纳完成：规则 ${res.before} 条 → ${res.after} 条（已合并冗余）`
          : `AI 归纳完成：新增/加强 ${res.added} 条规则`
      );
      if (res.summary) setSuggestion(res.summary);
      refresh();
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const suggest = async () => {
    setBusy('suggest');
    try {
      const res = await api.aiSuggest();
      setSuggestion(res.text);
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const rescore = async () => {
    setBusy('rescore');
    try {
      const res = await api.kbRescore();
      onToast(`已重新打分 ${res.updated} 张，其中 ${res.low} 张低于阈值`);
      refresh();
      onLibraryChanged();
    } catch (err) {
      onToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const toggleRule = async (rule: KbRule) => {
    await api.kbUpdateRule(rule.id, { enabled: rule.enabled ? 0 : 1 });
    await refreshRules();
    onLibraryChanged();
  };

  const changeWeight = async (rule: KbRule, delta: number) => {
    await api.kbUpdateRule(rule.id, { weight: Math.max(0, Math.min(45, rule.weight + delta)) });
    await refreshRules();
  };

  const removeRule = async (id: number) => {
    await api.kbDeleteRule(id);
    await refreshRules();
    onLibraryChanged();
  };

  const dormantRules = rules.filter((r) => r.dormant);
  const visibleRules = showDormant ? rules : rules.filter((r) => !r.dormant);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">AI 知识库</h1>
          <div className="page-sub">
            每次删除不满意的图片都会沉淀为规则，越用越懂你的口味 · 低分图自动降权并在采集时过滤
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={rescore} disabled={busy === 'rescore'}>
            重新打分
          </button>
          <button className="btn primary" onClick={summarize} disabled={busy === 'summarize' || !aiStatus?.ready}>
            {busy === 'summarize' ? 'AI 归纳中…' : 'AI 归纳规则'}
          </button>
        </div>
      </div>

      {!aiStatus?.ready && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'rgba(251,191,36,0.35)' }}>
          <b style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconGear /> AI 尚未配置
          </b>
          <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '8px 0 0', lineHeight: 1.9 }}>
            不配置也能用：删除时选择的原因会自动转成规则（来源/关键词/分辨率/相似画面）。
            <br />
            配置 AI 后可额外「看图分析」并归纳出更细的规则，请到「设置 → AI 接入」填写 Base URL、API Key 与模型。
          </p>
        </div>
      )}

      <div className="stat-grid">
        <div className="card stat-card">
          <div className="label">📝 不满意反馈</div>
          <div className="value">{stats?.feedbackCount ?? 0}</div>
          <div className="hint">删除时留下的记录</div>
        </div>
        <div className="card stat-card">
          <div className="label">🧠 知识库规则</div>
          <div className="value">{stats?.enabledRuleCount ?? 0}</div>
          <div className="hint">共 {stats?.ruleCount ?? 0} 条，可单独启停</div>
        </div>
        <div className="card stat-card">
          <div className="label">⚠️ 低分图片</div>
          <div className="value">{stats?.lowScoreCount ?? 0}</div>
          <div className="hint">采集时会被自动过滤</div>
        </div>
        <div className="card stat-card">
          <div className="label">📊 平均画质分</div>
          <div className="value">{stats?.avgScore ?? 100}</div>
          <div className="hint">满分 100，命中规则扣分</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h4 className="section-title">
          规则列表
          {aiStatus?.ready && (
            <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
              当前 AI：{presets[aiStatus.provider]?.label || aiStatus.provider} · {aiStatus.model}
            </span>
          )}
        </h4>
        {!visibleRules.length && (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            还没有规则。去图库删除几张不满意的图片，或点右上角「AI 归纳规则」。
          </div>
        )}
        {visibleRules.length > 0 && (
          <div className="rule-list">
            {visibleRules.map((rule) => {
              const main = rule.label || rule.value;
              return (
                <div className={`rule-row${rule.enabled ? '' : ' off'}`} key={rule.id}>
                  <span className={`rule-type t-${rule.type}`}>{RULE_TYPE_LABELS[rule.type] || rule.type}</span>
                  <div className="rule-main" title={rule.value}>
                    <span className="rule-label">{main}</span>
                    <span className="rule-meta">
                      {rule.value !== main && <span className="rule-value">{rule.value} · </span>}
                      命中 {rule.hits} 次 · {rule.origin === 'ai' ? 'AI 归纳' : '来自反馈'}
                      {rule.dormant && <span style={{ color: 'var(--warn)' }}> · 未生效（库里无 AI 描述数据）</span>}
                    </span>
                  </div>
                  <span className="rule-weight" title="权重（命中一次扣的分值）">
                    <button className="w-btn" onClick={() => changeWeight(rule, -2)}>
                      −
                    </button>
                    <b>{rule.weight}</b>
                    <button className="w-btn" onClick={() => changeWeight(rule, 2)}>
                      +
                    </button>
                  </span>
                  <button
                    className={`rule-switch${rule.enabled ? ' on' : ''}`}
                    title={rule.enabled ? '已启用 · 点击停用' : '已停用 · 点击启用'}
                    onClick={() => toggleRule(rule)}
                  />
                  <button className="rule-del" title="删除规则" onClick={() => removeRule(rule.id)}>
                    <IconTrash />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {ruleTotal > rules.length && (
          <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中…' : `加载更多规则（已显示 ${rules.length} / ${ruleTotal}）`}
          </button>
        )}
        {dormantRules.length > 0 && (
          <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
            另有 <b>{dormantRules.length}</b> 条「AI 描述词」规则<strong>未生效</strong>，已默认隐藏：
            这类规则靠 AI 看图描述（ai_desc）匹配，而当前库里还没有 AI 描述数据，命中数永远是 0。
            <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => setShowDormant((v) => !v)}>
              {showDormant ? '隐藏它们' : '显示它们'}
            </button>
          </div>
        )}
      </div>

      <div className="settings-layout" style={{ marginBottom: 14 }}>
        <div className="card">
          <h4 className="section-title">采集建议</h4>
          <button className="btn" onClick={suggest} disabled={busy === 'suggest' || !aiStatus?.ready}>
            {busy === 'suggest' ? '生成中…' : '让 AI 给采集建议'}
          </button>
          {suggestion && (
            <div className="ai-result" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
              {suggestion}
            </div>
          )}
        </div>

        <div className="card">
          <h4 className="section-title">原因分布</h4>
          {stats?.byReason.length ? (
            <div>
              {stats.byReason.map((r) => (
                <div className="bar-row" key={r.key}>
                  <span className="name">{r.label}</span>
                  <span className="bar-track">
                    <span
                      className="bar-fill"
                      style={{
                        width: `${(r.count / Math.max(1, ...stats.byReason.map((x) => x.count))) * 100}%`,
                      }}
                    />
                  </span>
                  <span className="val">{r.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>暂无数据</span>
          )}
        </div>
      </div>

      <div className="card">
        <h4 className="section-title">最近反馈记录（{feedback.length}）</h4>
        {!feedback.length && <span style={{ color: 'var(--muted)', fontSize: 13 }}>暂无记录</span>}
        {feedback.map((f) => (
          <div className="kw-row" key={f.id} style={{ alignItems: 'flex-start', marginBottom: 6 }}>
            <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.8 }}>
              <b>{f.reasons.length ? f.reasons.map(reasonLabel).join(' / ') : '（未选择原因）'}</b>
              {f.note && <span style={{ color: 'var(--muted)' }}> · {f.note}</span>}
              <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                {formatDate(f.createdAt)} · {f.snapshot.source} · {f.snapshot.keyword} ·{' '}
                {f.snapshot.width}×{f.snapshot.height}
              </div>
              {f.aiAnalysis && (
                <div style={{ color: '#b9b9d0', fontSize: 11.5, whiteSpace: 'pre-wrap' }}>
                  AI：{f.aiAnalysis}
                </div>
              )}
            </div>
            <button
              className="del"
              onClick={async () => {
                await api.kbDeleteFeedback(f.id);
                refresh();
              }}
            >
              <IconTrash />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
