import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { PluginInfo, PluginRunResult } from '../../types';
import Card from './Card';

interface Props {
  onToast: (m: string, kind?: 'info' | 'error') => void;
}

/** 插件 / 脚本宿主：清单、权限、试运行、打开用户插件目录 */
export default function PluginSection({ onToast }: Props) {
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
        </div>

        {!plugins.length && <div className="hint">还没有插件。内置的示例插件目录为 plugins/tag-prefix，可复制后修改。</div>}
        {plugins.map((p) => (
          <div key={p.id} className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <div>
                <b>{p.name}</b>{' '}
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {p.id} · v{p.version} · {p.builtin ? '内置' : '用户安装'}
                </span>
              </div>
              <button className="btn sm" disabled={!!running} onClick={() => void run(p.id)}>
                {running === p.id ? '运行中…' : '试运行（不写库）'}
              </button>
            </div>
            <div className="hint">{p.description}</div>
            <div className="hint">
              权限：{p.permissions.join(', ') || '无'} · 动作：{p.actions.join(', ')}
            </div>
          </div>
        ))}
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
