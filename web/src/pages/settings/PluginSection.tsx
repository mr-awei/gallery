import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { PluginInfo, PluginRunResult } from '../../types';
import Card from './Card';

interface Props {
  onToast: (m: string, kind?: 'info' | 'error') => void;
  /** 跳到设置侧栏的「插件市场」 */
  onOpenMarket?: () => void;
}

/** 插件 / 脚本宿主：清单、权限、试运行、打开用户插件目录 */
export default function PluginSection({ onToast, onOpenMarket }: Props) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [prefix, setPrefix] = useState('脚本标记');
  const [running, setRunning] = useState('');
  const [result, setResult] = useState<PluginRunResult | null>(null);

  const load = () => {
    api
      .plugins()
      .then((r) => {
        setPlugins(r.plugins || []);
        setPermissions(r.permissions || []);
      })
      .catch((err) => onToast(`读取插件列表失败：${(err as Error).message}`, 'error'));
  };
  useEffect(load, []);

  /** 停用只记开关、不卸载：关掉后执行会被明确拒绝，不用重启 */
  const toggle = async (id: string, enabled: boolean) => {
    setPlugins((list) => list.map((p) => (p.id === id ? { ...p, enabled } : p)));
    try {
      await api.setPluginEnabled(id, enabled);
      onToast(enabled ? `已启用 ${id}` : `已停用 ${id}`);
    } catch (err) {
      onToast(`切换失败：${(err as Error).message}`, 'error');
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
      onToast(r.denied ? '插件想写库但没有 image:write 权限，已忽略写操作' : `插件 ${id} 试运行完成`);
    } catch (err) {
      onToast(`运行失败：${(err as Error).message}`, 'error');
    } finally {
      setRunning('');
    }
  };

  return (
    <>
      <Card
        title="插件 / 脚本宿主"
        desc="在独立进程里运行自己写的 ESM 脚本；动作编辑器里可用「插件脚本」步骤对选中的素材批量执行。"
        badge={<span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>{plugins.length} 个已安装</span>}
      >
        <div className="hint" style={{ marginBottom: 12 }}>
          插件契约：<code>plugins/&lt;id&gt;/plugin.json</code> + 一个 ESM 入口，导出
          <code> default async ({'{ image, args, permissions, log }'})</code>，返回{' '}
          <code>{'{ logs?, patch?, result? }'}</code>。可用权限：{permissions.join(' / ') || '（读取中）'}。
          <br />
          安全边界：脚本跑在独立进程、拿不到数据库与文件路径，只能返回 patch；是否写库由宿主按声明权限过滤。
          这<strong>不是</strong> OS 级沙箱，请只安装自己信任的插件。
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <div className="field" style={{ margin: 0, flex: 1 }}>
            <label>试运行参数 prefix</label>
            <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </div>
          <button
            className="btn"
            onClick={async () => {
              try {
                await api.openPluginDir();
                onToast('已打开用户插件目录（把插件文件夹放这里即可）');
              } catch (err) {
                onToast(`打开目录失败：${(err as Error).message}`, 'error');
              }
            }}
          >
            打开插件目录
          </button>
          <button className="btn ghost" onClick={load}>
            刷新
          </button>
          {onOpenMarket && (
            <button className="btn" onClick={onOpenMarket}>
              插件市场 · 一键安装
            </button>
          )}
        </div>

        {!plugins.length && <div className="hint">还没有插件。内置官方插件随安装包分发，用户插件放到用户插件目录即可。</div>}
        {[
          { key: 'official', label: '官方插件（随安装包分发）', list: plugins.filter((p) => p.builtin) },
          { key: 'user', label: '用户插件（自己放进去的）', list: plugins.filter((p) => !p.builtin) },
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
                          title="停用后不再出现在批量动作里，执行会被明确拒绝；不需要卸载"
                        >
                          <input
                            type="checkbox"
                            checked={p.enabled !== false}
                            disabled={!!running}
                            onChange={(e) => void toggle(p.id, e.target.checked)}
                          />
                          {p.enabled === false ? '已停用' : '启用'}
                        </label>
                        <button
                          className="btn sm"
                          disabled={!!running || p.enabled === false}
                          title={p.enabled === false ? '插件已停用，先启用再试运行' : undefined}
                          onClick={() => void run(p.id)}
                        >
                          {running === p.id ? '运行中…' : '试运行（不写库）'}
                        </button>
                      </div>
                    </div>
                    <div className="hint">{p.description}</div>
                    <div className="hint">
                      权限：{p.permissions.join(', ') || '无'} · 动作：{p.actions.join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            )
        )}
        {result && (
          <div className="hint" style={{ marginTop: 10, color: 'var(--ok)' }}>
            ✔ {result.plugin} → logs: {result.logs.join(' / ') || '（无）'}；写回字段：
            {result.applied.length ? result.applied.join(', ') : '（试运行未指定素材，未写库）'}
          </div>
        )}
      </Card>
    </>
  );
}
