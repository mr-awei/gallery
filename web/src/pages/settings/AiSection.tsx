import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { AiProviderInfo } from '../../types';
import Card from './Card';
import Select from '../../components/Select';
import type { SettingsForm } from './useSettingsForm';

/**
 * 模型套件：把「当前表单里的这套配置」存成一家供应商，可以并存多家、随时切换。
 * 密钥进的是同一份库外共享配置，这里只展示掩码。
 */
function ProviderKit({ settings, onToast }: { settings: SettingsForm['settings']; onToast?: (m: string) => void }) {
  const [list, setList] = useState<AiProviderInfo[]>([]);
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.aiProviders();
      setList(r.providers || []);
      setActiveId(r.activeId || '');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCurrent = async () => {
    if (!settings?.ai) return;
    const name = window.prompt('给这套配置起个名字（如「DeepSeek 便宜档」）', settings.ai.model || '新配置');
    if (!name) return;
    setBusy('save');
    setErr('');
    try {
      await api.saveAiProvider({
        label: name,
        provider: settings.ai.provider || 'custom',
        baseUrl: settings.ai.baseUrl || '',
        model: settings.ai.model || '',
        visionModel: settings.ai.visionModel || '',
      });
      await load();
      onToast?.(`已存为「${name}」`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const activate = async (id: string) => {
    setBusy(id);
    try {
      await api.activateAiProvider(id);
      await load();
      onToast?.('已切换，刷新后生效');
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('删除这家供应商的配置？（已保存的密钥一并删除）')) return;
    setBusy(id);
    try {
      await api.removeAiProvider(id);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>模型套件</b>
        <span className="hint" style={{ flex: 1 }}>
          可以并存多家，切换时只改指针，不用重填
        </span>
        <button className="btn sm" disabled={!!busy} onClick={() => void saveCurrent()}>
          {busy === 'save' ? '保存中…' : '把当前配置存为一家'}
        </button>
      </div>
      {list.length === 0 && <div className="hint">还没有保存过多套配置。</div>}
      {list.map((p) => (
        <div
          key={p.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12.5 }}
        >
          <span style={{ minWidth: 110, fontWeight: p.id === activeId ? 700 : 400 }}>
            {p.label}
            {p.id === activeId ? ' ·当前' : ''}
          </span>
          <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.model || '(未填模型)'} · {p.baseUrl || '(未填地址)'} · {p.hasKey ? p.keyMask : '无密钥'}
          </span>
          <button className="btn ghost sm" disabled={!!busy || p.id === activeId} onClick={() => void activate(p.id)}>
            切换
          </button>
          <button className="btn ghost sm" disabled={!!busy} onClick={() => void remove(p.id)}>
            删除
          </button>
        </div>
      ))}
      {err && <div className="danger small">{err}</div>}
    </div>
  );
}

/** AI 接入区块：从 Settings.tsx 拆出，直接消费同一个 form 对象，不再逐层透传 props。 */
export default function AiSection({ form }: { form: SettingsForm }) {
  const {
    settings, patch, aiKeyDraft, setAiKeyDraft, setDirty, clearAiApiKey,
    presets, applyPreset, customModel, setCustomModel, modelOptions, fetchModels,
    customVision, setCustomVision, visionOptions, testAi, testing, aiError, aiStatus,
  } = form;
  if (!settings) return null;
  return (
    <Card
      title="AI 接入"
      desc="用于图片智能评分、看图分析、删除原因学习与知识库。不配置也能正常使用。"
      badge={
        aiStatus?.ready ? (
          <span style={{ color: 'var(--ok)', fontWeight: 400, fontSize: 12 }}>● 已就绪</span>
        ) : (
          <span style={{ color: 'var(--warn)', fontWeight: 400, fontSize: 12 }}>○ 未配置</span>
        )
      }
    >
      <div className="field">
        <label>厂家预设（均为 OpenAI 兼容接口）</label>
        <Select
          className="select"
          style={{ width: '100%' }}
          value={settings.ai?.provider || 'custom'}
          onChange={(v) => applyPreset(v)}
        >
          {Object.entries(presets).map(([key, p]) => (
            <option key={key} value={key}>
              {p.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="field">
        <label>Base URL</label>
        <input
          className="input"
          value={settings.ai?.baseUrl || ''}
          placeholder="https://api.deepseek.com/v1"
          onChange={(e) => patch({ ai: { ...settings.ai, baseUrl: e.target.value } })}
        />
      </div>
      <div className="field">
        <label>API Key</label>
        <input
          className="input"
          type="password"
          value={aiKeyDraft}
          placeholder={settings.hasAiApiKey ? '已保存（不回显），粘贴新 Key 可覆盖' : 'sk-...'}
          onChange={(e) => {
            setAiKeyDraft(e.target.value);
            setDirty(true);
          }}
        />
        {settings.hasAiApiKey && (
          <div style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={clearAiApiKey}>
              清除已保存的 Key
            </button>
          </div>
        )}
        <div className="hint">
          {presets[settings.ai?.provider || '']?.keyHint || '按接口方要求填写'}
          {presets[settings.ai?.provider || '']?.docs && (
            <>
              {' · '}
              <a
                href={presets[settings.ai?.provider || ''].docs}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                去获取密钥
              </a>
            </>
          )}
        </div>
      </div>
      <div className="field">
        <label>文本模型（归纳规则 / 生成建议）</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {customModel || !modelOptions.length ? (
            <input
              className="input"
              style={{ flex: 1 }}
              value={settings.ai?.model || ''}
              placeholder="如 glm-4-flash / gpt-4o-mini / deepseek-chat"
              onChange={(e) => patch({ ai: { ...settings.ai, model: e.target.value } })}
            />
          ) : (
            <Select
              className="select"
              style={{ flex: 1 }}
              value={settings.ai?.model || ''}
              onChange={(v) =>
                v === '__custom__' ? setCustomModel(true) : patch({ ai: { ...settings.ai, model: v } })
              }
            >
              {settings.ai?.model && !modelOptions.includes(settings.ai.model) && (
                <option value={settings.ai.model}>{settings.ai.model}（当前）</option>
              )}
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">自定义 / 手动输入…</option>
            </Select>
          )}
          <button className="btn" onClick={fetchModels} title="从接口拉取模型列表">
            拉取
          </button>
          <button
            className="btn"
            onClick={() => setCustomModel((v) => !v)}
            title="在下拉与手动输入之间切换"
          >
            {customModel ? '下拉' : '手填'}
          </button>
        </div>
        {modelOptions.length > 0 && !customModel && (
          <div className="hint">共 {modelOptions.length} 个可选模型</div>
        )}
      </div>
      <div className="field">
        <label>视觉模型（看图分析，可留空复用文本模型）</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {customVision || !visionOptions.length ? (
            <input
              className="input"
              style={{ flex: 1 }}
              value={settings.ai?.visionModel || ''}
              placeholder="如 glm-4v-flash / qwen-vl-max-latest / gpt-4o-mini"
              onChange={(e) => patch({ ai: { ...settings.ai, visionModel: e.target.value } })}
            />
          ) : (
            <Select
              className="select"
              style={{ flex: 1 }}
              value={settings.ai?.visionModel || ''}
              onChange={(v) =>
                v === '__custom__' ? setCustomVision(true) : patch({ ai: { ...settings.ai, visionModel: v } })
              }
            >
              {settings.ai?.visionModel && !visionOptions.includes(settings.ai.visionModel) && (
                <option value={settings.ai.visionModel}>{settings.ai.visionModel}（当前）</option>
              )}
              {visionOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">自定义 / 手动输入…</option>
            </Select>
          )}
          <button
            className="btn"
            onClick={() => setCustomVision((v) => !v)}
            title="在下拉与手动输入之间切换"
          >
            {customVision ? '下拉' : '手填'}
          </button>
        </div>
      </div>
      <div className="switch-row">
        <span>启用 AI</span>
        <input
          type="checkbox"
          checked={!!settings.ai?.enabled}
          onChange={(e) => patch({ ai: { ...settings.ai, enabled: e.target.checked } })}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={testAi} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>
      {aiError && <div className="ai-result" style={{ borderColor: 'rgba(248,113,113,0.4)' }}>{aiError}</div>}
      <ProviderKit settings={settings} />
      <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
        · 密钥只保存在本机数据库，不外传
        <br />· 不配置也能用：删除原因会直接转成规则
        <br />· 401：密钥错误/过期/带空格；403：无该模型权限；404：Base URL 填错；429：限流或余额不足
        <br />· 部分厂家不开放 /models 接口，拉取失败可直接手填模型名后点「测试连接」
        <br />· 修改后点右上角「保存设置」生效
      </div>
    </Card>
  );
}
