import React from 'react';
import { api } from '../../api';
import type { SettingsForm } from './useSettingsForm';
import Card from './Card';
import Select from '../../components/Select';
import i18n from '../../i18n';

/** 网络 / 代理（从 Settings.tsx 内联块抽出） */
export default function NetworkSection({
  form,
  onToast,
}: {
  form: SettingsForm;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}) {
  const { net, setNet, netError, setNetError, testingNet, setTestingNet, netModeLabel } = form;

  return (
    <Card
      title={i18n.t('k5419c9cc')}
      desc={i18n.t('kebf5229b')}
      badge={
        <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
          {netModeLabel(net?.mode)}
        </span>
      }
    >
      <div className="field">
        <label>{i18n.t('keb1dfda7')}</label>
        <Select
          className="select"
          style={{ width: '100%' }}
          value={net?.mode || 'off'}
          onChange={(v) => setNet((prev) => (prev ? { ...prev, mode: v } : prev))}
        >
          {(net?.modes || []).map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </Select>
      </div>
      {net && !['off', 'system'].includes(net.mode) && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="field" style={{ flex: 2 }}>
              <label>{i18n.t('k65227369')}</label>
              <input className="input" value={net.host} onChange={(e) => setNet({ ...net, host: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{i18n.t('kc76cfefe')}</label>
              <input
                className="input"
                type="number"
                value={net.port}
                onChange={(e) => setNet({ ...net, port: Number(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>{i18n.t('k07b8375a')}</label>
              <input
                className="input"
                value={net.username}
                onChange={(e) => setNet({ ...net, username: e.target.value })}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{i18n.t('keec70cd2')}</label>
              <input
                className="input"
                type="password"
                value={net.password}
                onChange={(e) => setNet({ ...net, password: e.target.value })}
              />
            </div>
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn"
          disabled={testingNet}
          onClick={async () => {
            if (!net) return;
            setTestingNet(true);
            try {
              await api.saveNetwork(net);
              const res = await api.testNetwork();
              if (res.ok) onToast(i18n.t('k1fffc589', { p0: res.proxy, p1: res.elapsed }));
              else onToast(i18n.t('kc9a10633', { p0: res.proxy }));
              setNetError(JSON.stringify(res.results, null, 2));
            } catch (err) {
              setNetError((err as Error).message);
            } finally {
              setTestingNet(false);
            }
          }}
        >
          {testingNet ? i18n.t('k2ff33d1a') : i18n.t('k69e74756')}
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            if (!net) return;
            const saved = await api.saveNetwork(net);
            setNet(saved);
            onToast(saved.applied ? i18n.t('ka33117e3') : i18n.t('kcddb3839'));
          }}
        >
          {i18n.t('k708d9d9d')}
        </button>
      </div>
      {netError && <div className="ai-result">{netError}</div>}
      <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
        {i18n.t('kb43ed9a3')}
        <br />{i18n.t('k0f39de1d')}
        <br />{i18n.t('kcdf8b637')}
      </div>
    </Card>
  );
}
