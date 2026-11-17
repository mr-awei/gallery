import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { AiProviderInfo } from '../../types';
import Card from './Card';
import Select from '../../components/Select';
import type { SettingsForm } from './useSettingsForm';
import i18n from '../../i18n';

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
    const name = window.prompt(i18n.t('k7c93ec7c'), settings.ai.model || i18n.t('k772e7fb7'));
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
      onToast?.(i18n.t('k647bc60b', { p0: name }));
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
      onToast?.(i18n.t('kb0f187f2'));
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(i18n.t('ka414058f'))) return;
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
        <b style={{ fontSize: 13 }}>{i18n.t('kd7c0b936')}</b>
        <span className="hint" style={{ flex: 1 }}>
          {i18n.t('k0c40d5f2')}
        </span>
        <button className="btn sm" disabled={!!busy} onClick={() => void saveCurrent()}>
          {busy === 'save' ? i18n.t('k9b5d32d1') : i18n.t('k92b7b7de')}
        </button>
      </div>
      {list.length === 0 && <div className="hint">{i18n.t('ke4f309a2')}</div>}
      {list.map((p) => (
        <div
          key={p.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12.5 }}
        >
          <span style={{ minWidth: 110, fontWeight: p.id === activeId ? 700 : 400 }}>
            {p.label}
            {p.id === activeId ? i18n.t('k9a4b23fc') : ''}
          </span>
          <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.model || i18n.t('keeaba8bc')} · {p.baseUrl || i18n.t('k534b46e3')} · {p.hasKey ? p.keyMask : i18n.t('k5e747213')}
          </span>
          <button className="btn ghost sm" disabled={!!busy || p.id === activeId} onClick={() => void activate(p.id)}>
            {i18n.t('kbec7e4d6')}
          </button>
          <button className="btn ghost sm" disabled={!!busy} onClick={() => void remove(p.id)}>
            {i18n.t('k2f4aaddd')}
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
      title={i18n.t('k70ba6cfb')}
      desc={i18n.t('k06b57a01')}
      badge={
        aiStatus?.ready ? (
          <span style={{ color: 'var(--ok)', fontWeight: 400, fontSize: 12 }}>{i18n.t('k4ae414b3')}</span>
        ) : (
          <span style={{ color: 'var(--warn)', fontWeight: 400, fontSize: 12 }}>{i18n.t('ke8e1c03e')}</span>
        )
      }
    >
      <div className="field">
        <label>{i18n.t('kc4fc97f8')}</label>
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
          placeholder={settings.hasAiApiKey ? i18n.t('k18973c3e') : 'sk-...'}
          onChange={(e) => {
            setAiKeyDraft(e.target.value);
            setDirty(true);
          }}
        />
        {settings.hasAiApiKey && (
          <div style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={clearAiApiKey}>
              {i18n.t('kf4e1c3c0')}
            </button>
          </div>
        )}
        <div className="hint">
          {presets[settings.ai?.provider || '']?.keyHint || i18n.t('k4dbdbc3c')}
          {presets[settings.ai?.provider || '']?.docs && (
            <>
              {' · '}
              <a
                href={presets[settings.ai?.provider || ''].docs}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                {i18n.t('k57448d52')}
              </a>
            </>
          )}
        </div>
      </div>
      <div className="field">
        <label>{i18n.t('kbbc1adce')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {customModel || !modelOptions.length ? (
            <input
              className="input"
              style={{ flex: 1 }}
              value={settings.ai?.model || ''}
              placeholder={i18n.t('k70d6f454')}
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
              <option value="__custom__">{i18n.t('k53fc9199')}</option>
            </Select>
          )}
          <button className="btn" onClick={fetchModels} title={i18n.t('k12e11810')}>
            {i18n.t('k1d0274a5')}
          </button>
          <button
            className="btn"
            onClick={() => setCustomModel((v) => !v)}
            title={i18n.t('kd188a3c3')}
          >
            {customModel ? i18n.t('k78f395c1') : i18n.t('kbd1f8309')}
          </button>
        </div>
        {modelOptions.length > 0 && !customModel && (
          <div className="hint">共 {modelOptions.length} 个可选模型</div>
        )}
      </div>
      <div className="field">
        <label>{i18n.t('kaa05d622')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {customVision || !visionOptions.length ? (
            <input
              className="input"
              style={{ flex: 1 }}
              value={settings.ai?.visionModel || ''}
              placeholder={i18n.t('k1689a0c3')}
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
              <option value="__custom__">{i18n.t('k53fc9199')}</option>
            </Select>
          )}
          <button
            className="btn"
            onClick={() => setCustomVision((v) => !v)}
            title={i18n.t('kd188a3c3')}
          >
            {customVision ? i18n.t('k78f395c1') : i18n.t('kbd1f8309')}
          </button>
        </div>
      </div>
      <div className="switch-row">
        <span>{i18n.t('ka9e80d42')}</span>
        <input
          type="checkbox"
          checked={!!settings.ai?.enabled}
          onChange={(e) => patch({ ai: { ...settings.ai, enabled: e.target.checked } })}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={testAi} disabled={testing}>
          {testing ? i18n.t('k2ff33d1a') : i18n.t('k69e74756')}
        </button>
      </div>
      {aiError && <div className="ai-result" style={{ borderColor: 'rgba(248,113,113,0.4)' }}>{aiError}</div>}
      <ProviderKit settings={settings} />
      <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
        {i18n.t('k8ee62ea9')}
        <br />{i18n.t('kd970dd20')}
        <br />{i18n.t('kea0edf18')}
        <br />{i18n.t('k85f9a747')}
        <br />{i18n.t('kd3ea4934')}
      </div>
    </Card>
  );
}
