import React, { useCallback, useEffect, useState } from 'react';
import { api, quiet } from '../api';
import type { AiPreset, AiStatus, FeedbackItem, KbRule, KbStats } from '../types';
import { IconGear, IconTrash } from '../components/Icons';
import { IconWarning } from '../components/Icons';
import { formatDate } from '../api';
import { reasonLabel } from '../components/DeleteReasonDialog';
import i18n from '../i18n';

const RULE_TYPE_LABELS: Record<string, string> = {
  source: i18n.t('k26ca20b1'),
  keyword: i18n.t('k9699a50e'),
  resolution: i18n.t('k874a5816'),
  aspect: i18n.t('k6ec2d5e6'),
  tag: i18n.t('k14d34236'),
  phash: i18n.t('ka915acb5'),
  ai_term: i18n.t('k01b4bf96'),
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
          ? i18n.t('k9278f0e7', { p0: res.before, p1: res.after })
          : i18n.t('kc6beb504', { p0: res.added })
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
      onToast(i18n.t('kd8987c25', { p0: res.updated, p1: res.low }));
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
          <h1 className="page-title">{i18n.t('kcbf9f467')}</h1>
          <div className="page-sub">
            {i18n.t('k83e142e4')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={rescore} disabled={busy === 'rescore'}>
            {i18n.t('kf39d5bdc')}
          </button>
          <button className="btn primary" onClick={summarize} disabled={busy === 'summarize' || !aiStatus?.ready}>
            {busy === 'summarize' ? i18n.t('k047304c0') : i18n.t('k56a43c45')}
          </button>
        </div>
      </div>

      {!aiStatus?.ready && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'rgba(251,191,36,0.35)' }}>
          <b style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconGear /> {i18n.t('k694899fc')}
          </b>
          <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '8px 0 0', lineHeight: 1.9 }}>
            {i18n.t('k9534ab19')}
            <br />
            {i18n.t('kb9fb4932')}
          </p>
        </div>
      )}

      <div className="stat-grid">
        <div className="card stat-card">
          <div className="label">{i18n.t('kdcf831c3')}</div>
          <div className="value">{stats?.feedbackCount ?? 0}</div>
          <div className="hint">{i18n.t('kc43da30b')}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{i18n.t('ka1ec3ff3')}</div>
          <div className="value">{stats?.enabledRuleCount ?? 0}</div>
          <div className="hint">共 {stats?.ruleCount ?? 0} 条，可单独启停</div>
        </div>
        <div className="card stat-card">
          <div className="label">{i18n.t('k210378e3')}</div>
          <div className="value">{stats?.lowScoreCount ?? 0}</div>
          <div className="hint">{i18n.t('k16250e5e')}</div>
        </div>
        <div className="card stat-card">
          <div className="label">{i18n.t('ke6e04379')}</div>
          <div className="value">{stats?.avgScore ?? 100}</div>
          <div className="hint">{i18n.t('kd43fdab8')}</div>
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
            {i18n.t('k54f5513d')}
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
                      命中 {rule.hits} 次 · {rule.origin === 'ai' ? i18n.t('k4c20068a') : i18n.t('k074467fc')}
                      {rule.dormant && <span style={{ color: 'var(--warn)' }}> {i18n.t('k1fbe1e01')}</span>}
                    </span>
                  </div>
                  <span className="rule-weight" title={i18n.t('k528ee1fb')}>
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
                    title={rule.enabled ? i18n.t('k3620a2a6') : i18n.t('kf952b319')}
                    onClick={() => toggleRule(rule)}
                  />
                  <button className="rule-del" title={i18n.t('kf5a93db7')} onClick={() => removeRule(rule.id)}>
                    <IconTrash />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {ruleTotal > rules.length && (
          <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? i18n.t('kfb4ca1cf') : i18n.t('k129c28b7', { p0: rules.length, p1: ruleTotal })}
          </button>
        )}
        {dormantRules.length > 0 && (
          <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
            {i18n.t('ke990cfba')} <b>{dormantRules.length}</b> {i18n.t('k7a737b03')}<strong>{i18n.t('k996aab1c')}</strong>，已默认隐藏：
            这类规则靠 AI 看图描述（ai_desc）匹配，而当前库里还没有 AI 描述数据，命中数永远是 0。
            <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => setShowDormant((v) => !v)}>
              {showDormant ? i18n.t('k2d565a81') : i18n.t('k744e3c61')}
            </button>
          </div>
        )}
      </div>

      <div className="settings-layout" style={{ marginBottom: 14 }}>
        <div className="card">
          <h4 className="section-title">{i18n.t('k2d400f13')}</h4>
          <button className="btn" onClick={suggest} disabled={busy === 'suggest' || !aiStatus?.ready}>
            {busy === 'suggest' ? i18n.t('k069491f7') : i18n.t('k2909feaf')}
          </button>
          {suggestion && (
            <div className="ai-result" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
              {suggestion}
            </div>
          )}
        </div>

        <div className="card">
          <h4 className="section-title">{i18n.t('k20814f63')}</h4>
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
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>{i18n.t('k21efd88b')}</span>
          )}
        </div>
      </div>

      <div className="card">
        <h4 className="section-title">最近反馈记录（{feedback.length}）</h4>
        {!feedback.length && <span style={{ color: 'var(--muted)', fontSize: 13 }}>{i18n.t('kb9db8476')}</span>}
        {feedback.map((f) => (
          <div className="kw-row" key={f.id} style={{ alignItems: 'flex-start', marginBottom: 6 }}>
            <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.8 }}>
              <b>{f.reasons.length ? f.reasons.map(reasonLabel).join(' / ') : i18n.t('ka53dc540')}</b>
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
              aria-label={i18n.t('k1b00c0e0')}
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
