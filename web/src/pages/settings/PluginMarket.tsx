import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { MarketPlugin, PluginMarketView } from '../../types';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

const PERMISSION_DESC: Record<string, string> = {
  'image:read': i18n.t('k07f34541'),
  'image:write': i18n.t('k82b650d4'),
  log: i18n.t('ka707fe1e'),
};

/** 插件市场：随包索引 + 自定义索引 + URL 在线安装 + 本地包安装 + 卸载 */
export default function PluginMarket({ onToast }: Props) {
  const [view, setView] = useState<PluginMarketView | null>(null);
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [indexUrl, setIndexUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [detail, setDetail] = useState<MarketPlugin | null>(null);

  const load = async () => {
    try {
      setView(await api.pluginMarket());
    } catch (err) {
      onToast(i18n.t('k7c910d0f', { p0: (err as Error).message }), 'error');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      await load();
      onToast(okMsg);
    } catch (err) {
      onToast(i18n.t('kf97c1cd6', { p0: (err as Error).message }), 'error');
    } finally {
      setBusy('');
    }
  };

  const install = (id: string) =>
    void act(`install-${id}`, () => api.installPlugin({ id }), i18n.t('kb3e77b56'));

  const uninstall = (id: string) =>
    void act(`uninstall-${id}`, async () => {
      const r = await api.uninstallPlugin(id);
      onToast(r.restoredBuiltin ? i18n.t('k9548df38') : i18n.t('k84136468'));
    }, i18n.t('k46c7c359'));

  const installFromUrl = () => {
    if (!url.trim()) return onToast(i18n.t('k4f84a48b'), 'error');
    void act('url', () => api.installPlugin({ url: url.trim() }), i18n.t('k4844bad8'));
  };

  const uploadFile = async (file: File) => {
    if (!/\.(tuku-plugin|zip|json)$/i.test(file.name)) {
      return onToast(i18n.t('k196b3865'), 'error');
    }
    void act('upload', async () => {
      const buf = await file.arrayBuffer();
      return api.uploadPluginPackage(buf, file.name);
    }, i18n.t('k2280530e'));
  };

  const filtered = (view?.plugins || []).filter((p) =>
    `${p.name} ${p.id} ${p.description} ${p.author} ${p.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <>
      <Card
        title={i18n.t('ka5fdebec')}
        desc={i18n.t('k91af9c27')}
        badge={
          <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
            {view?.remote ? i18n.t('kaee62cf4') : i18n.t('k7dfb49cf')} · {view?.plugins.length || 0} 个
          </span>
        }
      >
        <div className="hint" style={{ lineHeight: 1.8, marginBottom: 12 }}>
          {i18n.t('k3438785c')}<b>{i18n.t('kc90d329f')}</b>{i18n.t('k5571a18a')}<strong>{i18n.t('k046f5a05')}</strong> {i18n.t('kede72f2a')}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder={i18n.t('ka78d8ee8')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn sm ghost" onClick={() => void load()}>{i18n.t('k694fc5ef')}</button>
        </div>

        <div className="settings-subhead">{i18n.t('k3e4edc49')}</div>
        {!filtered.length && <div className="hint">{i18n.t('k1cd7ddc2')}</div>}
        {filtered.map((p) => (
          <div key={p.id} style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div>
                  <b>{p.name}</b>{' '}
                  <span className="hint">
                    {p.id} · v{p.version} · {p.author || i18n.t('kde837078')}
                    {p.source === 'remote' ? i18n.t('k0576607d') : ''}
                  </span>
                </div>
                <div className="hint" style={{ lineHeight: 1.7 }}>{p.description}</div>
                <div className="hint">
                  权限：{p.permissions.length ? p.permissions.join(' / ') : i18n.t('k5856bb68')} · 动作：{p.actions.join(', ')}
                </div>
                {p.tags.length > 0 && <div className="hint">标签：{p.tags.join(' · ')}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn sm ghost" onClick={() => setDetail(detail?.id === p.id ? null : p)}>
                  {i18n.t('k87433841')}
                </button>
                {p.installed ? (
                  p.installedBuiltin ? (
                    <span className="hint" style={{ alignSelf: 'center' }}>已随包安装 v{p.installedVersion}</span>
                  ) : (
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => uninstall(p.id)}>
                      {busy === `uninstall-${p.id}` ? i18n.t('k69827c2b') : i18n.t('k81824cff')}
                    </button>
                  )
                ) : (
                  <button className="btn sm" disabled={!!busy} onClick={() => install(p.id)}>
                    {busy === `install-${p.id}` ? i18n.t('kc8f8c937') : i18n.t('k04a0913e')}
                  </button>
                )}
              </div>
            </div>
            {detail?.id === p.id && (
              <div className="hint" style={{ marginTop: 8, padding: 10, background: 'var(--panel-strong)', borderRadius: 8 }}>
                <b>{i18n.t('k3f0ab0b1')}</b>
                {p.permissions.map((perm) => (
                  <div key={perm}>· <code>{perm}</code> — {PERMISSION_DESC[perm] || i18n.t('kf9559b94')}</div>
                ))}
                {!p.permissions.length && <div>{i18n.t('kec4d7005')}</div>}
                <div style={{ marginTop: 6 }}>
                  {i18n.t('k2a1c6636')}<code>{p.package || p.downloadUrl || i18n.t('k5c9e9c42')}</code>
                </div>
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card title={i18n.t('ke5317cef')} desc={i18n.t('kd54ccbeb')}>
        <div className="settings-subhead">{i18n.t('k2aa50818')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="https://example.com/plugins/my-plugin.tuku-plugin"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn sm" disabled={!!busy} onClick={installFromUrl}>
            {busy === 'url' ? i18n.t('k0164eeb4') : i18n.t('k229d360a')}
          </button>
        </div>

        <div className="settings-subhead">{i18n.t('k8d062ca7')}</div>
        <label
          className="btn sm ghost"
          style={{ display: 'inline-flex', cursor: 'pointer' }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void uploadFile(file);
          }}
        >
          {busy === 'upload' ? i18n.t('kc8f8c937') : i18n.t('ka0ff3d35')}
          <input
            type="file"
            hidden
            accept=".tuku-plugin,.zip,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadFile(file);
              e.target.value = '';
            }}
          />
        </label>
        <div className="hint" style={{ marginTop: 6 }}>
          {i18n.t('k9d1190f6')}<code>{'{ format: "tuku-plugin/1", manifest, files }'}</code> {i18n.t('k5d3b2a90')} <code>plugin.json</code> {i18n.t('k7dabc0d8')}
        </div>

        <div className="settings-subhead">{i18n.t('kfecb461b')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="https://example.com/plugin-market/index.json"
            value={indexUrl}
            onChange={(e) => setIndexUrl(e.target.value)}
          />
          <button
            className="btn sm"
            disabled={!!busy}
            onClick={() =>
              void act('index', () => api.refreshPluginMarket(indexUrl.trim()), i18n.t('ke44583dd'))
            }
          >
            {i18n.t('k2aba8807')}
          </button>
          <button className="btn sm ghost" disabled={!!busy} onClick={() => void act('reset', () => api.resetPluginMarket(), i18n.t('k33fe370b'))}>
            {i18n.t('k4a09283e')}
          </button>
        </div>
        <div className="hint">{i18n.t('ke98b9fcb')}</div>
      </Card>
    </>
  );
}
