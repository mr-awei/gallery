import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { PluginInfo, PluginRunResult } from '../../types';
import Card from './Card';
import i18n from '../../i18n';

interface Props {
  onToast: (m: string, kind?: 'info' | 'error') => void;
  /** 跳到设置侧栏的「插件市场」 */
  onOpenMarket?: () => void;
}

/** 插件 / 脚本宿主：清单、权限、试运行、打开用户插件目录 */
export default function PluginSection({ onToast, onOpenMarket }: Props) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [prefix, setPrefix] = useState(i18n.t('ke17a6882'));
  const [running, setRunning] = useState('');
  const [result, setResult] = useState<PluginRunResult | null>(null);

  const load = () => {
    api
      .plugins()
      .then((r) => {
        setPlugins(r.plugins || []);
        setPermissions(r.permissions || []);
      })
      .catch((err) => onToast(i18n.t('k653f2d21', { p0: (err as Error).message }), 'error'));
  };
  useEffect(load, []);

  /** 停用只记开关、不卸载：关掉后执行会被明确拒绝，不用重启 */
  const toggle = async (id: string, enabled: boolean) => {
    setPlugins((list) => list.map((p) => (p.id === id ? { ...p, enabled } : p)));
    try {
      await api.setPluginEnabled(id, enabled);
      onToast(enabled ? i18n.t('k2e6e33a7', { p0: id }) : i18n.t('k1515aa1f', { p0: id }));
    } catch (err) {
      onToast(i18n.t('k94a44610', { p0: (err as Error).message }), 'error');
      load();
    }
  };

  const run = async (id: string) => {
    if (running) return;
    setRunning(id);
    setResult(null);
    try {
      const r = await api.runPlugin(id, { action: 'run', args: { prefix } });
      setResult(r);
      onToast(r.denied ? i18n.t('k1eda8721') : i18n.t('k635e6073', { p0: id }));
    } catch (err) {
      onToast(i18n.t('k57f31d62', { p0: (err as Error).message }), 'error');
    } finally {
      setRunning('');
    }
  };

  return (
    <>
      <Card
        title={i18n.t('kf758faa0')}
        desc={i18n.t('k09a295ee')}
        badge={<span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>{plugins.length} 个已安装</span>}
      >
        <div className="hint" style={{ marginBottom: 12 }}>
          {i18n.t('k8d1ddf61')}<code>plugins/&lt;id&gt;/plugin.json</code> {i18n.t('k1ad96313')}
          <code> default async ({'{ image, args, permissions, log }'})</code>，返回{' '}
          <code>{'{ logs?, patch?, result? }'}</code>。可用权限：{permissions.join(' / ') || i18n.t('k6bc14eee')}。
          <br />
          安全边界：脚本跑在独立进程、拿不到数据库与文件路径，只能返回 patch；是否写库由宿主按声明权限过滤。
          这<strong>{i18n.t('k046f5a05')}</strong> {i18n.t('ke0ce17b4')}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <div className="field" style={{ margin: 0, flex: 1 }}>
            <label>{i18n.t('k02a57747')}</label>
            <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </div>
          <button
            className="btn"
            onClick={async () => {
              try {
                await api.openPluginDir();
                onToast(i18n.t('k5a2f9ecf'));
              } catch (err) {
                onToast(i18n.t('k9cd07541', { p0: (err as Error).message }), 'error');
              }
            }}
          >
            {i18n.t('k40020e00')}
          </button>
          <button className="btn ghost" onClick={load}>
            {i18n.t('k694fc5ef')}
          </button>
          {onOpenMarket && (
            <button className="btn" onClick={onOpenMarket}>
              {i18n.t('ke4f6a8f7')}
            </button>
          )}
        </div>

        {!plugins.length && <div className="hint">{i18n.t('k47501c95')}</div>}
        {[
          { key: 'official', label: i18n.t('k3dc38c65'), list: plugins.filter((p) => p.builtin) },
          { key: 'user', label: i18n.t('kd880d201'), list: plugins.filter((p) => !p.builtin) },
        ].map(
          (group) =>
            group.list.length > 0 && (
              <div key={group.key} style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                  {group.label} · {group.list.length} 个
                </div>
                {group.list.map((p) => (
                  <div key={p.id} className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <div>
                        <b>{p.name}</b>{' '}
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                          {p.id} · v{p.version}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <label
                          className="hint"
                          style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}
                          title={i18n.t('k61826498')}
                        >
                          <input
                            type="checkbox"
                            checked={p.enabled !== false}
                            disabled={!!running}
                            onChange={(e) => void toggle(p.id, e.target.checked)}
                          />
                          {p.enabled === false ? i18n.t('k69b0f684') : i18n.t('k7854b52a')}
                        </label>
                        <button
                          className="btn sm"
                          disabled={!!running || p.enabled === false}
                          title={p.enabled === false ? i18n.t('ke8a65ade') : undefined}
                          onClick={() => void run(p.id)}
                        >
                          {running === p.id ? i18n.t('k8d11c5c8') : i18n.t('kc13cd518')}
                        </button>
                      </div>
                    </div>
                    <div className="hint">{p.description}</div>
                    <div className="hint">
                      权限：{p.permissions.join(', ') || i18n.t('kd81bb206')} · 动作：{p.actions.join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            )
        )}
        {result && (
          <div className="hint" style={{ marginTop: 10, color: 'var(--ok)' }}>
            ✔ {result.plugin} → logs: {result.logs.join(' / ') || i18n.t('ke2c0dc29')}；写回字段：
            {result.applied.length ? result.applied.join(', ') : i18n.t('k1d25fed2')}
          </div>
        )}
      </Card>
    </>
  );
}
