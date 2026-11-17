import { useEffect, useState } from 'react';
import { api } from '../../api';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  value: string;
  applyToLocal: boolean;
  onChange: (patch: { importNameTemplate?: string; importNameTemplateForLocal?: boolean }) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

interface Meta {
  presets: { label: string; value: string }[];
  tokens: { token: string; desc: string }[];
}

/** 导入命名模板：占位符、预设、前 20 个目标名预览、本地扫描可选复制 */
export default function ImportNameTemplateCard({ value, applyToLocal, onChange, onToast }: Props) {
  const [meta, setMeta] = useState<Meta>({ presets: [], tokens: [] });
  const [names, setNames] = useState<string[]>([]);
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 空模板也会返回 presets / tokens，用一次请求把说明和预设都拿下来
    api
      .nameTemplatePreview('')
      .then((r) => setMeta({ presets: r.presets || [], tokens: r.tokens || [] }))
      .catch((err) => onToast(i18n.t('kbfab7937', { p0: (err as Error).message }), 'error'));
  }, []);

  const preview = async () => {
    if (!value.trim()) {
      setNames([]);
      setSample(false);
      onToast(i18n.t('kb07c6a1c'));
      return;
    }
    setBusy(true);
    try {
      const r = await api.nameTemplatePreview(value);
      setNames(r.names || []);
      setSample(!!r.sample);
      setMeta({ presets: r.presets || [], tokens: r.tokens || [] });
      onToast(i18n.t('k53f76138'));
    } catch (err) {
      onToast(i18n.t('kb6327eeb', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={i18n.t('k2404cfc0')}
      desc={i18n.t('k16319d8a')}
      badge={<span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>{i18n.t('k389927e0')}</span>}
    >
      <div className="settings-subhead">{i18n.t('k59cf15fe')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="field" style={{ flex: 2, minWidth: 220, margin: 0 }}>
          <label>{i18n.t('k4286b222')}</label>
          <input
            className="input"
            style={{ width: '100%' }}
            value={value}
            maxLength={200}
            placeholder="{date}-{index}{ext}"
            onChange={(e) => onChange({ importNameTemplate: e.target.value })}
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 180, margin: 0 }}>
          <label>{i18n.t('k323afcc4')}</label>
          <select
            className="select"
            style={{ width: '100%', padding: '7px 8px', borderRadius: 8 }}
            value=""
            onChange={(e) => onChange({ importNameTemplate: e.target.value })}
          >
            <option value="">{i18n.t('kf6e77050')}</option>
            {meta.presets.map((p) => (
              <option key={p.label} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button className="btn sm" disabled={busy} onClick={() => void preview()}>
          {i18n.t('k75865583')}
        </button>
      </div>

      <div className="hint" style={{ lineHeight: 1.9, marginTop: 10 }}>
        可用占位符：{' '}
        {meta.tokens.map((t) => (
          <code key={t.token} title={t.desc} style={{ marginRight: 8 }}>
            {t.token}
          </code>
        ))}
        <br />
        <code>{'{index}'}</code> {i18n.t('k41d6c1dc')} <code>-1 / -2</code>{i18n.t('k7c2dc34a')} <code>{'{ext}'}</code> {i18n.t('kf14cd153')}
      </div>

      {names.length > 0 && (
        <div className="field" style={{ marginTop: 10 }}>
          <label>
            目标文件名预览（{names.length} 个{sample ? i18n.t('k16e31089') : i18n.t('k0248df3b')}）
          </label>
          <div
            className="hint"
            style={{ maxHeight: 180, overflowY: 'auto', background: 'var(--panel-strong)', borderRadius: 8, padding: 10 }}
          >
            {names.map((n, i) => (
              <div key={`${n}-${i}`} style={{ fontFamily: 'monospace' }}>
                {String(i + 1).padStart(2, '0')}. {n}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="settings-subhead">{i18n.t('k34668c88')}</div>
      <div className="switch-row">
        <span>{i18n.t('k8620aac3')}</span>
        <input
          type="checkbox"
          checked={applyToLocal}
          onChange={(e) => onChange({ importNameTemplateForLocal: e.target.checked })}
        />
      </div>
      <div className="hint" style={{ lineHeight: 1.8 }}>
        {i18n.t('k447a773d')}<b>{i18n.t('kc564c2e9')}</b>，不会改名或移动你硬盘上的文件。
        开启后才会把素材复制一份到保存文件夹（保留目录层级，文件夹关联不丢）并按模板命名，原文件始终不动。
        <b>{i18n.t('k2c8af7ac')}</b>{i18n.t('k495f5c30')}
      </div>
      <div className="hint">{i18n.t('k3d0009ad')}</div>
    </Card>
  );
}
