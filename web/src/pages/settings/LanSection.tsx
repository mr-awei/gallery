import { useEffect, useState } from 'react';
import { api, withToken } from '../../api';
import type { LanStatus } from '../../types';
import Card from './Card';

interface Props {
  onToast: (m: string, kind?: 'info' | 'error') => void;
}

/** 局域网 / 手机扫码投送：开关、二维码、地址、令牌轮换 */
export default function LanSection({ onToast }: Props) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const s = await api.lanStatus();
      setStatus(s);
      setQrUrl(s.enabled ? await withToken('/api/lan/qrcode.svg') : '');
    } catch (err) {
      onToast(`读取投送状态失败：${(err as Error).message}`, 'error');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<LanStatus>, okMsg: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await load();
      onToast(okMsg);
    } catch (err) {
      onToast(`操作失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="手机扫码投送"
      desc="同一 Wi-Fi 下用手机扫码，把照片 / 视频直接投送到电脑上的当前资源库。"
      badge={
        <span style={{ color: status?.enabled ? 'var(--ok)' : 'var(--warn)', fontSize: 12, fontWeight: 400 }}>
          {status?.enabled ? '● 已开启' : '○ 默认关闭'}
        </span>
      }
    >
      <div className="switch-row">
        <span>允许局域网访问</span>
        <input
          type="checkbox"
          checked={!!status?.enabled}
          disabled={busy || !status}
          onChange={(e) => void act(() => api.setLanAccess(e.target.checked), e.target.checked ? '已开启投送' : '已关闭投送')}
        />
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        主服务始终只监听 127.0.0.1；开启时另起一个独立端口的小服务，只暴露「投送页 + 上传」两个入口，
        使用单独的投送令牌，普通接口 / 设置 / 凭据都摸不到。关闭后外部设备扫不到任何端口。
      </div>

      {status?.enabled && (
        <>
          {status.urls.length ? (
            <>
              <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {qrUrl && (
                  <img
                    src={qrUrl}
                    alt="投送二维码"
                    style={{ width: 168, height: 168, background: '#fff', borderRadius: 8, padding: 4 }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="field">
                    <label>手机可访问的地址（选一个能连通的）</label>
                    {status.urls.map((u) => (
                      <div key={u} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                        <input className="input" readOnly value={u} onFocus={(e) => e.currentTarget.select()} />
                        <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(u).then(() => onToast('地址已复制'))}>
                          复制
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="hint">投送端口：{status.port}（每次开启由系统分配）</div>
                </div>
              </div>
              <div className="field" style={{ marginTop: 12 }}>
                <label>投送令牌（换设备或怀疑泄露时轮换）</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input" readOnly value={status.token} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn sm ghost" disabled={busy} onClick={() => void act(() => api.rotateLanToken(), '已生成新令牌，旧二维码立即失效')}>
                    重新生成
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="hint" style={{ color: 'var(--warn)' }}>
              没有检测到可用的局域网 IPv4 地址：请连上 Wi-Fi / 网线后关闭再开启投送。
            </div>
          )}
        </>
      )}
      {!status?.enabled && <div className="hint">{status?.note || '开启后会显示二维码与手机上传页地址。'}</div>}
    </Card>
  );
}
