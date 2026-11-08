import Card from './Card';
import Select from '../../components/Select';
import type { SettingsForm } from './useSettingsForm';

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
