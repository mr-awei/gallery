import React from 'react';
import { api } from '../../api';
import type { SettingsForm } from './useSettingsForm';
import Card from './Card';
import Select from '../../components/Select';

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
      title="网络 / 代理"
      desc="采集 Wallhaven 等外网源、AI 接口访问不畅时，配置代理即可。"
      badge={
        <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
          {netModeLabel(net?.mode)}
        </span>
      }
    >
      <div className="field">
        <label>代理模式</label>
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
              <label>主机</label>
              <input className="input" value={net.host} onChange={(e) => setNet({ ...net, host: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>端口</label>
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
              <label>用户名（可选）</label>
              <input
                className="input"
                value={net.username}
                onChange={(e) => setNet({ ...net, username: e.target.value })}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>密码（可选）</label>
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
              if (res.ok) onToast(`网络正常（${res.proxy}，${res.elapsed}ms）`);
              else onToast(`网络不通（${res.proxy}），详见下方提示`);
              setNetError(JSON.stringify(res.results, null, 2));
            } catch (err) {
              setNetError((err as Error).message);
            } finally {
              setTestingNet(false);
            }
          }}
        >
          {testingNet ? '测试中…' : '测试连接'}
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            if (!net) return;
            const saved = await api.saveNetwork(net);
            setNet(saved);
            onToast(saved.applied ? '网络设置已生效' : '已保存（网页模式下代理不生效，请用桌面端）');
          }}
        >
          保存并应用
        </button>
      </div>
      {netError && <div className="ai-result">{netError}</div>}
      <div className="hint" style={{ marginTop: 10, lineHeight: 1.9 }}>
        · 常见本地端口：Clash 7890（HTTP/SOCKS5）、v2rayN 10808（SOCKS5）/ 10809（HTTP）
        <br />· 建议同时勾选 Wallhaven 等外网来源后再开代理采集
        <br />· 系统代理（自动）会跟随 Windows 的代理设置
      </div>
    </Card>
  );
}
